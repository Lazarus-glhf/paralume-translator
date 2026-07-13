# Paralume

Paralume（并译）is a local-first bilingual webpage translator for Chrome and
Edge. Milestone 1 implements a complete, deterministic Mock translation loop:
extract readable page blocks, send validated requests to the background service
worker, batch them, generate Mock output, and place each translation directly
with its original block.

The Mock provider proves the extension workflow but does **not** perform real
translation. Its deterministic output is prefixed with `【Mock zh-CN】` so it
cannot be mistaken for a production translation service.

## Current functionality

Open the popup and explicitly choose an action:

- **Translate current page** injects the page runtime on demand and translates
  eligible, unprocessed blocks.
- **Hide/Show translations** changes only the visibility of existing
  translation blocks and never calls the provider.
- **Clear translations** removes Paralume-owned translation nodes and markers,
  restoring the original page structure.

Repeated popup actions and repeated runtime injection are idempotent. Original
DOM nodes, inline links, event listeners, and framework ownership are retained;
provider output is inserted with `textContent`, never as executable HTML.
Concurrent Translate commands share one in-flight request. Clear invalidates any
pending Translate generation, so a late response cannot restore cleared or
newer translation state. Toggle always updates the translations currently
present; pending results use that visibility when they finish. If no translation
exists yet, Toggle is a no-op and pending results remain visible.

The Options page honestly reports that Mock mode is active and exposes no API
key or provider settings.

## Page eligibility

Paralume considers these whole-block candidates:

```text
p, li, blockquote, h1-h6, td, th, figcaption
```

Readable text is normalized from `innerText`. A block needs at least eight
letters or numbers to avoid translating labels and visual noise. Structural
containers (`li`, `td`, and `th`) take precedence over every nested candidate
and are translated as one readable block. For other nesting, the deepest
eligible blocks are selected. Paragraphs containing inline links remain one
segment.

Normal blocks receive an immediate sibling translation `div`. For `li`, `td`,
and `th`, Paralume appends the translation `div` inside the original container
after its original content. This preserves list numbering, list-item count,
table columns, source child nodes, and links; Paralume never creates sibling
`li`, `td`, or `th` elements.

Paralume excludes code and preformatted regions, scripts and styles, forms and
buttons, navigation and footer regions, SVG/canvas content, editable content,
hidden content, runtime-owned nodes, and blocks already processed by Paralume.
Runtime-private registries are the ownership authority. `data-paralume-*`
attributes remain only for styling, diagnostics, and browser tests, so matching
attributes authored by the host page are not trusted, removed, overwritten, or
used by themselves to exclude content.

## Architecture

- WXT packages Manifest V3 extensions for Chrome and Edge.
- React is limited to Popup and Options.
- Extraction, eligibility, protocol validation, provider contracts, Mock
  translation, batching, rendering, cleanup, and the page controller are strict,
  framework-independent TypeScript.
- The popup queries the active tab only after a user action, injects the WXT
  unlisted `paralume.js` artifact with `browser.scripting.executeScript`, and
  sends a validated page command.
- The page runtime extracts source segments and sends only validated translation
  requests to the background service worker.
- The background service worker owns provider execution. Content scripts do not
  receive provider configuration or secrets.
- Stable segment IDs come from a per-runtime element `WeakMap`. Duplicate text
  receives distinct IDs, and the same element keeps its ID across repeated
  extraction even if its DOM position changes. Results are reconciled by ID,
  including reordered, missing, duplicate, and partial provider results.
- Batching enforces segment and character bounds plus limited concurrency.
- Each page request is limited to the first 200 eligible blocks and 50,000 total
  source characters in document order. A partial request reports how many later
  blocks were skipped; another explicit Translate action can process the next
  prefix. The background boundary independently rejects over-budget forged
  requests with a structured `REQUEST_LIMIT_EXCEEDED` response.

## Permissions

The generated manifest requests exactly:

- `activeTab` — temporary access to the current tab following an explicit
  extension action.
- `scripting` — programmatic injection of `paralume.js` into that tab.

There are no broad `host_permissions` and no static `content_scripts`
registration. Browser-internal, extension, and other restricted pages return a
clear popup error instead of attempting injection.

## Repository layout

```text
entrypoints/
  background.ts       Validated Mock provider service-worker boundary
  paralume.ts         Unlisted, programmatically injected page runtime
  options/            Minimal React Mock-mode information boundary
  popup/              React page controls and accessible status/error UI
src/
  content/             Eligibility, extraction, rendering, cleanup, controller
  messaging/           Runtime protocol, validation, background handler
  popup/               Framework-independent popup command client
  shared/              Shared types and structured errors
  translation/         Provider contract, Mock provider, batching
tests/                 Vitest and happy-dom unit/integration tests
e2e/                   Playwright extension tests and static fixture server
```

## Requirements and setup

- Node.js 20.19 or newer, or Node.js 22.12 or newer
- pnpm 11.9 or newer (pinned through `packageManager`)

```sh
corepack enable
pnpm install
pnpm exec playwright install chromium
```

On a fresh Linux CI image that also needs browser system packages, use
`pnpm exec playwright install --with-deps chromium` instead.

## Development and builds

```sh
pnpm dev
pnpm dev:edge
pnpm build
pnpm build:edge
```

WXT writes unpacked builds beneath `.output/chrome-mv3` and
`.output/edge-mv3`.

## Verification

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm build:edge
pnpm test:e2e
```

`pnpm test:e2e` rebuilds the unpacked Chrome extension, starts the deterministic
fixture server on `127.0.0.1:4173`, and runs the suite with Playwright's pinned
Chromium. `pnpm verify` runs the complete format, lint, typecheck, unit, Chrome
build, Edge build, and E2E sequence.

After each build, inspect the generated manifest and confirm that permissions
are exactly `activeTab` and `scripting`, with no `host_permissions` or
`content_scripts` keys.

The Playwright release gate opens the real fixture URL at
`http://127.0.0.1:4173/static-article.html`, activates that exact Chromium tab
target, and invokes the installed extension's default action with the browser
CDP `Extensions.triggerAction` command. This creates the actual toolbar popup
and grants `activeTab` for the selected HTTP tab. Toolbar popups are not exposed
through `BrowserContext.pages()`, so a focused helper discovers the newly
created popup with the CDP `Target` APIs, attaches to its real DOM, and clicks
the React Translate, Hide/Show, and Clear buttons.

That release-gate test asserts that the popup sees the HTTP fixture as its
active tab, reports successful translate/repeat/toggle/clear status, and changes
the fixture DOM. It does not pre-inject `paralume.js`, call the content runtime
directly, use `setContent`, or substitute an extension page. With no static
`content_scripts` and no `host_permissions`, the successful result exercises the
production popup path: `tabs.query` → `scripting.executeScript(paralume.js)` →
`tabs.sendMessage` → background Mock provider → safe page rendering.

A separate, clearly labeled lower-level content-runtime integration test still
loads the fixture into an extension-owned page, injects the built runtime, and
sends runtime commands directly. It retains the detailed structural placement,
text-only output, source-node/listener preservation, exclusion, idempotency,
toggle, and cleanup assertions, but it does **not** claim to prove `activeTab` or
the popup injection path. Restricted-page handling is also exercised through
the React popup UI. The live OpenAI documentation compatibility check remains a
separate Hermes verification step.

## Current limitations

- Mock output is deterministic workflow proof, not a real translation.
- Source language is fixed to automatic detection and the Mock target label is
  fixed to `zh-CN`; there are no settings yet.
- Extraction runs only when Translate is requested. Dynamically added content
  is not observed automatically in Milestone 1.
- Complex real-world list/table layouts still need a broader compatibility test
  matrix beyond the deterministic fixture.
- Browser-protected pages cannot be translated. Local `file:` pages also depend
  on the browser's per-extension file-access setting.
- PDF, video/subtitle, OCR, accounts, cloud sync, payments, Firefox, and real
  provider integration are out of scope.

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md) before
making changes.

## License

No open-source license has been selected. See [LICENSE.md](./LICENSE.md).
