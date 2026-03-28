---
name: upstream-sync
description: Use when maintaining this fork and checking whether changes from jarrodwatts/claude-hud should be ported into the current repository.
---

# Upstream Sync

Use this skill to sync this fork with `jarrodwatts/claude-hud` without erasing fork-specific behavior.

## When to Use

- Upstream `jarrodwatts/claude-hud` has new commits, tags, or releases
- You want to compare this fork against upstream before porting changes
- You need a repeatable maintainer workflow for upstream updates

Do not use this skill for normal feature work inside this fork.

## Repository Context

- **Upstream repository:** `https://github.com/jarrodwatts/claude-hud`
- **Current fork:** this repository
- **Maintainer flow constraints:** follow `CONTRIBUTING.md` and `RELEASING.md`
- **Important:** this fork already contains local deltas that must be reviewed before applying upstream changes. Read `references/checklist.md` before porting anything.

## Workflow

### 1. Prepare the comparison

Make sure the working tree is clean before you inspect or port upstream changes.

```bash
git status --short --branch
git remote -v
git remote add upstream https://github.com/jarrodwatts/claude-hud.git   # only if missing
git fetch upstream --tags
```

### 2. Inspect what changed upstream

Start with history and file-level scope before touching code.

```bash
git log --oneline --decorate HEAD..upstream/main
git diff --stat --find-renames HEAD...upstream/main
```

If the update appears release-related, also inspect the latest upstream tag and release notes.

### 3. Classify the incoming changes

Use this table to choose the update strategy.

| Change shape | Preferred strategy |
| --- | --- |
| Small docs or metadata updates | Port manually file-by-file |
| Isolated bugfix or focused feature commit | Consider cherry-picking after reading the full patch |
| Large cross-cutting refactor | Read the diff, then port changes manually in smaller pieces |
| Anything that overlaps fork-only behavior | Port manually and preserve the local delta intentionally |

Do not blindly merge `upstream/main` into this fork unless the user explicitly wants a wholesale sync and you have already analyzed the conflict surface.

### 4. Preserve fork-specific behavior

Before editing files, re-read `references/checklist.md` and compare every overlapping upstream change against the fork-specific deltas listed there.

Treat these deltas as protected until you intentionally decide otherwise.

### 5. Port the changes

For each upstream change you bring over:

1. Read the upstream diff completely
2. Identify any fork-specific behavior in the same file cluster
3. Port the smallest safe change set
4. Keep the change focused; avoid opportunistic refactors

### 6. Verify after porting

Run the smallest verification that honestly proves the update is safe.

- Narrow docs-only change → verify the edited docs and linked commands/config names
- Source change → run at least:

```bash
npm ci
npm run build
```

- If behavior or tests changed, run related tests or `npm test` when the update is broad
- If release metadata changed, re-check the release/version files described in `RELEASING.md`

### 7. Report the sync clearly

Always summarize three things:

1. What came from upstream
2. What fork-specific behavior was intentionally preserved
3. What verification was run and what it proved

## Common Mistakes

- **Blind merge:** pulling in upstream wholesale without checking fork-only behavior nearby
- **Surface-only diff review:** looking at filenames without reading the actual patch
- **Overwriting install/source docs:** replacing fork-specific README install instructions with upstream defaults
- **Missing verification:** claiming the sync is done without rebuilding or testing the affected area

## Quick Reference

```bash
git fetch upstream --tags
git log --oneline --decorate HEAD..upstream/main
git diff --stat --find-renames HEAD...upstream/main
```

Then read `references/checklist.md`, port the smallest safe change set, and verify honestly.
