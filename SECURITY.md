# Security

## Scope

`pi-jev-mgt` is a Pi extension that injects an OpenRouter router plugin into
requests and edits a local JSON configuration file.

- It does **not** read, store, log, or transmit API keys, tokens, or any other
  credential. Provider authentication is handled by Pi itself.
- The only outbound request it makes on its own is an anonymous
  `GET https://openrouter.ai/api/v1/models` (public catalog, no auth header).
- It writes exactly two local files: the configuration JSON (only when you
  change something through `/jev-models`) and a catalog cache
  (`jev-router-catalog.json`) used to keep recommendations working offline.

## Secrets in this repository

None. The example configuration is generic, there is no `.env` file, and the
CI workflow uses no repository secrets. If you plan to add a publishing
workflow, prefer npm trusted publishing (OIDC) over a long-lived `NPM_TOKEN`.

## Reporting a vulnerability

Open a private security advisory on GitHub:
<https://github.com/Tuxik/pi-jev-mgt/security/advisories/new>

Please do not open a public issue for a vulnerability before a fix is
available. Include the affected version, a minimal reproduction, and the
impact you expect.
