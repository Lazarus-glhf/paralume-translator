# Paralume Milestone 3 — Retry, Appearance, and Chinese Support

## Goal

Improve tester usability by recovering transient translation failures, allowing users to customize only Paralume-owned translation presentation, and localizing Popup/Options plus repository documentation into Simplified Chinese and English.

## Confirmed product decisions

### Retry

- Retry transient/recoverable failures automatically up to 2 additional attempts.
- Recoverable codes: `RATE_LIMITED`, `REQUEST_TIMEOUT`, `NETWORK_ERROR`, `SERVER_UNAVAILABLE`.
- Do not automatically retry authentication, configuration, permission, validation, request-limit, segment-size, malformed JSON, malformed structured output, duplicate/missing result, or unknown/internal contract failures.
- Retry the same whole batch; do not automatically split it into per-segment requests.
- Use bounded exponential backoff with jitter and honor a safely bounded `Retry-After` response when available.
- Preserve cancellation/clear semantics while sleeping or retrying; do not render stale results after Clear.
- Key active operations and bounded pending cancellations by `(sender scope, operation UUID)` so another sender's collisions, cancels, or capacity pressure cannot affect them.
- Clear synchronously removes owned UI and requests cancellation. An active worker aborts retry sleep/fetch/body reads; forced worker termination destroys that execution context and its in-memory controllers rather than transferring them to a restarted handler.
- Keep restart state ephemeral: a fresh handler may retain a cancel that arrives before its later translate, while content generation rejects late responses. Do not persist requests, page text, secrets, operation registries, or `AbortController` assumptions in storage.
- Document that already accepted upstream requests may still complete or be billed; cancellation is not an absolute fee-prevention guarantee.
- After automatic attempts are exhausted, render a subtle failure block with a `Retry` button at the bottom-right.
- Manual retry submits only that source segment, shows a lightweight pending state, deduplicates repeated clicks, and replaces the failure block in place on success.
- Manual retry is available for every failed segment, including failures that are not automatically retryable, but global configuration/permission/auth failures should still return a clear safe message.
- No automatic fallback to Mock.
- Document that retries can incur additional provider usage/cost.

### Appearance

- Appearance applies only to Paralume-owned translation and retry UI; never alter original page styles.
- First release controls:
  - translation font family,
  - font size,
  - text color,
  - background color,
  - line height,
  - opacity,
  - vertical spacing.
- Provide safe defaults and a Reset appearance action.
- Validate and normalize every stored value. Use bounded enums/numeric ranges and safe CSS color values; do not accept arbitrary CSS declarations or executable values.
- Apply appearance to existing translations after settings changes where feasible and to all future renders.
- Preserve text-only provider output and DOM ownership/cleanup guarantees.

### Language and documentation

- UI language choices: `system`, `zh-CN`, `en`.
- Default is `system`, resolving from browser UI language with safe fallback to English.
- Localize Popup, Options, statuses, validation/user-facing errors, retry labels/states, and appearance labels.
- Runtime protocols should carry stable error/message identifiers rather than using English strings as logic keys. Localize at the UI/content rendering boundary.
- Page-injected failure/retry UI follows the configured language.
- Add `README.zh-CN.md`; English `README.md` and Chinese README link to each other prominently.
- Keep code identifiers and provider protocol fields in English.

## Settings/storage design

- Advance the versioned settings schema with backward-compatible migration from v1.
- Persist provider, retry, appearance, and UI language settings in `chrome.storage.local`.
- API keys remain background-only and never enter public settings responses.
- Public settings include retry/appearance/language but only `apiKeyConfigured` booleans for credentials.
- Content scripts receive only non-sensitive presentation/retry policy needed for rendering and commands; never receive API keys.

## Architecture

- Keep React limited to Popup and Options.
- Keep retry policy/backoff, settings validation/migration, localization catalog/resolution, and appearance serialization framework-independent TypeScript.
- Background owns provider access and automatic retry execution.
- The runtime listener returns literal `true` to keep the one-time response channel open; the running message event keeps the worker active for in-flight handler work, subject to Chromium's normal extension-worker lifetime limits.
- Content controller owns single-segment manual retry orchestration and stale-operation protection.
- Renderer owns subtle failure/retry DOM, pending state, styling, listener ownership, and cleanup.
- Avoid inline provider HTML and avoid rewriting source-page `innerHTML`.

## Required tests

1. Retry policy classification for every safe error code.
2. Exactly 0/1/2 retries, bounded backoff, Retry-After parsing, and no retry for permanent errors.
3. Whole-batch retry preserves IDs/order and does not split automatically.
4. Clear/cancellation during retry sleep/fetch cannot render stale translations.
5. Manual single-segment retry success/failure, click deduplication, pending state, and cleanup.
6. Retry buttons are extension-owned, accessible, text-only, visually subtle, and excluded from extraction.
7. Settings v1 migration preserves providers/keys and adds retry/appearance/language defaults.
8. Appearance validation rejects unsafe CSS and clamps bounded numeric values.
9. Appearance changes affect only Paralume-owned nodes, including existing nodes, and never mutate original source styles.
10. Locale resolution for system/zh-CN/en and fallback behavior.
11. Popup/Options/content retry UI renders Chinese and English without hard-coded mixed-language leftovers.
12. Public settings/runtime responses never expose API keys.
13. Playwright: configure Chinese, appearance, and retry policy through Options; inject deterministic transient failures; verify two automatic retries, manual retry, reload/service-worker restart persistence, and exact DOM cleanup.
14. Full release validation, Chrome/Edge manifests, ZIPs, and no credential or page-text leakage.
15. Sender-scoped same-UUID concurrency, cross-sender pending cancellation, per-sender eviction isolation, and simulated handler restart with cancel-before-translate plus late-response generation rejection.

## Release target

- Next Alpha numeric version: `0.0.2` after implementation, review, and real-page verification.
- GitHub Release remains prerelease. Store publication remains out of scope.
