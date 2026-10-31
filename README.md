# pi-jev-mgt

[![CI](https://github.com/Tuxik/pi-jev-mgt/actions/workflows/ci.yml/badge.svg)](https://github.com/Tuxik/pi-jev-mgt/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-jev-mgt.svg)](https://www.npmjs.com/package/pi-jev-mgt)

Manage which models may answer, from inside [Pi](https://pi.dev): a curated allowed
list, hard cost exclusions, a cost tier, a per-model flash/balanced/power annotation,
and **live-price recommendations** for the 3 best models to put in that list.

```bash
pi install npm:pi-jev-mgt

pi --model jev/auto                 # standard path: Pi routes, natively
pi --model typesafe/jev-router      # OpenRouter's server-side router
```

## Objectives

This plugin has been vibe coded through Pi Agent. The aim is to manage the models
typesafe/jev-router picks, so that it selects the model that best matches your prompt.

The plugin is open to any pull request and contribution. Feel free to PR!

The extension UI is available in **English, French, Spanish, Italian and German**,
and follows the language selected in Pi (see [Languages](#languages)). This README
and the code comments are in English.

---

## Two ways to route

The same config file drives two routers. They are independent, and both can be
installed at once — selecting one model or the other is what picks the path.

| | `jev/auto` (standard) | `typesafe/jev-router` (OpenRouter) |
| --- | --- | --- |
| Who decides | **Pi**, in-process | OpenRouter, server-side |
| Mechanism | `pi.registerVirtualModel()` | `plugins: [{ id: "jev-router", … }]` in the request body |
| Configured by | this extension's config | this extension's config |
| Model recorded per message | Pi records the physical model | the placeholder, patched by this extension |
| Cost | **native**, computed by Pi | re-billed by this extension (the router reports `$0`) |
| `/session` cost per model | **native** | only through the re-billing |
| Footer `selection → routed` | **native** | this extension's status bar |
| Context window / compaction | **native** (physical model limits) | the placeholder's limits |
| Session resume | **native** | falls back to the last physical model |
| Routing quality | this extension's heuristic | the vendor's classifier |

**The standard path is the recommended one.** Pi's [virtual models](https://pi.dev/docs/latest/virtual-models)
already implement everything that is hard to get right — dispatch, recording,
cost, context accounting, prompt-cache preservation, session state. The extension
supplies only what Pi does not: the policy and the tooling around it.

## What Pi already does, and what this extension adds

Pi's virtual models provide the routing *mechanism*. Comparing the two, the
extension's additions are:

| Capability | Pi standard | This extension |
| --- | --- | --- |
| Pick a physical model per request | ✅ `registerVirtualModel` | uses it |
| Thinking level as a router input | ✅ passed to `route()` | maps it to a cost band |
| Record the physical model per message | ✅ | uses it |
| Real cost, `/session` cost per model | ✅ | uses it |
| Footer `auto • high → model • medium` | ✅ | — (status bar kept only for the OpenRouter path) |
| Context limits, compaction on overflow | ✅ | — |
| Cache-preserving stickiness (`previous` / `failed`) | ✅ API | implements the policy |
| Router state on the session branch | ✅ API | not needed (no phase) |
| **Curated allowed list** (`allowedModels`) | ❌ | ✅ + hot reload |
| **Hard exclusions** (`excludedModels`) | ❌ | ✅, enforced at route time |
| **Cost tier → cost ceiling** | ❌ | ✅, caps the routing pool |
| **Per-model `tier` annotation** | ❌ | ✅, drives band selection |
| **Interactive manager** (`/jev-models`) | ❌ | ✅ |
| **Live-price recommendation** (`/jev-recommend`) | ❌ | ✅ |
| **Config file + precedence + hot reload** | ❌ | ✅ |
| **Vendor-side routing** (OpenRouter) | ❌ | ✅, as a second path |
| **UI localization** (5 languages) | ❌ | ✅ |

So the refactor is one-directional: everything Pi can already do is delegated to
Pi, and the extension keeps the curation, guardrails, recommendations and i18n.

## The standard path: `jev/auto`

`jev/auto` is a virtual model registered under the `jev` provider. It has no
physical models and no credentials of its own, so it is always selectable in
`/model`, `--model` and `enabledModels`.

**The virtual thinking level is the band selector.** That is exactly what Pi means
by "its meaning is up to the router":

| Selected level | Band | Behaviour |
| --- | --- | --- |
| `off`, `minimal`, `low` | `flash` | cheap and fast; everyday edits and questions |
| `medium` | `balanced` | the default workhorse |
| `high`, `xhigh`, `max` | `power` | hard reasoning, large context, tool chains |

The dispatched reasoning effort never exceeds what you asked for: `off` stays
`off`, `max` on a power model stays `max`.

Routing rules, in order:

1. **Retry after a context overflow** → the eligible model with the largest context
   window, so the retry can actually fit.
2. **Tool follow-up (`continuation`) or retry with no overflow** → the model that
   handled the turn (`request.previous` / `request.failed`), which keeps the prompt
   cache and the thinking signatures valid. This is skipped when that model is now
   excluded, above the cost ceiling, or no longer in the allowed list: the hard
   guardrails win over cache reuse.
3. **Outside the agent loop** (`direct`: compaction summaries, extension calls) →
   the cheap band, so housekeeping never costs a frontier turn.
4. **Otherwise** → the band named by the thinking level. Within a band an explicit
   `tier` annotation in `allowedModels` wins, in list order (your own preference
   order); otherwise the price band is used, and flash/balanced rank by
   capability-per-dollar while power ranks by declared capability.

The router reads Pi's **local** catalog, so it never adds network latency to a
request. An empty `allowedModels` means "no restriction", exactly as it does for
the OpenRouter path: the whole catalog is eligible under the cost tier. If no
config file exists at all, `jev/auto` routes from the whole catalog and warns once.

## The OpenRouter path: `typesafe/jev-router`

`jev-router` is an OpenRouter router plugin: it picks the model (and reasoning
effort) per request. You constrain it by sending a plugin block in the request body:

```json
{ "plugins": [{ "id": "jev-router", "cost_tier": "low", "models": ["..."], "excluded_models": ["..."] }] }
```

`pi-jev-mgt` injects that block on every request sent to `routerModel`, and re-bills
the response at the routed model's tariff, because the router advertises `$0` per
token and Pi ignores OpenRouter's `usage.cost`. The routed model is shown in the
status bar (`→ vendor/model`).

OpenRouter semantics that shape the design:

| Field | Semantics |
| --- | --- |
| `models` | **preference list with fallback** — if no listed model is eligible, the router retries without the list |
| `excluded_models` | **hard restriction**, never ignored — this is the cost guardrail |

## Commands

| Command | Description |
| --- | --- |
| `/jev-models` | Interactive manager: allowed models (with live `✔`/`✖` + price/context), add from catalog or manual pattern, remove, reorder, edit note, manage hard exclusions, change cost tier, enable/disable, browse the catalog, language, recommendations |
| `/jev-recommend` | Fetch the live OpenRouter catalog and rank the **3 most suitable models** for the router (flash / balanced / power) under your cost ceiling; add the missing ones in one click |
| `/jev-router` | Print the effective configuration (non-interactive summary, including the active virtual model and UI language) |

`/jev-recommend` writes `tier` annotations, and the router reads them: a
recommendation is not just a suggestion, it becomes the routing policy.

## Configuration

Precedence, first match wins:

1. `$PI_JEV_ROUTER_CONFIG` — explicit path
2. `<cwd>/.pi/jev-router.json` — per-project override
3. `~/.pi/agent/jev-router.json` — global

The file is re-read whenever its mtime changes: **no `/reload` needed**.
`/jev-models` creates the global file on its first modification. Unknown keys are
preserved on write. Both routing paths read this one file.

```json
{
  "enabled": true,
  "routerModel": "typesafe/jev-router",
  "costTier": "low",
  "allowedModels": [
    { "model": "z-ai/glm-5.3-flash", "tier": "flash", "note": "cheap, 1M ctx, vision" },
    { "model": "anthropic/claude-haiku-5.5", "tier": "balanced", "note": "quality/price sweet spot" }
  ],
  "excludedModels": ["openrouter/*", "typesafe/*", "*:batch*", "*:free*", "anthropic/claude-opus*"]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `enabled` | boolean | `false` disables the OpenRouter request-body injection. `jev/auto` keeps routing |
| `routerModel` | string | Placeholder model for the OpenRouter path (keep `typesafe/jev-router`) |
| `costTier` | `low` \| `medium` \| `high` | Cost ceiling: `1` / `4` / `∞` USD per million blended tokens. Caps the routing pool; **not** the reasoning effort |
| `language` | `"auto"` \| `en` \| `fr` \| `es` \| `it` \| `de` | UI language; `"auto"` (default) follows Pi and the system. Also settable from `/jev-models` → *Language* |
| `allowedModels` | array | Entries: exact slug, dated revision, wildcard (`anthropic/*`, `*flash*`), alias (`~author/family-latest`), or `{ model, tier, note }` objects. Empty = no restriction |
| `excludedModels` | array | Hard exclusions, same pattern language. Never overridden by anything |

Entry `tier` accepts `flash`, `balanced` or `power`. It is **operative** on the
`jev/auto` path: the router prefers an entry whose declared tier matches the
requested band, in list order. The list is therefore a preference order, not a set.

A complete example lives in [`examples/jev-router.example.json`](examples/jev-router.example.json).
Model slugs and prices change constantly — verify them with `/jev-models` →
*Explorer le catalogue* or let `/jev-recommend` pick from the live catalog.

## How the recommendation works

1. Fetches `https://openrouter.ai/api/v1/models` (public, no credentials). Cached 10 minutes in memory and on disk at `~/.pi/agent/jev-router-catalog.json`; falls back to Pi's local model catalog when offline.
2. Drops non-candidates: `:free` / `:batch` / `:online` / `:extended` variants, `~author/family-latest` aliases, router slugs, models without tool calling, models without a `/chat/completions` endpoint, expired models, and anything matched by `excludedModels`.
3. Computes a **cost ceiling**: `min(1.1 × dearest allowed model found in the live catalog, cost-tier ceiling)`, with tier ceilings of `low = 1`, `medium = 4`, `high = ∞` USD per million blended tokens. The router uses the same function, so a recommendation is always routable.
4. Blended price = `(prompt + 2 × completion) / 3`, using the **worst-case** tariff: some providers bill more at peak hours via `pricing.overrides`. The report shows the base price and the peak price when they differ.
5. Splits the eligible pool into three registers — `flash` (≤ 12 % of the ceiling), `balanced` (≤ 45 %), `power` (above) — and picks:
   - flash / balanced: best capability-per-dollar in the band,
   - power: maximal declared capabilities at the lowest price,
   - with a small bonus for a different vendor than the already-picked models.
6. Marks models already covered by `allowedModels` as *(already in the list)* and keeps them ranked, so the top 3 never degrade into weaker models just because the best one is already allowed. A note flags a candidate that is the current revision of a pinned entry (useful when its live price differs from the note).

The ranking is a **heuristic**, not a benchmark: the catalog exposes no quality scores, so scores combine declared capabilities (tool calling, reasoning, vision, context window, freshness) minus a penalty for `exp` / `preview` / `alpha` / `beta` variants. Prices and price bands are real; treat the "score" as an ordering hint.

## Languages

Every on-screen string — status bar, notifications, dialogs, menus and the
slash-command descriptions — comes from `extensions/i18n.ts`, which ships one
catalog per supported language: `en` (default), `fr`, `es`, `it`, `de`.

Pi itself has no language setting, so the extension resolves the language from
the first source that names a supported one:

| # | Source | Notes |
| --- | --- | --- |
| 1 | `$PI_JEV_LANG` (or `$PI_JEV_ROUTER_LANG`) | Explicit, plugin-scoped override — handy for scripts and tests |
| 2 | `language` in the jev-router config | The value `/jev-models` → *Language* writes; same precedence as the config file |
| 3 | `$PI_LANG` | Forward-compatible Pi override |
| 4 | `language` in a Pi `settings.json` | `<cwd>/.pi/settings.json`, then `~/.pi/agent/settings.json` |
| 5 | `$LC_ALL`, `$LC_MESSAGES`, `$LANG` | Operating-system locale |
| 6 | — | English |

`"language": "auto"` (the default), an empty value or an unsupported tag means
"keep looking". Locale tags such as `fr-FR` or `de_DE.UTF-8` and native names
(`Français`, `Deutsch`, …) are accepted.

Pick a language interactively with `/jev-models` → *Language*; the choice is
written to the config and applied immediately, no `/reload` needed. Export
`PI_JEV_LANG=de` to override it for a single session:

```bash
PI_JEV_LANG=es pi --model jev/auto
```

Menu dispatch never compares translated labels: each row carries a stable id, so
translations can be reworded or reordered without breaking a dialog.

The one exception is the slash-command descriptions registered with Pi, which are
fixed at extension load time; a language change applies to them on the next Pi
start (or `/reload`).

## Safety, privacy, secrets

- **No credentials**: the extension never reads, stores, or sends API keys. Pi handles provider authentication; the public catalog endpoint requires none.
- Files written: the config JSON (only when you change something from the UI) and a catalog cache (`~/.pi/agent/jev-router-catalog.json`).
- Nothing leaves your machine except the anonymous `GET` to `openrouter.ai/api/v1/models` and the requests Pi already sends. `jev/auto` never adds a network call to the request path.
- This repository contains no keys, tokens, or personal model lists; the example config is generic. CI runs `gitleaks` on every push and pull request, and fails if a credential-like file or a local `jev-router.json` / catalog cache is ever tracked.

## Development

```bash
npm ci
npm run typecheck     # tsc --noEmit
npm run pack:check    # npm pack --dry-run: verify published file list
pi -e ./extensions/jev-router.ts --model jev/auto   # try the local extension for one session
```

Layout:

```text
extensions/jev-router.ts   # entry: registers jev/auto, the OpenRouter injection, the commands
extensions/router.ts       # the virtual-model routing policy (bands, stickiness, guardrails)
extensions/config.ts       # config file I/O, pattern matching, language resolution
extensions/catalog.ts      # live catalog, eligibility, scoring, ceiling, recommendation
extensions/ui.ts           # /jev-models, /jev-recommend, the effective-config summary
extensions/i18n.ts         # message catalog for the 5 supported languages
examples/                  # sample configuration
.github/workflows/ci.yml   # typecheck on push / PR
```

`router.ts` is the only module that depends on Pi's virtual-model API, and it does
no UI work; `ui.ts` edits the policy but never routes. That split is what keeps the
standard mechanism replaceable.

Publishing (after `npm login`, once you own the name):

```bash
npm version patch
npm publish            # keywords: pi-package -> discoverable on https://pi.dev/packages
git push --follow-tags
```

Pi resolves the extension through the `pi.extensions` manifest in `package.json`. Host packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) are declared as optional `peerDependencies` and are **not** bundled, so Pi supplies its own instances.

## Français (résumé)

`pi-jev-mgt` gère les modèles qui peuvent répondre depuis Pi : liste autorisée,
exclusions dures (garde-fou anti-coût), `cost_tier`, annotation `tier` par modèle,
et recommandation des **3 modèles les plus adaptés** d'après les prix OpenRouter
du moment.

Deux chemins, un seul fichier de config :

- **`jev/auto`** (recommandé) — un *modèle virtuel* Pi enregistré par l'extension.
  Pi choisit, enregistre et facture le modèle physique : coût réel, `/session`,
  limites de contexte, reprise de session et affichage `auto • high → modèle`
  fonctionnent nativement. Le niveau de réflexion sélectionné sert de sélecteur de
  gamme (`low` → flash, `medium` → balanced, `high`/`max` → power).
- **`typesafe/jev-router`** — le routeur côté OpenRouter : l'extension injecte
  `cost_tier` / `models` / `excluded_models` dans chaque requête et refacture la
  réponse au tarif du modèle retenu.

Commandes : `/jev-models`, `/jev-recommend`, `/jev-router`. La config vit dans
`~/.pi/agent/jev-router.json` (ou `<projet>/.pi/jev-router.json`, ou
`$PI_JEV_ROUTER_CONFIG`) et est relue à chaud. L'interface est disponible en
anglais (par défaut), français, espagnol, italien et allemand : la langue suit Pi
(réglages, `$PI_LANG`, locale système) et se choisit dans `/jev-models` → *Langue*
ou via `language` dans la config (`"auto"` par défaut). Aucune clé n'est lue ni
stockée.

## License

[MIT](LICENSE) © 2026 Tuxik
