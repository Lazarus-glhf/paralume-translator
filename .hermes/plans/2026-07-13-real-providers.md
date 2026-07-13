# Paralume Real Providers Implementation Plan

**Goal:** Add selectable OpenAI-compatible and Microsoft Translator BYOK providers while preserving the verified paragraph extraction/rendering workflow.

## Confirmed requirements

- Providers: Mock, OpenAI-compatible, Microsoft Translator.
- No automatic fallback to Mock when a real provider is unconfigured or fails.
- OpenAI-compatible protocols: user selects Responses or Chat Completions.
- OpenAI settings: HTTPS Base URL, API Key, model, reasoning effort, protocol.
- The selected OpenAI-compatible endpoint must support strict `json_schema`
  output and the reasoning field used by the chosen protocol. Chat content may
  be a string or a text-part array; unsupported content shapes fail safely.
- Microsoft settings: API Key, Region, configurable HTTPS Endpoint.
- Credentials persist in `chrome.storage.local`, are read only by the
  background/provider layer, are masked in Options, and can be cleared.
- OpenAI-compatible custom endpoints must be HTTPS in this milestone.
- Retain arbitrary HTTPS custom endpoints. Declare the ungranted manifest
  `optional_host_permissions` pattern `https://*/*` because Chrome requires a
  static declaration that covers later custom-origin requests. From a direct
  Options click, request only the exact configured origin; do not add broad
  granted `host_permissions`, and remove stale exact grants after changes.
- OpenAI batches remain bounded at 20 segments / 6000 characters. A successful
  HTTP response with malformed, missing, duplicate, unknown, or additional
  structured fields fails clearly. No per-segment automatic retry in this
  milestone; preserve a future policy seam.
- Convert all provider, fetch, permission, storage, and background failures to
  allowlisted codes with fixed safe messages before any runtime response.

## Implementation sequence

1. Define versioned provider settings and storage repository with validation/migration-safe defaults.
2. Add optional-origin permission derivation and a direct user-gesture request flow.
3. Build Options UI for provider selection, protocol, endpoints, model/effort, credentials, save, clear, and connection test.
4. Add background settings loading and provider registry; remove hard-coded Mock selection.
5. Implement OpenAI Responses structured translation parsing and safe error mapping.
6. Implement OpenAI Chat Completions structured translation parsing and safe error mapping.
7. Implement Microsoft Translator v3 request/response mapping and Azure headers.
8. Add deterministic provider tests for request shape, prompt-injection text, auth-header handling, malformed response, timeout, rate limit, language mapping, and partial-result failures.
9. Add Chromium coverage for direct permission requests, Options reopen/origin rotation, credential masking and clearing, service-worker restart, permission revocation, and safe blocked-fetch behavior.
10. Inspect generated Chrome and Edge manifests and scan tracked, staged, build, and test-log outputs for secrets or environment-specific endpoint/model details before independent security review.

## Release gates

- No secret appears in Git, build output, logs, screenshots, fixtures, or test reports.
- Content script never receives provider credentials.
- Options cannot save an invalid/non-HTTPS OpenAI endpoint.
- The broad optional manifest declaration remains ungranted at install time;
  only the exact configured origin is requested at runtime.
- Revoked permissions produce a fixed safe error before any fetch.
- Provider response IDs and fields are validated independently of response order.
- Authentication, rate limit, timeout/network, server unavailable, malformed
  JSON/output, unconfigured key, permission missing, and validation paths use
  allowlisted codes and fixed safe messages.
- Full `pnpm verify`, deterministic provider coverage, generated manifest
  inspection, leakage scans, and independent security review pass. Live
  provider checks are optional local verification and must not place endpoint,
  model, connectivity, credential, or page-content details in repository files
  or logs.
