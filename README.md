# Paralume

**English** | [简体中文](./README.zh-CN.md)

Paralume（并译）is a local-first bilingual webpage translator for Chrome and
Edge. It extracts readable page blocks, sends validated requests to the
background service worker, batches provider work, and places each translation
directly with its original block.

Alpha `0.0.3` adds progressive, viewport-prioritized translation, faster
multi-batch rendering, a floating in-page control, and source-aware translation
styling. Selectable OpenAI-compatible and Microsoft
Translator BYOK providers remain available. The deterministic Mock provider is
used only when explicitly selected for development; Paralume never falls back
to Mock after a real-provider configuration or request failure.

Paralume is currently an **alpha prerelease** intended for tester feedback.
GitHub Releases provide reviewed Chrome and Edge ZIP assets for unpacked
installation. Chrome Web Store and Microsoft Edge Add-ons publishing are not
automated or part of the current release workflow.

## Tester installation from GitHub Releases

1. Open the repository's
   [GitHub Releases](https://github.com/Lazarus-glhf/paralume-translator/releases)
   page and select the intended prerelease.
2. Download the ZIP for your browser, named like
   `paralume-translator-0.0.3-chrome.zip` or
   `paralume-translator-0.0.3-edge.zip`, plus the matching
   `SHA256SUMS.txt` file.
3. Verify the ZIP's SHA-256 digest against its line in the checksum file. For
   example, use `sha256sum <zip>` on Linux, `shasum -a 256 <zip>` on macOS,
   or `Get-FileHash <zip> -Algorithm SHA256` in PowerShell.
4. Extract the ZIP into a permanent local folder. Do not select the ZIP itself
   in the browser and do not delete the extracted folder while the extension is
   installed.
5. In Chrome, open `chrome://extensions`; in Edge, open `edge://extensions`.
   Enable **Developer mode**, choose **Load unpacked**, and select the extracted
   folder containing `manifest.json`.

Unpacked prereleases do not update automatically. Repeat the download,
verification, and unpacked installation steps for a newer prerelease.

Paralume is BYOK software. Real-provider API keys are stored in
`chrome.storage.local` in the local browser profile, which is **not an encrypted
vault**. Use a limited-purpose key, review provider quota and billing controls,
and clear the key from Options when it is no longer needed. The deterministic
Mock provider needs no credential and never contacts a translation provider.

## Current functionality

Open the popup and explicitly choose an action:

- **Translate page** injects the page runtime on demand and translates
  eligible, unprocessed blocks.
- **Show / hide** changes only the visibility of existing
  translation blocks and never calls the provider.
- **Clear** synchronously removes Paralume-owned translation nodes and markers,
  restores the original page structure, and sends cancellation for active page
  translation operations without waiting for settings IPC.

Repeated popup actions and repeated runtime injection are idempotent. Original
DOM nodes, inline links, event listeners, and framework ownership are retained;
provider output is inserted with `textContent`, never as executable HTML.
Concurrent Translate commands share one in-flight page task. Paralume prioritizes
readable blocks intersecting the current viewport, sends a four-block first-response
batch, then uses provider-sized follow-up batches (up to 20 segments and 6,000 source
characters) with at most three requests in flight. Each completed batch renders
immediately instead of waiting for the slowest batch. Visible documentation code blocks
(`pre`) are translated as one block; nested code spans are not duplicated. Semantic line
breaks from `br` elements and preformatted text are preserved in provider input.
Translated newlines, blank lines, and list markers render through inert `textContent`
with `white-space: pre-wrap`; HTML source indentation is still collapsed and provider
output is never interpreted as markup. Every batch and manual retry has its own validated
opaque UUID, and Clear cancels all active batch operations. Before rendering an async
result, the content runtime verifies that its source remains in the current document and
still matches the captured normalized text; changed or detached sources are skipped and
remain eligible for a later Translate action. Original DOM nodes, inline links,
event listeners, and framework ownership are retained; provider output is inserted
with `textContent`, never as executable HTML.

The Options page selects the provider, edits provider-specific settings, saves
or clears masked credentials, and runs a one-segment connection test. A blank
masked key field preserves an existing stored key; the key itself is never read
back into Options. It also configures automatic retry, translation appearance,
and UI language (`system`, `zh-CN`, or `en`).

Recoverable whole-batch failures (`RATE_LIMITED`, `REQUEST_TIMEOUT`,
`NETWORK_ERROR`, and `SERVER_UNAVAILABLE`) are retried automatically when
enabled, with at most two additional attempts. Backoff is bounded exponential
delay with jitter, and a valid provider `Retry-After` hint is honored only
within a safe upper bound. Authentication, permission, validation,
configuration, malformed JSON, malformed structured output, missing/duplicate
result, and other permanent failures are not retried automatically. Automatic
retry repeats the same whole batch and can increase provider usage or cost; it
never silently splits a malformed batch and never falls back to Mock.

Only genuine failures returned in a provider result array receive an accessible
bottom-right **Retry** control. Request-wide authentication, permission,
configuration, validation, malformed-output, invalid-message, and internal
failures are reported once through the safe popup/status error boundary and do
not create per-segment Retry requests. Manual retry sends only that source
segment, deduplicates repeated clicks, shows a pending state, and replaces the
same failure node on success.

Clear removes Paralume UI synchronously, advances the content generation, and
requests cancellation without waiting for cancellation IPC. The background
listener returns literal `true` to keep the one-time runtime response channel
open, and the running handler event keeps the worker active while its in-flight
promise settles, subject to Chromium's normal lifetime limits. In an active
worker, cancellation aborts retry sleep, provider fetch, and response-body
reads. If Chromium forcibly terminates the worker process or execution context,
that context's fetches, timers, retries, and `AbortController`s terminate with
it; a restarted handler has fresh in-memory state and cannot abort an already
nonexistent old-context controller. A cancel that reaches the new handler
before a reordered translate is retained as a bounded, sender-scoped pending
cancellation. Content-side generation checks reject any late response, so
cleared or newer UI cannot be overwritten.

Chromium still applies its normal extension-worker lifetime limits, and an
upstream request accepted before cancellation or worker termination may still
complete or be billed. Cancellation reduces avoidable work but is not an
absolute fee-prevention guarantee; provider quota and billing limits remain
important.

## Provider settings

Settings are versioned and stored in `chrome.storage.local`. Alpha `0.0.2`
migrates schema v1 data to v2 in place, preserving provider configuration and
both API keys while adding retry, appearance, and language defaults. Public
settings responses never include keys:

- **Mock** is deterministic development output and must be selected explicitly.
- **OpenAI-compatible** is the fresh-install default. It accepts an HTTPS Base URL, model, reasoning effort, API
  key, and a user-selected protocol: Responses (`/responses`) or Chat
  Completions (`/chat/completions`). Until a key and exact origin permission are
  configured, Translate reports the configuration error clearly and never falls
  back to Mock. The selected endpoint must support strict `json_schema` output
  and the chosen protocol's reasoning field
  (`reasoning.effort` for Responses or `reasoning_effort` for Chat
  Completions). Chat content may be a string or an array containing only common
  text parts; other content parts are rejected. Paralume requires stable
  segment IDs and rejects missing, duplicate, unknown, or additional fields.
- **Microsoft Translator** accepts an HTTPS Endpoint, API Key, and Region. It
  calls Translator v3 at `/translate?api-version=3.0&to=zh-Hans` and sends the
  Azure subscription key and region headers.

Credentials are stored locally in the browser profile. `chrome.storage.local`
is **not an encrypted vault**; anyone or any software with access to the browser
profile may be able to recover its contents. Options receives only
`apiKeyConfigured` flags from the background and provides explicit per-provider
clear buttons. Content scripts receive neither provider configuration nor
credentials.

OpenAI-compatible batches remain bounded at 20 segments and 6,000 source
characters. Malformed JSON, malformed structured output, missing IDs, duplicate
IDs, and partial batches fail the whole batch clearly and are never
automatically split into per-segment provider calls. The connection test sends
the short text `Paralume connection test.` and may consume provider quota.

Provider, fetch, storage, permission, and background exceptions are converted
to an allowlisted structured error code with a fixed safe message before they
cross a runtime boundary. Upstream exception text, causes, URLs, response
bodies, credentials, and source-page text are never included in settings,
translation, per-segment failure, content-controller, or popup error responses.

## Retry, appearance, and language

Appearance settings affect only Paralume-owned translation, failure, pending,
Retry, and floating-control UI. By default, each translation follows its own source
block's computed typography: font family and size, weight, style, line height, spacing,
alignment, text transform, direction, and preformatted whitespace. Headings,
paragraphs, quotes, table cells, and code blocks therefore retain distinct hierarchy.
Explicit font-family, font-size, or line-height settings override only that matching
source-derived field. Source text/background colors and opacity are also followed while
the matching appearance setting remains at its safe default; changing that setting makes
it an explicit override. Translation spacing remains a validated Paralume control.
Source DOM nodes and inline styles are not rewritten; arbitrary CSS declarations, URLs,
and executable values remain rejected.

Interface language choices are `system` (default), `zh-CN`, and `en`. System
resolution uses the browser UI language with a safe English fallback. Popup,
Options, page failure/retry/pending UI, statuses, validation messages, and fixed
errors are localized at the rendering boundary. Runtime protocols use stable
message identifiers and error codes rather than English text as logic keys.

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
- Extraction, eligibility, protocol validation, provider contracts, HTTP
  providers, retry policy, localization, appearance validation/application,
  batching, rendering, cleanup, settings, and the page controller are strict,
  framework-independent TypeScript.
- The popup queries the active tab only after a user action, injects the WXT
  unlisted `paralume.js` artifact with `browser.scripting.executeScript`, and
  sends a validated page command.
- The page runtime extracts source segments and sends only validated translation
  requests to the background service worker.
- The background service worker owns settings reads, provider selection,
  provider execution, and automatic whole-batch retry. Options submits
  replacement credentials through a
  validated runtime message but never reads stored keys. Content scripts do not
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

The generated manifest requests these install-time extension permissions:

- `activeTab` — temporary access to the current tab following an explicit
  extension action.
- `scripting` — programmatic injection of `paralume.js` into that tab.
- `storage` — versioned provider settings and local BYOK credential persistence.

There are no granted `host_permissions` and no static `content_scripts`
registration. The manifest declares `optional_host_permissions` as
`https://*/*` because Chrome requires every potentially user-configured custom
HTTPS endpoint to be covered by a static optional match pattern. This wildcard
is not granted at install time. When real-provider settings are saved, Paralume
derives and requests only the exact configured origin pattern, such as
`https://api.example.com/*`; paths, queries, fragments, embedded credentials,
and non-HTTPS endpoints are rejected. The background checks that exact grant
again before every provider use, so a revoked permission produces a clear
failure before any fetch. Saving a changed endpoint removes the previous exact
origin grant so stale provider permissions do not accumulate.

Browser-internal, extension, and other restricted pages return a clear popup
error instead of attempting injection.

## Repository layout

```text
entrypoints/
  background.ts       Validated settings/provider service-worker boundary
  paralume.ts         Unlisted, programmatically injected page runtime
  options/            React provider settings and masked credential UI
  popup/              React page controls and accessible status/error UI
src/
  content/             Eligibility, extraction, rendering, cleanup, controller
  localization/        English/Chinese catalogs, locale resolution, formatting
  messaging/           Translation/settings protocols, validation, routing
  options/             Framework-independent Options runtime client
  popup/               Framework-independent popup command client
  settings/            Versioned storage, validation, exact-origin permissions
  shared/              Shared types and structured errors
  translation/         Mock, OpenAI, Microsoft, registry, batching, HTTP safety
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

## Prerelease packaging and versioning

`package.json` is the single release-version source. It uses canonical numeric
SemVer such as `0.0.3`, which is also valid as a Chromium manifest version. The
current Alpha target is `0.0.3`; a reviewed prerelease uses tag
`v0.0.3`, while the future first stable release will use `0.1.0`. WXT derives
both generated Chrome and Edge manifest versions
from that value; do not add a duplicate hard-coded version to `wxt.config.ts`.

To simulate release packaging locally after installing Playwright:

```sh
pnpm verify
pnpm release:metadata
pnpm release:package
```

`pnpm release:package` rebuilds both WXT ZIPs, validates the unpacked and zipped
manifests, checks required archive paths, and writes stable browser ZIPs plus a
SHA-256 checksum file beneath `release-assets/`.

For a tag-driven prerelease, update only the `package.json` version and lockfile
if needed, complete review and verification on `main`, then create the exact
matching tag `v<package-version>` (for example, `v0.0.3`). Pushing that tag runs
the release gate and creates an Alpha GitHub prerelease. A mismatched,
non-canonical, or placeholder version fails before packaging.

The workflow can also be dispatched manually from `main` with an exact version
input matching `package.json`. After the same gate passes, the final job creates
the matching tag and GitHub prerelease at the dispatched commit. Only that final
job receives `contents: write`; verification and packaging have read-only
repository access.

Before any release scripts, dependency installation, packaging, or release
creation, the workflow checks out the immutable `GITHUB_SHA` without persisting
checkout credentials, reads `refs/heads/main` through the authenticated GitHub
API using the read-only job token, and requires the release commit to equal that
remote `main` HEAD. This exact HEAD policy applies to both matching tag pushes
and manual dispatches from `main`; manual tag creation targets the already
validated commit output.

The final release job targets the GitHub Environment named `prerelease`.
Repository owners should create that environment and configure required
reviewers for manual approval where their GitHub plan supports protection
rules. Merely naming the environment does not enforce approval until those
rules are configured.

For a manual dispatch, the final job creates the exact lightweight tag through
the GitHub API at the previously validated `origin/main` HEAD. Tag creation
fails if that name already exists, preventing a manual release from silently
reusing a tag that points at a different commit.

The release gate performs a frozen pnpm install, the complete deterministic
verification suite, both browser ZIP builds, manifest permission/version
validation, archive inspection, checksum creation, and checksum revalidation
after artifact transfer. It uploads only Playwright diagnostics on failure and
does not use provider credentials or secrets. GitHub Release assets are the
only automated distribution output for now; store submission remains a manual,
future milestone.

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

Vitest includes deterministic clocks/randomness for retry policy plus a
loopback HTTP server for OpenAI Responses, Chat Completions, and Microsoft
Translator v3. It verifies sender-scoped operation IDs, settings races,
bounded pending-cancellation isolation, simulated handler restart,
cancellation during retry sleep/fetch/body reads, late-response generation
rejection, request paths, structured payloads, authentication headers, ID
mapping, malformed output, 429 responses, `Retry-After`, timeouts, whole-batch
attempt counts, and partial batches without contacting an external service.

After each build, inspect the generated manifest and confirm that permissions
are exactly `activeTab`, `scripting`, and `storage`; optional host permissions
are exactly `https://*/*`; and there are no `host_permissions` or
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
`tabs.sendMessage` → background selected-provider registry → safe page
rendering. The deterministic release-gate page tests explicitly keep Mock
selected and make no external provider calls.

The Playwright suite also saves a clearly fake test credential through the real
Options UI, verifies the exact-origin runtime grant, confirms the key never
appears in the DOM or settings response, reopens Options, rotates to a second
origin, and proves the old grant is removed. It then terminates the service
worker, proves stored settings reload in the restarted worker, clears the key
through the UI, reopens to verify it is no longer configured, revokes the exact
origin, and confirms translation is blocked with a fixed safe permission error.
It additionally configures Chinese, retry, and appearance through Options,
restarts the service worker, verifies persistence, exercises deterministic Mock
failures through exactly two automatic retries and one manual single-segment
retry, and confirms in-place replacement, source-style/listener preservation,
and complete owned-DOM cleanup. No provider secrets are used.

A separate, clearly labeled lower-level content-runtime integration test still
loads the fixture into an extension-owned page, injects the built runtime, and
sends runtime commands directly. It retains the detailed structural placement,
text-only output, source-node/listener preservation, exclusion, idempotency,
toggle, and cleanup assertions, but it does **not** claim to prove `activeTab` or
the popup injection path. Restricted-page handling is also exercised through
the React popup UI. Live-provider compatibility remains a separate,
credentialed verification step; it is not part of deterministic `pnpm verify`.

## Current limitations

- Source language is fixed to automatic detection and the target language is
  fixed to Simplified Chinese (`zh-CN`, mapped to `zh-Hans` for Microsoft).
- Custom provider endpoints are HTTPS-only. Chrome's platform model requires a
  broad ungranted optional declaration in the manifest so arbitrary exact HTTPS
  origins can be requested later.
- Provider credentials are local BYOK values, not encrypted vault entries.
- Extraction runs only when Translate is requested. Dynamically added content
  is not observed automatically.
- Complex real-world list/table layouts still need a broader compatibility test
  matrix beyond the deterministic fixture.
- Browser-protected pages cannot be translated. Local `file:` pages also depend
  on the browser's per-extension file-access setting.
- PDF, video/subtitle, OCR, accounts, cloud sync, payments, and Firefox are out
  of scope.

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md) before
making changes.

## License

No open-source license has been selected. See [LICENSE.md](./LICENSE.md).
