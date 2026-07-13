# Paralume

Paralume（并译）is a local-first bilingual webpage translator for Chrome and
Edge. This repository currently contains **Milestone 0 only**: a loadable WXT
extension foundation with placeholder user interfaces and an inert background
entrypoint.

Translation extraction, messaging, batching, rendering, providers, and page
controls are intentionally not implemented in this milestone.

## Technology

- WXT and Manifest V3
- strict TypeScript
- React in the popup and options page only
- plain CSS
- Vitest with happy-dom
- pnpm

Core extension behavior added in later milestones must remain
framework-independent TypeScript. Provider work belongs in the background
service worker, and content scripts must never receive secrets.

## Repository layout

```text
entrypoints/
  background.ts       Inert MV3 service-worker entrypoint
  options/            Minimal React options boundary
  popup/              Minimal React popup boundary
tests/                Scaffold smoke tests
wxt.config.ts         WXT and manifest metadata
```

## Requirements

- Node.js 20.19 or newer, or Node.js 22.12 or newer
- pnpm 11.9 or newer (the repository pins pnpm through `packageManager`)

With Corepack enabled, install the pinned package-manager version and project
dependencies:

```sh
corepack enable
pnpm install
```

## Development

Start WXT for Chrome:

```sh
pnpm dev
```

Start WXT for Edge:

```sh
pnpm dev:edge
```

The popup and options page are intentionally informational in Milestone 0. The
background entrypoint registers no handlers. Milestone 0 deliberately registers
no content script and therefore does not run code on visited pages.

## Build and package

```sh
pnpm build
pnpm build:edge
pnpm zip
pnpm zip:edge
```

WXT writes unpacked builds and archives beneath `.output/`. The default Chrome
unpacked directory is `.output/chrome-mv3`; Edge builds use
`.output/edge-mv3`.

## Verification

Run checks individually:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Or run the complete local gate:

```sh
pnpm verify
```

After a production build, inspect `.output/chrome-mv3/manifest.json`. Milestone
0 requests no extension API permissions, no `host_permissions`, and registers
no content script. Page access will be introduced in Milestone 1 only after its
trigger and permission model are implemented and reviewed.

## Project rules

- Never rewrite a source page's `innerHTML` or execute provider output as HTML.
- Preserve original DOM nodes, links, listeners, and framework ownership.
- Keep React limited to popup and options UI.
- Validate all future cross-context messages and map translated results by
  stable IDs.
- Do not log secrets or complete sensitive page content.
- Keep permissions minimal and justify every addition.
- Keep changes within the active milestone and use conventional commit
  messages.

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md) before
making changes.

## License

No open-source license has been selected. See [LICENSE.md](./LICENSE.md).
