# pi-jev-mgt

[![CI](https://github.com/Tuxik/pi-jev-mgt/actions/workflows/ci.yml/badge.svg)](https://github.com/Tuxik/pi-jev-mgt/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-jev-mgt.svg)](https://www.npmjs.com/package/pi-jev-mgt)

Manage OpenRouter's [`jev-router`](https://openrouter.ai/) from inside [Pi](https://pi.dev): curated allowed models, hard cost exclusions, cost tier, and **live-price recommendations** for the 3 best models to hand to the router.

```bash
pi install npm:pi-jev-mgt
pi --model typesafe/jev-router
```


## Objectives 

This plugin has been vibe coded through Pi Agent. The aim it to provide a plugin to manage typesafe/jev-router's model to make it select the model perfect match against your prompts. 

This plugin is opened to any pull request and contribution. Feel free to PR !

The extension UI is available in **English, French, Spanish, Italian and German**,
and follows the language selected in Pi (see [Languages](#languages)). This README
and the code comments are in English.

---

## What it does

`jev-router` is an OpenRouter router plugin: it picks the model (and reasoning effort) per request. You constrain it by sending a plugin block in the request body:

```json
{ "plugins": [{ "id": "jev-router", "cost_tier": "low", "models": ["..."], "excluded_models": ["..."] }] }
```

`pi-jev-mgt` injects that block on every request sent to the router model, and gives you Pi commands to edit the restriction. It also fixes cost reporting: the router advertises `$0` per token and Pi ignores OpenRouter's `usage.cost`, so the extension recosts each assistant message at the price of the model the router actually used.

OpenRouter semantics that shape the design:

| Field | Semantics |
| --- | --- |
| `models` | **preference list with fallback** — if no listed model is eligible, the router retries without the list |
| `excluded_models` | **hard restriction**, never ignored — this is the cost guardrail |

## Commands

| Command | Description |
| --- | --- |
| `/jev-models` | Interactive manager: allowed models (with live `✔`/`✖` + price/context), add from catalog or manual pattern, remove, reorder, edit note, manage hard exclusions, change cost tier, enable/disable, browse the catalog, get recommendations |
| `/jev-recommend` | Fetch the live OpenRouter catalog and rank the **3 most suitable models** for the router (flash / balanced / power) under your cost ceiling; add the missing ones in one click |
| `/jev-router` | Print the effective configuration (non-interactive text summary) |

The routed model is displayed in the status bar (`→ vendor/model`) on every response.

## Configuration

Precedence, first match wins:

1. `$PI_JEV_ROUTER_CONFIG` — explicit path
2. `<cwd>/.pi/jev-router.json` — per-project override
3. `~/.pi/agent/jev-router.json` — global

The file is re-read whenever its mtime changes: **no `/reload` needed**. `/jev-models` creates the global file on its first modification. If no file exists, the router is left unrestricted and a warning is shown.

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
| `enabled` | boolean | `false` disables plugin injection without switching models |
| `routerModel` | string | Router slug (keep `typesafe/jev-router`) |
| `costTier` | `low` \| `medium` \| `high` | Router policy, **not** the reasoning effort |
| `language` | `"auto"` \| `en` \| `fr` \| `es` \| `it` \| `de` | UI language of the extension; `"auto"` (default) follows Pi and the system. Also settable from `/jev-models` → *Language* |
| `allowedModels` | array | Entries: exact slug, dated revision, wildcard (`anthropic/*`, `*flash*`), alias (`~author/family-latest`), or `{ model, tier, note }` objects |
| `excludedModels` | array | Hard exclusions, same pattern language |

A complete example lives in [`examples/jev-router.example.json`](examples/jev-router.example.json). Model slugs and prices change constantly — verify them with `/jev-models` → *Explorer le catalogue* or let `/jev-recommend` pick from the live catalog.

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
PI_JEV_LANG=es pi --model typesafe/jev-router
```

Menu dispatch never compares translated labels: each row carries a stable id, so
translations can be reworded or reordered without breaking a dialog.

The one exception is the slash-command descriptions registered with Pi, which are
fixed at extension load time; a language change applies to them on the next Pi
start (or `/reload`).

## How the recommendation works

1. Fetches `https://openrouter.ai/api/v1/models` (public, no credentials). Cached 10 minutes in memory and on disk at `~/.pi/agent/jev-router-catalog.json`; falls back to Pi's local model catalog when offline.
2. Drops non-candidates: `:free` / `:batch` / `:online` / `:extended` variants, `~author/family-latest` aliases, router slugs, models without tool calling, models without a `/chat/completions` endpoint, expired models, and anything matched by `excludedModels`.
3. Computes a **cost ceiling**: `min(1.1 × dearest allowed model found in the live catalog, cost-tier ceiling)`, with tier ceilings of `low = 1`, `medium = 4`, `high = ∞` USD per million blended tokens.
4. Blended price = `(prompt + 2 × completion) / 3`, using the **worst-case** tariff: some providers bill more at peak hours via `pricing.overrides`. The report shows the base price and the peak price when they differ.
5. Splits the eligible pool into three registers — `flash` (≤ 12 % of the ceiling), `balanced` (≤ 45 %), `power` (above) — and picks:
   - flash / balanced: best capability-per-dollar in the band,
   - power: maximal declared capabilities at the lowest price,
   - with a small bonus for a different vendor than the already-picked models.
6. Marks models already covered by `allowedModels` as *(already in the list)* and keeps them ranked, so the top 3 never degrade into weaker models just because the best one is already allowed. A note flags a candidate that is the current revision of a pinned entry (useful when its live price differs from the note).

The ranking is a **heuristic**, not a benchmark: the catalog exposes no quality scores, so scores combine declared capabilities (tool calling, reasoning, vision, context window, freshness) minus a penalty for `exp` / `preview` / `alpha` / `beta` variants. Prices and prices bands are real; treat the "score" as an ordering hint.

## Safety, privacy, secrets

- **No credentials**: the extension never reads, stores, or sends API keys. Pi handles provider authentication; the public catalog endpoint requires none.
- Files written: the config JSON (only when you change something from the UI) and a catalog cache (`~/.pi/agent/jev-router-catalog.json`, or under the resolved project path).
- Nothing leaves your machine except the anonymous `GET` to `openrouter.ai/api/v1/models` and the requests Pi already sends.
- This repository contains no keys, tokens, or personal model lists; the example config is generic. CI runs `gitleaks` on every push and pull request, and fails if a credential-like file or a local `jev-router.json` / catalog cache is ever tracked.

## Development

```bash
npm ci
npm run typecheck     # tsc --noEmit
npm run pack:check    # npm pack --dry-run: verify published file list
pi -e ./extensions/jev-router.ts   # try the local extension for one session
```

Layout:

```text
extensions/jev-router.ts   # the extension itself
extensions/i18n.ts         # message catalog for the 5 supported languages
examples/                  # sample configuration
.github/workflows/ci.yml   # typecheck on push / PR
```

Publishing (after `npm login`, once you own the name):

```bash
npm version patch
npm publish            # keywords: pi-package -> discoverable on https://pi.dev/packages
git push --follow-tags
```

Pi resolves the extension through the `pi.extensions` manifest in `package.json`. Host packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) are declared as optional `peerDependencies` and are **not** bundled, so Pi supplies its own instances.

## Français (résumé)

`pi-jev-mgt` gère le routeur OpenRouter `typesafe/jev-router` depuis Pi : liste de modèles autorisés, exclusions dures (garde-fou anti-coût), `cost_tier`, et recommandation des **3 modèles les plus adaptés** d'après le catalogue et les prix OpenRouter du moment. Commandes : `/jev-models`, `/jev-recommend`, `/jev-router`. La config vit dans `~/.pi/agent/jev-router.json` (ou `<projet>/.pi/jev-router.json`, ou `$PI_JEV_ROUTER_CONFIG`) et est relue à chaud. L'interface est disponible en anglais (par défaut), français, espagnol, italien et allemand : la langue suit Pi (réglages, `$PI_LANG`, locale système) et se choisit dans `/jev-models` → *Langue* ou via `language` dans le fichier de config (`"auto"` par défaut). Aucune clé n'est lue ni stockée : l'extension n'interroge que le catalogue public des modèles.

## License

[MIT](LICENSE) © 2026 Tuxik
