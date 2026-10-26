---
description: Generate one CRUD vertical slice of monopoly-online (migration, domain, service, sqlite repo, Fastify routes, module wiring, HTTP tests) from a feature-plan file, then make pnpm check green.
argument-hint: '<docs/features/<context>-<entity>.md>'
allowed-tools: Bash(monopoly-slice *), Bash(pnpm check), Bash(pnpm typecheck), Bash(pnpm test*), Bash(pnpm arch:check), Bash(pnpm exec vitest *), Read, Edit, Write
---

# Scaffold a slice

Input: `$ARGUMENTS`, a plan written by `/monopoly-kit:feature-plan`. No path, or no ```json slice block in the
file → stop and say to run feature-plan first. Never invent fields.

1. From the repo root: `monopoly-slice $ARGUMENTS`. It writes the migration, domain, service, repo, routes and
   test matrix in the shape of the first slice, wires `src/<context>/module.ts` and `src/app.ts` when it can, never
   overwrites, and prints a `NEEDS` line for each thing left to you. Exit 1 → show its message and stop.
2. Do every `NEEDS` line and nothing more. The usual one: the referenced context's `<Ctx>Api` has no
   `<plural>.exists(id)`. Add it to the interface and to the returned `api` in that context's `module.ts`, built on
   its own service or repository. Outside the slice's context you may edit only that `module.ts` and, when a
   NEEDS line names it, `src/app.ts`; the module-boundary hook blocks imports of another context's internals.
3. `pnpm check`. Red → fix the generated files or your NEEDS edits and re-run. When a generated test fails, decide
   whether the code or the plan is wrong; never weaken an assertion to get green.
4. Report:

```
## Slice scaffolded: <Entity> in <context>

- Generated: <file (lines)> for each line the generator printed
- NEEDS done: <file: what> | none
- pnpm check: <N tests passed>, arch clean
- Next: /monopoly-kit:feature-tests <context> <entity>, then /monopoly-kit:feature-ship
```

No commit in this step.
