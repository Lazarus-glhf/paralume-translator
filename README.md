# Paralume

**English** | [简体中文](./README.zh-CN.md)

Paralume（并译）is an open-source, local-first bilingual webpage translator for
Chrome and Edge. It keeps the original page intact and inserts each translation
beside its source block, so you can read both languages in parallel.

Release `0.1.0` introduces an always-available in-page floating control, a compact
edge dock, accurate page-level progress, per-site visibility controls, and a new
Parallel P extension icon. Translation still starts only after an explicit
**Translate page** action.

## Highlights

- Bilingual reading without replacing the original page.
- Floating control appears automatically on ordinary HTTP and HTTPS pages.
- Compact edge dock expands into translation, retry, visibility, clear, and site
  controls.
- **Hide on this page** hides the dock until the page reloads.
- **Disable on this site** persists by hostname; clicking the extension icon can
  temporarily restore the control for the current page.
- OpenAI-compatible and Microsoft Translator BYOK providers.
- Deterministic Mock provider for explicit development/testing use only; it is
  never an automatic fallback.
- Progressive viewport-prioritized batching, bounded concurrency, streaming
  results, automatic retry for recoverable errors, and per-segment manual retry.
- English and Simplified Chinese UI.
- Translation appearance settings that affect only Paralume-owned UI.

## Install from GitHub Releases

1. Open [GitHub Releases](https://github.com/Lazarus-glhf/paralume-translator/releases)
   and select `v0.1.0`.
2. Download `paralume-translator-0.1.0-chrome.zip` or
   `paralume-translator-0.1.0-edge.zip`, plus
   `paralume-translator-0.1.0-SHA256SUMS.txt`.
3. Verify the ZIP digest with `sha256sum`, `shasum -a 256`, or PowerShell
   `Get-FileHash -Algorithm SHA256`.
4. Extract the ZIP to a permanent local directory.
5. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**,
   choose **Load unpacked**, and select the extracted directory containing
   `manifest.json`.

Unpacked installations do not update automatically. Repeat these steps for a
new release.

## Usage

The floating dock is available on supported webpages without opening the toolbar
popup. Click it to expand the control panel:

- **Translate page** translates eligible, unprocessed blocks.
- **Retry all failed** retries failed translation blocks.
- **Show / hide** changes only existing translation visibility and does not call
  a provider.
- **Clear** removes Paralume-owned translations and cancels active page work.
- **Hide on this page** removes the dock for the current page load.
- **Disable on this site** stores the hostname locally and suppresses automatic
  display on future visits.

Clicking the toolbar icon opens the popup and can temporarily restore the
runtime on a disabled site. Browser-internal and other protected pages cannot
run extension content scripts.

## Providers and local credential security

Paralume is BYOK software:

- **OpenAI-compatible** supports Responses (`/responses`) and Chat Completions
  (`/chat/completions`) at user-configured HTTPS endpoints with strict structured
  output.
- **Microsoft Translator** supports configurable HTTPS Endpoint, API Key, and
  Region and calls Translator v3.
- **Mock** produces deterministic development output only when selected.

API keys are stored in `chrome.storage.local` in the local browser profile. This
storage is **not an encrypted vault**. Use limited-purpose keys and provider quota
or billing controls. Options receives only `apiKeyConfigured` flags; content
scripts never receive provider credentials.

## Safety model

- Paralume never rewrites source-page `innerHTML`.
- Original nodes, links, listeners, list numbering, table structure, and framework
  ownership are preserved.
- Provider output is inserted as inert `textContent`, never executable HTML.
- Code, forms, editable regions, navigation/footer, hidden content, and
  extension-owned nodes are excluded.
- Runtime messages are structurally validated and use stable segment IDs.
- Late or stale results are rejected if the source changed, detached, or belongs
  to an older operation generation.
- Clear cancels active page operations and prevents late results from reappearing.

## Permissions

The Manifest V3 extension requests:

- `storage` for versioned settings, site-disable preferences, and local BYOK
  credentials.
- `activeTab` and `scripting` for explicit popup recovery/injection on the current
  page.
- `host_permissions` for `http://*/*` and `https://*/*`, required for the floating
  dock to appear automatically on ordinary webpages and for configured HTTPS
  translation providers.

A single static content script runs at `document_idle` on HTTP and HTTPS pages.
It checks the local disabled-site list before installing the isolated Shadow DOM
control. No script is registered for browser-internal pages.

## Architecture

- WXT packages Manifest V3 extensions for Chrome and Edge.
- React is limited to Popup and Options.
- Extraction, eligibility, protocol validation, providers, retry policy,
  localization, batching, rendering, cleanup, settings, and page control are
  strict framework-independent TypeScript.
- The background service worker owns provider settings, credentials, network
  calls, batching retries, and cancellation.
- The page runtime owns extraction, safe rendering, progress, and the Shadow DOM
  floating control.

## Development

Requirements:

- Node.js 20.19+ or 22.12+
- pnpm 11.9+ through Corepack

```sh
corepack enable
pnpm install
pnpm exec playwright install chromium
pnpm dev
```

Build and verify:

```sh
pnpm build
pnpm build:edge
pnpm verify
pnpm release:package
```

`pnpm verify` runs formatting, ESLint, TypeScript, Vitest, Chrome and Edge builds,
and Playwright extension tests. `pnpm release:package` validates both manifests
and archives, then creates browser ZIPs and a SHA-256 checksum file beneath
`release-assets/`.

## Repository layout

```text
entrypoints/             Background, automatic content script, popup, options
src/content/             Extraction, rendering, controller, floating UI
src/messaging/           Validated cross-context protocols and routing
src/settings/            Versioned storage and settings validation
src/translation/         Mock, OpenAI-compatible, Microsoft, batching and retry
tests/                   Vitest unit and integration tests
e2e/                     Playwright extension tests
design/                  Non-production design explorations
public/icon/              Production extension icons
```

## Current limitations

- Source language is automatic; target language is Simplified Chinese.
- API keys are local BYOK values, not encrypted vault entries.
- Dynamic DOM additions are processed on the next Translate action, not observed
  continuously.
- Protected browser pages, PDF, video/subtitles, OCR, accounts, cloud sync,
  payments, and Firefox are out of scope.
- Store submission is not automated; GitHub Releases provide unpacked ZIPs.

See [CONTRIBUTING.md](./CONTRIBUTING.md) before contributing.

## License

Paralume is open source under the [MIT License](./LICENSE).
