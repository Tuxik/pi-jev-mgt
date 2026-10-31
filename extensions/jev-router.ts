/**
 * Jev Router - OpenRouter `typesafe/jev-router` router restricted to a curated
 * list of models, with an interactive manager directly inside pi.
 *
 * The OpenRouter router accepts a `jev-router` plugin in the request body:
 *   plugins: [{ id: "jev-router", cost_tier, models, excluded_models }]
 *
 * This extension injects that plugin on every request sent to the configurable
 * model (default `typesafe/jev-router`) from the file:
 *
 *   <cwd>/.pi/jev-router.json          (optional project override)
 *   ~/.pi/agent/jev-router.json        (global config)
 *   $PI_JEV_ROUTER_CONFIG              (explicit path, highest priority)
 *
 * The config is re-read when the file changes: no /reload needed.
 *
 * Commands:
 *   /jev-models     interactive manager: view, add, remove and reorder allowed
 *                   models, manage exclusions and the cost tier, browse the
 *                   OpenRouter catalog. Changes are written to the config.
 *   /jev-router     print the effective config (non-interactive text summary)
 *   /jev-recommend  query the live OpenRouter catalog and propose the 3 models
 *                   best suited to the router (flash / balanced / power), with
 *                   the option to add them to the allowed list.
 *
 * UI language: English (default), French, Spanish, Italian and German. See
 * `i18n.ts` for the resolution order; the `language` key of the config file
 * pins it, and `/jev-models` has a picker for it.
 *
 * OpenRouter reminder:
 *   - `models` / `allowed_models` = preferences with fallback: if no model in
 *     the pool is eligible, the router retries without the list.
 *   - `excluded_models` = hard exclusion, never ignored.
 * Hence the default `excludedModels` list, which acts as a guardrail against
 * expensive models.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_LANGUAGE,
	LANGUAGES,
	LANGUAGE_NAMES,
	LOCALE_TAGS,
	getMessages,
	languageFromEnv,
	parseLanguage,
	type Language,
	type Messages,
} from "./i18n.ts";

interface ModelEntry {
	/** OpenRouter slug (exact, dated, wildcard or `~author/family-latest` alias). */
	model?: string;
	/** Alias of `model`, accepted for readability. */
	pattern?: string;
	tier?: string;
	/** Free-form notes, purely documentary. */
	note?: string;
}

interface RouterConfig {
	enabled?: boolean;
	routerModel?: string;
	costTier?: "low" | "medium" | "high";
	/** `"auto"` (or absent) follows the detection chain; a tag pins the UI language. */
	language?: string;
	allowedModels?: Array<string | ModelEntry>;
	excludedModels?: Array<string | ModelEntry>;
}

/** Raw JSON object of the config file, to preserve unknown keys. */
type RawConfig = Record<string, unknown>;

const DEFAULT_ROUTER_MODEL = "typesafe/jev-router";
const DEFAULT_COST_TIER: NonNullable<RouterConfig["costTier"]> = "medium";
const COST_TIERS = new Set(["low", "medium", "high"]);

const FALLBACK: RouterConfig = {
	enabled: true,
	routerModel: DEFAULT_ROUTER_MODEL,
	costTier: DEFAULT_COST_TIER,
	allowedModels: [],
	excludedModels: [],
};

function configCandidates(cwd: string): string[] {
	const candidates: string[] = [];
	if (process.env.PI_JEV_ROUTER_CONFIG) candidates.push(process.env.PI_JEV_ROUTER_CONFIG);
	candidates.push(join(cwd, ".pi", "jev-router.json"));
	candidates.push(join(getAgentDir(), "jev-router.json"));
	return candidates;
}

// ---------------------------------------------------------------------------
// Language resolution
// ---------------------------------------------------------------------------
//
// Pi has no language setting of its own, so the UI language comes from the
// first source that names a supported language:
//
//   1. `$PI_JEV_LANG` / `$PI_JEV_ROUTER_LANG`  explicit, plugin-scoped override
//   2. `language` in the jev-router config     the value `/jev-models` writes
//   3. `$PI_LANG`                              forward-compatible Pi override
//   4. `language` in a Pi `settings.json`      project, then agent directory
//   5. `$LC_ALL` / `$LC_MESSAGES` / `$LANG`    operating-system locale
//   6. English
//
// `"language": "auto"`, an empty value or an unsupported tag means "keep
// looking", so English is used whenever nothing is specified.

type LanguageSource = "override" | "config" | "pi-env" | "settings" | "locale" | "default";

interface LanguageResolution {
	language: Language;
	source: LanguageSource;
	/** True when a source explicitly pinned a language (not "auto"). */
	pinned: boolean;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** `language` from the first readable config candidate. Never throws. */
function configLanguage(cwd: string): Language | undefined {
	for (const path of configCandidates(cwd)) {
		const raw = readJsonObject(path);
		if (raw) return parseLanguage(raw.language);
	}
	return undefined;
}

function settingsLanguage(cwd: string): Language | undefined {
	// Project settings first, then the agent-directory ones.
	const paths = [join(cwd, ".pi", "settings.json"), join(getAgentDir(), "settings.json")];
	for (const path of paths) {
		const language = parseLanguage(readJsonObject(path)?.language);
		if (language) return language;
	}
	return undefined;
}

function resolveLanguage(cwd: string): LanguageResolution {
	const override = parseLanguage(process.env.PI_JEV_LANG) ?? parseLanguage(process.env.PI_JEV_ROUTER_LANG);
	if (override) return { language: override, source: "override", pinned: true };

	const configured = configLanguage(cwd);
	if (configured) return { language: configured, source: "config", pinned: true };

	const piEnv = parseLanguage(process.env.PI_LANG);
	if (piEnv) return { language: piEnv, source: "pi-env", pinned: true };

	const settings = settingsLanguage(cwd);
	if (settings) return { language: settings, source: "settings", pinned: true };

	const env = languageFromEnv();
	if (env) return { language: env.language, source: "locale", pinned: false };

	return { language: DEFAULT_LANGUAGE, source: "default", pinned: false };
}

let languageCache: { signature: string; resolved: LanguageResolution } | undefined;

/** Files whose content can change the resolved language. */
function languageSources(cwd: string): string[] {
	return [
		...configCandidates(cwd),
		join(cwd, ".pi", "settings.json"),
		join(getAgentDir(), "settings.json"),
	];
}

/**
 * Cheap change detector for the language sources: modification time and size of
 * every related file, plus the language environment variables. `provider_stream_event`
 * fires on every streamed chunk, so the resolution must not re-read the files each time,
 * yet a hand edit of `language` has to take effect immediately.
 */
function languageSignature(cwd: string): string {
	const parts = languageSources(cwd).map((path) => {
		try {
			const stat = statSync(path);
			return `${path}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			return `${path}:-`;
		}
	});
	for (const name of ["PI_JEV_LANG", "PI_JEV_ROUTER_LANG", "PI_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
		parts.push(`${name}=${process.env[name] ?? ""}`);
	}
	return parts.join("|");
}

function currentLanguage(cwd: string): LanguageResolution {
	const signature = languageSignature(cwd);
	if (languageCache?.signature === signature) return languageCache.resolved;
	const resolved = resolveLanguage(cwd);
	languageCache = { signature, resolved };
	return resolved;
}

function invalidateLanguage(): void {
	languageCache = undefined;
}

/** Translator plus the resolution behind it, for the current working directory. */
function translator(cwd: string): { t: Messages; language: LanguageResolution } {
	const language = currentLanguage(cwd);
	return { t: getMessages(language.language), language };
}

/**
 * Human-readable language for the UI. When no source pins a language, the
 * active one is still shown next to the "automatic" marker so the menu is not
 * ambiguous.
 */
function languageLabel(t: Messages, resolution: LanguageResolution): string {
	const name = LANGUAGE_NAMES[resolution.language];
	return resolution.pinned ? name : `${name} — ${t.languageAuto}`;
}

let cache: { path: string; mtimeMs: number; config: RouterConfig } | undefined;

function resolveConfig(
	cwd: string,
	t: Messages,
): { config: RouterConfig; path: string; missing: boolean } {
	const candidates = configCandidates(cwd);
	for (const path of candidates) {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		if (cache && cache.path === path && cache.mtimeMs === mtimeMs) {
			return { config: cache.config, path, missing: false };
		}
		try {
			const config = JSON.parse(readFileSync(path, "utf8")) as RouterConfig;
			cache = { path, mtimeMs, config };
			return { config, path, missing: false };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(t.invalidConfig(path, message));
		}
	}
	return {
		config: FALLBACK,
		path: candidates.at(-1) ?? join(getAgentDir(), "jev-router.json"),
		missing: true,
	};
}

function patternOf(entry: string | ModelEntry): string {
	if (typeof entry === "string") return entry.trim();
	return (entry?.model ?? entry?.pattern ?? "").trim();
}

function patternsOf(entries: Array<string | ModelEntry> | undefined): string[] {
	return (entries ?? []).map(patternOf).filter(Boolean);
}

/** Path to write: the resolved config, otherwise the global one. */
function configPathForWrite(cwd: string): string {
	for (const path of configCandidates(cwd)) {
		try {
			statSync(path);
			return path;
		} catch {
			// continue
		}
	}
	return join(getAgentDir(), "jev-router.json");
}

function loadRawConfig(cwd: string, t: Messages): { raw: RawConfig; path: string; missing: boolean } {
	const path = configPathForWrite(cwd);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") {
			const raw: RawConfig = {
				enabled: true,
				routerModel: DEFAULT_ROUTER_MODEL,
				costTier: DEFAULT_COST_TIER,
				allowedModels: [],
				excludedModels: [],
			};
			return { raw, path, missing: true };
		}
		throw error;
	}

	// Parse and shape-check separately so a syntax error is reported with the
	// same localized message as an invalid root, never as a raw JSON.parse error.
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(t.invalidConfig(path, error instanceof Error ? error.message : String(error)));
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(t.invalidConfigRoot(path));
	}
	return { raw: parsed as RawConfig, path, missing: false };
}

function saveRawConfig(path: string, raw: RawConfig): void {
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	cache = undefined;
	invalidateLanguage();
}

function arrayField(raw: RawConfig, key: string): unknown[] {
	const value = raw[key];
	if (Array.isArray(value)) return value;
	const created: unknown[] = [];
	raw[key] = created;
	return created;
}

function buildPlugin(config: RouterConfig): Record<string, unknown> {
	const plugin: Record<string, unknown> = { id: "jev-router" };
	if (config.costTier && COST_TIERS.has(config.costTier)) plugin.cost_tier = config.costTier;
	const models = patternsOf(config.allowedModels);
	const excluded = patternsOf(config.excludedModels);
	if (models.length > 0) plugin.models = models;
	if (excluded.length > 0) plugin.excluded_models = excluded;
	return plugin;
}

/** JSON body of a provider request, after verification at the boundary. */
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

function describe(
	t: Messages,
	language: LanguageResolution,
	config: RouterConfig,
	path: string,
	missing: boolean,
): string {
	const enabled = config.enabled !== false;
	const routerModel = config.routerModel ?? DEFAULT_ROUTER_MODEL;
	const tier = config.costTier ?? DEFAULT_COST_TIER;
	const lines = [
		t.summaryTitle(routerModel, enabled, tier),
		t.summaryConfig(path, missing),
		t.summaryLanguage(languageLabel(t, language)),
	];
	const allowed = config.allowedModels ?? [];
	if (allowed.length === 0) {
		lines.push(t.noRestriction);
	} else {
		lines.push(t.allowedHeader(allowed.length));
		for (const entry of allowed) {
			const pattern = patternOf(entry);
			if (!pattern) continue;
			const meta = typeof entry === "string" ? "" : [entry.tier, entry.note].filter(Boolean).join(" - ");
			lines.push(`  - ${pattern}${meta ? `  (${meta})` : ""}`);
		}
	}
	const excluded = patternsOf(config.excludedModels);
	lines.push(
		excluded.length > 0 ? t.exclusionsHeader(excluded.length, excluded.join(", ")) : t.noExclusions,
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Catalog and pattern helpers
// ---------------------------------------------------------------------------

function catalogMap(ctx: ExtensionContext): Map<string, Model<string>> {
	const map = new Map<string, Model<string>>();
	for (const model of ctx.modelRegistry.getModelsOfType("chat", "openrouter")) {
		map.set(model.id, model as Model<string>);
	}
	return map;
}

function priceLabel(model: Model<string>): string {
	const { input, output } = model.cost;
	return `${input.toFixed(3)}/${output.toFixed(2)} $/Mtok`;
}

function contextLabel(model: Model<string>): string {
	return `${Math.round(model.contextWindow / 1000)}K ctx`;
}

function capabilitiesLabel(model: Model<string>): string {
	const caps: string[] = [];
	if (model.reasoning) caps.push("think");
	if (model.input.includes("image")) caps.push("img");
	return caps.join(" ");
}

/** An exact OpenRouter pattern also covers dated revisions of that slug. */
function patternMatches(pattern: string, modelId: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	const suffix = pattern.includes("*") ? "" : "(?:-\\d{4,8})?";
	try {
		return new RegExp(`^${escaped}${suffix}$`).test(modelId);
	} catch {
		return false;
	}
}

/** A concrete pattern can be compared against exclusions; a wildcard/alias cannot. */
function isConcrete(pattern: string): boolean {
	return !pattern.includes("*") && !pattern.startsWith("~");
}

function exclusionFor(modelId: string, excluded: string[]): string | undefined {
	return excluded.find((pattern) => patternMatches(pattern, modelId));
}

function fuzzyMatch(model: Model<string>, needle: string): boolean {
	if (!needle) return true;
	return model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle);
}

function sortByOutputCost(a: Model<string>, b: Model<string>): number {
	return a.cost.output - b.cost.output || a.id.localeCompare(b.id);
}

/** Detail block for a registry (offline) model. */
function catalogDetails(t: Messages, model: Model<string>): string {
	return [
		model.id,
		model.name,
		`${t.priceField}: ${priceLabel(model)}`,
		`${t.contextField}: ${contextLabel(model)}`,
		`${t.maxOutputField}: ${t.maxOutputValue(`${Math.round(model.maxTokens / 1000)}K`)}`,
		`${t.capabilitiesField}: ${capabilitiesLabel(model) || t.textOnly}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Recommendation: 3 models suited to the router, from the live catalog
// ---------------------------------------------------------------------------
//
// The router picks one model per request: the allowed list must cover three
// complementary registers (flash / balanced / power). Candidates are scored
// from the live OpenRouter catalog (current price, context, tool calling,
// reasoning, vision) instead of hard-coded ratings.
//
// The cost ceiling is derived from the current list: never recommend a model
// clearly more expensive than the dearest model already accepted.

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CEILING = 3;
/** Cost ceiling ($/Mtok blended) implied by the router cost_tier. */
const TIER_CEILING: Record<NonNullable<RouterConfig["costTier"]>, number> = {
	low: 1,
	medium: 4,
	high: Number.POSITIVE_INFINITY,
};
const BAND_FLASH = 0.12;
const BAND_BALANCED = 0.45;
const NON_CHAT_VARIANT = /:(free|batch|online|extended)\b/i;
const CATALOG_CACHE_FILE = "jev-router-catalog.json";

interface LiveModel {
	id: string;
	name: string;
	/** $/Mtok (base tariff). */
	prompt: number;
	/** $/Mtok (base tariff). */
	completion: number;
	/** $/Mtok, peak tariff when one exists (OpenRouter overrides). */
	peakPrompt: number;
	/** $/Mtok, peak tariff when one exists (OpenRouter overrides). */
	peakCompletion: number;
	/** $/Mtok, input/output blend at the highest tariff. */
	blended: number;
	context: number;
	tools: boolean;
	reasoning: boolean;
	vision: boolean;
	created: number;
	canonical: string;
	chat: boolean;
	expired: boolean;
}

interface LiveCatalog {
	models: LiveModel[];
	fetchedAt: number;
	source: "live" | "cache" | "registry";
}

type RouterRole = "flash" | "balanced" | "power";

interface Recommendation {
	role: RouterRole;
	model: LiveModel;
	score: number;
	reason: string;
	/** Already covered by a pattern in `allowedModels`. */
	present: boolean;
}

interface RecommendationResult {
	picks: Recommendation[];
	ceiling: number;
	ceilingBasis: string;
	candidateCount: number;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function numberOf(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Blended cost: output weighs more than input on the bill. */
function blendCost(prompt: number, completion: number): number {
	return (prompt + 2 * completion) / 3;
}

function liveModelFromOpenRouter(value: unknown): LiveModel | undefined {
	const record = recordOf(value);
	const id = typeof record?.id === "string" ? record.id : undefined;
	if (!record || !id) return undefined;

	const pricing = recordOf(record.pricing) ?? {};
	const prompt = (numberOf(pricing.prompt) ?? 0) * 1_000_000;
	const completion = (numberOf(pricing.completion) ?? 0) * 1_000_000;
	const parameters = Array.isArray(record.supported_parameters)
		? record.supported_parameters.filter((item): item is string => typeof item === "string")
		: [];
	const architecture = recordOf(record.architecture) ?? {};
	const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
	const endpoints = Array.isArray(record.endpoints)
		? record.endpoints.filter((item): item is string => typeof item === "string")
		: [];
	const topProvider = recordOf(record.top_provider) ?? {};
	const expiresAt = typeof record.expiration_date === "string" ? Date.parse(record.expiration_date) : Number.NaN;
	// Some models bill more at peak hours (`pricing.overrides`): keep the highest
	// tariff so the cost ceiling is never underestimated.
	let peakPrompt = prompt;
	let peakCompletion = completion;
	for (const item of Array.isArray(pricing.overrides) ? pricing.overrides : []) {
		const override = recordOf(item);
		if (!override) continue;
		const overridePrompt = (numberOf(override.prompt) ?? prompt / 1_000_000) * 1_000_000;
		const overrideCompletion = (numberOf(override.completion) ?? completion / 1_000_000) * 1_000_000;
		if (blendCost(overridePrompt, overrideCompletion) > blendCost(peakPrompt, peakCompletion)) {
			peakPrompt = overridePrompt;
			peakCompletion = overrideCompletion;
		}
	}

	return {
		id,
		name: typeof record.name === "string" ? record.name : id,
		prompt,
		completion,
		peakPrompt,
		peakCompletion,
		blended: blendCost(peakPrompt, peakCompletion),
		context: numberOf(record.context_length) ?? numberOf(topProvider.context_length) ?? 0,
		tools: parameters.includes("tools"),
		reasoning:
			recordOf(record.reasoning) !== undefined ||
			parameters.includes("reasoning") ||
			parameters.includes("include_reasoning"),
		vision: inputs.includes("image"),
		created: numberOf(record.created) ?? 0,
		canonical: typeof record.canonical_slug === "string" ? record.canonical_slug : id,
		chat: endpoints.length === 0 || endpoints.some((endpoint) => endpoint.endsWith("/chat/completions")),
		expired: Number.isFinite(expiresAt) && expiresAt < Date.now(),
	};
}

/** Offline fallback: the local pi catalog (price and context, without explicit tool calling). */
function registryLiveModels(ctx: ExtensionContext): LiveModel[] {
	return ctx.modelRegistry.getModelsOfType("chat", "openrouter").map((model) => {
		const prompt = model.cost.input;
		const completion = model.cost.output;
		return {
			id: model.id,
			name: model.name,
			prompt,
			completion,
			peakPrompt: prompt,
			peakCompletion: completion,
			blended: blendCost(prompt, completion),
			context: model.contextWindow,
			tools: true,
			reasoning: model.reasoning,
			vision: model.input.includes("image"),
			created: 0,
			canonical: model.id,
			chat: true,
			expired: false,
		};
	});
}

function catalogCachePath(): string {
	return join(getAgentDir(), CATALOG_CACHE_FILE);
}

function readCatalogCache(): { models: LiveModel[]; fetchedAt: number } | undefined {
	try {
		const parsed = recordOf(JSON.parse(readFileSync(catalogCachePath(), "utf8")));
		const raw = parsed?.models;
		const fetchedAt = numberOf(parsed?.fetchedAt);
		if (!Array.isArray(raw) || fetchedAt === undefined) return undefined;
		const models: LiveModel[] = [];
		for (const item of raw) {
			const record = recordOf(item);
			if (typeof record?.id !== "string") continue;
			const prompt = numberOf(record.prompt);
			const completion = numberOf(record.completion);
			const blended = numberOf(record.blended);
			if (prompt === undefined || completion === undefined || blended === undefined) continue;
			models.push({
				id: record.id,
				name: typeof record.name === "string" ? record.name : record.id,
				prompt,
				completion,
				peakPrompt: numberOf(record.peakPrompt) ?? prompt,
				peakCompletion: numberOf(record.peakCompletion) ?? completion,
				blended,
				context: numberOf(record.context) ?? 0,
				tools: record.tools === true,
				reasoning: record.reasoning === true,
				vision: record.vision === true,
				created: numberOf(record.created) ?? 0,
				canonical: typeof record.canonical === "string" ? record.canonical : record.id,
				chat: record.chat !== false,
				expired: record.expired === true,
			});
		}
		return models.length > 0 ? { models, fetchedAt } : undefined;
	} catch {
		return undefined;
	}
}

function writeCatalogCache(catalog: LiveCatalog): void {
	try {
		writeFileSync(
			catalogCachePath(),
			`${JSON.stringify({ fetchedAt: catalog.fetchedAt, models: catalog.models })}\n`,
			"utf8",
		);
	} catch {
		// Optional cache: a write failure must not break the recommendation.
	}
}

let liveCatalogCache: LiveCatalog | undefined;

async function loadLiveCatalog(ctx: ExtensionContext): Promise<LiveCatalog> {
	if (liveCatalogCache && Date.now() - liveCatalogCache.fetchedAt < CATALOG_TTL_MS) return liveCatalogCache;
	try {
		const response = await fetch(OPENROUTER_MODELS_URL, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const payload = recordOf(await response.json());
		const list = payload?.data;
		if (!Array.isArray(list)) throw new Error("unexpected response");
		const models = list.map(liveModelFromOpenRouter).filter((model): model is LiveModel => model !== undefined);
		if (models.length === 0) throw new Error("empty catalog");
		const catalog: LiveCatalog = { models, fetchedAt: Date.now(), source: "live" };
		liveCatalogCache = catalog;
		writeCatalogCache(catalog);
		return catalog;
	} catch {
		const cached = readCatalogCache();
		if (cached) {
			liveCatalogCache = { ...cached, source: "cache" };
			return liveCatalogCache;
		}
		liveCatalogCache = { models: registryLiveModels(ctx), fetchedAt: Date.now(), source: "registry" };
		return liveCatalogCache;
	}
}

/** Keep one entry per canonical model (the `:free`, `:batch` variants disappear). */
function dedupeLiveModels(models: LiveModel[]): LiveModel[] {
	const byCanonical = new Map<string, LiveModel>();
	for (const model of models) {
		const existing = byCanonical.get(model.canonical);
		if (!existing) {
			byCanonical.set(model.canonical, model);
			continue;
		}
		const aliasA = existing.id.startsWith("~");
		const aliasB = model.id.startsWith("~");
		const preferred =
			aliasA !== aliasB
				? aliasA
					? model
					: existing
				: model.blended < existing.blended || (model.blended === existing.blended && model.id.length < existing.id.length)
					? model
					: existing;
		byCanonical.set(model.canonical, preferred);
	}
	return [...byCanonical.values()];
}

/** Models usable by pi: chat, known price, tool calling, outside the hard exclusions. */
function eligibleLiveModels(models: LiveModel[], excluded: string[]): LiveModel[] {
	return models.filter((model) => {
		if (!model.chat || model.expired) return false;
		// `~author/family-latest` aliases are not real models: their concrete
		// versions are already in the catalog.
		if (model.id.startsWith("~")) return false;
		if (NON_CHAT_VARIANT.test(model.id)) return false;
		if (model.prompt <= 0 || model.completion <= 0) return false;
		if (/^(openrouter|typesafe)\//.test(model.id)) return false;
		if (!model.tools) return false;
		return !excluded.some((pattern) => patternMatches(pattern, model.id));
	});
}

/** Experimental / preview variants: riskier in a fallback list. */
function isExperimental(id: string): boolean {
	return /(?:^|[-_.])(exp|experimental|preview|alpha|beta|dev)(?:$|[-_.])/i.test(id);
}

function capabilityScore(model: LiveModel): number {
	const contextScore = Math.min(1, Math.log2(Math.max(model.context, 8_000) / 8_000) / Math.log2(125));
	let score = 0.46 + (model.reasoning ? 0.16 : 0) + (model.vision ? 0.06 : 0) + 0.32 * contextScore;
	if (model.created > 0) {
		const ageMonths = (Date.now() / 1000 - model.created) / 2_592_000;
		score += 0.06 * Math.max(0, 1 - ageMonths / 18);
	}
	if (isExperimental(model.id)) score -= 0.08;
	return Math.max(0, Math.min(1, score));
}

/** Capability / price ratio, normalized inside a price band. */
function valueScore(model: LiveModel, low: number, high: number): number {
	const position = Math.min(1, Math.max(0, (model.blended - low) / Math.max(high - low, 1e-9)));
	return 0.58 * capabilityScore(model) + 0.42 * (1 - position);
}

function vendorOf(model: LiveModel): string {
	return model.id.replace(/^~/, "").split("/")[0] ?? model.id;
}

function roleFor(blended: number, ceiling: number): RouterRole {
	if (blended <= ceiling * BAND_FLASH) return "flash";
	if (blended <= ceiling * BAND_BALANCED) return "balanced";
	return "power";
}

/** Family of a slug: `vendor/model` without the `~` alias or the dated revision. */
function familyOf(id: string): string {
	return id.replace(/^~/, "").replace(/[-@]\d{4,8}$/, "");
}

/** Flag a candidate that is the current revision of a model already in the list. */
function familyNote(t: Messages, model: LiveModel, allowed: string[], catalog: LiveModel[]): string | undefined {
	const family = familyOf(model.id);
	for (const pattern of allowed) {
		if (patternMatches(pattern, model.id) || familyOf(pattern) !== family) continue;
		const known = catalog.find((item) => patternMatches(pattern, item.id));
		return known
			? t.reasonRevision(pattern, `${known.prompt.toFixed(3)}/${known.completion.toFixed(2)}`)
			: t.reasonRevision(pattern);
	}
	return undefined;
}

function reasonFor(
	t: Messages,
	base: string,
	model: LiveModel,
	allowed: string[],
	catalog: LiveModel[],
): string {
	return [
		base,
		familyNote(t, model, allowed, catalog),
		isExperimental(model.id) ? t.reasonExperimental : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

/** Equal score: the cheapest, then alphabetical order (deterministic ranking). */
function compareCandidates(a: { model: LiveModel; score: number }, b: { model: LiveModel; score: number }): number {
	if (b.score !== a.score) return b.score - a.score;
	if (a.model.blended !== b.model.blended) return a.model.blended - b.model.blended;
	return a.model.id.localeCompare(b.model.id);
}

function recommendModels(
	t: Messages,
	models: LiveModel[],
	allowed: string[],
	excluded: string[],
	tier: NonNullable<RouterConfig["costTier"]>,
): RecommendationResult {
	const eligible = dedupeLiveModels(eligibleLiveModels(models, excluded));
	const isAllowed = (model: LiveModel) => allowed.some((pattern) => patternMatches(pattern, model.id));
	const allowedModels = eligible.filter(isAllowed);
	const dearest = allowedModels.length > 0 ? Math.max(...allowedModels.map((model) => model.blended)) : undefined;
	const listCeiling = dearest === undefined ? DEFAULT_CEILING : Math.max(dearest * 1.1, 0.15);
	const tierCeiling = TIER_CEILING[tier] ?? Number.POSITIVE_INFINITY;
	const ceiling = Math.min(listCeiling, tierCeiling);
	const ceilingBasis =
		tierCeiling < listCeiling
			? `${t.ceilingTier(tier, tierCeiling.toFixed(2))}${
					dearest === undefined
						? t.ceilingTierEmptyListSuffix
						: t.ceilingTierDearestSuffix(dearest.toFixed(2))
				}`
			: dearest === undefined
				? t.ceilingNoList
				: t.ceilingDearest(dearest.toFixed(2));

	// The whole eligible catalog is ranked: an already-allowed model is still a
	// valid recommendation, it is merely flagged as already present.
	const candidates = eligible.filter((model) => model.blended <= ceiling);
	const picks: Recommendation[] = [];
	const seen = new Set<string>();
	const add = (role: RouterRole, model: LiveModel, score: number, reason: string) => {
		if (seen.has(model.canonical)) return;
		seen.add(model.canonical);
		picks.push({ role, model, score: Math.min(1, score), reason, present: isAllowed(model) });
	};

	const bands: Record<RouterRole, LiveModel[]> = { flash: [], balanced: [], power: [] };
	for (const model of candidates) bands[roleFor(model.blended, ceiling)].push(model);

	const bestOfBand = (role: RouterRole): { model: LiveModel; score: number } | undefined => {
		const band = bands[role];
		if (band.length === 0) return undefined;
		const low = Math.min(...band.map((model) => model.blended));
		const high = Math.max(...band.map((model) => model.blended));
		const ranked = band
			.map((model) => {
				// Diversity bonus: avoid three models from the same vendor.
				const diversity = picks.some((pick) => vendorOf(pick.model) === vendorOf(model)) ? 1 : 1.06;
				return { model, score: valueScore(model, low, high) * diversity };
			})
			.sort(compareCandidates);
		return ranked[0];
	};

	for (const role of ["flash", "balanced"] as const) {
		const best = bestOfBand(role);
		if (!best) continue;
		const bandLabel = role === "flash" ? t.bandFlash : t.bandBalanced;
		const limit = (role === "flash" ? ceiling * BAND_FLASH : ceiling * BAND_BALANCED).toFixed(2);
		add(
			role,
			best.model,
			best.score,
			reasonFor(t, t.reasonBand(bandLabel, limit), best.model, allowed, models),
		);
	}

	if (bands.power.length > 0) {
		// High band: maximal capabilities under the ceiling, at the lowest price
		// for equal capabilities (the router only sends demanding requests there).
		const ranked = bands.power.map((model) => ({ model, score: capabilityScore(model) })).sort(compareCandidates);
		const best = ranked[0];
		if (best) {
			add(
				"power",
				best.model,
				best.score,
				reasonFor(t, t.reasonPower(ceiling.toFixed(2)), best.model, allowed, models),
			);
		}
	}

	// Complete the list if a band was empty (exclusions, low ceiling).
	if (picks.length < 3 && candidates.length > 0) {
		const low = Math.min(...candidates.map((model) => model.blended));
		const high = Math.max(...candidates.map((model) => model.blended));
		const ranked = candidates.map((model) => ({ model, score: valueScore(model, low, high) })).sort(compareCandidates);
		for (const item of ranked) {
			if (picks.length >= 3) break;
			add(
				roleFor(item.model.blended, ceiling),
				item.model,
				item.score,
				reasonFor(t, t.reasonFill, item.model, allowed, models),
			);
		}
	}

	const order: RouterRole[] = ["flash", "balanced", "power"];
	picks.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
	return { picks, ceiling, ceilingBasis, candidateCount: candidates.length };
}

function compactContext(model: LiveModel): string {
	return model.context >= 1_000_000
		? `${(model.context / 1_000_000).toFixed(1)}M ctx`
		: `${Math.round(model.context / 1000)}K ctx`;
}

function livePriceLabel(t: Messages, model: LiveModel): string {
	const peak =
		model.peakPrompt !== model.prompt || model.peakCompletion !== model.completion
			? t.peakPrice(model.peakPrompt.toFixed(3), model.peakCompletion.toFixed(2))
			: "";
	return `${model.prompt.toFixed(3)}/${model.completion.toFixed(2)} $/Mtok${peak}`;
}

function liveCapabilitiesLabel(model: LiveModel): string {
	const caps: string[] = [];
	if (model.reasoning) caps.push("think");
	if (model.vision) caps.push("img");
	return caps.join(" ");
}

function recommendationNote(t: Messages, pick: Recommendation): string {
	const caps = [compactContext(pick.model), pick.model.vision ? t.noteVision : t.noteText].join(", ");
	return `${pick.model.prompt.toFixed(3)} / ${pick.model.completion.toFixed(2)} - ${caps} - ${t.noteRecommendation(pick.role)}`;
}

function recommendationReport(
	t: Messages,
	locale: string,
	catalog: LiveCatalog,
	result: RecommendationResult,
): string {
	const freshness =
		catalog.source === "live"
			? t.freshnessLive
			: catalog.source === "cache"
				? t.freshnessCache(new Date(catalog.fetchedAt).toLocaleString(locale))
				: t.freshnessRegistry;
	const lines = [
		t.recTitle(catalog.models.length, freshness),
		t.recCeiling(result.ceiling.toFixed(2), result.ceilingBasis),
		t.recCandidates(result.candidateCount),
		t.recMethod,
	];
	if (result.picks.length === 0) {
		lines.push(t.recNone);
		return lines.join("\n");
	}
	for (const [index, pick] of result.picks.entries()) {
		const caps = liveCapabilitiesLabel(pick.model);
		lines.push(
			`${index + 1}. [${pick.role}] ${pick.model.id}${pick.present ? t.recPresent : ""}`,
			`   ${livePriceLabel(t, pick.model)} - ${compactContext(pick.model)}${caps ? ` - ${caps}` : ""} - ${t.recScore(Math.round(pick.score * 100))}`,
			`   ${pick.reason}`,
		);
	}
	return lines.join("\n");
}

async function recommendForRouter(ctx: ExtensionCommandContext): Promise<void> {
	const { t, language } = translator(ctx.cwd);
	const locale = LOCALE_TAGS[language.language];
	ctx.ui.setStatus("jev-router", t.statusCatalog);
	const catalog = await loadLiveCatalog(ctx);
	ctx.ui.setStatus("jev-router", undefined);
	const { raw } = loadRawConfig(ctx.cwd, t);
	const config = raw as RouterConfig;
	const result = recommendModels(
		t,
		catalog.models,
		patternsOf(config.allowedModels),
		patternsOf(config.excludedModels),
		config.costTier ?? DEFAULT_COST_TIER,
	);
	const report = recommendationReport(t, locale, catalog, result);
	ctx.ui.notify(report, result.picks.length > 0 ? "info" : "warning");
	if (result.picks.length === 0) return;

	const options = result.picks.map((recommendation, index) => {
		const caps = liveCapabilitiesLabel(recommendation.model);
		return `${index + 1}. [${recommendation.role}] ${recommendation.model.id}${recommendation.present ? t.recPresentShort : ""}  -  ${livePriceLabel(t, recommendation.model)}  -  ${compactContext(recommendation.model)}${
			caps ? `  -  ${caps}` : ""
		}  -  ${Math.round(recommendation.score * 100)}/100`;
	});
	const missing = result.picks.filter((recommendation) => !recommendation.present);
	const addAllLabel =
		missing.length > 1
			? t.recAddAllMissing(missing.length)
			: missing.length === 1
				? t.recAddMissingOne
				: t.recAddNothing;

	const choices: Choice[] = result.picks.map((_recommendation, index) => ({
		id: `p${index}`,
		label: options[index] ?? "",
	}));
	choices.push({ id: "all", label: addAllLabel }, { id: "back", label: t.back });

	const picked = await pick(ctx, t.recPickerTitle(result.ceiling.toFixed(2)), choices);
	if (!picked || picked === "back") return;

	if (picked === "all") {
		if (missing.length === 0) {
			ctx.ui.notify(t.recAllPresent, "info");
			return;
		}
		const ok = await ctx.ui.confirm(t.recConfirmAddAll, missing.map((item) => item.model.id).join("\n"));
		if (!ok) return;
		const fresh = loadRawConfig(ctx.cwd, t);
		const list = arrayField(fresh.raw, "allowedModels");
		const existing = patternsOf((fresh.raw as RouterConfig).allowedModels);
		const added: string[] = [];
		for (const item of missing) {
			if (existing.some((pattern) => patternMatches(pattern, item.model.id))) continue;
			list.push({ model: item.model.id, tier: item.role, note: recommendationNote(t, item) });
			existing.push(item.model.id);
			added.push(item.model.id);
		}
		saveRawConfig(fresh.path, fresh.raw);
		ctx.ui.notify(added.length > 0 ? t.recAddedList(added.join(", ")) : t.recAddedNone, "info");
		return;
	}

	const index = Number(picked.slice(1));
	const chosen = result.picks[index];
	if (!chosen) return;
	if (chosen.present) {
		ctx.ui.notify(t.recAlreadyCoveredRole(chosen.model.id, chosen.role), "info");
		return;
	}
	const ok = await ctx.ui.confirm(t.recConfirmAdd(chosen.model.id), recommendationNote(t, chosen));
	if (!ok) return;

	const fresh = loadRawConfig(ctx.cwd, t);
	const list = arrayField(fresh.raw, "allowedModels");
	const existing = patternsOf((fresh.raw as RouterConfig).allowedModels);
	if (existing.some((pattern) => patternMatches(pattern, chosen.model.id))) {
		ctx.ui.notify(t.recAlreadyCovered(chosen.model.id), "info");
		return;
	}
	list.push({ model: chosen.model.id, tier: chosen.role, note: recommendationNote(t, chosen) });
	saveRawConfig(fresh.path, fresh.raw);
	ctx.ui.notify(t.recAddedOne(chosen.model.id, chosen.role), "info");

}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
//
// `ctx.ui.select` returns the chosen *label*, so every menu keeps a stable id
// next to its localized label and dispatches on the id. Translated labels can
// then change, collide across languages or be reordered without breaking the
// control flow.

interface Choice {
	id: string;
	label: string;
}

async function pick(
	ctx: ExtensionCommandContext,
	title: string,
	choices: readonly Choice[],
): Promise<string | undefined> {
	const picked = await ctx.ui.select(
		title,
		choices.map((choice) => choice.label),
	);
	if (picked === undefined) return undefined;
	return choices.find((choice) => choice.label === picked)?.id;
}

/** Ids for model rows are `m<index>`; recover the index. */
function modelIndex(id: string): number | undefined {
	if (!id.startsWith("m")) return undefined;
	const parsed = Number(id.slice(1));
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function addAllowedModel(ctx: ExtensionCommandContext): Promise<void> {
	const { t } = translator(ctx.cwd);
	const query = await ctx.ui.input(t.searchTitle, t.searchPlaceholder);
	if (query === undefined) return;

	const { raw } = loadRawConfig(ctx.cwd, t);
	const config = raw as RouterConfig;
	const allowed = new Set(patternsOf(config.allowedModels));
	const catalog = [...catalogMap(ctx).values()];
	const needle = query.trim().toLowerCase();
	const candidates = catalog
		.filter((model) => !allowed.has(model.id))
		.filter((model) => fuzzyMatch(model, needle))
		.sort(sortByOutputCost)
		.slice(0, 30);

	const choices: Choice[] = candidates.map((model, index) => ({
		id: `m${index}`,
		label: `${index + 1}. ${model.id}  ·  ${priceLabel(model)}  ·  ${contextLabel(model)}${
			capabilitiesLabel(model) ? `  ·  ${capabilitiesLabel(model)}` : ""
		}`,
	}));
	choices.push({ id: "manual", label: t.manualPattern }, { id: "cancel", label: t.cancel });

	const picked = await pick(ctx, t.addModelTitle(candidates.length, query.trim()), choices);
	if (!picked || picked === "cancel") return;

	let entry: string | ModelEntry;
	if (picked === "manual") {
		const pattern = await ctx.ui.input(t.manualPatternTitle, t.manualPatternPlaceholder);
		if (!pattern?.trim()) return;
		entry = pattern.trim();
	} else {
		const index = modelIndex(picked);
		const model = index === undefined ? undefined : candidates[index];
		if (!model) return;
		entry = { model: model.id, note: `${priceLabel(model)} · ${contextLabel(model)}` };
	}

	// Reload after the dialogs: the file may have changed in the meantime.
	const fresh = loadRawConfig(ctx.cwd, t);
	const list = arrayField(fresh.raw, "allowedModels");
	list.push(entry);
	saveRawConfig(fresh.path, fresh.raw);

	const pattern = typeof entry === "string" ? entry : (entry.model ?? "");
	const excludedBy = exclusionFor(pattern, patternsOf((fresh.raw as RouterConfig).excludedModels));
	ctx.ui.notify(
		excludedBy ? t.addedWithExclusion(pattern, excludedBy) : t.added(pattern),
		excludedBy ? "warning" : "info",
	);
}

async function browseCatalog(ctx: ExtensionCommandContext): Promise<void> {
	const { t } = translator(ctx.cwd);
	const query = await ctx.ui.input(t.browseTitle, t.browsePlaceholder);
	if (query === undefined) return;

	const needle = query.trim().toLowerCase();
	const models = [...catalogMap(ctx).values()].filter((model) => fuzzyMatch(model, needle)).sort(sortByOutputCost).slice(0, 40);
	const choices: Choice[] = models.map((model, index) => ({
		id: `m${index}`,
		label: `${index + 1}. ${model.id}  ·  ${priceLabel(model)}  ·  ${contextLabel(model)}${
			capabilitiesLabel(model) ? `  ·  ${capabilitiesLabel(model)}` : ""
		}`,
	}));
	choices.push({ id: "back", label: t.back });

	const picked = await pick(ctx, t.browseResults(models.length, query.trim() || t.all), choices);
	if (!picked || picked === "back") return;

	const index = modelIndex(picked);
	const model = index === undefined ? undefined : models[index];
	if (!model) return;
	ctx.ui.notify(catalogDetails(t, model), "info");

	const add = await ctx.ui.confirm(t.addToAllowedConfirm, model.id);
	if (!add) return;
	const fresh = loadRawConfig(ctx.cwd, t);
	const list = arrayField(fresh.raw, "allowedModels");
	if (!patternsOf((fresh.raw as RouterConfig).allowedModels).includes(model.id)) {
		list.push({ model: model.id, note: `${priceLabel(model)} · ${contextLabel(model)}` });
		saveRawConfig(fresh.path, fresh.raw);
		ctx.ui.notify(t.added(model.id), "info");
	}
}

async function manageAllowedModels(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const { t } = translator(ctx.cwd);
		const { raw, path } = loadRawConfig(ctx.cwd, t);
		const config = raw as RouterConfig;
		const catalog = catalogMap(ctx);
		const excluded = patternsOf(config.excludedModels);
		const source = config.allowedModels ?? [];
		const entries = source
			.map((entry, rawIndex) => ({ entry, rawIndex, pattern: patternOf(entry) }))
			.filter((item) => item.pattern);

		const choices: Choice[] = entries.map((item, index) => {
			const catalogModel = catalog.get(item.pattern);
			const excludedBy = isConcrete(item.pattern) ? exclusionFor(item.pattern, excluded) : undefined;
			let details: string;
			if (catalogModel) {
				details = `${priceLabel(catalogModel)} · ${contextLabel(catalogModel)}`;
			} else if (item.pattern.includes("*") || item.pattern.startsWith("~")) {
				details = t.entryPattern;
			} else {
				details = t.entryNotInCatalog;
			}
			const marker = excludedBy ? "✖" : "✔";
			const suffix = excludedBy ? `  ·  ${t.excludedBy(excludedBy)}` : "";
			return { id: `m${index}`, label: `${index + 1}. ${marker} ${item.pattern}  ·  ${details}${suffix}` };
		});
		choices.push({ id: "add", label: t.addModelEntry }, { id: "back", label: t.back });

		const picked = await pick(ctx, t.allowedMenuTitle(entries.length, path), choices);
		if (!picked || picked === "back") return;
		if (picked === "add") {
			await addAllowedModel(ctx);
			continue;
		}

		const index = modelIndex(picked);
		const item = index === undefined ? undefined : entries[index];
		if (!item) continue;

		const action = await pick(ctx, item.pattern, [
			{ id: "remove", label: t.actionRemove },
			{ id: "up", label: t.actionMoveUp },
			{ id: "down", label: t.actionMoveDown },
			{ id: "note", label: t.actionEditNote },
			{ id: "details", label: t.actionDetails },
			{ id: "back", label: t.back },
		]);
		if (!action || action === "back") continue;

		if (action === "details") {
			const model = catalog.get(item.pattern);
			ctx.ui.notify(model ? catalogDetails(t, model) : t.absentFromCatalog(item.pattern), "info");
			continue;
		}

		const fresh = loadRawConfig(ctx.cwd, t);
		const list = (fresh.raw as RouterConfig).allowedModels ?? [];
		const rawIndex = item.rawIndex;

		if (action === "remove") {
			const ok = await ctx.ui.confirm(t.removeModelConfirm, item.pattern);
			if (!ok) continue;
			list.splice(rawIndex, 1);
		} else if (action === "up") {
			if (rawIndex <= 0) continue;
			const previous = list[rawIndex - 1];
			const current = list[rawIndex];
			if (previous === undefined || current === undefined) continue;
			list[rawIndex - 1] = current;
			list[rawIndex] = previous;
		} else if (action === "down") {
			if (rawIndex >= list.length - 1) continue;
			const next = list[rawIndex + 1];
			const current = list[rawIndex];
			if (next === undefined || current === undefined) continue;
			list[rawIndex + 1] = current;
			list[rawIndex] = next;
		} else if (action === "note") {
			const current = list[rawIndex];
			const base: ModelEntry = typeof current === "string" ? { model: current } : { ...current };
			const note = await ctx.ui.input(t.noteTitle, base.note ?? "");
			if (note === undefined) continue;
			list[rawIndex] = { ...base, note };
		}

		saveRawConfig(fresh.path, fresh.raw);
		ctx.ui.notify(t.configSaved, "info");
	}
}

async function manageExclusions(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const { t } = translator(ctx.cwd);
		const { raw, path } = loadRawConfig(ctx.cwd, t);
		const config = raw as RouterConfig;
		const excluded = patternsOf(config.excludedModels);
		const choices: Choice[] = excluded.map((pattern, index) => ({
			id: `m${index}`,
			label: `${index + 1}. ${pattern}`,
		}));
		choices.push({ id: "add", label: t.addExclusionEntry }, { id: "back", label: t.back });

		const picked = await pick(ctx, t.exclusionsMenuTitle(excluded.length, path), choices);
		if (!picked || picked === "back") return;

		if (picked === "add") {
			const pattern = await ctx.ui.input(t.newExclusionTitle, t.newExclusionPlaceholder);
			if (!pattern?.trim()) continue;
			const fresh = loadRawConfig(ctx.cwd, t);
			arrayField(fresh.raw, "excludedModels").push(pattern.trim());
			saveRawConfig(fresh.path, fresh.raw);
			ctx.ui.notify(t.exclusionAdded(pattern.trim()), "info");
			continue;
		}

		const index = modelIndex(picked);
		const pattern = index === undefined ? undefined : excluded[index];
		if (pattern === undefined) continue;
		const ok = await ctx.ui.confirm(t.removeExclusionConfirm, pattern);
		if (!ok) continue;
		const fresh = loadRawConfig(ctx.cwd, t);
		const list = arrayField(fresh.raw, "excludedModels");
		const rawIndex = patternsOf((fresh.raw as RouterConfig).excludedModels).indexOf(pattern);
		if (rawIndex >= 0) list.splice(rawIndex, 1);
		saveRawConfig(fresh.path, fresh.raw);
		ctx.ui.notify(t.exclusionRemoved(pattern), "info");
	}
}

async function manageLanguage(ctx: ExtensionCommandContext): Promise<void> {
	const { t } = translator(ctx.cwd);
	const choices: Choice[] = [
		{ id: "auto", label: t.languageAuto },
		...LANGUAGES.map((code) => ({ id: code, label: LANGUAGE_NAMES[code] })),
		{ id: "cancel", label: t.cancel },
	];
	const picked = await pick(ctx, t.languageTitle, choices);
	if (!picked || picked === "cancel") return;

	const fresh = loadRawConfig(ctx.cwd, t);
	fresh.raw.language = picked === "auto" ? "auto" : picked;
	saveRawConfig(fresh.path, fresh.raw);
	invalidateLanguage();

	// Confirm in the language that was just selected.
	const next = translator(ctx.cwd);
	ctx.ui.notify(
		picked === "auto"
			? next.t.languageChanged(languageLabel(next.t, next.language))
			: getMessages(picked as Language).languageChanged(LANGUAGE_NAMES[picked as Language]),
		"info",
	);
}

async function manageRouter(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const { t, language } = translator(ctx.cwd);
		const { raw, path, missing } = loadRawConfig(ctx.cwd, t);
		const config = raw as RouterConfig;
		const allowed = patternsOf(config.allowedModels);
		const excluded = patternsOf(config.excludedModels);
		const tier = config.costTier ?? DEFAULT_COST_TIER;
		const enabled = config.enabled !== false;

		const choice = await pick(ctx, t.routerMenuTitle(path, missing), [
			{ id: "allowed", label: t.menuAllowed(allowed.length) },
			{ id: "add", label: t.menuAddModel },
			{ id: "exclusions", label: t.menuExclusions(excluded.length) },
			{ id: "tier", label: t.menuTier(tier) },
			{ id: "enabled", label: t.menuEnabled(enabled) },
			{ id: "recommend", label: t.menuRecommend },
			{ id: "browse", label: t.menuBrowse },
			{ id: "show", label: t.menuShow },
			{ id: "language", label: t.menuLanguage(languageLabel(t, language)) },
			{ id: "close", label: t.menuClose },
		]);
		if (!choice || choice === "close") return;

		try {
			if (choice === "allowed") {
				await manageAllowedModels(ctx);
			} else if (choice === "add") {
				await addAllowedModel(ctx);
			} else if (choice === "exclusions") {
				await manageExclusions(ctx);
			} else if (choice === "tier") {
				const pickedTier = await pick(ctx, t.tierTitle, [
					{ id: "low", label: "low" },
					{ id: "medium", label: "medium" },
					{ id: "high", label: "high" },
					{ id: "cancel", label: t.cancel },
				]);
				if (!pickedTier || pickedTier === "cancel") continue;
				raw.costTier = pickedTier as NonNullable<RouterConfig["costTier"]>;
				saveRawConfig(path, raw);
				ctx.ui.notify(t.tierChanged(pickedTier), "info");
			} else if (choice === "enabled") {
				raw.enabled = !(raw.enabled !== false);
				saveRawConfig(path, raw);
				ctx.ui.notify(t.routerToggled(raw.enabled === true), "info");
			} else if (choice === "recommend") {
				await recommendForRouter(ctx);
			} else if (choice === "browse") {
				await browseCatalog(ctx);
			} else if (choice === "show") {
				ctx.ui.notify(describe(t, language, config, path, missing), "info");
			} else if (choice === "language") {
				await manageLanguage(ctx);
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
}

export default function (pi: ExtensionAPI) {
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

	// The router declares a zero cost: bill the message at the physical model's tariff.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (!message.responseModel || message.responseModel === message.model) return;
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
				ctx.ui.notify(describe(t, language, resolved.config, resolved.path, resolved.missing), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
