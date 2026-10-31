/**
 * The OpenRouter model catalog: live prices, eligibility rules, scoring, and the
 * 3-model recommendation (flash / balanced / power).
 *
 * Two sources, same shape:
 *   - `loadLiveCatalog()` fetches https://openrouter.ai/api/v1/models, cached in
 *     memory and on disk, with the local Pi catalog as an offline fallback. Used
 *     by the interactive commands, never on the request path.
 *   - `registryLiveModels()` reads Pi's local catalog. Instant, so the router
 *     (router.ts) can score candidates before every request without doing I/O.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { TIER_CEILING, patternMatches, type RouterConfig } from "./config.ts";
import type { Messages } from "./i18n.ts";

export function catalogMap(ctx: ExtensionContext): Map<string, Model<string>> {
	const map = new Map<string, Model<string>>();
	for (const model of ctx.modelRegistry.getModelsOfType("chat", "openrouter")) {
		map.set(model.id, model as Model<string>);
	}
	return map;
}

export function priceLabel(model: Model<string>): string {
	const { input, output } = model.cost;
	return `${input.toFixed(3)}/${output.toFixed(2)} $/Mtok`;
}

export function contextLabel(model: Model<string>): string {
	return `${Math.round(model.contextWindow / 1000)}K ctx`;
}

export function capabilitiesLabel(model: Model<string>): string {
	const caps: string[] = [];
	if (model.reasoning) caps.push("think");
	if (model.input.includes("image")) caps.push("img");
	return caps.join(" ");
}

/** An exact OpenRouter pattern also covers dated revisions of that slug. */

export function fuzzyMatch(model: Model<string>, needle: string): boolean {
	if (!needle) return true;
	return model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle);
}

export function sortByOutputCost(a: Model<string>, b: Model<string>): number {
	return a.cost.output - b.cost.output || a.id.localeCompare(b.id);
}

/** Detail block for a registry (offline) model. */
export function catalogDetails(t: Messages, model: Model<string>): string {
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
const BAND_FLASH = 0.12;
const BAND_BALANCED = 0.45;
const NON_CHAT_VARIANT = /:(free|batch|online|extended)\b/i;
const CATALOG_CACHE_FILE = "jev-router-catalog.json";

export interface LiveModel {
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

export interface LiveCatalog {
	models: LiveModel[];
	fetchedAt: number;
	source: "live" | "cache" | "registry";
}

export type RouterRole = "flash" | "balanced" | "power";

export interface Recommendation {
	role: RouterRole;
	model: LiveModel;
	score: number;
	reason: string;
	/** Already covered by a pattern in `allowedModels`. */
	present: boolean;
}

export interface RecommendationResult {
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
export function blendCost(prompt: number, completion: number): number {
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
export function registryLiveModels(ctx: ExtensionContext): LiveModel[] {
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

export async function loadLiveCatalog(ctx: ExtensionContext): Promise<LiveCatalog> {
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
export function dedupeLiveModels(models: LiveModel[]): LiveModel[] {
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
export function eligibleLiveModels(models: LiveModel[], excluded: string[]): LiveModel[] {
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
export function isExperimental(id: string): boolean {
	return /(?:^|[-_.])(exp|experimental|preview|alpha|beta|dev)(?:$|[-_.])/i.test(id);
}

export function capabilityScore(model: LiveModel): number {
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
export function valueScore(model: LiveModel, low: number, high: number): number {
	const position = Math.min(1, Math.max(0, (model.blended - low) / Math.max(high - low, 1e-9)));
	return 0.58 * capabilityScore(model) + 0.42 * (1 - position);
}

export function vendorOf(model: LiveModel): string {
	return model.id.replace(/^~/, "").split("/")[0] ?? model.id;
}

export function roleFor(blended: number, ceiling: number): RouterRole {
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

/**
 * The cost ceiling shared by the recommendation and the router: never recommend or
 * route to a model clearly more expensive than the dearest accepted one, and never
 * above what the cost tier allows. Both paths must agree, so both call this.
 */
export interface Ceiling {
	ceiling: number;
	listCeiling: number;
	tierCeiling: number;
	dearest: number | undefined;
}

export function ceilingFor(
	models: LiveModel[],
	allowed: string[],
	tier: NonNullable<RouterConfig["costTier"]>,
): Ceiling {
	const accepted =
		allowed.length === 0
			? []
			: models.filter((model) => allowed.some((pattern) => patternMatches(pattern, model.id)));
	const dearest = accepted.length > 0 ? Math.max(...accepted.map((model) => model.blended)) : undefined;
	const listCeiling = dearest === undefined ? DEFAULT_CEILING : Math.max(dearest * 1.1, 0.15);
	const tierCeiling = TIER_CEILING[tier] ?? Number.POSITIVE_INFINITY;
	return { ceiling: Math.min(listCeiling, tierCeiling), listCeiling, tierCeiling, dearest };
}

/** Equal score: the cheapest, then alphabetical order (deterministic ranking). */
export function compareCandidates(a: { model: LiveModel; score: number }, b: { model: LiveModel; score: number }): number {
	if (b.score !== a.score) return b.score - a.score;
	if (a.model.blended !== b.model.blended) return a.model.blended - b.model.blended;
	return a.model.id.localeCompare(b.model.id);
}

export function recommendModels(
	t: Messages,
	models: LiveModel[],
	allowed: string[],
	excluded: string[],
	tier: NonNullable<RouterConfig["costTier"]>,
): RecommendationResult {
	const eligible = dedupeLiveModels(eligibleLiveModels(models, excluded));
	const isAllowed = (model: LiveModel) => allowed.some((pattern) => patternMatches(pattern, model.id));
	const { ceiling, listCeiling, tierCeiling, dearest } = ceilingFor(eligible, allowed, tier);
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

export function compactContext(model: LiveModel): string {
	return model.context >= 1_000_000
		? `${(model.context / 1_000_000).toFixed(1)}M ctx`
		: `${Math.round(model.context / 1000)}K ctx`;
}

export function livePriceLabel(t: Messages, model: LiveModel): string {
	const peak =
		model.peakPrompt !== model.prompt || model.peakCompletion !== model.completion
			? t.peakPrice(model.peakPrompt.toFixed(3), model.peakCompletion.toFixed(2))
			: "";
	return `${model.prompt.toFixed(3)}/${model.completion.toFixed(2)} $/Mtok${peak}`;
}

export function liveCapabilitiesLabel(model: LiveModel): string {
	const caps: string[] = [];
	if (model.reasoning) caps.push("think");
	if (model.vision) caps.push("img");
	return caps.join(" ");
}

export function recommendationNote(t: Messages, pick: Recommendation): string {
	const caps = [compactContext(pick.model), pick.model.vision ? t.noteVision : t.noteText].join(", ");
	return `${pick.model.prompt.toFixed(3)} / ${pick.model.completion.toFixed(2)} - ${caps} - ${t.noteRecommendation(pick.role)}`;
}

export function recommendationReport(
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
