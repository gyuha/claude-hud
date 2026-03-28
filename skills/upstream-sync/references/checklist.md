# Upstream Sync Checklist

Read this checklist before porting any upstream change from `jarrodwatts/claude-hud` into this fork.

## Maintainer Docs to Re-check

- `CONTRIBUTING.md`
- `RELEASING.md`
- `README.md`
- `CLAUDE.README.md`

## Fork-specific Deltas to Protect

These are known areas where this fork differs from upstream and may require manual preservation.

### Installation and repository identity

- `README.md`
  - install flow currently points to `gyuha/claude-hud`
  - README explicitly notes that `jarrodwatts/claude-hud` is the original project
- `CLAUDE.README.md`
  - still contains upstream-oriented install text and may need intentional review during future syncs
- `commands/setup.md`
  - contains GitHub star guidance referencing the upstream repository

### GLM-specific usage support

- `src/glm-usage.ts`
- `src/stdin.ts`
- `src/render/session-line.ts`
- `src/render/lines/usage.ts`
- tests covering the GLM behavior:
  - `tests/core.test.js`
  - `tests/render.test.js`

If upstream touches any of these files or adjacent usage-rendering logic, review the GLM behavior explicitly before porting.

## High-risk metadata files

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `package.json`

These files affect install/update behavior and release visibility. Re-check them carefully during upstream syncs.

## Verification Baseline

Use the narrowest honest verification:

- docs-only change → inspect final docs and command names
- source change → `npm ci` and `npm run build`
- broad behavior change → add relevant tests or run `npm test`

Do not claim the sync is complete until the verification matches the actual surface area of the port.
