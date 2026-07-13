# Paralume MVP Foundation Implementation Plan

> **For Hermes:** Orchestrate Codex task-by-task, then independently review and verify every milestone before committing and pushing.

**Goal:** Build a loadable Chrome/Edge Manifest V3 extension that uses a Mock translation provider to prove the full paragraph extraction → message → batching → translation → rendering → hide/show → cleanup loop.

**Architecture:** WXT owns extension entrypoints and packaging. React is restricted to Popup and Options UI. Extraction, eligibility, protocol, provider, batching, rendering, and cleanup are framework-independent strict TypeScript modules. The content script never receives secrets; later real providers will execute from the background service worker.

**Tech Stack:** WXT, TypeScript strict mode, React, plain CSS, Vitest, happy-dom, Playwright/Chromium extension smoke tests, pnpm.

---

## Confirmed product scope

- Product: Paralume（并译）.
- Repository: `Lazarus-glhf/paralume-translator` (private initially).
- Browsers: Chrome and Edge via Manifest V3.
- First milestone uses only a `MockTranslationProvider`; no real API and no API key UI yet.
- A user-triggered action translates the current page.
- Page access uses `activeTab` + `scripting`: inject the content entrypoint only after an explicit popup action. Do not register a static all-sites content script in Milestone 1.
- Original DOM nodes remain unchanged. Normal blocks receive an immediate sibling translation `div`; structural `li`, `td`, and `th` containers receive an internal translation `div` appended after their original content.
- Required presentation is strictly interleaved at block level while preserving list numbering and table column structure; never create sibling `li`, `td`, or `th` elements.
- Popup actions: translate, hide/show translations, clear translations.
- Basic Options page exists as a future provider/settings boundary, but avoids speculative settings.
- React is limited to Popup and Options.
- No PDF, subtitles, OCR, accounts, cloud sync, payments, Firefox, shared keys, or automatic site rules.

## Project rules

- Hermes owns planning, milestone boundaries, independent review, verification, commits, pushes, and Discord reports.
- Codex CLI is the preferred implementation agent.
- Commit and push at meaningful verified milestones, not for every tiny edit.
- Conventional commits; Git identity is `Lazarus-glhf <redrumlivedog@outlook.com>`.
- Never call a milestone complete merely because it builds.
- Keep core modules independent from WXT and React where practical.
- Preserve original page DOM and event handlers; never rewrite source `innerHTML`.
- Insert translated output as text (`textContent`/React escaping), never untrusted HTML.
- Exclude `script`, `style`, `code`, `pre`, form controls, `nav`, `footer`, SVG/canvas, contenteditable, hidden content, and extension-owned nodes.
- No API keys, page content dumps, or sensitive values in logs or fixtures.
- Keep permissions minimal and document why each permission is needed.

## Milestone 0 — Repository foundation

**Deliverables**
- WXT + React + TypeScript scaffold. Keep the background entrypoint inert and
  defer content-script registration until Milestone 1 needs page access.
- pnpm package manager and lockfile.
- Formatting/linting/typecheck/test/build scripts.
- README with scope, setup, architecture, and verification commands.
- `.gitignore`, license decision placeholder, contribution/project rules.

**Verification**
- `pnpm install`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- Inspect generated manifest and permissions.

**Commit:** `chore: initialize paralume extension`

## Milestone 1 — Mock translation vertical slice

### Task 1: Define framework-independent contracts

**Create**
- `src/shared/types.ts`
- `src/shared/errors.ts`
- `src/messaging/protocol.ts`
- `src/messaging/validation.ts`
- `src/translation/provider.ts`
- `src/translation/mock.ts`

Define stable IDs for source segments, request/result types, commands, structured failures, and a provider interface that preserves one result per input ID.

**Tests**
- Reject malformed messages.
- Mock provider preserves IDs/order and supports deterministic output.
- Partial failures are representable without failing the entire page.

### Task 2: Extract eligible page blocks

**Create**
- `src/content/eligibility.ts`
- `src/content/extractor.ts`
- `src/content/text.ts`

Start with `p`, `li`, `blockquote`, `h1`–`h6`, `td`, `th`, and `figcaption`. Use whole-block `innerText`, normalize whitespace, impose a small minimum meaningful length, skip hidden and excluded regions, nested duplicates, extension-owned nodes, and already processed blocks.

**Tests**
- Paragraph with inline link is one segment.
- Code/form/navigation/hidden/editable content is excluded.
- Nested candidate blocks do not produce duplicate translation requests.
- Existing translation blocks are excluded.

### Task 3: Render, toggle, and clean up safely

**Create**
- `src/content/renderer.ts`
- `src/content/cleanup.ts`
- `src/content/constants.ts`

Insert a sibling translation `div` for normal blocks and an internal appended translation `div` for `li`, `td`, and `th`, using text-only output. Track authoritative ownership in runtime-private state; `data-paralume-*` attributes are non-authoritative diagnostics. Toggle visibility without retranslating. Cleanup removes only nodes and markers recorded by the installed runtime.

**Tests**
- Original source HTML and links remain unchanged.
- Output is text, so HTML-like provider output is not executed.
- Re-render updates/reuses instead of duplicating.
- Hide/show and cleanup are idempotent.

### Task 4: Add batching and background message handling

**Create**
- `src/translation/batcher.ts`
- `entrypoints/background.ts`

Batch by bounded segment count/character count, limit concurrency, handle errors per batch/segment, and route translation commands through the background provider registry. Do not depend on long-lived global state for correctness.

**Tests**
- Batch limits are respected.
- Result IDs map back correctly even if provider output is reordered.
- One failed segment does not discard successful results.
- Invalid requests receive structured errors.

### Task 5: Wire the content-script controller

**Create**
- `entrypoints/content.ts`
- `src/content/controller.ts`

Handle translate, toggle, and clear commands. Extract only when translation is requested. Repeated translate commands must reuse rendered/mock results or skip already processed segments, not create duplicates. Package the content entrypoint for programmatic injection with `browser.scripting.executeScript`; do not add static `matches` that run on every site.

**Tests**
- Full controller loop in happy-dom.
- Repeated translate is idempotent.
- Toggle does not invoke provider.
- Clear restores the page to its original content structure.

### Task 6: Build the React popup and minimal Options boundary

**Create**
- `entrypoints/popup/index.html`
- `entrypoints/popup/main.tsx`
- `entrypoints/popup/App.tsx`
- `entrypoints/popup/style.css`
- `entrypoints/options/index.html`
- `entrypoints/options/main.tsx`
- `entrypoints/options/App.tsx`
- `entrypoints/options/style.css`

Popup requests the active tab, injects the content entrypoint on demand when needed, sends commands, and displays concise progress/errors. It must handle restricted/browser-internal pages honestly. Options explains that Mock is active and reserves a typed settings boundary; it must not expose fake API settings.

**Tests**
- Popup action/message tests where valuable.
- Accessible labels and disabled/busy behavior.

### Task 7: Add extension-level smoke verification

**Create**
- `e2e/fixtures/static-article.html`
- `e2e/extension.spec.ts`
- Playwright configuration/scripts.

Load the built unpacked extension into Chromium, open a local static article, trigger translation, and verify:
- translations appear under eligible blocks;
- source link remains clickable/unchanged;
- code block is not translated;
- hide/show does not duplicate output;
- clear removes translations.
- generated manifest has only `activeTab` and `scripting`, no broad `host_permissions`, and no static `content_scripts` entry.

After deterministic fixture verification, manually exercise the unpacked extension against `https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6` and record observed extraction/rendering issues. The live page is a compatibility check, not the sole automated test oracle because its content can change.

If popup automation is brittle, directly exercise the same runtime command boundary and separately smoke-open the popup page.

## Milestone 2 — Dynamic content spike (after vertical slice)

Add a debounced `MutationObserver` behind explicit controller lifecycle methods. Scan only added subtrees, ignore extension-owned mutations, and prevent recursive translation. Validate against a deterministic infinite-scroll fixture before trying real sites.

**Likely files**
- `src/content/observer.ts`
- `src/content/controller.ts`
- `e2e/fixtures/dynamic-feed.html`
- `e2e/dynamic-content.spec.ts`

**Commit:** `feat: support dynamically added page content`

## Milestone 3 — Real provider decision and implementation (separate requirement interview)

Compare OpenAI-compatible and one traditional translation provider using latency, output alignment, cost, permissions, endpoint validation, retries, and privacy. Add settings and secret storage only after selecting the provider(s).

## Acceptance gate for first development phase

All must be true:
- Clean install succeeds from lockfile.
- Typecheck and unit tests pass.
- Production Chrome build succeeds.
- Generated manifest contains only justified permissions.
- Playwright loads the unpacked extension and proves the static-page workflow.
- Build output contains no secret or remote executable code.
- Independent review finds no blocker in DOM safety, message validation, extension permissions, or module boundaries.
- Commit is pushed to `origin/main`, and remote HEAD is verified.

## Risks and explicit deferrals

- Real-world DOM extraction accuracy is not proven by a static fixture; maintain a later 10–20-site test matrix.
- MutationObserver and virtualized feeds are deferred until the static loop is solid.
- Service worker suspension recovery becomes more important with real network providers and persistent queues.
- Translation cache is deferred until a real provider creates cost/latency pressure; do not build speculative persistence around Mock.
- Chrome Web Store packaging/privacy policy is a later release milestone.
