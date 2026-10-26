---
name: feature-ship
description: Ships a finished monopoly-online slice on its feature branch. Runs the done gate, commits the slice with a message that names the plugin steps used, appends the LOG.md row and commits it. Never pushes. Manual only.
disable-model-invocation: true
argument-hint: '<docs/features/<context>-<entity>.md>'
allowed-tools: Bash(pnpm check), Bash(git status*), Bash(git diff*), Bash(git add *), Bash(git commit *), Bash(git log *), Bash(git branch *), Bash(monopoly-slice log-row *), Read
---

# Ship a slice

Input: `$ARGUMENTS`, the slice's plan file.

1. Preflight. `git branch --show-current` is `feature-<n>/<slug>`, not `main` → else stop. `git status --short`
   shows only this slice: its context folder, its migration, `test/<context>/`, the plan, and the NEEDS edits
   (another context's `module.ts`, `src/app.ts`). Anything else → list it and ask.
2. `pnpm check` green. Note the number of passing tests.
3. Stage exactly those paths with `git add <paths>` (never `-A` or `.`) as its own Bash call, then commit in a
   separate call, so the commit-gate hook sees the staged slice:

   ```
   feat(<context>): <entity> CRUD

   <the plan's one-sentence summary>

   Created via monopoly-kit: /monopoly-kit:feature-plan, /monopoly-kit:feature-scaffold,
   /monopoly-kit:feature-tests, /monopoly-kit:feature-ship.
   ```

   The commit-gate hook runs the touched contexts' tests, typecheck and arch rules first. A block is a real
   failure: fix it and commit again; never split or reshape the commit to get past it.
4. `monopoly-slice log-row $ARGUMENTS <passing tests>` appends the LOG.md row (minutes from the plan's
   `Started:`). `monopoly-slice` is on PATH: call it by that name, never by its absolute path, which
   allowed-tools does not match. Commit the row alone: `git add LOG.md`, then `chore(log): <entity>`.
5. Never push, tag, merge or open a PR. Report both short shas, the LOG row and `git log --oneline -3`.
