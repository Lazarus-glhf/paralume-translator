# Contributing to Paralume

Read `AGENTS.md` and the active implementation plan before making changes.

## Working agreement

1. Use pnpm and commit `pnpm-lock.yaml` whenever dependencies change.
2. Keep work inside the current milestone; avoid future-provider or settings
   abstractions until they are required.
3. Restrict React to popup and options entrypoints. Keep extension behavior in
   framework-independent strict TypeScript.
4. Preserve host-page DOM ownership and treat all provider output as text.
5. Add meaningful tests for behavior and failure boundaries.
6. Before handing work off, inspect the diff and run formatting, linting,
   typechecking, tests, a production build, and manifest inspection.
7. Use conventional commit messages. Do not commit or push unless the current
   workflow explicitly assigns that responsibility.

## Local quality gate

```sh
pnpm verify
```

Report any skipped check and the reason instead of treating an incomplete gate
as successful.
