/**
 * Configuration, pattern matching and UI-language resolution for pi-jev-mgt.
 *
 * The extension keeps its settings in a plain JSON file that is re-read when it
 * changes, so no `/reload` is needed:
 *
 *   $PI_JEV_ROUTER_CONFIG              explicit path, highest priority
 *   <cwd>/.pi/jev-router.json          optional per-project override
 *   ~/.pi/agent/jev-router.json        global config
 *
 * Unknown keys are preserved on write. This module owns no UI and no routing: it
 * answers "what is the policy right now?" for the router (router.ts), the menus
 * (ui.ts) and the OpenRouter request-body injection (jev-router.ts).
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_LANGUAGE,
	LANGUAGE_NAMES,
	getMessages,
	languageFromEnv,
	parseLanguage,
	type Language,
	type Messages,
} from "./i18n.ts";

export interface ModelEntry {
	/** OpenRouter slug (exact, dated, wildcard or `~author/family-latest` alias). */
	model?: string;
	/** Alias of `model`, accepted for readability. */
	pattern?: string;
	tier?: string;
	/** Free-form notes, purely documentary. */
	note?: string;
}

export interface RouterConfig {
	enabled?: boolean;
	routerModel?: string;
	costTier?: "low" | "medium" | "high";
	/** `"auto"` (or absent) follows the detection chain; a tag pins the UI language. */
	language?: string;
	allowedModels?: Array<string | ModelEntry>;
	excludedModels?: Array<string | ModelEntry>;
}

/** Raw JSON object of the config file, to preserve unknown keys. */
export type RawConfig = Record<string, unknown>;

export const DEFAULT_ROUTER_MODEL = "typesafe/jev-router";
export const DEFAULT_COST_TIER: NonNullable<RouterConfig["costTier"]> = "medium";
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

export interface LanguageResolution {
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

export function currentLanguage(cwd: string): LanguageResolution {
	const signature = languageSignature(cwd);
	if (languageCache?.signature === signature) return languageCache.resolved;
	const resolved = resolveLanguage(cwd);
	languageCache = { signature, resolved };
	return resolved;
}

export function invalidateLanguage(): void {
	languageCache = undefined;
}

/** Translator plus the resolution behind it, for the current working directory. */
export function translator(cwd: string): { t: Messages; language: LanguageResolution } {
	const language = currentLanguage(cwd);
	return { t: getMessages(language.language), language };
}

/**
 * Human-readable language for the UI. When no source pins a language, the
 * active one is still shown next to the "automatic" marker so the menu is not
 * ambiguous.
 */
export function languageLabel(t: Messages, resolution: LanguageResolution): string {
	const name = LANGUAGE_NAMES[resolution.language];
	return resolution.pinned ? name : `${name} — ${t.languageAuto}`;
}

let cache: { path: string; mtimeMs: number; config: RouterConfig } | undefined;

export function resolveConfig(
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

export function patternOf(entry: string | ModelEntry): string {
	if (typeof entry === "string") return entry.trim();
	return (entry?.model ?? entry?.pattern ?? "").trim();
}

export function patternsOf(entries: Array<string | ModelEntry> | undefined): string[] {
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

export function loadRawConfig(cwd: string, t: Messages): { raw: RawConfig; path: string; missing: boolean } {
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

export function saveRawConfig(path: string, raw: RawConfig): void {
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	cache = undefined;
	invalidateLanguage();
}

export function arrayField(raw: RawConfig, key: string): unknown[] {
	const value = raw[key];
	if (Array.isArray(value)) return value;
	const created: unknown[] = [];
	raw[key] = created;
	return created;
}

export function buildPlugin(config: RouterConfig): Record<string, unknown> {
	const plugin: Record<string, unknown> = { id: "jev-router" };
	if (config.costTier && COST_TIERS.has(config.costTier)) plugin.cost_tier = config.costTier;
	const models = patternsOf(config.allowedModels);
	const excluded = patternsOf(config.excludedModels);
	if (models.length > 0) plugin.models = models;
	if (excluded.length > 0) plugin.excluded_models = excluded;
	return plugin;
}

/** JSON body of a provider request, after verification at the boundary. */

/** Cost ceiling ($/Mtok blended) implied by the router cost_tier. */
export const TIER_CEILING: Record<NonNullable<RouterConfig["costTier"]>, number> = {
	low: 1,
	medium: 4,
	high: Number.POSITIVE_INFINITY,
};

export function patternMatches(pattern: string, modelId: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	const suffix = pattern.includes("*") ? "" : "(?:-\\d{4,8})?";
	try {
		return new RegExp(`^${escaped}${suffix}$`).test(modelId);
	} catch {
		return false;
	}
}


/** A concrete pattern can be compared against exclusions; a wildcard/alias cannot. */
export function isConcrete(pattern: string): boolean {
	return !pattern.includes("*") && !pattern.startsWith("~");
}

export function exclusionFor(modelId: string, excluded: string[]): string | undefined {
	return excluded.find((pattern) => patternMatches(pattern, modelId));
}
