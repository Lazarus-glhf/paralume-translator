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
Do not add real translation providers, API key forms, PDF/video/OCR support, accounts, cloud sync, payments, Firefox support, UI libraries, Redux/Zustand, React Router, or speculative abstractions in the initial milestone.
