/**
 * pi-jev-mgt as a Pi *virtual model*: `jev/auto`.
 *
 * This is the standard-aligned path. Pi's virtual models let an extension pick a
 * physical model per request, and Pi then does the rest natively: it records the
 * physical model on every assistant message, computes the real cost, lists cost
 * per model in `/session`, shows `auto • high → <model> • medium` in the footer,
 * tracks the physical model's context window, keeps prompt caches by reusing
 * `previous`/`failed`, stores router state on the session branch, and restores the
 * selection on resume. None of that is re-implemented here.
 *
 * What the extension contributes is the *policy*: the curated allowed list, the
 * hard exclusions, the cost tier, the per-entry flash/balanced/power annotation,
 * and the recommendation engine that fills that list. `route()` is the join point:
 *
 *   selection (jev/auto, virtual level)  ->  physical OpenRouter model + level
 *
 * The virtual thinking level is the band selector, which is exactly what Pi's
 * documentation means by "its meaning is up to the router":
 *
 *   off | minimal | low    -> flash      cheap, fast, everyday edits and questions
 *   medium                 -> balanced   the default workhorse
 *   high | xhigh | max     -> power      hard reasoning, large context, tool chains
 *
 * Requests issued outside the agent loop (compaction summaries, extension calls)
 * always go to the cheap band, so housekeeping never costs a frontier-model turn.
 */

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import type { Messages } from "./i18n.ts";
import {
	DEFAULT_COST_TIER,
	currentLanguage,
	exclusionFor,
	patternMatches,
	patternsOf,
	resolveConfig,
	translator,
	type RouterConfig,
} from "./config.ts";
import {
	ceilingFor,
	capabilityScore,
	dedupeLiveModels,
	eligibleLiveModels,
	registryLiveModels,
	roleFor,
	valueScore,
	type LiveModel,
	type RouterRole,
} from "./catalog.ts";

/** Provider the virtual model is listed under. No provider owns it, so it is always selectable. */
export const VIRTUAL_PROVIDER = "jev";
export const VIRTUAL_MODEL_ID = "auto";
/** Display name in `/model`. A product name: not translated. */
export const VIRTUAL_MODEL_NAME = "Auto (jev-router)";
/** Provider the curated physical models come from. */
const CANDIDATE_PROVIDER = "openrouter";

/** Every level Pi offers on `jev/auto`; the router reads them as a band selector. */
const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const LEVEL_RANK: Record<ModelThinkingLevel, number> = {
	off: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

const LEVEL_BAND: Record<ModelThinkingLevel, RouterRole> = {
	off: "flash",
	minimal: "flash",
	low: "flash",
	medium: "balanced",
	high: "power",
	xhigh: "power",
	max: "power",
};

/** Highest physical thinking level a band is allowed to spend. */
const BAND_LEVEL_CAP: Record<RouterRole, ModelThinkingLevel> = {
	flash: "low",
	balanced: "medium",
	power: "max",
};

const OVERFLOW_ERROR = /context|too (?:long|many tokens)|token limit|maximum.*length|overflow/i;

/** Tier declared for a pattern in `allowedModels`, and the pattern's list position. */
interface DeclaredTier {
	pattern: string;
	role: RouterRole;
	order: number;
}

interface Candidate {
	live: LiveModel;
	/** Catalog entry handed back to Pi; Pi validates its provider credentials. */
	model: Model<Api>;
	declared?: { role: RouterRole; order: number };
}

interface Pool {
	candidates: Candidate[];
	ceiling: number;
	allowed: string[];
	excluded: string[];
	missing: boolean;
}

function isRouterRole(value: unknown): value is RouterRole {
	return value === "flash" || value === "balanced" || value === "power";
}

/** Explicit `tier` annotations from the allowed list, in list order. */
function declaredTiers(config: RouterConfig): DeclaredTier[] {
	const declared: DeclaredTier[] = [];
	for (const [order, entry] of (config.allowedModels ?? []).entries()) {
		if (typeof entry === "string") continue;
		const pattern = (entry.model ?? entry.pattern ?? "").trim();
		if (!pattern || !isRouterRole(entry.tier)) continue;
		declared.push({ pattern, role: entry.tier, order });
	}
	return declared;
}

/** The earliest declared tier that covers a model id. */
function declaredFor(modelId: string, declared: DeclaredTier[]): { role: RouterRole; order: number } | undefined {
	let best: DeclaredTier | undefined;
	for (const item of declared) {
		if (!patternMatches(item.pattern, modelId)) continue;
		if (!best || item.order < best.order) best = item;
	}
	return best ? { role: best.role, order: best.order } : undefined;
}

function bandLabel(t: Messages, band: RouterRole): string {
	if (band === "flash") return t.bandFlash;
	if (band === "balanced") return t.bandBalanced;
	return t.bandPower;
}

/** Never raise the reasoning effort the user asked for; only cap it. */
function clampLevel(requested: ModelThinkingLevel, cap: ModelThinkingLevel): ModelThinkingLevel {
	return LEVEL_RANK[requested] <= LEVEL_RANK[cap] ? requested : cap;
}

/**
 * Build the routing pool: catalog models that are allowed, not hard-excluded,
 * under the cost ceiling, and resolvable to a real catalog entry.
 */
function buildPool(ctx: ExtensionContext, config: RouterConfig, missing: boolean): Pool {
	const allowed = patternsOf(config.allowedModels);
	const excluded = patternsOf(config.excludedModels);
	const tier = config.costTier ?? DEFAULT_COST_TIER;

	const eligible = eligibleLiveModels(dedupeLiveModels(registryLiveModels(ctx)), excluded);
	const { ceiling } = ceilingFor(eligible, allowed, tier);
	const declared = declaredTiers(config);

	const candidates: Candidate[] = [];
	for (const live of eligible) {
		// An empty allowed list means "no restriction", as it does for the router body.
		if (allowed.length > 0 && !allowed.some((pattern) => patternMatches(pattern, live.id))) continue;
		if (live.blended > ceiling) continue;
		const model = ctx.modelRegistry.find(CANDIDATE_PROVIDER, live.id);
		if (!model) continue;
		const tierInfo = declaredFor(live.id, declared);
		candidates.push(tierInfo ? { live, model, declared: tierInfo } : { live, model });
	}
	return { candidates, ceiling, allowed, excluded, missing };
}

/** Best candidate per capability-per-dollar inside one band; capability wins in `power`. */
function rankBand(candidates: Candidate[], role: RouterRole): Candidate[] {
	const low = Math.min(...candidates.map((item) => item.live.blended));
	const high = Math.max(...candidates.map((item) => item.live.blended));
	const scored = candidates.map((item) => ({
		candidate: item,
		score: role === "power" ? capabilityScore(item.live) : valueScore(item.live, low, high),
	}));
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			a.candidate.live.blended - b.candidate.live.blended ||
			a.candidate.live.id.localeCompare(b.candidate.live.id),
	);
	return scored.map((entry) => entry.candidate);
}

function cheapest(candidates: Candidate[]): Candidate | undefined {
	return [...candidates].sort((a, b) => a.live.blended - b.live.blended)[0];
}

/**
 * The model for one band: an explicit `tier` annotation wins (it is the user's own
 * ordering), then the price band, and finally the whole pool so a low ceiling or a
 * one-model list still routes instead of failing.
 */
function pickForBand(pool: Pool, role: RouterRole): Candidate | undefined {
	const declared = pool.candidates
		.filter((item) => item.declared?.role === role)
		.sort((a, b) => (a.declared?.order ?? 0) - (b.declared?.order ?? 0));
	const first = declared[0];
	if (first) return first;

	const inBand = pool.candidates.filter((item) => roleFor(item.live.blended, pool.ceiling) === role);
	if (inBand.length > 0) return rankBand(inBand, role)[0];

	if (role === "flash") return cheapest(pool.candidates);
	return rankBand(pool.candidates, role)[0];
}

/**
 * Whether the model that handled the previous request may keep the next one.
 * Stickiness exists to preserve the prompt cache, but it never overrides the hard
 * guardrails: an excluded model, one above the cost ceiling, or one dropped from
 * the allowed list is not reused.
 */
function stickyAllowed(pool: Pool, model: Model<Api>): boolean {
	if (model.provider !== CANDIDATE_PROVIDER) return false;
	if (exclusionFor(model.id, pool.excluded)) return false;
	if (pool.allowed.length > 0 && !pool.allowed.some((pattern) => patternMatches(pattern, model.id))) return false;
	const live = pool.candidates.find((item) => item.live.id === model.id)?.live;
	const blended = live?.blended ?? (model.cost.input + 2 * model.cost.output) / 3;
	return blended <= pool.ceiling;
}

let warnedMissingConfig = false;

function warnMissingConfig(ctx: ExtensionContext, t: Messages, path: string): void {
	if (warnedMissingConfig) return;
	warnedMissingConfig = true;
	ctx.ui.notify(t.routerConfigMissing(path), "warning");
}

/** Decide the physical model and thinking level for one request. */
function decide(request: ModelRouteRequest, ctx: ExtensionContext): ModelRoute {
	const { t } = translator(ctx.cwd);
	const { config, path, missing } = resolveConfig(ctx.cwd, t);
	const pool = buildPool(ctx, config, missing);
	if (missing) warnMissingConfig(ctx, t, path);

	const levelFor = (band: RouterRole) => clampLevel(request.thinkingLevel, BAND_LEVEL_CAP[band]);

	// A retry after a context overflow needs more window, not the same model again.
	if (request.reason === "retry" && request.failed && OVERFLOW_ERROR.test(request.failed.message.errorMessage ?? "")) {
		const largest = [...pool.candidates].sort((a, b) => b.live.context - a.live.context)[0];
		if (largest) return { model: largest.model, thinkingLevel: levelFor("power") };
	}

	// Tool follow-ups and retries stay on the model that handled the turn, so the
	// prompt cache and the thinking signatures stay valid.
	const sticky = request.reason === "retry" ? request.failed : request.reason === "continuation" ? request.previous : undefined;
	if (sticky && stickyAllowed(pool, sticky.model)) {
		return {
			model: sticky.model,
			thinkingLevel: sticky.thinkingLevel ?? levelFor(LEVEL_BAND[request.thinkingLevel]),
		};
	}

	// Housekeeping outside the agent loop (compaction summaries, extension calls)
	// never needs a frontier model.
	const band: RouterRole = request.reason === "direct" ? "flash" : LEVEL_BAND[request.thinkingLevel];
	const candidate = pickForBand(pool, band);
	if (!candidate) throw new Error(t.routerNoCandidate(bandLabel(t, band), pool.ceiling.toFixed(2)));
	return { model: candidate.model, thinkingLevel: levelFor(band) };
}

/** Register `jev/auto` with Pi. Registration is static; config is read per request. */
export function registerJevRouter(pi: ExtensionAPI): void {
	pi.registerVirtualModel({
		provider: VIRTUAL_PROVIDER,
		id: VIRTUAL_MODEL_ID,
		name: VIRTUAL_MODEL_NAME,
		thinkingLevels: THINKING_LEVELS,
		input: ["text", "image"] as ("text" | "image")[],
		route: (request, ctx) => decide(request, ctx),
	});
}
