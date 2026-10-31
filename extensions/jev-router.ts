/**
 * Jev Router - curate which OpenRouter models may answer, from inside pi.
 *
 * Two entry points share one policy file (`<cwd>/.pi/jev-router.json`,
 * `~/.pi/agent/jev-router.json`, or `$PI_JEV_ROUTER_CONFIG`; re-read on change):
 *
 * 1. Standard path - `jev/auto`, a Pi *virtual model* (see router.ts).
 *    `pi --model jev/auto`, then pick the desired effort with /thinking.
 *    Pi records the physical model per message, so cost, /session, context
 *    limits, footer display and session resume all work natively.
 *
 * 2. OpenRouter path - `typesafe/jev-router`, the vendor's server-side router.
 *    `pi --model typesafe/jev-router`. The extension injects the router plugin
 *    (`cost_tier`, `models`, `excluded_models`) into each request body, and
 *    re-bills the response at the routed model's tariff because the router
 *    declares $0.
 *
 * The file below also holds the OpenRouter request-body plumbing for path 2.
 *
 * OpenRouter reminder:
 *   - `models` / `allowed_models` = preferences with fallback: if no model in
 *     the pool is eligible, the router retries without the list.
 *   - `excluded_models` = hard exclusion, never ignored.
 * The router extension enforces the same semantics locally: exclusions are hard,
 * the allowed list is a preference order, and the cost tier caps the pool.
 */

import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMessages } from "./i18n.ts";
import {
	DEFAULT_COST_TIER,
	DEFAULT_ROUTER_MODEL,
	buildPlugin,
	currentLanguage,
	resolveConfig,
	translator,
} from "./config.ts";
import { describe, manageRouter, recommendForRouter } from "./ui.ts";
import { VIRTUAL_MODEL_ID, VIRTUAL_PROVIDER, registerJevRouter } from "./router.ts";

type ProviderPayload = Record<string, unknown>;

function asProviderPayload(value: unknown): ProviderPayload | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as ProviderPayload)
		: undefined;
}

function isJevRouterPlugin(value: unknown): boolean {
	const plugin = asProviderPayload(value);
	return plugin?.id === "jev-router";
}

function applyJevRouter(body: ProviderPayload, plugin: ProviderPayload): ProviderPayload {
	const existing = Array.isArray(body.plugins) ? body.plugins.filter((item) => !isJevRouterPlugin(item)) : [];
	return { ...body, plugins: [...existing, plugin] };
}

/** Physical model actually used, from the `responseModel` returned by OpenRouter. */
function resolveRoutedModel(
	ctx: ExtensionContext,
	provider: string,
	responseModel: string,
): Model<string> | undefined {
	const exact = ctx.modelRegistry.find(provider, responseModel);
	if (exact) return exact;
	// The router often returns a dated revision, e.g. `anthropic/claude-haiku-5.5-20261007`.
	let best: Model<string> | undefined;
	for (const model of ctx.modelRegistry.getModelsOfType("chat", provider)) {
		if (responseModel !== model.id && !responseModel.startsWith(`${model.id}-`)) continue;
		if (!best || model.id.length > best.id.length) best = model as Model<string>;
	}
	return best;
}

/** Recompute a message cost with the routed model's tariff (the router declares $0/Mtok). */
function recost(message: AssistantMessage, model: Model<string>): AssistantMessage {
	const usage = message.usage;
	if (!usage) return message;
	const cost = {
		input: (usage.input / 1_000_000) * model.cost.input,
		output: (usage.output / 1_000_000) * model.cost.output,
		cacheRead: (usage.cacheRead / 1_000_000) * model.cost.cacheRead,
		cacheWrite: (usage.cacheWrite / 1_000_000) * model.cost.cacheWrite,
	};
	const recosted: Usage = {
		...usage,
		cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
	};
	return { ...message, usage: recosted };
}


export default function (pi: ExtensionAPI) {
	// Standard path: `jev/auto` is a Pi virtual model, so Pi owns dispatch,
	// model recording, cost, context limits, cache-preserving stickiness and
	// session restore. The extension only supplies the routing policy.
	registerJevRouter(pi);

	pi.on("before_provider_request", (event, ctx) => {
		const { t } = translator(ctx.cwd);
		let resolved: ReturnType<typeof resolveConfig>;
		try {
			resolved = resolveConfig(ctx.cwd, t);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("jev-router", t.statusInvalidConfig);
			ctx.ui.notify(message, "error");
			return event.payload;
		}
		const { config, missing } = resolved;
		if (config.enabled === false) {
			ctx.ui.setStatus("jev-router", t.statusOff);
			return event.payload;
		}
		const routerModel = config.routerModel ?? DEFAULT_ROUTER_MODEL;
		const payload = asProviderPayload(event.payload);
		if (!payload) return event.payload;
		if (payload.model !== routerModel) {
			ctx.ui.setStatus("jev-router", undefined);
			return payload;
		}
		if (missing) {
			ctx.ui.setStatus("jev-router", t.statusConfigMissing);
			ctx.ui.notify(t.missingConfigWarning(resolved.path), "warning");
			return payload;
		}
		ctx.ui.setStatus("jev-router", t.statusTier(config.costTier ?? DEFAULT_COST_TIER));
		return applyJevRouter(payload, buildPlugin(config));
	});

	// Show the model actually chosen by the router in the status bar.
	let lastStatus: string | undefined;
	pi.on("provider_stream_event", (event, ctx) => {
		if (event.provider !== "openrouter") return;
		const { t } = translator(ctx.cwd);
		let routerModel = DEFAULT_ROUTER_MODEL;
		try {
			routerModel = resolveConfig(ctx.cwd, t).config.routerModel ?? DEFAULT_ROUTER_MODEL;
		} catch {
			return;
		}
		if (event.model !== routerModel) return;
		const chunk = asProviderPayload(event.data);
		const routed = typeof chunk?.model === "string" && chunk.model !== routerModel ? chunk.model : undefined;
		const status = routed ? `→ ${routed}` : t.statusTier(DEFAULT_COST_TIER);
		if (status === lastStatus) return;
		lastStatus = status;
		ctx.ui.setStatus("jev-router", status);
	});

	// OpenRouter's router reports a zero cost, so a response that went through the
	// `typesafe/jev-router` placeholder is re-billed at the physical model's tariff.
	// Requests routed by the `jev/auto` virtual model are excluded: Pi recorded the
	// physical model itself and already computed the real cost.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (!message.responseModel || message.responseModel === message.model) return;
		const { t } = translator(ctx.cwd);
		let routerModel = DEFAULT_ROUTER_MODEL;
		try {
			routerModel = resolveConfig(ctx.cwd, t).config.routerModel ?? DEFAULT_ROUTER_MODEL;
		} catch {
			return;
		}
		if (message.model !== routerModel) return;
		const model = resolveRoutedModel(ctx, message.provider, message.responseModel);
		if (!model) return;
		return { message: recost(message, model) };
	});

	pi.registerCommand("jev-models", {
		description: getMessages(currentLanguage(process.cwd()).language).cmdModels,
		handler: async (_args, ctx) => {
			try {
				await manageRouter(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("jev-recommend", {
		description: getMessages(currentLanguage(process.cwd()).language).cmdRecommend,
		handler: async (_args, ctx) => {
			try {
				await recommendForRouter(ctx);
			} catch (error) {
				const { t } = translator(ctx.cwd);
				ctx.ui.notify(t.recFailed(error instanceof Error ? error.message : String(error)), "error");
			}
		},
	});

	pi.registerCommand("jev-router", {
		description: getMessages(currentLanguage(process.cwd()).language).cmdRouter,
		handler: async (_args, ctx) => {
			try {
				const { t, language } = translator(ctx.cwd);
				const resolved = resolveConfig(ctx.cwd, t);
						ctx.ui.notify(
					describe(t, language, resolved.config, resolved.path, resolved.missing, `${VIRTUAL_PROVIDER}/${VIRTUAL_MODEL_ID}`),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
