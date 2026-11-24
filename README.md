# Paralume

**English** | [简体中文](./README.zh-CN.md)

Paralume（并译）is an open-source, local-first bilingual webpage translator for
Chrome and Edge. It keeps the original page intact and inserts each translation
beside its source block, so you can read both languages in parallel.

`0.2.1` stops translating standalone code blocks on documentation pages. Code
blocks such as `pre > code` (including Shiki-highlighted blocks) are skipped
whether or not the page marks them `translate="no"`. Short commands are no longer
merged into the surrounding list item or table cell. Inline code inside sentences,
plain `pre` text, and the explanations around code are still translated. The
stop, resume, and site restore controls from `0.2.0` are unchanged.

## Highlights

- Bilingual reading without replacing the original page.
- Floating control appears automatically on ordinary HTTP and HTTPS pages.
- Compact edge dock expands into translation, retry, visibility, clear, and site
  controls.
- **Hide floating controls on this page** hides the dock until the page reloads.
- **Disable floating controls on this site** persists by hostname. Disabled sites
  can be restored from Popup or Options; reloading then shows the dock again.
- Active translation can be stopped without clearing completed or failed blocks,
  then resumed for only the remaining untranslated content.
- OpenAI-compatible and Microsoft Translator BYOK providers.
- Deterministic Mock provider for explicit development/testing use only; it is
  never an automatic fallback.
- Progressive viewport-prioritized batching, bounded concurrency, streaming
  results, automatic retry for recoverable errors, and per-segment manual retry.
- English and Simplified Chinese UI.
- Translation appearance settings that affect only Paralume-owned UI.

## Install from GitHub Releases

1. Open [GitHub Releases](https://github.com/Lazarus-glhf/paralume-translator/releases)
   and select `v0.2.1`.
2. Download `paralume-translator-0.2.1-chrome.zip` or
   `paralume-translator-0.2.1-edge.zip`, plus
   `paralume-translator-0.2.1-SHA256SUMS.txt`.
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
- **Stop translation** cancels active page, bulk-retry, and manual-retry work while
  preserving rendered translations and the current visibility preference.
- **Retry all failed** retries failed translation blocks.
- **Show translations / Hide translations** explicitly reflects the current
  visibility and does not call a provider.
- **Clear** removes Paralume-owned translations and cancels active page work.
- **Hide floating controls on this page** removes the dock for the current page
  load without changing translations.
- **Disable floating controls on this site** stores the hostname locally and
  suppresses automatic display on future visits.

Clicking the toolbar icon opens the popup. Translation remains available there
for a disabled site without forcing its floating control to appear. Use
**Restore floating controls** in Popup, or restore any disabled hostname from
Options; reload an already-open page afterward. Storage failures are shown in
the UI. Browser-internal and other protected pages cannot run extension content
scripts.

## Providers and local credential security

Paralume is BYOK software:

- **OpenAI-compatible** supports Responses (`/responses`) and Chat Completions
  (`/chat/completions`) at user-configured HTTPS endpoints with strict structured
  output. Responses requests send `store: false`; this asks the provider not to
  store the response but cannot rule out provider-side logging. Reasoning effort
  can be set to **Don't send** for models or compatible endpoints that reject a
  reasoning parameter. **Test saved provider** uses the same streaming request as
  page translation.
- **Microsoft Translator** supports configurable HTTPS Endpoint, API Key, and
  Region and calls Translator v3.
- **Mock** produces deterministic development output only when selected.

API keys are stored in `chrome.storage.local` in the local browser profile. This
storage is **not an encrypted vault**. Use limited-purpose keys and provider quota
or billing controls. Options receives only `apiKeyConfigured` flags; content
scripts never receive provider credentials.

- Only Paralume's own extension pages (Options, Popup) may read provider
  settings, save settings or keys, clear keys, or run a connection test. The
  background rejects these commands from content scripts based on the
  browser-provided sender.
- A saved key is bound to its endpoint origin. Saving a Base URL or Endpoint on a
  different origin without entering a key removes the old key, so it is never
  sent to the new server.
- The background asks the browser to restrict `chrome.storage.local` to trusted
  extension contexts (`setAccessLevel`), and content scripts read the
  disabled-site list through background messages. Browsers that do not support
  this restriction leave `storage.local` readable by content scripts, and a
  compromised renderer must be assumed able to reach it.

## Safety model

- Paralume never rewrites source-page `innerHTML`.
- Original nodes, links, listeners, list numbering, table structure, and framework
  ownership are preserved.
- Provider output is inserted as inert `textContent`, never executable HTML.
- Code, forms, editable regions, navigation/footer, hidden content, and
  extension-owned nodes are excluded.
- Code blocks (`pre` whose text is all `code`, `samp`, or `kbd` markup, or
  block-level code elements) are never translated. A `pre` that mixes prose with
  inline code, such as `Press <kbd>Enter</kbd> to continue`, is translated. A
  nested block that holds only code is not merged into its list item or table
  cell, and text before and after a removed code block stays separated. Inline
  code inside prose is kept as context.
- The HTML `translate` attribute is honored. The nearest valid value applies,
  invalid values are inherited from the parent, and `translate="yes"` restores
  translation inside a `translate="no"` region. Inline `translate="no"` words
  such as product names stay in their sentence as context, but a block that
  contains only such text is not translated. When the page changes a source to
  `translate="no"`, late results for it are dropped and its translation is
  removed on the next Translate action.
- Runtime messages are structurally validated and use stable segment IDs.
- Late or stale results are rejected if the source changed, detached, or belongs
  to an older operation generation.
- Stop cancels every active page operation, rejects late results, resets pending
  Retry controls, and keeps successful and failed translations in place.
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
It asks the background whether the current site is disabled before installing
the isolated Shadow DOM control. No script is registered for browser-internal pages.

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
- Code shown in a plain `pre` without `code`, `samp`, or `kbd` markup and without
  `translate="no"` is indistinguishable from preformatted prose and is translated.
- Protected browser pages, PDF, video/subtitles, OCR, accounts, cloud sync,
  payments, and Firefox are out of scope.
- Store submission is not automated; GitHub Releases provide unpacked ZIPs.

See [CONTRIBUTING.md](./CONTRIBUTING.md) before contributing.

## License

Paralume is open source under the [MIT License](./LICENSE).
