#!/bin/bash
# End-to-end check of monopoly-slice on a real monopoly-online checkout, in a throwaway detached worktree:
# a ref slice in an empty context (bank Account → lobby players), a second slice in a used one (lobby Room),
# SQL-keyword columns with short text (board Tile), refs only with two refs to one api (turns Seat), the NEEDS
# edits Claude would make, then pnpm check. Nothing touches the checkout you pass.
# usage: tests/e2e.sh <monopoly-online repo> [ref]
set -euo pipefail
repo=$(cd "${1:?monopoly-online repo}" && pwd)
gen="$(cd "$(dirname "$0")/.." && pwd)/scripts/monopoly-slice.mjs"
wt=$(mktemp -d)/e2e
git -C "$repo" worktree add -q --detach "$wt" "${2:-HEAD}"
trap 'git -C "$repo" worktree remove --force "$wt"' EXIT
cd "$wt"
pnpm install --frozen-lockfile --prefer-offline >/dev/null

mkdir -p docs/features
cat >docs/features/bank-account.md <<'EOF'
```json slice
{ "context": "bank", "entity": "Account", "summary": "a player's money in one game", "fields": [
  { "name": "label", "type": "text", "max": 24, "unique": true },
  { "name": "currency", "type": "enum", "values": ["mono", "euro"] },
  { "name": "balance", "type": "int", "min": 0, "max": 100000 },
  { "name": "holderId", "type": "ref", "ref": "lobby.players", "optional": true,
    "fixture": { "url": "/players", "body": { "name": "Alice", "token": "car" } } } ] }
```
EOF
cat >docs/features/lobby-room.md <<'EOF'
```json slice
{ "context": "lobby", "entity": "Room", "fields": [
  { "name": "title", "type": "text", "min": 3, "max": 40, "unique": true },
  { "name": "capacity", "type": "int", "min": 2, "max": 8 },
  { "name": "speed", "type": "enum", "values": ["classic", "fast"] } ] }
```
EOF
cat >docs/features/board-tile.md <<'EOF'
```json slice
{ "context": "board", "entity": "Tile", "fields": [
  { "name": "code", "type": "text", "max": 6, "unique": true },
  { "name": "label", "type": "text", "min": 4, "max": 40 },
  { "name": "group", "type": "enum", "values": ["brown", "red"] },
  { "name": "order", "type": "int", "min": 0, "max": 39 } ] }
```
EOF
cat >docs/features/turns-seat.md <<'EOF'
```json slice
{ "context": "turns", "entity": "Seat", "fields": [
  { "name": "playerId", "type": "ref", "ref": "lobby.players",
    "fixture": { "url": "/players", "body": { "name": "Alice", "token": "car" } } },
  { "name": "hostId", "type": "ref", "ref": "lobby.players", "optional": true,
    "fixture": { "url": "/players", "body": { "name": "Bob", "token": "hat" } } } ] }
```
EOF

echo "\$ monopoly-slice docs/features/bank-account.md"
node "$gen" docs/features/bank-account.md
echo "\$ monopoly-slice docs/features/lobby-room.md"
node "$gen" docs/features/lobby-room.md
echo "\$ monopoly-slice docs/features/board-tile.md"
node "$gen" docs/features/board-tile.md
echo "\$ monopoly-slice docs/features/turns-seat.md"
node "$gen" docs/features/turns-seat.md

# The NEEDS edits, as Claude makes them: LobbyApi.players.exists (unless lobby already has it) and Room wiring.
node --input-type=module - <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
const p = 'src/lobby/module.ts'
let s = readFileSync(p, 'utf8')
if (!/players:\s*\{[^}]*exists/.test(s)) {
  s = s.replace('export interface LobbyApi {}', 'export interface LobbyApi {\n  players: { exists(id: string): boolean };\n}')
    .replace('    api: {},', '    api: {\n      players: {\n        exists: (id) => {\n          try {\n            players.get(id);\n            return true;\n          } catch {\n            return false;\n          }\n        },\n      },\n    },')
}
s = s.replace("import type { Db } from '../shared/db.js';", "import type { Db } from '../shared/db.js';\nimport { createRoomService } from './app/roomService.js';\nimport { registerRoomRoutes } from './infra/http/roomRoutes.js';\nimport { createRoomRepo } from './infra/sqlite/roomRepo.js';")
  .replace(/(\n\s*const players = [^\n]+\n)/, '$1  const rooms = createRoomService(createRoomRepo(deps.db));\n')
  .replace(/(\n(\s*)registerPlayerRoutes\(app, players\);)/, '$1\n$2registerRoomRoutes(app, rooms);')
writeFileSync(p, s)
JS
echo "\$ pnpm check"
pnpm -s check 2>&1 | grep -E "error|Test Files|Tests |violations|FAIL" || true
pnpm -s check >/dev/null 2>&1 && echo "e2e: green" || { echo "e2e: red"; exit 1; }
