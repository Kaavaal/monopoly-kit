---
name: feature-plan
description: >
  Plans one CRUD vertical slice (a new entity) of the monopoly-online backend and writes
  docs/features/<context>-<entity>.md with a machine-readable ```json slice spec that /monopoly-kit:feature-scaffold
  generates the code from. Use when adding a new entity, table, resource or CRUD endpoints to the Monopoly API:
  "add Property to board", "new entity for …", "нова сутність", "додай CRUD для …", "новая сущность …".
  Not for changing an entity that already exists.
argument-hint: '<Entity> in <context>: <fields and rules>'
allowed-tools: Bash(monopoly-slice *), Bash(date *), Read, Glob, Grep, Write
---

# Plan a slice

Input: `$ARGUMENTS`, the entity, its context and its fields in one line. No fields given → ask for them in one
question; never invent the data model.

## 1. Facts

From the repo root run `monopoly-slice facts <context>` (on PATH while monopoly-kit is enabled) and
`date -u +%FT%TZ` (the slice's start time). Facts list every context with its slices and `<Ctx>Api`, the next
migration number, the exemplar slice and the conventions the generator applies on its own. Read
`ARCHITECTURE.md` only if the context or a dependency is unclear from the facts. Call the `slice-scout` agent only
when there is no exemplar yet or the request does not fit the CRUD shape.

## 2. Decide

- **context**: the one that owns the data (ARCHITECTURE.md context map). Not a folder under `src/` → stop.
- **entity** PascalCase, **plural** lowercase letters: the table and the route.
- **fields**, each one of:
  - `text`: `min` (default 1), `max`, `unique` (case-insensitive, trimmed);
  - `enum`: `values`, lowercase, 2 or more;
  - `int`: `min`, optional `max`;
  - `ref`: data of another context. `ref: "<context>.<plural>"`, the name ends in `Id`, `optional` if it may be
    empty, and `fixture: { url, body }`: the POST that creates one in tests (take a valid body from the other
    slice's tests). Two refs to the same plural need different bodies: both are created in every test, and the
    other slice's unique fields would answer 409. The referenced context must be created before this one in
    `src/app.ts`. Never copy another context's table or columns.
- Field names: camelCase, not a JS reserved word (`default`, `new`…) and not the entity's own name.
- What the request leaves open and the conventions do not settle (bounds, uniqueness, optional refs): pick the
  usual answer and list it under Decisions, so the human can veto it before any code exists. Ask only when the
  choice changes the data model.

## 3. Write `docs/features/<context>-<entity>.md`

````markdown
# <Entity> (<context>)

Started: <the date -u output from step 1>

<one sentence: what it is in the game>

## Routes

POST, GET, GET /:id, PATCH /:id, DELETE /:id on /<plural>.

## Decisions

- <each default you picked, one line>

## Domain rules for feature-tests

- <a rule the generated matrix does not cover, testable through HTTP, e.g. "PATCH to another player's id transfers the deed">

```json slice
{ "context": "…", "entity": "…", "plural": "…", "summary": "…", "fields": [
  { "name": "title", "type": "text", "min": 1, "max": 40, "unique": true },
  { "name": "colorGroup", "type": "enum", "values": ["brown", "light-blue"] },
  { "name": "price", "type": "int", "min": 1, "max": 1000 },
  { "name": "ownerId", "type": "ref", "ref": "lobby.players", "optional": true,
    "fixture": { "url": "/players", "body": { "name": "Alice", "token": "car" } } }
] }
```
````

## 4. Validate

`monopoly-slice docs/features/<context>-<entity>.md --dry-run` must list the files it would create. An error
names the field to fix; fix the plan and re-run.

## 5. Report

The plan path, the dry-run file list (and NEEDS lines), the Decisions. Next:
`/monopoly-kit:feature-scaffold docs/features/<context>-<entity>.md`. No code in this step.
