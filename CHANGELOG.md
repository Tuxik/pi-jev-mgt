# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Localized UI in English (default), French, Spanish, Italian and German.
  Every on-screen string — status bar, notifications, dialogs, menus and the
  slash-command descriptions — now comes from `extensions/i18n.ts`, which holds
  one typed catalog per language so a translation cannot silently miss a message.
- Language resolution chain: `$PI_JEV_LANG` / `$PI_JEV_ROUTER_LANG`, then the
  `language` key of the jev-router config, then `$PI_LANG`, then `language` in a
  Pi `settings.json`, then `$LC_ALL` / `$LC_MESSAGES` / `$LANG`, then English.
  Locale tags (`fr-FR`, `de_DE.UTF-8`) and native names (`Français`, `Deutsch`)
  are accepted; `"auto"` means "keep looking".
- `/jev-models` → *Language* picker (Automatic + the 5 languages). The choice is
  written to the config and applied immediately, without `/reload`.

### Changed

- Interactive menus dispatch on stable row ids instead of the displayed label,
  so reworded or reordered translations can no longer break a dialog.
- The effective-config summary (`/jev-router`) also reports the UI language.

## [0.1.0] - 2026-10-30

### Added

- Inject the OpenRouter `jev-router` plugin (`cost_tier`, `models`,
  `excluded_models`) on every request sent to the router model, from a config
  file re-read on mtime change (no `/reload`).
- `/jev-models`: interactive manager for allowed models, hard exclusions,
  cost tier, enable flag, plus a catalog browser.
- `/jev-router`: non-interactive summary of the effective configuration.
- `/jev-recommend`: live OpenRouter catalog fetch and ranking of the 3 most
  suitable models (flash / balanced / power) under a cost ceiling derived from
  the allowed list and the cost tier, with one-click add.
- Cost ceiling and blended price use the worst-case tariff, including
  `pricing.overrides` peak-hour prices; the report shows both base and peak.
- Status bar shows the model actually chosen by the router.
- Assistant messages are recosted at the routed model's price, because the
  router reports `$0` per token and Pi ignores OpenRouter's `usage.cost`.
