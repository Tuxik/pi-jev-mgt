# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
