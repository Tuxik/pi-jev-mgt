/**
 * Interactive side of pi-jev-mgt: the /jev-models manager, the /jev-recommend
 * flow and the effective-config summary.
 *
 * Everything here is UI; the policy it edits lives in config.ts and the ranking
 * it shows lives in catalog.ts. A selection comes back as the displayed *label*,
 * so every menu carries a stable row id next to its localized label and
 * dispatches on the id: a reworded or reordered translation cannot break a
 * dialog, and neither can a different language.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { LANGUAGE_NAMES, LANGUAGES, LOCALE_TAGS, getMessages, type Language, type Messages } from "./i18n.ts";
import {
	DEFAULT_COST_TIER,
	DEFAULT_ROUTER_MODEL,
	arrayField,
	exclusionFor,
	invalidateLanguage,
	isConcrete,
	languageLabel,
	loadRawConfig,
	patternOf,
	patternsOf,
	patternMatches,
	saveRawConfig,
	translator,
	type LanguageResolution,
	type ModelEntry,
	type RouterConfig,
} from "./config.ts";
import {
	catalogDetails,
	catalogMap,
	capabilitiesLabel,
	compactContext,
	contextLabel,
	fuzzyMatch,
	liveCapabilitiesLabel,
	livePriceLabel,
	loadLiveCatalog,
	priceLabel,
	recommendModels,
	recommendationNote,
	recommendationReport,
	sortByOutputCost,
} from "./catalog.ts";
import { VIRTUAL_MODEL_ID, VIRTUAL_PROVIDER } from "./router.ts";

export function describe(
	t: Messages,
	language: LanguageResolution,
	config: RouterConfig,
	path: string,
	missing: boolean,
	virtualId: string,
): string {
	const enabled = config.enabled !== false;
	const routerModel = config.routerModel ?? DEFAULT_ROUTER_MODEL;
	const tier = config.costTier ?? DEFAULT_COST_TIER;
	const lines = [
		t.summaryTitle(routerModel, enabled, tier),
		t.summaryConfig(path, missing),
		t.summaryLanguage(languageLabel(t, language)),
		t.summaryVirtual(virtualId),
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

export async function manageRouter(ctx: ExtensionCommandContext): Promise<void> {
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
				ctx.ui.notify(describe(t, language, config, path, missing, `${VIRTUAL_PROVIDER}/${VIRTUAL_MODEL_ID}`), "info");
			} else if (choice === "language") {
				await manageLanguage(ctx);
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
}


export async function recommendForRouter(ctx: ExtensionCommandContext): Promise<void> {
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
