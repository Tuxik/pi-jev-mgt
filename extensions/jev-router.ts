/**
 * Jev Router - routeur OpenRouter `typesafe/jev-router` restreint a une liste de modeles,
 * avec un gestionnaire interactif directement dans pi.
 *
 * Le routeur OpenRouter accepte un plugin `jev-router` dans le corps de la requete :
 *   plugins: [{ id: "jev-router", cost_tier, models, excluded_models }]
 *
 * Cette extension injecte ce plugin sur chaque requete envoyee au modele configurable
 * (par defaut `typesafe/jev-router`) a partir du fichier :
 *
 *   <cwd>/.pi/jev-router.json          (override projet, optionnel)
 *   ~/.pi/agent/jev-router.json        (config globale)
 *   $PI_JEV_ROUTER_CONFIG              (chemin explicite, prioritaire)
 *
 * La config est relue quand le fichier change : pas besoin de /reload.
 *
 * Commandes :
 *   /jev-models   gestionnaire interactif : voir, ajouter, retirer, reordonner les
 *                 modeles autorises, gerer les exclusions et le cost tier, explorer
 *                 le catalogue OpenRouter. Les modifications sont ecrites dans la config.
 *   /jev-router   affiche la config effective (version texte, non interactive)
 *   /jev-recommend  interroge le catalogue OpenRouter en direct et propose les 3
 *                 modeles les plus adaptes au routeur (flash / balanced / power),
 *                 avec possibilite de les ajouter a la liste autorisee.
 *
 * Rappel OpenRouter :
 *   - `models` / `allowed_models` = preferences avec repli : si aucun modele du pool
 *     n'est eligible, le routeur reessaie sans la liste.
 *   - `excluded_models` = exclusion dure, jamais ignoree.
 * D'ou la liste `excludedModels` par defaut qui sert de garde-fou sur les modeles chers.
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

interface ModelEntry {
	/** Slug OpenRouter (exact, date, wildcard ou alias `~auteur/famille-latest`). */
	model?: string;
	/** Alias de `model`, accepte pour la lisibilite. */
	pattern?: string;
	tier?: string;
	/** Notes libres, purement documentaires. */
	note?: string;
}

interface RouterConfig {
	enabled?: boolean;
	routerModel?: string;
	costTier?: "low" | "medium" | "high";
	allowedModels?: Array<string | ModelEntry>;
	excludedModels?: Array<string | ModelEntry>;
}

/** Objet JSON brut du fichier de config, pour preserver les cles inconnues. */
type RawConfig = Record<string, unknown>;

const DEFAULT_ROUTER_MODEL = "typesafe/jev-router";
const DEFAULT_COST_TIER: NonNullable<RouterConfig["costTier"]> = "medium";
const COST_TIERS = new Set(["low", "medium", "high"]);
const MANUAL_PATTERN = "\u270e Saisir un motif manuellement\u2026";

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

let cache: { path: string; mtimeMs: number; config: RouterConfig } | undefined;

function resolveConfig(cwd: string): { config: RouterConfig; path: string; missing: boolean } {
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
			throw new Error(`Config Jev Router invalide (${path}): ${message}`);
		}
	}
	return { config: FALLBACK, path: candidates.at(-1) ?? join(getAgentDir(), "jev-router.json"), missing: true };
}

function patternOf(entry: string | ModelEntry): string {
	if (typeof entry === "string") return entry.trim();
	return (entry?.model ?? entry?.pattern ?? "").trim();
}

function patternsOf(entries: Array<string | ModelEntry> | undefined): string[] {
	return (entries ?? []).map(patternOf).filter(Boolean);
}

/** Chemin a ecrire : la config resolue, sinon la config globale. */
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

function loadRawConfig(cwd: string): { raw: RawConfig; path: string; missing: boolean } {
	const path = configPathForWrite(cwd);
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`Config Jev Router invalide (${path}): la racine doit etre un objet JSON`);
		}
		return { raw: parsed as RawConfig, path, missing: false };
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
}

function saveRawConfig(path: string, raw: RawConfig): void {
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	cache = undefined;
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

/** Corps JSON d'une requete provider, apres verification a la frontiere. */
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

/** Modele physique reellement utilise, a partir du `responseModel` renvoye par OpenRouter. */
function resolveRoutedModel(
	ctx: ExtensionContext,
	provider: string,
	responseModel: string,
): Model<string> | undefined {
	const exact = ctx.modelRegistry.find(provider, responseModel);
	if (exact) return exact;
	// Le routeur renvoie souvent une revision datee, ex. `anthropic/claude-haiku-5.5-20261007`.
	let best: Model<string> | undefined;
	for (const model of ctx.modelRegistry.getModelsOfType("chat", provider)) {
		if (responseModel !== model.id && !responseModel.startsWith(`${model.id}-`)) continue;
		if (!best || model.id.length > best.id.length) best = model as Model<string>;
	}
	return best;
}

/** Recalcule le cout d'un message avec le tarif du modele route (le routeur declare 0 $/Mtok). */
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

function describe(config: RouterConfig, path: string, missing: boolean): string {
	const enabled = config.enabled !== false;
	const routerModel = config.routerModel ?? DEFAULT_ROUTER_MODEL;
	const tier = config.costTier ?? DEFAULT_COST_TIER;
	const lines = [
		`Jev Router: ${routerModel} (${enabled ? "actif" : "desactive"}), cost_tier=${tier}`,
		`Config: ${path}${missing ? " (absent -> valeurs par defaut)" : ""}`,
	];
	const allowed = config.allowedModels ?? [];
	if (allowed.length === 0) {
		lines.push("Modeles autorises: (aucune restriction)");
	} else {
		lines.push(`Modeles autorises (${allowed.length}):`);
		for (const entry of allowed) {
			const pattern = patternOf(entry);
			if (!pattern) continue;
			const meta = typeof entry === "string" ? "" : [entry.tier, entry.note].filter(Boolean).join(" - ");
			lines.push(`  - ${pattern}${meta ? `  (${meta})` : ""}`);
		}
	}
	const excluded = patternsOf(config.excludedModels);
	lines.push(
		excluded.length > 0 ? `Exclusions dures (${excluded.length}): ${excluded.join(", ")}` : "Exclusions dures: aucune",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Aides catalogue / motifs
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

/** Un motif exact OpenRouter couvre aussi les revisions datees de ce slug. */
function patternMatches(pattern: string, modelId: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	const suffix = pattern.includes("*") ? "" : "(?:-\\d{4,8})?";
	try {
		return new RegExp(`^${escaped}${suffix}$`).test(modelId);
	} catch {
		return false;
	}
}

/** Un motif concret peut etre compare aux exclusions ; un wildcard/alias non. */
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

// ---------------------------------------------------------------------------
// Recommandation : 3 modeles adaptes au routeur, d'apres le catalogue live
// ---------------------------------------------------------------------------
//
// Le routeur choisit un modele par requete : la liste autorisee doit couvrir
// trois registres complementaires (flash / balanced / power). On note les
// candidats a partir du catalogue OpenRouter en direct (prix du moment,
// contexte, tool-calling, raisonnement, vision) au lieu de notes figees.
//
// Le plafond de cout est deduit de la liste actuelle : on ne recommande jamais
// un modele nettement plus cher que le modele le plus cher deja accepte.

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CEILING = 3;
/** Plafond de cout ($/Mtok melange) induit par le cost_tier du routeur. */
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
	/** $/Mtok (tarif de base). */
	prompt: number;
	/** $/Mtok (tarif de base). */
	completion: number;
	/** $/Mtok, tarif de pointe s'il en existe (overrides OpenRouter). */
	peakPrompt: number;
	/** $/Mtok, tarif de pointe s'il en existe (overrides OpenRouter). */
	peakCompletion: number;
	/** $/Mtok, melange entree/sortie au tarif le plus eleve. */
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
	/** Deja couvert par un motif de `allowedModels`. */
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

/** Cout melange : la sortie pese plus lourd que l'entree dans la facture. */
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
	// Certains modeles facturent plus cher aux heures de pointe (`pricing.overrides`) :
	// on retient le tarif le plus eleve pour ne pas sous-estimer le plafond de cout.
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

/** Repli hors ligne : le catalogue pi local (prix et contexte, sans tool-calling explicite). */
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
		// Cache optionnel : un echec d'ecriture ne doit pas casser la recommandation.
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
		if (!Array.isArray(list)) throw new Error("reponse inattendue");
		const models = list.map(liveModelFromOpenRouter).filter((model): model is LiveModel => model !== undefined);
		if (models.length === 0) throw new Error("catalogue vide");
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

/** Garde une seule entree par modele canonique (les variantes `:free`, `:batch` disparaissent). */
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

/** Modeles utilisables par pi : chat, prix connu, tool-calling, hors exclusions dures. */
function eligibleLiveModels(models: LiveModel[], excluded: string[]): LiveModel[] {
	return models.filter((model) => {
		if (!model.chat || model.expired) return false;
		// Les alias `~auteur/famille-latest` ne sont pas des modeles a proprement parler :
		// leurs versions concretes sont deja dans le catalogue.
		if (model.id.startsWith("~")) return false;
		if (NON_CHAT_VARIANT.test(model.id)) return false;
		if (model.prompt <= 0 || model.completion <= 0) return false;
		if (/^(openrouter|typesafe)\//.test(model.id)) return false;
		if (!model.tools) return false;
		return !excluded.some((pattern) => patternMatches(pattern, model.id));
	});
}

/** Variantes experimentales / preview : plus risquees dans une liste de repli. */
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

/** Rapport capacites / prix, normalise a l'interieur d'une bande de prix. */
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

/** Famille d'un slug : `vendor/modele` sans alias `~` ni revision datee. */
function familyOf(id: string): string {
	return id.replace(/^~/, "").replace(/[-@]\d{4,8}$/, "");
}

/** Signale qu'un candidat est la revision courante d'un modele deja present dans la liste. */
function familyNote(model: LiveModel, allowed: string[], catalog: LiveModel[]): string | undefined {
	const family = familyOf(model.id);
	for (const pattern of allowed) {
		if (patternMatches(pattern, model.id) || familyOf(pattern) !== family) continue;
		const known = catalog.find((item) => patternMatches(pattern, item.id));
		return known
			? `Revision actuelle de ${pattern} (${known.prompt.toFixed(3)}/${known.completion.toFixed(2)} $/Mtok) : verifier si elle remplace l'ancienne.`
			: `Revision actuelle de ${pattern} : verifier si elle remplace l'ancienne.`;
	}
	return undefined;
}

function reasonFor(base: string, model: LiveModel, allowed: string[], catalog: LiveModel[]): string {
	return [
		base,
		familyNote(model, allowed, catalog),
		isExperimental(model.id) ? "Variante experimentale : verifier la stabilite avant de compter dessus." : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

/** A score egal : le moins cher, puis l'ordre alphabetique (classement deterministe). */
function compareCandidates(a: { model: LiveModel; score: number }, b: { model: LiveModel; score: number }): number {
	if (b.score !== a.score) return b.score - a.score;
	if (a.model.blended !== b.model.blended) return a.model.blended - b.model.blended;
	return a.model.id.localeCompare(b.model.id);
}

function recommendModels(
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
			? `cost_tier ${tier} plafonne a ${tierCeiling.toFixed(2)} $/Mtok${
					dearest === undefined
						? " (liste vide : plafond par defaut)"
						: ` (modele le plus cher de la liste : ${dearest.toFixed(2)} $/Mtok)`
				}`
			: dearest === undefined
				? "aucun modele de la liste retrouve dans le catalogue, plafond par defaut"
				: `modele le plus cher de la liste (${dearest.toFixed(2)} $/Mtok) + 10 %`;

	// On classe tout le catalogue eligible : un modele deja autorise reste une
	// recommandation valable, il est simplement marque comme deja present.
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
				// Bonus de diversite : eviter trois modeles du meme editeur.
				const diversity = picks.some((pick) => vendorOf(pick.model) === vendorOf(model)) ? 1 : 1.06;
				return { model, score: valueScore(model, low, high) * diversity };
			})
			.sort(compareCandidates);
		return ranked[0];
	};

	for (const role of ["flash", "balanced"] as const) {
		const best = bestOfBand(role);
		if (!best) continue;
		const bandLabel = role === "flash" ? "Bande flash" : "Bande equilibree";
		const limit = (role === "flash" ? ceiling * BAND_FLASH : ceiling * BAND_BALANCED).toFixed(2);
		add(
			role,
			best.model,
			best.score,
			reasonFor(`${bandLabel} (<= ${limit} $/Mtok) : meilleur rapport capacites/prix.`, best.model, allowed, models),
		);
	}

	if (bands.power.length > 0) {
		// Bande haute : capacites maximales sous le plafond, au tarif le plus bas a
		// capacites egales (le routeur n'y envoie que les demandes qui en ont besoin).
		const ranked = bands.power.map((model) => ({ model, score: capabilityScore(model) })).sort(compareCandidates);
		const best = ranked[0];
		if (best) {
			add(
				"power",
				best.model,
				best.score,
				reasonFor(
					`Bande haute (<= ${ceiling.toFixed(2)} $/Mtok) : capacites maximales, au prix le plus bas a capacites egales.`,
					best.model,
					allowed,
					models,
				),
			);
		}
	}

	// Completer si une bande etait vide (exclusions, plafond bas).
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
				reasonFor("Complement du classement (bande incomplete).", item.model, allowed, models),
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

function livePriceLabel(model: LiveModel): string {
	const peak =
		model.peakPrompt !== model.prompt || model.peakCompletion !== model.completion
			? ` (pointe ${model.peakPrompt.toFixed(3)}/${model.peakCompletion.toFixed(2)})`
			: "";
	return `${model.prompt.toFixed(3)}/${model.completion.toFixed(2)} $/Mtok${peak}`;
}

function liveCapabilitiesLabel(model: LiveModel): string {
	const caps: string[] = [];
	if (model.reasoning) caps.push("think");
	if (model.vision) caps.push("img");
	return caps.join(" ");
}

function recommendationNote(pick: Recommendation): string {
	const caps = [compactContext(pick.model), pick.model.vision ? "vision" : "texte"].join(", ");
	return `${pick.model.prompt.toFixed(3)} / ${pick.model.completion.toFixed(2)} - ${caps} - reco live (${pick.role})`;
}

function recommendationReport(catalog: LiveCatalog, result: RecommendationResult): string {
	const freshness =
		catalog.source === "live"
			? "live"
			: catalog.source === "cache"
				? `cache du ${new Date(catalog.fetchedAt).toLocaleString("fr-FR")}`
				: "catalogue pi local (hors ligne)";
	const lines = [
		`Recommandations jev-router - ${catalog.models.length} modeles (${freshness})`,
		`Plafond de cout : ${result.ceiling.toFixed(2)} $/Mtok melange - ${result.ceilingBasis}`,
		`Candidats eligibles sous le plafond : ${result.candidateCount}`,
		"Classement heuristique : prix du moment + capacites declarees + contexte (pas un benchmark).",
	];
	if (result.picks.length === 0) {
		lines.push("Aucun candidat : elargir la liste ou alleger les exclusions dures.");
		return lines.join("\n");
	}
	for (const [index, pick] of result.picks.entries()) {
		const caps = liveCapabilitiesLabel(pick.model);
		lines.push(
			`${index + 1}. [${pick.role}] ${pick.model.id}${pick.present ? "  (deja dans la liste)" : ""}`,
			`   ${livePriceLabel(pick.model)} - ${compactContext(pick.model)}${caps ? ` - ${caps}` : ""} - score ${Math.round(pick.score * 100)}/100`,
			`   ${pick.reason}`,
		);
	}
	return lines.join("\n");
}

async function recommendForRouter(ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.setStatus("jev-router", "catalogue OpenRouter\u2026");
	const catalog = await loadLiveCatalog(ctx);
	ctx.ui.setStatus("jev-router", undefined);
	const { raw } = loadRawConfig(ctx.cwd);
	const config = raw as RouterConfig;
	const result = recommendModels(
		catalog.models,
		patternsOf(config.allowedModels),
		patternsOf(config.excludedModels),
		config.costTier ?? DEFAULT_COST_TIER,
	);
	const report = recommendationReport(catalog, result);
	ctx.ui.notify(report, result.picks.length > 0 ? "info" : "warning");
	if (result.picks.length === 0) return;

	const options = result.picks.map((pick, index) => {
		const caps = liveCapabilitiesLabel(pick.model);
		return `${index + 1}. [${pick.role}] ${pick.model.id}${pick.present ? "  (deja la)" : ""}  -  ${livePriceLabel(pick.model)}  -  ${compactContext(pick.model)}${
			caps ? `  -  ${caps}` : ""
		}  -  ${Math.round(pick.score * 100)}/100`;
	});
	const missing = result.picks.filter((pick) => !pick.present);
	const addAll = `\uff0b Ajouter ${missing.length > 1 ? "les " + missing.length + " manquants" : missing.length === 1 ? "le manquant" : "(rien a ajouter)"}`;
	options.push(addAll, "\u2190 Retour");

	const picked = await ctx.ui.select(`Recommandations jev-router - plafond ${result.ceiling.toFixed(2)} $/Mtok`, options);
	if (!picked || picked === "\u2190 Retour") return;

	if (picked === addAll) {
		if (missing.length === 0) {
			ctx.ui.notify("La liste autorisee contient deja ces trois modeles", "info");
			return;
		}
		const ok = await ctx.ui.confirm("Ajouter ces modeles a la liste autorisee ?", missing.map((pick) => pick.model.id).join("\n"));
		if (!ok) return;
		const fresh = loadRawConfig(ctx.cwd);
		const list = arrayField(fresh.raw, "allowedModels");
		const existing = patternsOf((fresh.raw as RouterConfig).allowedModels);
		const added: string[] = [];
		for (const pick of missing) {
			if (existing.some((pattern) => patternMatches(pattern, pick.model.id))) continue;
			list.push({ model: pick.model.id, tier: pick.role, note: recommendationNote(pick) });
			existing.push(pick.model.id);
			added.push(pick.model.id);
		}
		saveRawConfig(fresh.path, fresh.raw);
		ctx.ui.notify(added.length > 0 ? `Ajoutes : ${added.join(", ")}` : "Aucun ajout (deja couverts)", "info");
		return;
	}

	const pick = result.picks[options.indexOf(picked)];
	if (!pick) return;
	if (pick.present) {
		ctx.ui.notify(`${pick.model.id} est deja couvert par la liste autorisee (${pick.role})`, "info");
		return;
	}
	const ok = await ctx.ui.confirm(`Ajouter ${pick.model.id} ?`, recommendationNote(pick));
	if (!ok) return;

	const fresh = loadRawConfig(ctx.cwd);
	const list = arrayField(fresh.raw, "allowedModels");
	const existing = patternsOf((fresh.raw as RouterConfig).allowedModels);
	if (existing.some((pattern) => patternMatches(pattern, pick.model.id))) {
		ctx.ui.notify(`${pick.model.id} est deja couvert par la liste autorisee`, "info");
		return;
	}
	list.push({ model: pick.model.id, tier: pick.role, note: recommendationNote(pick) });
	saveRawConfig(fresh.path, fresh.raw);
	ctx.ui.notify(`Ajoute : ${pick.model.id} (${pick.role})`, "info");
}

// ---------------------------------------------------------------------------
// Gestionnaire interactif
// ---------------------------------------------------------------------------

async function addAllowedModel(ctx: ExtensionCommandContext): Promise<void> {
	const query = await ctx.ui.input("Rechercher un modele OpenRouter", "glm, kimi, deepseek, qwen\u2026");
	if (query === undefined) return;

	const { raw } = loadRawConfig(ctx.cwd);
	const config = raw as RouterConfig;
	const allowed = new Set(patternsOf(config.allowedModels));
	const catalog = [...catalogMap(ctx).values()];
	const needle = query.trim().toLowerCase();
	const candidates = catalog
		.filter((model) => !allowed.has(model.id))
		.filter((model) => fuzzyMatch(model, needle))
		.sort(sortByOutputCost)
		.slice(0, 30);

	const options = candidates.map(
		(model, index) =>
			`${index + 1}. ${model.id}  \u00b7  ${priceLabel(model)}  \u00b7  ${contextLabel(model)}${
				capabilitiesLabel(model) ? `  \u00b7  ${capabilitiesLabel(model)}` : ""
			}`,
	);
	options.push(MANUAL_PATTERN, "\u2190 Annuler");
	const picked = await ctx.ui.select(
		`Ajouter un modele \u2014 ${candidates.length} resultat(s) pour "${query.trim()}"`,
		options,
	);
	if (!picked || picked === "\u2190 Annuler") return;

	let entry: string | ModelEntry;
	if (picked === MANUAL_PATTERN) {
		const pattern = await ctx.ui.input("Motif OpenRouter", "ex. z-ai/glm-*, ~moonshotai/kimi-latest");
		if (!pattern?.trim()) return;
		entry = pattern.trim();
	} else {
		const model = candidates[options.indexOf(picked)];
		if (!model) return;
		entry = { model: model.id, note: `${priceLabel(model)} \u00b7 ${contextLabel(model)}` };
	}

	// Recharger apres les dialogues : le fichier a pu changer entre-temps.
	const fresh = loadRawConfig(ctx.cwd);
	const list = arrayField(fresh.raw, "allowedModels");
	list.push(entry);
	saveRawConfig(fresh.path, fresh.raw);

	const pattern = typeof entry === "string" ? entry : (entry.model ?? "");
	const excludedBy = exclusionFor(pattern, patternsOf((fresh.raw as RouterConfig).excludedModels));
	ctx.ui.notify(
		excludedBy
			? `Ajoute : ${pattern}. Attention, ce modele est couvert par l'exclusion dure "${excludedBy}" et ne sera pas utilise.`
			: `Ajoute : ${pattern}`,
		excludedBy ? "warning" : "info",
	);
}

async function browseCatalog(ctx: ExtensionCommandContext): Promise<void> {
	const query = await ctx.ui.input("Explorer le catalogue OpenRouter", "filtrer par slug/nom (vide = tout)");
	if (query === undefined) return;

	const needle = query.trim().toLowerCase();
	const models = [...catalogMap(ctx).values()].filter((model) => fuzzyMatch(model, needle)).sort(sortByOutputCost).slice(0, 40);
	const options = models.map(
		(model, index) =>
			`${index + 1}. ${model.id}  \u00b7  ${priceLabel(model)}  \u00b7  ${contextLabel(model)}${
				capabilitiesLabel(model) ? `  \u00b7  ${capabilitiesLabel(model)}` : ""
			}`,
	);
	options.push("\u2190 Retour");
	const picked = await ctx.ui.select(
		`Catalogue \u2014 ${models.length} resultat(s) pour "${query.trim() || "tout"}"`,
		options,
	);
	if (!picked || picked === "\u2190 Retour") return;

	const model = models[options.indexOf(picked)];
	if (!model) return;
	ctx.ui.notify(
		[
			`${model.id}`,
			`${model.name}`,
			`Prix  : ${priceLabel(model)}`,
			`Contexte : ${contextLabel(model)}`,
			`Sortie max : ${Math.round(model.maxTokens / 1000)}K tokens`,
			`Capacites : ${capabilitiesLabel(model) || "texte seul"}`,
		].join("\n"),
		"info",
	);

	const add = await ctx.ui.confirm("Ajouter a la liste autorisee ?", model.id);
	if (!add) return;
	const fresh = loadRawConfig(ctx.cwd);
	const list = arrayField(fresh.raw, "allowedModels");
	if (!patternsOf((fresh.raw as RouterConfig).allowedModels).includes(model.id)) {
		list.push({ model: model.id, note: `${priceLabel(model)} \u00b7 ${contextLabel(model)}` });
		saveRawConfig(fresh.path, fresh.raw);
		ctx.ui.notify(`Ajoute : ${model.id}`, "info");
	}
}

async function manageAllowedModels(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const { raw, path } = loadRawConfig(ctx.cwd);
		const config = raw as RouterConfig;
		const catalog = catalogMap(ctx);
		const excluded = patternsOf(config.excludedModels);
		const source = config.allowedModels ?? [];
		const entries = source
			.map((entry, rawIndex) => ({ entry, rawIndex, pattern: patternOf(entry) }))
			.filter((item) => item.pattern);

		const options = entries.map((item, index) => {
			const catalogModel = catalog.get(item.pattern);
			const excludedBy = isConcrete(item.pattern) ? exclusionFor(item.pattern, excluded) : undefined;
			let details: string;
			if (catalogModel) {
				details = `${priceLabel(catalogModel)} \u00b7 ${contextLabel(catalogModel)}`;
			} else if (item.pattern.includes("*") || item.pattern.startsWith("~")) {
				details = "motif";
			} else {
				details = "hors catalogue";
			}
			const marker = excludedBy ? "\u2716" : "\u2714";
			const suffix = excludedBy ? `  \u00b7  exclu par ${excludedBy}` : "";
			return `${index + 1}. ${marker} ${item.pattern}  \u00b7  ${details}${suffix}`;
		});
		options.push("\uff0b Ajouter un modele\u2026", "\u2190 Retour");

		const picked = await ctx.ui.select(`Modeles autorises (${entries.length}) \u2014 ${path}`, options);
		if (!picked || picked === "\u2190 Retour") return;
		if (picked === "\uff0b Ajouter un modele\u2026") {
			await addAllowedModel(ctx);
			continue;
		}

		const item = entries[options.indexOf(picked)];
		if (!item) continue;

		const action = await ctx.ui.select(item.pattern, [
			"Retirer de la liste",
			"Monter dans la liste",
			"Descendre dans la liste",
			"Modifier la note",
			"Voir les details du catalogue",
			"\u2190 Retour",
		]);
		if (!action || action === "\u2190 Retour") continue;

		if (action === "Voir les details du catalogue") {
			const model = catalog.get(item.pattern);
			ctx.ui.notify(
				model
					? [
							model.id,
							model.name,
							`Prix : ${priceLabel(model)}`,
							`Contexte : ${contextLabel(model)}`,
							`Sortie max : ${Math.round(model.maxTokens / 1000)}K tokens`,
							`Capacites : ${capabilitiesLabel(model) || "texte seul"}`,
						].join("\n")
					: `${item.pattern}\nAbsent du catalogue (wildcard, alias ou modele inconnu).`,
				"info",
			);
			continue;
		}

		const fresh = loadRawConfig(ctx.cwd);
		const list = (fresh.raw as RouterConfig).allowedModels ?? [];
		const rawIndex = item.rawIndex;

		if (action === "Retirer de la liste") {
			const ok = await ctx.ui.confirm("Retirer le modele ?", item.pattern);
			if (!ok) continue;
			list.splice(rawIndex, 1);
		} else if (action === "Monter dans la liste") {
			if (rawIndex <= 0) continue;
			const previous = list[rawIndex - 1];
			const current = list[rawIndex];
			if (previous === undefined || current === undefined) continue;
			list[rawIndex - 1] = current;
			list[rawIndex] = previous;
		} else if (action === "Descendre dans la liste") {
			if (rawIndex >= list.length - 1) continue;
			const next = list[rawIndex + 1];
			const current = list[rawIndex];
			if (next === undefined || current === undefined) continue;
			list[rawIndex + 1] = current;
			list[rawIndex] = next;
		} else if (action === "Modifier la note") {
			const current = list[rawIndex];
			const base: ModelEntry = typeof current === "string" ? { model: current } : { ...current };
			const note = await ctx.ui.input("Note (prix, contexte, usage\u2026)", base.note ?? "");
			if (note === undefined) continue;
			list[rawIndex] = { ...base, note };
		}

		saveRawConfig(fresh.path, fresh.raw);
		ctx.ui.notify("Config enregistree", "info");
	}
}

async function manageExclusions(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const { raw, path } = loadRawConfig(ctx.cwd);
		const config = raw as RouterConfig;
		const excluded = patternsOf(config.excludedModels);
		const options = excluded.map((pattern, index) => `${index + 1}. ${pattern}`);
		options.push("\uff0b Ajouter une exclusion\u2026", "\u2190 Retour");

		const picked = await ctx.ui.select(`Exclusions dures (${excluded.length}) \u2014 ${path}`, options);
		if (!picked || picked === "\u2190 Retour") return;

		if (picked === "\uff0b Ajouter une exclusion\u2026") {
			const pattern = await ctx.ui.input("Nouvelle exclusion", "ex. anthropic/claude-opus*, *:batch*");
			if (!pattern?.trim()) continue;
			const fresh = loadRawConfig(ctx.cwd);
			arrayField(fresh.raw, "excludedModels").push(pattern.trim());
			saveRawConfig(fresh.path, fresh.raw);
			ctx.ui.notify(`Exclusion ajoutee : ${pattern.trim()}`, "info");
			continue;
		}

		const index = options.indexOf(picked);
		const pattern = excluded[index];
		if (pattern === undefined) continue;
		const ok = await ctx.ui.confirm("Retirer cette exclusion ?", pattern);
		if (!ok) continue;
		const fresh = loadRawConfig(ctx.cwd);
		const list = arrayField(fresh.raw, "excludedModels");
		const rawIndex = patternsOf((fresh.raw as RouterConfig).excludedModels).indexOf(pattern);
		if (rawIndex >= 0) list.splice(rawIndex, 1);
		saveRawConfig(fresh.path, fresh.raw);
		ctx.ui.notify(`Exclusion retiree : ${pattern}`, "info");
	}
}

async function manageRouter(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const { raw, path, missing } = loadRawConfig(ctx.cwd);
		const config = raw as RouterConfig;
		const allowed = patternsOf(config.allowedModels);
		const excluded = patternsOf(config.excludedModels);
		const tier = config.costTier ?? DEFAULT_COST_TIER;
		const enabled = config.enabled !== false;

		const choice = await ctx.ui.select(
			`Jev Router \u2014 ${path}${missing ? " (cree a la premiere modification)" : ""}`,
			[
				`Modeles autorises : ${allowed.length}`,
				"Ajouter un modele\u2026",
				`Exclusions dures : ${excluded.length}`,
				`Cost tier : ${tier}`,
				`Routeur : ${enabled ? "actif" : "desactive"}`,
				"Recommander 3 modeles (catalogue live)\u2026",
				"Explorer le catalogue OpenRouter\u2026",
				"Afficher la config effective",
				"Fermer",
			],
		);
		if (!choice || choice === "Fermer") return;

		try {
			if (choice.startsWith("Modeles autorises")) {
				await manageAllowedModels(ctx);
			} else if (choice === "Ajouter un modele\u2026") {
				await addAllowedModel(ctx);
			} else if (choice.startsWith("Exclusions dures")) {
				await manageExclusions(ctx);
			} else if (choice.startsWith("Cost tier")) {
				const picked = await ctx.ui.select("Cost tier (politique du routeur)", [
					"low",
					"medium",
					"high",
					"\u2190 Annuler",
				]);
				if (!picked || picked === "\u2190 Annuler") continue;
				raw.costTier = picked;
				saveRawConfig(path, raw);
				ctx.ui.notify(`cost_tier = ${picked}`, "info");
			} else if (choice.startsWith("Routeur")) {
				raw.enabled = !(raw.enabled !== false);
				saveRawConfig(path, raw);
				ctx.ui.notify(`Routeur ${raw.enabled ? "actif" : "desactive"}`, "info");
			} else if (choice.startsWith("Recommander")) {
				await recommendForRouter(ctx);
			} else if (choice.startsWith("Explorer")) {
				await browseCatalog(ctx);
			} else if (choice.startsWith("Afficher")) {
				ctx.ui.notify(describe(config, path, missing), "info");
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		let resolved: ReturnType<typeof resolveConfig>;
		try {
			resolved = resolveConfig(ctx.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("jev-router", "config invalide");
			ctx.ui.notify(message, "error");
			return event.payload;
		}
		const { config, missing } = resolved;
		if (config.enabled === false) {
			ctx.ui.setStatus("jev-router", "off");
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
			ctx.ui.setStatus("jev-router", "config absente");
			ctx.ui.notify(
				`Jev Router: aucune config trouvee (${resolved.path}). Le routeur n'est pas restreint. Lance /jev-models pour en creer une.`,
				"warning",
			);
			return payload;
		}
		ctx.ui.setStatus("jev-router", `tier ${config.costTier ?? DEFAULT_COST_TIER}`);
		return applyJevRouter(payload, buildPlugin(config));
	});

	// Affiche le modele reellement choisi par le routeur dans la barre de statut.
	let lastStatus: string | undefined;
	pi.on("provider_stream_event", (event, ctx) => {
		if (event.provider !== "openrouter") return;
		let routerModel = DEFAULT_ROUTER_MODEL;
		try {
			routerModel = resolveConfig(ctx.cwd).config.routerModel ?? DEFAULT_ROUTER_MODEL;
		} catch {
			return;
		}
		if (event.model !== routerModel) return;
		const chunk = asProviderPayload(event.data);
		const routed = typeof chunk?.model === "string" && chunk.model !== routerModel ? chunk.model : undefined;
		const status = routed ? `\u2192 ${routed}` : `tier ${DEFAULT_COST_TIER}`;
		if (status === lastStatus) return;
		lastStatus = status;
		ctx.ui.setStatus("jev-router", status);
	});

	// Le routeur declare un cout nul : on facture le message au tarif du modele physique.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (!message.responseModel || message.responseModel === message.model) return;
		const model = resolveRoutedModel(ctx, message.provider, message.responseModel);
		if (!model) return;
		return { message: recost(message, model) };
	});

	pi.registerCommand("jev-models", {
		description: "Gerer les modeles autorises par le routeur typesafe/jev-router",
		handler: async (_args, ctx) => {
			try {
				await manageRouter(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("jev-recommend", {
		description: "Propose les 3 modeles les plus adaptes au routeur, d'apres le catalogue OpenRouter en direct",
		handler: async (_args, ctx) => {
			try {
				await recommendForRouter(ctx);
			} catch (error) {
				ctx.ui.notify(`Recommandation impossible : ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("jev-router", {
		description: "Affiche la config effective du routeur typesafe/jev-router",
		handler: async (_args, ctx) => {
			try {
				const resolved = resolveConfig(ctx.cwd);
				ctx.ui.notify(describe(resolved.config, resolved.path, resolved.missing), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
