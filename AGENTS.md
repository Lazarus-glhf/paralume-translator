# Paralume Agent Rules

## Product
Paralume is a local-first bilingual webpage translator for Chrome and Edge. The initial milestone uses a deterministic Mock provider to verify the complete extension workflow before any real API integration.

## Architecture
- WXT + strict TypeScript.
- React only in Popup and Options.
- Core extraction, DOM eligibility, messaging, provider, batching, rendering, and cleanup remain framework-independent TypeScript.
- Translation network/provider work belongs in the background service worker; content scripts must never receive API keys.

## Safety and correctness
- Never rewrite source-page `innerHTML`.
- Preserve original DOM, links, listeners, and framework ownership.
- Insert provider output as text, not executable HTML.
- Exclude code, forms, editable regions, navigation/footer, hidden content, and extension-owned nodes.
- Validate every cross-context runtime message.
- Use stable segment IDs and map results by ID, never by unchecked array position.
- Make translate/toggle/clear operations idempotent.
- Keep Manifest permissions minimal and justified.
- Milestone 1 uses `activeTab` + `scripting` for explicit, on-demand page injection. Do not add a static all-sites content script or broad host permissions.
- Do not log secrets or full sensitive page content.

## Workflow
- Prefer Codex CLI for implementation.
- Use pnpm and commit the lockfile.
- Work in small, verifiable milestones.
- Before a commit: inspect diff, run typecheck, tests, production build, relevant e2e, and inspect generated manifest.
- Use conventional commit messages.
- Git identity: `Lazarus-glhf <redrumlivedog@outlook.com>`.
- Hermes performs commits and pushes after independent verification unless explicitly instructed otherwise.

## Scope discipline
Do not add PDF/video/OCR support, accounts, cloud sync, payments, Firefox support, UI libraries, Redux/Zustand, React Router, or speculative abstractions.

## Milestone 2 provider decisions
- Add OpenAI-compatible and Microsoft Translator providers; keep Mock available only as an explicitly selected development provider and never automatically fall back to it.
- OpenAI-compatible supports both Responses (`/responses`) and Chat Completions (`/chat/completions`), selected by the user.
- The first public release automatically injects the floating control on ordinary HTTP and HTTPS pages. The manifest grants only `http://*/*` and `https://*/*`; runtime code still validates configured provider URLs and never exposes API keys to content scripts.
- Store BYOK credentials in `chrome.storage.local`; only background/provider code may read keys. Options must mask and clear keys, and documentation must state that local storage is not an encrypted vault.
- Microsoft Translator uses API Key + Region + configurable Endpoint, defaulting to `https://api.cognitive.microsofttranslator.com`.
- OpenAI batch format errors fail the batch clearly. Do not silently split malformed batches into per-segment requests.

## Milestone 3 tester-usability decisions
- Automatically retry only recoverable provider failures (`RATE_LIMITED`, `REQUEST_TIMEOUT`, `NETWORK_ERROR`, `SERVER_UNAVAILABLE`) up to two additional whole-batch attempts with bounded backoff. Do not retry permanent/configuration/structured-output failures automatically and never fall back to Mock.
- Every rendered failed segment gets a subtle bottom-right manual Retry control. Manual retry submits only that segment, deduplicates clicks, shows pending state, and remains cancellation-safe.
- Appearance settings affect only Paralume-owned translation/failure/retry UI, never source-page styling. Support font family, font size, text/background colors, line height, opacity, and vertical spacing with strict validation and safe defaults.
- Localize Popup, Options, status/error messages, and page retry UI for Simplified Chinese and English. Language choices are system (default), zh-CN, and en. Add an independently maintained `README.zh-CN.md` linked with the English README.
- Continue to keep React in Popup/Options only; retry policy, localization, appearance validation/application, messaging, and rendering remain framework-independent TypeScript where applicable.
