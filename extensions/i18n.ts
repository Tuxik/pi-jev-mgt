/**
 * Localization for the jev-router extension.
 *
 * Pi itself has no language setting, so the UI language is resolved from, in
 * order of precedence:
 *
 *   1. `$PI_JEV_LANG`                       explicit override, plugin-scoped
 *   2. `language` in the jev-router config  `<cwd>/.pi/jev-router.json`, then
 *                                           `~/.pi/agent/jev-router.json`
 *   3. `$PI_LANG`                           forward-compatible Pi override
 *   4. `language` in Pi's `settings.json`   project, then agent directory
 *   5. `$LC_ALL`, `$LC_MESSAGES`, `$LANG`   operating-system locale
 *   6. `en`                                 default
 *
 * `"language": "auto"` (or a missing value) at any step means "keep looking",
 * so the default is English whenever nothing is specified.
 *
 * Only English, French, Spanish, Italian and German are supported. An unknown
 * or unsupported value is ignored and resolution continues.
 */

export type Language = "en" | "fr" | "es" | "it" | "de";

export const DEFAULT_LANGUAGE: Language = "en";

export const LANGUAGES: readonly Language[] = ["en", "fr", "es", "it", "de"];

/** BCP-47 tag used for date and number formatting. */
export const LOCALE_TAGS: Record<Language, string> = {
	en: "en-US",
	fr: "fr-FR",
	es: "es-ES",
	it: "it-IT",
	de: "de-DE",
};

/** Language name written in that language, for the picker. */
export const LANGUAGE_NAMES: Record<Language, string> = {
	en: "English",
	fr: "Français",
	es: "Español",
	it: "Italiano",
	de: "Deutsch",
};

const LANGUAGE_ALIASES: Record<string, Language> = {
	en: "en",
	eng: "en",
	english: "en",
	anglais: "en",
	ingles: "en",
	inglese: "en",
	englisch: "en",
	fr: "fr",
	fra: "fr",
	fre: "fr",
	french: "fr",
	francais: "fr",
	français: "fr",
	es: "es",
	spa: "es",
	spanish: "es",
	espanol: "es",
	español: "es",
	castellano: "es",
	it: "it",
	ita: "it",
	italian: "it",
	italiano: "it",
	de: "de",
	deu: "de",
	ger: "de",
	german: "de",
	deutsch: "de",
	allemand: "de",
	aleman: "de",
	alemán: "de",
	tedesco: "de",
};

/**
 * Normalize a user-provided value into a supported language.
 *
 * Accepts locales (`fr`, `fr-FR`, `fr_FR.UTF-8`), English or native language
 * names, and returns `undefined` for `auto`, empty, unknown or unsupported
 * values so the caller can fall through to the next source.
 */
export function parseLanguage(value: unknown): Language | undefined {
	if (typeof value !== "string") return undefined;
	const raw = value.trim();
	if (!raw || raw.toLowerCase() === "auto") return undefined;
	// `fr_FR.UTF-8` / `de-DE` / `pt-BR`: the first subtag is what we care about.
	const base = raw.toLowerCase().split(/[-_.]/)[0];
	if (!base) return undefined;
	if (LANGUAGES.includes(base as Language)) return base as Language;
	return LANGUAGE_ALIASES[base];
}

export interface EnvLanguage {
	language: Language;
	/** Name of the environment variable that decided the language. */
	variable: string;
}

/** Resolve the language from well-known environment variables. */
export function languageFromEnv(env: NodeJS.ProcessEnv = process.env): EnvLanguage | undefined {
	for (const variable of ["PI_JEV_LANG", "PI_JEV_ROUTER_LANG", "PI_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
		const language = parseLanguage(env[variable]);
		if (language) return { language, variable };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Message catalog
// ---------------------------------------------------------------------------

/**
 * Every user-visible string of the extension. Implementing it as an interface
 * (rather than a bag of keys) makes TypeScript reject a translation that is
 * missing a message or has the wrong signature.
 */
export interface Messages {
	// Shared navigation and feedback
	back: string;
	cancel: string;
	close: string;
	configSaved: string;

	// Config resolution and effective-config summary
	invalidConfig(path: string, reason: string): string;
	invalidConfigRoot(path: string): string;
	summaryTitle(routerModel: string, active: boolean, tier: string): string;
	summaryConfig(path: string, missing: boolean): string;
	summaryLanguage(name: string): string;
	summaryVirtual(id: string): string;
	noRestriction: string;
	allowedHeader(count: number): string;
	noExclusions: string;
	exclusionsHeader(count: number, patterns: string): string;

	// Catalog browsing and model search
	searchTitle: string;
	searchPlaceholder: string;
	manualPattern: string;
	manualPatternTitle: string;
	manualPatternPlaceholder: string;
	addModelTitle(count: number, query: string): string;
	addedWithExclusion(pattern: string, exclusion: string): string;
	added(pattern: string): string;
	browseTitle: string;
	browsePlaceholder: string;
	browseResults(count: number, query: string): string;
	all: string;
	priceField: string;
	contextField: string;
	maxOutputField: string;
	capabilitiesField: string;
	maxOutputValue(value: string): string;
	textOnly: string;
	addToAllowedConfirm: string;
	absentFromCatalog(pattern: string): string;

	// Allowed-models manager
	allowedMenuTitle(count: number, path: string): string;
	entryPattern: string;
	entryNotInCatalog: string;
	excludedBy(pattern: string): string;
	addModelEntry: string;
	actionRemove: string;
	actionMoveUp: string;
	actionMoveDown: string;
	actionEditNote: string;
	actionDetails: string;
	removeModelConfirm: string;
	noteTitle: string;

	// Hard exclusions manager
	exclusionsMenuTitle(count: number, path: string): string;
	addExclusionEntry: string;
	newExclusionTitle: string;
	newExclusionPlaceholder: string;
	exclusionAdded(pattern: string): string;
	exclusionRemoved(pattern: string): string;
	removeExclusionConfirm: string;

	// Router menu
	routerMenuTitle(path: string, created: boolean): string;
	menuAllowed(count: number): string;
	menuAddModel: string;
	menuExclusions(count: number): string;
	menuTier(tier: string): string;
	menuEnabled(active: boolean): string;
	menuRecommend: string;
	menuBrowse: string;
	menuShow: string;
	menuLanguage(name: string): string;
	menuClose: string;
	tierTitle: string;
	tierChanged(tier: string): string;
	routerToggled(active: boolean): string;
	languageTitle: string;
	languageAuto: string;
	languageChanged(name: string): string;

	// Recommendation
	statusCatalog: string;
	recTitle(count: number, freshness: string): string;
	freshnessLive: string;
	freshnessCache(stamp: string): string;
	freshnessRegistry: string;
	recCeiling(ceiling: string, basis: string): string;
	recCandidates(count: number): string;
	recMethod: string;
	recNone: string;
	recPresent: string;
	recPresentShort: string;
	recScore(score: number): string;
	ceilingTier(tier: string, ceiling: string): string;
	ceilingTierEmptyListSuffix: string;
	ceilingTierDearestSuffix(dearest: string): string;
	ceilingNoList: string;
	ceilingDearest(dearest: string): string;
	bandFlash: string;
	bandBalanced: string;
	bandPower: string;
	reasonBand(band: string, limit: string): string;
	reasonPower(limit: string): string;
	reasonFill: string;
	reasonRevision(pattern: string, price?: string): string;
	reasonExperimental: string;
	peakPrice(peakPrompt: string, peakCompletion: string): string;
	noteText: string;
	noteVision: string;
	noteRecommendation(role: string): string;
	recPickerTitle(ceiling: string): string;
	recAddAllMissing(count: number): string;
	recAddMissingOne: string;
	recAddNothing: string;
	recAllPresent: string;
	recConfirmAddAll: string;
	recAddedList(list: string): string;
	recAddedNone: string;
	recAlreadyCoveredRole(id: string, role: string): string;
	recAlreadyCovered(id: string): string;
	recConfirmAdd(id: string): string;
	recAddedOne(id: string, role: string): string;
	recFailed(reason: string): string;

	// Status bar and startup warnings
	statusInvalidConfig: string;
	statusOff: string;
	statusConfigMissing: string;
	statusTier(tier: string): string;
	missingConfigWarning(path: string): string;
	routerConfigMissing(path: string): string;
	routerNoCandidate(band: string, ceiling: string): string;

	// Slash-command descriptions (shown in Pi's command list)
	cmdModels: string;
	cmdRecommend: string;
	cmdRouter: string;
}

const en: Messages = {
	back: "← Back",
	cancel: "← Cancel",
	close: "Close",
	configSaved: "Config saved",

	invalidConfig: (path, reason) => `Invalid Jev Router config (${path}): ${reason}`,
	invalidConfigRoot: (path) => `Invalid Jev Router config (${path}): the root must be a JSON object`,
	summaryTitle: (routerModel, active, tier) =>
		`Jev Router: ${routerModel} (${active ? "active" : "disabled"}), cost_tier=${tier}`,
	summaryConfig: (path, missing) => `Config: ${path}${missing ? " (missing → defaults)" : ""}`,
	summaryLanguage: (name) => `Language: ${name}`,
	noRestriction: "Allowed models: (no restriction)",
	allowedHeader: (count) => `Allowed models (${count}):`,
	noExclusions: "Hard exclusions: none",
	exclusionsHeader: (count, patterns) => `Hard exclusions (${count}): ${patterns}`,

	searchTitle: "Search an OpenRouter model",
	searchPlaceholder: "glm, kimi, deepseek, qwen…",
	manualPattern: "✎ Enter a pattern manually…",
	manualPatternTitle: "OpenRouter pattern",
	manualPatternPlaceholder: "e.g. z-ai/glm-*, ~moonshotai/kimi-latest",
	addModelTitle: (count, query) => `Add a model — ${count} result(s) for "${query}"`,
	addedWithExclusion: (pattern, exclusion) =>
		`Added: ${pattern}. Warning: this model is matched by the hard exclusion "${exclusion}" and will not be used.`,
	added: (pattern) => `Added: ${pattern}`,
	browseTitle: "Browse the OpenRouter catalog",
	browsePlaceholder: "filter by slug/name (empty = all)",
	browseResults: (count, query) => `Catalog — ${count} result(s) for "${query}"`,
	all: "all",
	priceField: "Price",
	contextField: "Context",
	maxOutputField: "Max output",
	capabilitiesField: "Capabilities",
	maxOutputValue: (value) => `${value} tokens`,
	textOnly: "text only",
	addToAllowedConfirm: "Add to the allowed list?",
	absentFromCatalog: (pattern) => `${pattern}\nNot in the catalog (wildcard, alias or unknown model).`,

	allowedMenuTitle: (count, path) => `Allowed models (${count}) — ${path}`,
	entryPattern: "pattern",
	entryNotInCatalog: "not in the catalog",
	excludedBy: (pattern) => `excluded by ${pattern}`,
	addModelEntry: "＋ Add a model…",
	actionRemove: "Remove from the list",
	actionMoveUp: "Move up in the list",
	actionMoveDown: "Move down in the list",
	actionEditNote: "Edit the note",
	actionDetails: "Show catalog details",
	removeModelConfirm: "Remove this model?",
	noteTitle: "Note (price, context, usage…)",

	exclusionsMenuTitle: (count, path) => `Hard exclusions (${count}) — ${path}`,
	addExclusionEntry: "＋ Add an exclusion…",
	newExclusionTitle: "New exclusion",
	newExclusionPlaceholder: "e.g. anthropic/claude-opus*, *:batch*",
	exclusionAdded: (pattern) => `Exclusion added: ${pattern}`,
	exclusionRemoved: (pattern) => `Exclusion removed: ${pattern}`,
	removeExclusionConfirm: "Remove this exclusion?",

	routerMenuTitle: (path, created) => `Jev Router — ${path}${created ? " (created on the first change)" : ""}`,
	menuAllowed: (count) => `Allowed models: ${count}`,
	menuAddModel: "Add a model…",
	menuExclusions: (count) => `Hard exclusions: ${count}`,
	menuTier: (tier) => `Cost tier: ${tier}`,
	menuEnabled: (active) => `Router: ${active ? "active" : "disabled"}`,
	menuRecommend: "Recommend 3 models (live catalog)…",
	menuBrowse: "Browse the OpenRouter catalog…",
	menuShow: "Show the effective config",
	menuLanguage: (name) => `Language: ${name}`,
	menuClose: "Close",
	tierTitle: "Cost tier (router policy)",
	tierChanged: (tier) => `cost_tier = ${tier}`,
	routerToggled: (active) => `Router ${active ? "active" : "disabled"}`,
	languageTitle: "UI language of this extension",
	languageAuto: "Automatic (Pi / system)",
	languageChanged: (name) => `Language: ${name}`,

	statusCatalog: "OpenRouter catalog…",
	recTitle: (count, freshness) => `jev-router recommendations — ${count} models (${freshness})`,
	freshnessLive: "live",
	freshnessCache: (stamp) => `cache from ${stamp}`,
	freshnessRegistry: "local Pi catalog (offline)",
	recCeiling: (ceiling, basis) => `Cost ceiling: ${ceiling} $/Mtok blended — ${basis}`,
	recCandidates: (count) => `Eligible candidates under the ceiling: ${count}`,
	recMethod: "Heuristic ranking: current price + declared capabilities + context (not a benchmark).",
	recNone: "No candidate: widen the list or loosen the hard exclusions.",
	recPresent: "  (already in the list)",
	recPresentShort: "  (already there)",
	recScore: (score) => `score ${score}/100`,
	ceilingTier: (tier, ceiling) => `cost_tier ${tier} capped at ${ceiling} $/Mtok`,
	ceilingTierEmptyListSuffix: " (empty list: default ceiling)",
	ceilingTierDearestSuffix: (dearest) => ` (dearest model in the list: ${dearest} $/Mtok)`,
	ceilingNoList: "no model from the list found in the catalog, default ceiling",
	ceilingDearest: (dearest) => `dearest model in the list (${dearest} $/Mtok) + 10%`,
	bandFlash: "Flash band",
	bandBalanced: "Balanced band",
	bandPower: "Power band",
	reasonBand: (band, limit) => `${band} (≤ ${limit} $/Mtok): best capability-to-price ratio.`,
	reasonPower: (limit) =>
		`Power band (≤ ${limit} $/Mtok): maximal capabilities at the lowest price for equal capabilities.`,
	reasonFill: "Fill-in from the ranking (incomplete band).",
	reasonRevision: (pattern, price) =>
		price
			? `Current revision of ${pattern} (${price} $/Mtok) — check whether it replaces the old one.`
			: `Current revision of ${pattern} — check whether it replaces the old one.`,
	reasonExperimental: "Experimental variant: check stability before relying on it.",
	peakPrice: (peakPrompt, peakCompletion) => ` (peak ${peakPrompt}/${peakCompletion})`,
	noteText: "text",
	noteVision: "vision",
	noteRecommendation: (role) => `live reco (${role})`,
	recPickerTitle: (ceiling) => `jev-router recommendations — ceiling ${ceiling} $/Mtok`,
	recAddAllMissing: (count) => `＋ Add the ${count} missing`,
	recAddMissingOne: "＋ Add the missing one",
	recAddNothing: "＋ Add (nothing to add)",
	recAllPresent: "The allowed list already contains these three models",
	recConfirmAddAll: "Add these models to the allowed list?",
	recAddedList: (list) => `Added: ${list}`,
	recAddedNone: "Nothing added (already covered)",
	recAlreadyCoveredRole: (id, role) => `${id} is already covered by the allowed list (${role})`,
	recAlreadyCovered: (id) => `${id} is already covered by the allowed list`,
	recConfirmAdd: (id) => `Add ${id}?`,
	recAddedOne: (id, role) => `Added: ${id} (${role})`,
	recFailed: (reason) => `Recommendation failed: ${reason}`,

	statusInvalidConfig: "invalid config",
	statusOff: "off",
	statusConfigMissing: "config missing",
	statusTier: (tier) => `tier ${tier}`,
	missingConfigWarning: (path) =>
		`Jev Router: no config found (${path}). The router is unrestricted. Run /jev-models to create one.`,
	summaryVirtual: (id) => `Virtual model: ${id} — select it with /model to route inside Pi`,
	routerConfigMissing: (path) =>
		`Jev Router: no config found (${path}). jev/auto routes from the whole catalog under the cost tier. Run /jev-models to curate it.`,
	routerNoCandidate: (band, ceiling) =>
		`No model available (${band}, ceiling ${ceiling} $/Mtok). Loosen excludedModels, raise costTier, or add a model with /jev-models.`,

	cmdModels: "Manage the models the typesafe/jev-router router is allowed to pick",
	cmdRecommend: "Suggest the 3 models best suited to the router, from the live OpenRouter catalog",
	cmdRouter: "Print the effective configuration of the typesafe/jev-router router",
};

const fr: Messages = {
	back: "← Retour",
	cancel: "← Annuler",
	close: "Fermer",
	configSaved: "Config enregistrée",

	invalidConfig: (path, reason) => `Config Jev Router invalide (${path}) : ${reason}`,
	invalidConfigRoot: (path) => `Config Jev Router invalide (${path}) : la racine doit être un objet JSON`,
	summaryTitle: (routerModel, active, tier) =>
		`Jev Router : ${routerModel} (${active ? "actif" : "désactivé"}), cost_tier=${tier}`,
	summaryConfig: (path, missing) => `Config : ${path}${missing ? " (absente → valeurs par défaut)" : ""}`,
	summaryLanguage: (name) => `Langue : ${name}`,
	noRestriction: "Modèles autorisés : (aucune restriction)",
	allowedHeader: (count) => `Modèles autorisés (${count}) :`,
	noExclusions: "Exclusions dures : aucune",
	exclusionsHeader: (count, patterns) => `Exclusions dures (${count}) : ${patterns}`,

	searchTitle: "Rechercher un modèle OpenRouter",
	searchPlaceholder: "glm, kimi, deepseek, qwen…",
	manualPattern: "✎ Saisir un motif manuellement…",
	manualPatternTitle: "Motif OpenRouter",
	manualPatternPlaceholder: "ex. z-ai/glm-*, ~moonshotai/kimi-latest",
	addModelTitle: (count, query) => `Ajouter un modèle — ${count} résultat(s) pour « ${query} »`,
	addedWithExclusion: (pattern, exclusion) =>
		`Ajouté : ${pattern}. Attention, ce modèle est couvert par l'exclusion dure « ${exclusion} » et ne sera pas utilisé.`,
	added: (pattern) => `Ajouté : ${pattern}`,
	browseTitle: "Explorer le catalogue OpenRouter",
	browsePlaceholder: "filtrer par slug/nom (vide = tout)",
	browseResults: (count, query) => `Catalogue — ${count} résultat(s) pour « ${query} »`,
	all: "tout",
	priceField: "Prix",
	contextField: "Contexte",
	maxOutputField: "Sortie max",
	capabilitiesField: "Capacités",
	maxOutputValue: (value) => `${value} tokens`,
	textOnly: "texte seul",
	addToAllowedConfirm: "Ajouter à la liste autorisée ?",
	absentFromCatalog: (pattern) => `${pattern}\nAbsent du catalogue (wildcard, alias ou modèle inconnu).`,

	allowedMenuTitle: (count, path) => `Modèles autorisés (${count}) — ${path}`,
	entryPattern: "motif",
	entryNotInCatalog: "hors catalogue",
	excludedBy: (pattern) => `exclu par ${pattern}`,
	addModelEntry: "＋ Ajouter un modèle…",
	actionRemove: "Retirer de la liste",
	actionMoveUp: "Monter dans la liste",
	actionMoveDown: "Descendre dans la liste",
	actionEditNote: "Modifier la note",
	actionDetails: "Voir les détails du catalogue",
	removeModelConfirm: "Retirer le modèle ?",
	noteTitle: "Note (prix, contexte, usage…)",

	exclusionsMenuTitle: (count, path) => `Exclusions dures (${count}) — ${path}`,
	addExclusionEntry: "＋ Ajouter une exclusion…",
	newExclusionTitle: "Nouvelle exclusion",
	newExclusionPlaceholder: "ex. anthropic/claude-opus*, *:batch*",
	exclusionAdded: (pattern) => `Exclusion ajoutée : ${pattern}`,
	exclusionRemoved: (pattern) => `Exclusion retirée : ${pattern}`,
	removeExclusionConfirm: "Retirer cette exclusion ?",

	routerMenuTitle: (path, created) => `Jev Router — ${path}${created ? " (créée à la première modification)" : ""}`,
	menuAllowed: (count) => `Modèles autorisés : ${count}`,
	menuAddModel: "Ajouter un modèle…",
	menuExclusions: (count) => `Exclusions dures : ${count}`,
	menuTier: (tier) => `Cost tier : ${tier}`,
	menuEnabled: (active) => `Routeur : ${active ? "actif" : "désactivé"}`,
	menuRecommend: "Recommander 3 modèles (catalogue live)…",
	menuBrowse: "Explorer le catalogue OpenRouter…",
	menuShow: "Afficher la config effective",
	menuLanguage: (name) => `Langue : ${name}`,
	menuClose: "Fermer",
	tierTitle: "Cost tier (politique du routeur)",
	tierChanged: (tier) => `cost_tier = ${tier}`,
	routerToggled: (active) => `Routeur ${active ? "actif" : "désactivé"}`,
	languageTitle: "Langue de l'interface de l'extension",
	languageAuto: "Automatique (Pi / système)",
	languageChanged: (name) => `Langue : ${name}`,

	statusCatalog: "catalogue OpenRouter…",
	recTitle: (count, freshness) => `Recommandations jev-router — ${count} modèles (${freshness})`,
	freshnessLive: "live",
	freshnessCache: (stamp) => `cache du ${stamp}`,
	freshnessRegistry: "catalogue pi local (hors ligne)",
	recCeiling: (ceiling, basis) => `Plafond de coût : ${ceiling} $/Mtok mélangé — ${basis}`,
	recCandidates: (count) => `Candidats éligibles sous le plafond : ${count}`,
	recMethod: "Classement heuristique : prix du moment + capacités déclarées + contexte (pas un benchmark).",
	recNone: "Aucun candidat : élargir la liste ou alléger les exclusions dures.",
	recPresent: "  (déjà dans la liste)",
	recPresentShort: "  (déjà là)",
	recScore: (score) => `score ${score}/100`,
	ceilingTier: (tier, ceiling) => `cost_tier ${tier} plafonné à ${ceiling} $/Mtok`,
	ceilingTierEmptyListSuffix: " (liste vide : plafond par défaut)",
	ceilingTierDearestSuffix: (dearest) => ` (modèle le plus cher de la liste : ${dearest} $/Mtok)`,
	ceilingNoList: "aucun modèle de la liste retrouvé dans le catalogue, plafond par défaut",
	ceilingDearest: (dearest) => `modèle le plus cher de la liste (${dearest} $/Mtok) + 10 %`,
	bandFlash: "Bande flash",
	bandBalanced: "Bande équilibrée",
	bandPower: "Bande haute",
	reasonBand: (band, limit) => `${band} (≤ ${limit} $/Mtok) : meilleur rapport capacités/prix.`,
	reasonPower: (limit) =>
		`Bande haute (≤ ${limit} $/Mtok) : capacités maximales, au prix le plus bas à capacités égales.`,
	reasonFill: "Complément du classement (bande incomplète).",
	reasonRevision: (pattern, price) =>
		price
			? `Révision actuelle de ${pattern} (${price} $/Mtok) : vérifier si elle remplace l'ancienne.`
			: `Révision actuelle de ${pattern} : vérifier si elle remplace l'ancienne.`,
	reasonExperimental: "Variante expérimentale : vérifier la stabilité avant de compter dessus.",
	peakPrice: (peakPrompt, peakCompletion) => ` (pointe ${peakPrompt}/${peakCompletion})`,
	noteText: "texte",
	noteVision: "vision",
	noteRecommendation: (role) => `reco live (${role})`,
	recPickerTitle: (ceiling) => `Recommandations jev-router — plafond ${ceiling} $/Mtok`,
	recAddAllMissing: (count) => `＋ Ajouter les ${count} manquants`,
	recAddMissingOne: "＋ Ajouter le manquant",
	recAddNothing: "＋ Ajouter (rien à ajouter)",
	recAllPresent: "La liste autorisée contient déjà ces trois modèles",
	recConfirmAddAll: "Ajouter ces modèles à la liste autorisée ?",
	recAddedList: (list) => `Ajoutés : ${list}`,
	recAddedNone: "Aucun ajout (déjà couverts)",
	recAlreadyCoveredRole: (id, role) => `${id} est déjà couvert par la liste autorisée (${role})`,
	recAlreadyCovered: (id) => `${id} est déjà couvert par la liste autorisée`,
	recConfirmAdd: (id) => `Ajouter ${id} ?`,
	recAddedOne: (id, role) => `Ajouté : ${id} (${role})`,
	recFailed: (reason) => `Recommandation impossible : ${reason}`,

	statusInvalidConfig: "config invalide",
	statusOff: "off",
	statusConfigMissing: "config absente",
	statusTier: (tier) => `tier ${tier}`,
	missingConfigWarning: (path) =>
		`Jev Router : aucune config trouvée (${path}). Le routeur n'est pas restreint. Lancez /jev-models pour en créer une.`,
	summaryVirtual: (id) => `Modèle virtuel : ${id} — le sélectionner avec /model pour router dans Pi`,
	routerConfigMissing: (path) =>
		`Jev Router : aucune config trouvée (${path}). jev/auto route depuis tout le catalogue sous le cost tier. Lancez /jev-models pour la restreindre.`,
	routerNoCandidate: (band, ceiling) =>
		`Aucun modèle disponible (${band}, plafond ${ceiling} $/Mtok). Alléger excludedModels, relever costTier ou ajouter un modèle avec /jev-models.`,

	cmdModels: "Gérer les modèles autorisés par le routeur typesafe/jev-router",
	cmdRecommend: "Propose les 3 modèles les plus adaptés au routeur, d'après le catalogue OpenRouter en direct",
	cmdRouter: "Affiche la config effective du routeur typesafe/jev-router",
};

const es: Messages = {
	back: "← Volver",
	cancel: "← Cancelar",
	close: "Cerrar",
	configSaved: "Configuración guardada",

	invalidConfig: (path, reason) => `Configuración de Jev Router no válida (${path}): ${reason}`,
	invalidConfigRoot: (path) => `Configuración de Jev Router no válida (${path}): la raíz debe ser un objeto JSON`,
	summaryTitle: (routerModel, active, tier) =>
		`Jev Router: ${routerModel} (${active ? "activo" : "desactivado"}), cost_tier=${tier}`,
	summaryConfig: (path, missing) => `Configuración: ${path}${missing ? " (ausente → valores por defecto)" : ""}`,
	summaryLanguage: (name) => `Idioma: ${name}`,
	noRestriction: "Modelos permitidos: (sin restricción)",
	allowedHeader: (count) => `Modelos permitidos (${count}):`,
	noExclusions: "Exclusiones duras: ninguna",
	exclusionsHeader: (count, patterns) => `Exclusiones duras (${count}): ${patterns}`,

	searchTitle: "Buscar un modelo de OpenRouter",
	searchPlaceholder: "glm, kimi, deepseek, qwen…",
	manualPattern: "✎ Introducir un patrón manualmente…",
	manualPatternTitle: "Patrón de OpenRouter",
	manualPatternPlaceholder: "p. ej. z-ai/glm-*, ~moonshotai/kimi-latest",
	addModelTitle: (count, query) => `Añadir un modelo — ${count} resultado(s) para «${query}»`,
	addedWithExclusion: (pattern, exclusion) =>
		`Añadido: ${pattern}. Atención: este modelo está cubierto por la exclusión dura «${exclusion}» y no se usará.`,
	added: (pattern) => `Añadido: ${pattern}`,
	browseTitle: "Explorar el catálogo de OpenRouter",
	browsePlaceholder: "filtrar por slug/nombre (vacío = todo)",
	browseResults: (count, query) => `Catálogo — ${count} resultado(s) para «${query}»`,
	all: "todo",
	priceField: "Precio",
	contextField: "Contexto",
	maxOutputField: "Salida máx.",
	capabilitiesField: "Capacidades",
	maxOutputValue: (value) => `${value} tokens`,
	textOnly: "solo texto",
	addToAllowedConfirm: "¿Añadir a la lista permitida?",
	absentFromCatalog: (pattern) => `${pattern}\nNo está en el catálogo (comodín, alias o modelo desconocido).`,

	allowedMenuTitle: (count, path) => `Modelos permitidos (${count}) — ${path}`,
	entryPattern: "patrón",
	entryNotInCatalog: "fuera del catálogo",
	excludedBy: (pattern) => `excluido por ${pattern}`,
	addModelEntry: "＋ Añadir un modelo…",
	actionRemove: "Quitar de la lista",
	actionMoveUp: "Subir en la lista",
	actionMoveDown: "Bajar en la lista",
	actionEditNote: "Editar la nota",
	actionDetails: "Ver los detalles del catálogo",
	removeModelConfirm: "¿Quitar el modelo?",
	noteTitle: "Nota (precio, contexto, uso…)",

	exclusionsMenuTitle: (count, path) => `Exclusiones duras (${count}) — ${path}`,
	addExclusionEntry: "＋ Añadir una exclusión…",
	newExclusionTitle: "Nueva exclusión",
	newExclusionPlaceholder: "p. ej. anthropic/claude-opus*, *:batch*",
	exclusionAdded: (pattern) => `Exclusión añadida: ${pattern}`,
	exclusionRemoved: (pattern) => `Exclusión eliminada: ${pattern}`,
	removeExclusionConfirm: "¿Quitar esta exclusión?",

	routerMenuTitle: (path, created) => `Jev Router — ${path}${created ? " (se crea en el primer cambio)" : ""}`,
	menuAllowed: (count) => `Modelos permitidos: ${count}`,
	menuAddModel: "Añadir un modelo…",
	menuExclusions: (count) => `Exclusiones duras: ${count}`,
	menuTier: (tier) => `Cost tier: ${tier}`,
	menuEnabled: (active) => `Router: ${active ? "activo" : "desactivado"}`,
	menuRecommend: "Recomendar 3 modelos (catálogo en vivo)…",
	menuBrowse: "Explorar el catálogo de OpenRouter…",
	menuShow: "Mostrar la configuración efectiva",
	menuLanguage: (name) => `Idioma: ${name}`,
	menuClose: "Cerrar",
	tierTitle: "Cost tier (política del router)",
	tierChanged: (tier) => `cost_tier = ${tier}`,
	routerToggled: (active) => `Router ${active ? "activo" : "desactivado"}`,
	languageTitle: "Idioma de la interfaz de la extensión",
	languageAuto: "Automático (Pi / sistema)",
	languageChanged: (name) => `Idioma: ${name}`,

	statusCatalog: "catálogo de OpenRouter…",
	recTitle: (count, freshness) => `Recomendaciones jev-router — ${count} modelos (${freshness})`,
	freshnessLive: "en vivo",
	freshnessCache: (stamp) => `caché del ${stamp}`,
	freshnessRegistry: "catálogo local de Pi (sin conexión)",
	recCeiling: (ceiling, basis) => `Límite de coste: ${ceiling} $/Mtok mixto — ${basis}`,
	recCandidates: (count) => `Candidatos elegibles bajo el límite: ${count}`,
	recMethod: "Clasificación heurística: precio actual + capacidades declaradas + contexto (no es un benchmark).",
	recNone: "Ningún candidato: amplía la lista o relaja las exclusiones duras.",
	recPresent: "  (ya está en la lista)",
	recPresentShort: "  (ya está)",
	recScore: (score) => `puntuación ${score}/100`,
	ceilingTier: (tier, ceiling) => `cost_tier ${tier} limitado a ${ceiling} $/Mtok`,
	ceilingTierEmptyListSuffix: " (lista vacía: límite por defecto)",
	ceilingTierDearestSuffix: (dearest) => ` (modelo más caro de la lista: ${dearest} $/Mtok)`,
	ceilingNoList: "ningún modelo de la lista encontrado en el catálogo, límite por defecto",
	ceilingDearest: (dearest) => `modelo más caro de la lista (${dearest} $/Mtok) + 10 %`,
	bandFlash: "Banda flash",
	bandBalanced: "Banda equilibrada",
	bandPower: "Banda alta",
	reasonBand: (band, limit) => `${band} (≤ ${limit} $/Mtok): mejor relación capacidades/precio.`,
	reasonPower: (limit) =>
		`Banda alta (≤ ${limit} $/Mtok): capacidades máximas, al precio más bajo con capacidades iguales.`,
	reasonFill: "Complemento de la clasificación (banda incompleta).",
	reasonRevision: (pattern, price) =>
		price
			? `Revisión actual de ${pattern} (${price} $/Mtok): comprobar si sustituye a la anterior.`
			: `Revisión actual de ${pattern}: comprobar si sustituye a la anterior.`,
	reasonExperimental: "Variante experimental: comprobar la estabilidad antes de contar con ella.",
	peakPrice: (peakPrompt, peakCompletion) => ` (punta ${peakPrompt}/${peakCompletion})`,
	noteText: "texto",
	noteVision: "visión",
	noteRecommendation: (role) => `reco en vivo (${role})`,
	recPickerTitle: (ceiling) => `Recomendaciones jev-router — límite ${ceiling} $/Mtok`,
	recAddAllMissing: (count) => `＋ Añadir los ${count} que faltan`,
	recAddMissingOne: "＋ Añadir el que falta",
	recAddNothing: "＋ Añadir (nada que añadir)",
	recAllPresent: "La lista permitida ya contiene estos tres modelos",
	recConfirmAddAll: "¿Añadir estos modelos a la lista permitida?",
	recAddedList: (list) => `Añadidos: ${list}`,
	recAddedNone: "Nada añadido (ya cubiertos)",
	recAlreadyCoveredRole: (id, role) => `${id} ya está cubierto por la lista permitida (${role})`,
	recAlreadyCovered: (id) => `${id} ya está cubierto por la lista permitida`,
	recConfirmAdd: (id) => `¿Añadir ${id}?`,
	recAddedOne: (id, role) => `Añadido: ${id} (${role})`,
	recFailed: (reason) => `Recomendación imposible: ${reason}`,

	statusInvalidConfig: "config no válida",
	statusOff: "off",
	statusConfigMissing: "config ausente",
	statusTier: (tier) => `tier ${tier}`,
	missingConfigWarning: (path) =>
		`Jev Router: no se encontró ninguna configuración (${path}). El router no está restringido. Ejecuta /jev-models para crear una.`,
	summaryVirtual: (id) => `Modelo virtual: ${id} — selecciónalo con /model para enrutar dentro de Pi`,
	routerConfigMissing: (path) =>
		`Jev Router: no se encontró configuración (${path}). jev/auto enruta desde todo el catálogo bajo el cost tier. Ejecuta /jev-models para restringirlo.`,
	routerNoCandidate: (band, ceiling) =>
		`Ningún modelo disponible (${band}, límite ${ceiling} $/Mtok). Relaja excludedModels, sube costTier o añade un modelo con /jev-models.`,

	cmdModels: "Gestionar los modelos que el router typesafe/jev-router puede elegir",
	cmdRecommend: "Propone los 3 modelos más adecuados para el router, según el catálogo de OpenRouter en vivo",
	cmdRouter: "Muestra la configuración efectiva del router typesafe/jev-router",
};

const it: Messages = {
	back: "← Indietro",
	cancel: "← Annulla",
	close: "Chiudi",
	configSaved: "Configurazione salvata",

	invalidConfig: (path, reason) => `Configurazione Jev Router non valida (${path}): ${reason}`,
	invalidConfigRoot: (path) => `Configurazione Jev Router non valida (${path}): la radice deve essere un oggetto JSON`,
	summaryTitle: (routerModel, active, tier) =>
		`Jev Router: ${routerModel} (${active ? "attivo" : "disattivato"}), cost_tier=${tier}`,
	summaryConfig: (path, missing) => `Configurazione: ${path}${missing ? " (assente → valori predefiniti)" : ""}`,
	summaryLanguage: (name) => `Lingua: ${name}`,
	noRestriction: "Modelli consentiti: (nessuna restrizione)",
	allowedHeader: (count) => `Modelli consentiti (${count}):`,
	noExclusions: "Esclusioni rigide: nessuna",
	exclusionsHeader: (count, patterns) => `Esclusioni rigide (${count}): ${patterns}`,

	searchTitle: "Cerca un modello OpenRouter",
	searchPlaceholder: "glm, kimi, deepseek, qwen…",
	manualPattern: "✎ Inserisci un pattern manualmente…",
	manualPatternTitle: "Pattern OpenRouter",
	manualPatternPlaceholder: "es. z-ai/glm-*, ~moonshotai/kimi-latest",
	addModelTitle: (count, query) => `Aggiungi un modello — ${count} risultato/i per «${query}»`,
	addedWithExclusion: (pattern, exclusion) =>
		`Aggiunto: ${pattern}. Attenzione: questo modello è coperto dall'esclusione rigida «${exclusion}» e non verrà usato.`,
	added: (pattern) => `Aggiunto: ${pattern}`,
	browseTitle: "Esplora il catalogo OpenRouter",
	browsePlaceholder: "filtra per slug/nome (vuoto = tutto)",
	browseResults: (count, query) => `Catalogo — ${count} risultato/i per «${query}»`,
	all: "tutto",
	priceField: "Prezzo",
	contextField: "Contesto",
	maxOutputField: "Output max",
	capabilitiesField: "Capacità",
	maxOutputValue: (value) => `${value} token`,
	textOnly: "solo testo",
	addToAllowedConfirm: "Aggiungere alla lista consentita?",
	absentFromCatalog: (pattern) => `${pattern}\nAssente dal catalogo (wildcard, alias o modello sconosciuto).`,

	allowedMenuTitle: (count, path) => `Modelli consentiti (${count}) — ${path}`,
	entryPattern: "pattern",
	entryNotInCatalog: "fuori catalogo",
	excludedBy: (pattern) => `escluso da ${pattern}`,
	addModelEntry: "＋ Aggiungi un modello…",
	actionRemove: "Rimuovi dalla lista",
	actionMoveUp: "Sposta su nella lista",
	actionMoveDown: "Sposta giù nella lista",
	actionEditNote: "Modifica la nota",
	actionDetails: "Vedi i dettagli del catalogo",
	removeModelConfirm: "Rimuovere il modello?",
	noteTitle: "Nota (prezzo, contesto, uso…)",

	exclusionsMenuTitle: (count, path) => `Esclusioni rigide (${count}) — ${path}`,
	addExclusionEntry: "＋ Aggiungi un'esclusione…",
	newExclusionTitle: "Nuova esclusione",
	newExclusionPlaceholder: "es. anthropic/claude-opus*, *:batch*",
	exclusionAdded: (pattern) => `Esclusione aggiunta: ${pattern}`,
	exclusionRemoved: (pattern) => `Esclusione rimossa: ${pattern}`,
	removeExclusionConfirm: "Rimuovere questa esclusione?",

	routerMenuTitle: (path, created) => `Jev Router — ${path}${created ? " (creata al primo cambiamento)" : ""}`,
	menuAllowed: (count) => `Modelli consentiti: ${count}`,
	menuAddModel: "Aggiungi un modello…",
	menuExclusions: (count) => `Esclusioni rigide: ${count}`,
	menuTier: (tier) => `Cost tier: ${tier}`,
	menuEnabled: (active) => `Router: ${active ? "attivo" : "disattivato"}`,
	menuRecommend: "Consiglia 3 modelli (catalogo live)…",
	menuBrowse: "Esplora il catalogo OpenRouter…",
	menuShow: "Mostra la configurazione effettiva",
	menuLanguage: (name) => `Lingua: ${name}`,
	menuClose: "Chiudi",
	tierTitle: "Cost tier (politica del router)",
	tierChanged: (tier) => `cost_tier = ${tier}`,
	routerToggled: (active) => `Router ${active ? "attivo" : "disattivato"}`,
	languageTitle: "Lingua dell'interfaccia dell'estensione",
	languageAuto: "Automatico (Pi / sistema)",
	languageChanged: (name) => `Lingua: ${name}`,

	statusCatalog: "catalogo OpenRouter…",
	recTitle: (count, freshness) => `Consigli jev-router — ${count} modelli (${freshness})`,
	freshnessLive: "live",
	freshnessCache: (stamp) => `cache del ${stamp}`,
	freshnessRegistry: "catalogo locale di Pi (offline)",
	recCeiling: (ceiling, basis) => `Tetto di costo: ${ceiling} $/Mtok misto — ${basis}`,
	recCandidates: (count) => `Candidati idonei sotto il tetto: ${count}`,
	recMethod: "Classifica euristica: prezzo attuale + capacità dichiarate + contesto (non è un benchmark).",
	recNone: "Nessun candidato: amplia la lista o allenta le esclusioni rigide.",
	recPresent: "  (già nella lista)",
	recPresentShort: "  (già presente)",
	recScore: (score) => `punteggio ${score}/100`,
	ceilingTier: (tier, ceiling) => `cost_tier ${tier} limitato a ${ceiling} $/Mtok`,
	ceilingTierEmptyListSuffix: " (lista vuota: tetto predefinito)",
	ceilingTierDearestSuffix: (dearest) => ` (modello più caro della lista: ${dearest} $/Mtok)`,
	ceilingNoList: "nessun modello della lista trovato nel catalogo, tetto predefinito",
	ceilingDearest: (dearest) => `modello più caro della lista (${dearest} $/Mtok) + 10%`,
	bandFlash: "Fascia flash",
	bandBalanced: "Fascia equilibrata",
	bandPower: "Fascia alta",
	reasonBand: (band, limit) => `${band} (≤ ${limit} $/Mtok): miglior rapporto capacità/prezzo.`,
	reasonPower: (limit) =>
		`Fascia alta (≤ ${limit} $/Mtok): capacità massime, al prezzo più basso a parità di capacità.`,
	reasonFill: "Complemento della classifica (fascia incompleta).",
	reasonRevision: (pattern, price) =>
		price
			? `Revisione attuale di ${pattern} (${price} $/Mtok): verificare se sostituisce la precedente.`
			: `Revisione attuale di ${pattern}: verificare se sostituisce la precedente.`,
	reasonExperimental: "Variante sperimentale: verificare la stabilità prima di farci affidamento.",
	peakPrice: (peakPrompt, peakCompletion) => ` (picco ${peakPrompt}/${peakCompletion})`,
	noteText: "testo",
	noteVision: "visione",
	noteRecommendation: (role) => `consiglio live (${role})`,
	recPickerTitle: (ceiling) => `Consigli jev-router — tetto ${ceiling} $/Mtok`,
	recAddAllMissing: (count) => `＋ Aggiungi i ${count} mancanti`,
	recAddMissingOne: "＋ Aggiungi quello mancante",
	recAddNothing: "＋ Aggiungi (niente da aggiungere)",
	recAllPresent: "La lista consentita contiene già questi tre modelli",
	recConfirmAddAll: "Aggiungere questi modelli alla lista consentita?",
	recAddedList: (list) => `Aggiunti: ${list}`,
	recAddedNone: "Nessuna aggiunta (già coperti)",
	recAlreadyCoveredRole: (id, role) => `${id} è già coperto dalla lista consentita (${role})`,
	recAlreadyCovered: (id) => `${id} è già coperto dalla lista consentita`,
	recConfirmAdd: (id) => `Aggiungere ${id}?`,
	recAddedOne: (id, role) => `Aggiunto: ${id} (${role})`,
	recFailed: (reason) => `Consiglio impossibile: ${reason}`,

	statusInvalidConfig: "config non valida",
	statusOff: "off",
	statusConfigMissing: "config assente",
	statusTier: (tier) => `tier ${tier}`,
	missingConfigWarning: (path) =>
		`Jev Router: nessuna configurazione trovata (${path}). Il router non è limitato. Esegui /jev-models per crearne una.`,
	summaryVirtual: (id) => `Modello virtuale: ${id} — selezionalo con /model per instradare dentro Pi`,
	routerConfigMissing: (path) =>
		`Jev Router: nessuna configurazione trovata (${path}). jev/auto instrada dall'intero catalogo sotto il cost tier. Esegui /jev-models per limitarlo.`,
	routerNoCandidate: (band, ceiling) =>
		`Nessun modello disponibile (${band}, tetto ${ceiling} $/Mtok). Allenta excludedModels, alza costTier o aggiungi un modello con /jev-models.`,

	cmdModels: "Gestisci i modelli che il router typesafe/jev-router può scegliere",
	cmdRecommend: "Propone i 3 modelli più adatti al router, dal catalogo OpenRouter live",
	cmdRouter: "Mostra la configurazione effettiva del router typesafe/jev-router",
};

const de: Messages = {
	back: "← Zurück",
	cancel: "← Abbrechen",
	close: "Schließen",
	configSaved: "Konfiguration gespeichert",

	invalidConfig: (path, reason) => `Ungültige Jev-Router-Konfiguration (${path}): ${reason}`,
	invalidConfigRoot: (path) =>
		`Ungültige Jev-Router-Konfiguration (${path}): die Wurzel muss ein JSON-Objekt sein`,
	summaryTitle: (routerModel, active, tier) =>
		`Jev Router: ${routerModel} (${active ? "aktiv" : "deaktiviert"}), cost_tier=${tier}`,
	summaryConfig: (path, missing) => `Konfiguration: ${path}${missing ? " (fehlt → Standardwerte)" : ""}`,
	summaryLanguage: (name) => `Sprache: ${name}`,
	noRestriction: "Erlaubte Modelle: (keine Einschränkung)",
	allowedHeader: (count) => `Erlaubte Modelle (${count}):`,
	noExclusions: "Harte Ausschlüsse: keine",
	exclusionsHeader: (count, patterns) => `Harte Ausschlüsse (${count}): ${patterns}`,

	searchTitle: "OpenRouter-Modell suchen",
	searchPlaceholder: "glm, kimi, deepseek, qwen…",
	manualPattern: "✎ Muster manuell eingeben…",
	manualPatternTitle: "OpenRouter-Muster",
	manualPatternPlaceholder: "z. B. z-ai/glm-*, ~moonshotai/kimi-latest",
	addModelTitle: (count, query) => `Modell hinzufügen — ${count} Treffer für „${query}“`,
	addedWithExclusion: (pattern, exclusion) =>
		`Hinzugefügt: ${pattern}. Achtung: Dieses Modell ist vom harten Ausschluss „${exclusion}“ betroffen und wird nicht verwendet.`,
	added: (pattern) => `Hinzugefügt: ${pattern}`,
	browseTitle: "OpenRouter-Katalog durchsuchen",
	browsePlaceholder: "nach Slug/Name filtern (leer = alles)",
	browseResults: (count, query) => `Katalog — ${count} Treffer für „${query}“`,
	all: "alles",
	priceField: "Preis",
	contextField: "Kontext",
	maxOutputField: "Max. Ausgabe",
	capabilitiesField: "Fähigkeiten",
	maxOutputValue: (value) => `${value} Tokens`,
	textOnly: "nur Text",
	addToAllowedConfirm: "Zur erlaubten Liste hinzufügen?",
	absentFromCatalog: (pattern) => `${pattern}\nNicht im Katalog (Wildcard, Alias oder unbekanntes Modell).`,

	allowedMenuTitle: (count, path) => `Erlaubte Modelle (${count}) — ${path}`,
	entryPattern: "Muster",
	entryNotInCatalog: "nicht im Katalog",
	excludedBy: (pattern) => `ausgeschlossen durch ${pattern}`,
	addModelEntry: "＋ Modell hinzufügen…",
	actionRemove: "Aus der Liste entfernen",
	actionMoveUp: "In der Liste nach oben",
	actionMoveDown: "In der Liste nach unten",
	actionEditNote: "Notiz bearbeiten",
	actionDetails: "Katalogdetails anzeigen",
	removeModelConfirm: "Modell entfernen?",
	noteTitle: "Notiz (Preis, Kontext, Verwendung…)",

	exclusionsMenuTitle: (count, path) => `Harte Ausschlüsse (${count}) — ${path}`,
	addExclusionEntry: "＋ Ausschluss hinzufügen…",
	newExclusionTitle: "Neuer Ausschluss",
	newExclusionPlaceholder: "z. B. anthropic/claude-opus*, *:batch*",
	exclusionAdded: (pattern) => `Ausschluss hinzugefügt: ${pattern}`,
	exclusionRemoved: (pattern) => `Ausschluss entfernt: ${pattern}`,
	removeExclusionConfirm: "Diesen Ausschluss entfernen?",

	routerMenuTitle: (path, created) =>
		`Jev Router — ${path}${created ? " (wird bei der ersten Änderung erstellt)" : ""}`,
	menuAllowed: (count) => `Erlaubte Modelle: ${count}`,
	menuAddModel: "Modell hinzufügen…",
	menuExclusions: (count) => `Harte Ausschlüsse: ${count}`,
	menuTier: (tier) => `Cost tier: ${tier}`,
	menuEnabled: (active) => `Router: ${active ? "aktiv" : "deaktiviert"}`,
	menuRecommend: "3 Modelle empfehlen (Live-Katalog)…",
	menuBrowse: "OpenRouter-Katalog durchsuchen…",
	menuShow: "Effektive Konfiguration anzeigen",
	menuLanguage: (name) => `Sprache: ${name}`,
	menuClose: "Schließen",
	tierTitle: "Cost tier (Router-Richtlinie)",
	tierChanged: (tier) => `cost_tier = ${tier}`,
	routerToggled: (active) => `Router ${active ? "aktiv" : "deaktiviert"}`,
	languageTitle: "Sprache der Erweiterungsoberfläche",
	languageAuto: "Automatisch (Pi / System)",
	languageChanged: (name) => `Sprache: ${name}`,

	statusCatalog: "OpenRouter-Katalog…",
	recTitle: (count, freshness) => `jev-router-Empfehlungen — ${count} Modelle (${freshness})`,
	freshnessLive: "live",
	freshnessCache: (stamp) => `Cache vom ${stamp}`,
	freshnessRegistry: "lokaler Pi-Katalog (offline)",
	recCeiling: (ceiling, basis) => `Kostengrenze: ${ceiling} $/Mtok gemischt — ${basis}`,
	recCandidates: (count) => `Geeignete Kandidaten unter der Grenze: ${count}`,
	recMethod: "Heuristische Reihenfolge: aktueller Preis + angegebene Fähigkeiten + Kontext (kein Benchmark).",
	recNone: "Kein Kandidat: Liste erweitern oder harte Ausschlüsse lockern.",
	recPresent: "  (bereits in der Liste)",
	recPresentShort: "  (bereits vorhanden)",
	recScore: (score) => `Punktzahl ${score}/100`,
	ceilingTier: (tier, ceiling) => `cost_tier ${tier} begrenzt auf ${ceiling} $/Mtok`,
	ceilingTierEmptyListSuffix: " (leere Liste: Standardgrenze)",
	ceilingTierDearestSuffix: (dearest) => ` (teuerstes Modell der Liste: ${dearest} $/Mtok)`,
	ceilingNoList: "kein Modell der Liste im Katalog gefunden, Standardgrenze",
	ceilingDearest: (dearest) => `teuerstes Modell der Liste (${dearest} $/Mtok) + 10 %`,
	bandFlash: "Flash-Band",
	bandBalanced: "Ausgewogenes Band",
	bandPower: "High-End-Band",
	reasonBand: (band, limit) => `${band} (≤ ${limit} $/Mtok): bestes Verhältnis Fähigkeiten/Preis.`,
	reasonPower: (limit) =>
		`High-End-Band (≤ ${limit} $/Mtok): maximale Fähigkeiten zum niedrigsten Preis bei gleichen Fähigkeiten.`,
	reasonFill: "Ergänzung aus der Rangliste (unvollständiges Band).",
	reasonRevision: (pattern, price) =>
		price
			? `Aktuelle Revision von ${pattern} (${price} $/Mtok): prüfen, ob sie die alte ersetzt.`
			: `Aktuelle Revision von ${pattern}: prüfen, ob sie die alte ersetzt.`,
	reasonExperimental: "Experimentelle Variante: Stabilität prüfen, bevor darauf gesetzt wird.",
	peakPrice: (peakPrompt, peakCompletion) => ` (Spitze ${peakPrompt}/${peakCompletion})`,
	noteText: "Text",
	noteVision: "Vision",
	noteRecommendation: (role) => `Live-Empfehlung (${role})`,
	recPickerTitle: (ceiling) => `jev-router-Empfehlungen — Grenze ${ceiling} $/Mtok`,
	recAddAllMissing: (count) => `＋ Die ${count} fehlenden hinzufügen`,
	recAddMissingOne: "＋ Das fehlende hinzufügen",
	recAddNothing: "＋ Hinzufügen (nichts hinzuzufügen)",
	recAllPresent: "Die erlaubte Liste enthält diese drei Modelle bereits",
	recConfirmAddAll: "Diese Modelle zur erlaubten Liste hinzufügen?",
	recAddedList: (list) => `Hinzugefügt: ${list}`,
	recAddedNone: "Nichts hinzugefügt (bereits abgedeckt)",
	recAlreadyCoveredRole: (id, role) => `${id} ist bereits durch die erlaubte Liste abgedeckt (${role})`,
	recAlreadyCovered: (id) => `${id} ist bereits durch die erlaubte Liste abgedeckt`,
	recConfirmAdd: (id) => `${id} hinzufügen?`,
	recAddedOne: (id, role) => `Hinzugefügt: ${id} (${role})`,
	recFailed: (reason) => `Empfehlung nicht möglich: ${reason}`,

	statusInvalidConfig: "ungültige Konfiguration",
	statusOff: "aus",
	statusConfigMissing: "Konfiguration fehlt",
	statusTier: (tier) => `tier ${tier}`,
	missingConfigWarning: (path) =>
		`Jev Router: keine Konfiguration gefunden (${path}). Der Router ist nicht eingeschränkt. Führe /jev-models aus, um eine zu erstellen.`,
	summaryVirtual: (id) => `Virtuelles Modell: ${id} — mit /model auswählen, um in Pi zu routen`,
	routerConfigMissing: (path) =>
		`Jev Router: keine Konfiguration gefunden (${path}). jev/auto routet aus dem gesamten Katalog unter dem cost tier. Führe /jev-models aus, um ihn einzuschränken.`,
	routerNoCandidate: (band, ceiling) =>
		`Kein Modell verfügbar (${band}, Grenze ${ceiling} $/Mtok). excludedModels lockern, costTier erhöhen oder ein Modell mit /jev-models hinzufügen.`,

	cmdModels: "Die Modelle verwalten, die der Router typesafe/jev-router wählen darf",
	cmdRecommend: "Schlägt die 3 am besten geeigneten Modelle für den Router vor, aus dem Live-OpenRouter-Katalog",
	cmdRouter: "Zeigt die effektive Konfiguration des Routers typesafe/jev-router",
};

export const MESSAGES: Record<Language, Messages> = { en, fr, es, it, de };

/** Messages for a resolved language, defaulting to English. */
export function getMessages(language: Language): Messages {
	return MESSAGES[language] ?? MESSAGES[DEFAULT_LANGUAGE];
}
