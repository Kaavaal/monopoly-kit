---
name: feature-tests
description: >
  Completes the tests of a freshly scaffolded monopoly-online slice: covers each domain rule from its plan that
  the generated matrix misses, through HTTP, and proves every new test can fail (red check). Use after
  /monopoly-kit:feature-scaffold, or when asked to "add tests for <entity>", "cover the rules of …",
  "допиши тести для …", "покрий правила …". Not for writing a slice from scratch.
argument-hint: '<context> <entity>'
allowed-tools: Bash(pnpm check), Bash(pnpm test*), Bash(pnpm exec vitest *), Read, Edit, Grep, Glob
---

# Complete a slice's tests

Input: `$ARGUMENTS`, a context and an entity, e.g. `board property`.

1. No context in the arguments, or no `docs/features/<context>-<entity>.md` → stop and say that this skill
   completes a slice planned by `/monopoly-kit:feature-plan`; never derive rules from the code. Otherwise read
   the plan's "Domain rules for feature-tests" and `test/<context>/<entity>.test.ts`. The generated matrix already covers CRUD, schema 400s, 404s, 409s on unique
   fields and unknown refs. Mark each rule *covered* (name the test) or *missing*.
2. Add one `it` per missing rule to the `describe` of its route, through HTTP with `makeTestApp()` and
   `app.inject`. Data of another context is created through its routes (e.g. `POST /players`), never its tables.
   Assert exact status, error code and body.
3. Red check for every new test: break the rule in the slice code with a one-line edit, run
   `pnpm exec vitest run test/<context>/<entity>.test.ts`, expect exactly the new test to fail, undo the edit with
   the inverse edit and re-run green. A test that cannot go red is removed, not kept.
4. `pnpm check` green.
5. Report a table rule → test (covered before / added), each red check as `edit → failing test → reverted`,
   and the final test count. Next: `/monopoly-kit:feature-ship`.
