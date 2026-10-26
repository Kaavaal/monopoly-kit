// node --test tests/ — monopoly-slice against a minimal fake repo. The real proof (generated code typechecks and
// its tests pass) is tests/e2e.sh against a monopoly-online checkout.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { facts, logRow, normalize, plan, readSpec } from '../scripts/monopoly-slice.mjs'

const CLI = new URL('../scripts/monopoly-slice.mjs', import.meta.url).pathname
const placeholder = ctx => `// ${ctx} context.
import type { FastifyInstance } from 'fastify';

import type { Db } from '../shared/db.js';

export interface ${ctx[0].toUpperCase()}${ctx.slice(1)}Api {}

export function create${ctx[0].toUpperCase()}${ctx.slice(1)}Module(deps: { db: Db }): {
  register(app: FastifyInstance): void;
  api: ${ctx[0].toUpperCase()}${ctx.slice(1)}Api;
} {
  return {
    register() {},
    api: {},
  };
}
`
function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ms-'))
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  put('src/app.ts', '  const lobby = createLobbyModule({ db });\n  const board = createBoardModule({ db });\n')
  put('src/lobby/module.ts', placeholder('lobby').replace('register() {},', 'register(app) { registerPlayerRoutes(app, createPlayerService(x)); },'))
  put('src/lobby/app/service.ts', 'export {}\n')
  put('src/board/module.ts', placeholder('board'))
  put('migrations/0001_lobby_players.sql', '')
  put('migrations/0002_lobby_players_name_nocase.sql', '')
  return { root, put }
}
const property = {
  context: 'board',
  entity: 'Property',
  plural: 'properties',
  fields: [
    { name: 'name', type: 'text', max: 40, unique: true },
    { name: 'colorGroup', type: 'enum', values: ['brown', 'dark-blue'] },
    { name: 'price', type: 'int', min: 1 },
    { name: 'ownerId', type: 'ref', ref: 'lobby.players', optional: true, fixture: { url: '/players', body: { name: 'Alice', token: 'car' } } },
  ],
}

test('readSpec(): needs the json slice block', () => {
  assert.throws(() => readSpec('# no block'), /json slice/)
  assert.deepEqual(readSpec('x\n```json slice\n{"a":1}\n```\n'), { a: 1 })
})

test('normalize(): lists every problem at once', () => {
  const { root } = fakeRepo()
  const spec = {
    context: 'nope',
    entity: 'property',
    fields: [
      { name: 'kind', type: 'enum', values: ['one'] },
      { name: 'title', type: 'text', max: 10, optional: true },
    ],
  }
  assert.throws(() => normalize(spec, root), e => {
    for (const re of [/src\/nope\/module\.ts does not exist/, /entity must be PascalCase/, /field kind: enum needs 2\+/, /field title: only ref fields can be optional/]) {
      assert.match(e.message, re)
    }
    return true
  })
})

test('normalize(): problem messages name the field', () => {
  const { root } = fakeRepo()
  try {
    normalize({ context: 'board', entity: 'Property', fields: [{ name: 'owner', type: 'ref', ref: 'board.x' }] }, root)
    assert.fail('expected a throw')
  } catch (e) {
    assert.match(e.message, /field owner: a ref field name ends in Id/)
    assert.match(e.message, /field owner: ref is "<other context>.<plural>"/)
    assert.match(e.message, /field owner: ref needs fixture/)
  }
})

test('plan(): a ref slice in an empty context', () => {
  const { root } = fakeRepo()
  const r = plan(property, root)
  assert.deepEqual([...r.files.keys()], [
    'migrations/0003_board_properties.sql',
    'src/board/domain/property.ts',
    'src/board/app/service.ts',
    'src/board/infra/sqlite/propertyRepo.ts',
    'src/board/infra/http/routes.ts',
    'test/board/property.test.ts',
  ])
  const sql = r.files.get('migrations/0003_board_properties.sql')
  assert.match(sql, /"color_group" TEXT NOT NULL CHECK \("color_group" IN \('brown', 'dark-blue'\)\)/)
  assert.match(sql, /"price" INTEGER NOT NULL CHECK \("price" >= 1\)/)
  assert.match(sql, /"owner_id" TEXT,/)
  assert.match(sql, /CREATE UNIQUE INDEX properties_name_nocase ON properties \("name" COLLATE NOCASE\);/)
  assert.match(r.files.get('src/board/domain/property.ts'), /export const COLOR_GROUPS = \['brown', 'dark-blue'\] as const;/)
  assert.match(r.edits.get('src/board/module.ts'), /deps: \{ db: Db; lobby: LobbyApi \}/)
  assert.match(r.edits.get('src/board/module.ts'), /ownerExists: \(id\) => deps\.lobby\.players\.exists\(id\)/)
  assert.match(r.edits.get('src/app.ts'), /createBoardModule\(\{ db, lobby: lobby\.api \}\)/)
  assert.equal(r.needs.length, 1)
  assert.match(r.needs[0], /src\/lobby\/module\.ts: LobbyApi has no players\.exists\(id\)/)
})

test('plan(): no NEEDS for the api once it exposes exists', () => {
  const { root, put } = fakeRepo()
  put('src/lobby/module.ts', placeholder('lobby').replace('export interface LobbyApi {}', 'export interface LobbyApi {\n  players: { exists(id: string): boolean };\n}'))
  assert.deepEqual(plan(property, root).needs, [])
})

test('plan(): a second slice in a used context gets suffixed files and a wiring NEEDS', () => {
  const { root } = fakeRepo()
  const r = plan({ context: 'lobby', entity: 'Room', fields: [{ name: 'title', type: 'text', max: 40 }] }, root)
  assert.ok(r.files.has('src/lobby/app/roomService.ts'))
  assert.ok(r.files.has('src/lobby/infra/http/roomRoutes.ts'))
  assert.ok(r.files.has('migrations/0003_lobby_rooms.sql'))
  assert.equal(r.edits.size, 0)
  assert.match(r.needs[0], /src\/lobby\/module\.ts: wire the new slice/)
})

test('plan(): a ref to a context created later is refused', () => {
  const { root, put } = fakeRepo()
  put('src/app.ts', '  const board = createBoardModule({ db });\n  const lobby = createLobbyModule({ db });\n')
  assert.throws(() => plan(property, root), /must create the lobby module before board/)
})

const alice = { url: '/players', body: { name: 'Alice', token: 'car' } }
const problems = (spec, root) => {
  try {
    normalize(spec, root)
    return ''
  } catch (e) {
    return e.message
  }
}

test('normalize(): names that break the generated SQL, JS or tests are refused', () => {
  const { root } = fakeRepo()
  const msg = problems(
    {
      context: 'board',
      entity: 'Note',
      fields: [
        { name: 'default', type: 'int', min: 0 },
        { name: 'note', type: 'text', max: 200 },
        { name: 'title', type: 'text', min: -1, max: 10 },
        { name: 'title', type: 'text', min: 1.5, max: 10 },
        { name: 'newId', type: 'ref', ref: 'lobby.players', fixture: alice },
      ],
    },
    root,
  )
  assert.match(msg, /field default: a JS reserved word/)
  assert.match(msg, /field note: same name as the entity's variable/)
  assert.match(msg, /field title: text min must be an integer >= 0/)
  assert.match(msg, /field title: duplicate name/)
  assert.match(msg, /field newId: a JS reserved word/)
})

test('normalize(): two refs with the same fixture are refused', () => {
  const { root } = fakeRepo()
  const ref = name => ({ name, type: 'ref', ref: 'lobby.players', fixture: alice })
  assert.match(problems({ context: 'board', entity: 'Transfer', fields: [ref('fromId'), ref('toId')] }, root), /field toId: same fixture as fromId/)
})

test('normalize(): the default plural is English, and a bad one gets a suggestion', () => {
  const { root } = fakeRepo()
  const field = [{ name: 'title', type: 'text', max: 10 }]
  assert.equal(normalize({ context: 'board', entity: 'Property', fields: field }, root).plural, 'properties')
  assert.equal(normalize({ context: 'board', entity: 'TitleDeed', fields: field }, root).plural, 'titledeeds')
  assert.match(problems({ context: 'board', entity: 'TitleDeed', plural: 'title_deeds', fields: field }, root), /e\.g\. "titledeeds"/)
})

test('plan(): columns are quoted in SQL (group, order are SQLite keywords)', () => {
  const { root } = fakeRepo()
  const r = plan({ context: 'board', entity: 'Tile', fields: [{ name: 'group', type: 'enum', values: ['brown', 'red'] }, { name: 'order', type: 'int', min: 0, max: 39 }] }, root)
  assert.match(r.files.get('migrations/0003_board_tiles.sql'), /"group" TEXT NOT NULL CHECK \("group" IN \('brown', 'red'\)\),\n  "order" INTEGER NOT NULL CHECK \("order" >= 0 AND "order" <= 39\)/)
  const repo = r.files.get('src/board/infra/sqlite/tileRepo.ts')
  assert.match(repo, /INSERT INTO tiles \(id, "group", "order", created_at\)/)
  assert.match(repo, /UPDATE tiles SET "group" = :group, "order" = :order WHERE id = :id/)
})

test('plan(): an entity of refs only gets PATCH tests that can pass', () => {
  const { root } = fakeRepo()
  const r = plan({ context: 'board', entity: 'Wallet', fields: [{ name: 'ownerId', type: 'ref', ref: 'lobby.players', fixture: alice }] }, root)
  const t = r.files.get('test/board/wallet.test.ts')
  assert.match(t, /const changes = valid\(2\);/)
  assert.match(t, /await patch\(a\.id, \{ ownerId: refs\.ownerId \}\)/)
  assert.match(t, /patch\(UNKNOWN_ID, \{ ownerId: refs\.ownerId \}\), 404/)
  assert.match(t, /patch\('nope', \{ ownerId: refs\.ownerId \}\), 400/)
  assert.doesNotMatch(r.files.get('src/board/infra/http/routes.ts'), /import \{\s*\} from/)
  assert.doesNotMatch(r.files.get('src/board/domain/wallet.ts'), /invalid/)
})

test('plan(): trim tests fit short text, blank and padded-short cases reach the domain', () => {
  const { root } = fakeRepo()
  const r = plan({ context: 'board', entity: 'Color', fields: [{ name: 'code', type: 'text', max: 6, unique: true }, { name: 'tag', type: 'text', min: 3, max: 3 }, { name: 'title', type: 'text', min: 4, max: 40 }] }, root)
  const t = r.files.get('test/board/color.test.ts')
  for (const [, value] of t.matchAll(/code: '([^']*)'/g)) assert.ok(value.length <= 6, `code '${value}' longer than max 6`)
  assert.match(t, /it\('trims code'/)
  assert.doesNotMatch(t, /trims tag/, 'max = min leaves no room to pad')
  assert.match(t, /\['blank title', \{ title: ' {4}' \}\]/, 'blank passes minLength 4')
  assert.match(t, /\['padded 3-character title', \{ title: ' aaa ' \}\]/)
  const patchPart = t.slice(t.indexOf("describe('PATCH"))
  assert.match(patchPart, /it\('trims title'/)
})

test('plan(): two refs to the same api print its NEEDS once', () => {
  const { root } = fakeRepo()
  const r = plan({ context: 'board', entity: 'Transfer', fields: [
    { name: 'fromId', type: 'ref', ref: 'lobby.players', fixture: alice },
    { name: 'toId', type: 'ref', ref: 'lobby.players', fixture: { url: '/players', body: { name: 'Bob', token: 'hat' } } },
  ] }, root)
  assert.equal(r.needs.filter(x => /LobbyApi has no players\.exists/.test(x)).length, 1)
})

test('plan(): a ref slice in a used context names the deps and the refs object', () => {
  const { root, put } = fakeRepo()
  put('src/board/module.ts', placeholder('board').replace('register() {},', 'register(app) { registerTileRoutes(app, createTileService(x)); },'))
  put('src/board/app/service.ts', 'export {}\n')
  const deed = { context: 'board', entity: 'Deed', fields: [{ name: 'title', type: 'text', max: 30 }, { name: 'holderId', type: 'ref', ref: 'lobby.players', optional: true, fixture: alice }] }
  const r = plan(deed, root)
  assert.match(r.needs[0], /add lobby: LobbyApi to deps/)
  assert.match(r.needs[0], /createDeedService\(createDeedRepo\(deps\.db\), \{ holderExists: \(id\) => deps\.lobby\.players\.exists\(id\) \}\)/)
  assert.match(r.edits.get('src/app.ts'), /createBoardModule\(\{ db, lobby: lobby\.api \}\)/)
  put('src/app.ts', '  const lobby = createLobbyModule({ db });\n  const board = createBoardModule({ db, lobby: lobby.api });\n')
  const again = plan(deed, root)
  assert.equal(again.edits.has('src/app.ts'), false)
  assert.equal(again.needs.some(x => x.startsWith('src/app.ts')), false, 'app.ts already passes lobby')
})

test('facts(): an api with nested members is reported whole', () => {
  const { root, put } = fakeRepo()
  put('src/lobby/module.ts', placeholder('lobby').replace('export interface LobbyApi {}', 'export interface LobbyApi {\n  players: { exists(id: string): boolean };\n  rooms: { exists(id: string): boolean };\n}'))
  assert.match(facts(root, 'lobby'), /LobbyApi: players: \{ exists\(id: string\): boolean \}; rooms: \{ exists\(id: string\): boolean \};/)
})

test('logRow(): no minutes when Started is not a date', () => {
  const row = logRow({ plan: 'Started: <the date -u output from step 1>\n', tests: '12', now: '2026-10-26T21:03:30Z', branch: 'feature-2/x', sha: 'abc1234', subject: 's' })
  assert.equal(row, '| 2026-10-26T21:03:30Z | feature-2/x | abc1234 | s | 12 tests passing |')
})

test('CLI log-row: refuses a detached HEAD', () => {
  const { root, put } = fakeRepo()
  put('docs/features/q.md', 'Started: 2026-10-26T21:00:00Z\n')
  const g = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' })
  g('init', '-q', '-b', 'main')
  g('add', '.')
  g('commit', '-qm', 'init')
  g('checkout', '-q', '--detach')
  const r = spawnSync('node', [CLI, 'log-row', 'docs/features/q.md', '12'], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /detached/)
})

test('logRow(): minutes from the plan Started line', () => {
  const row = logRow({ plan: 'Started: 2026-10-26T21:00:00Z\n', tests: '98', now: '2026-10-26T21:03:30Z', branch: 'feature-2/properties', sha: 'abc1234', subject: 'feat(board): property CRUD' })
  assert.equal(row, '| 2026-10-26T21:03:30Z | feature-2/properties | abc1234 | feat(board): property CRUD | 98 tests passing, 3.5 min since first prompt |')
})

test('CLI: writes, then refuses to overwrite', () => {
  const { root, put } = fakeRepo()
  put('docs/features/board-property.md', `# Property\n\n\`\`\`json slice\n${JSON.stringify(property)}\n\`\`\`\n`)
  const run = (...a) => spawnSync('node', [CLI, ...a], { cwd: root, encoding: 'utf8' })
  const dry = run('docs/features/board-property.md', '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /dry run: nothing written/)
  const first = run('docs/features/board-property.md')
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /NEEDS src\/lobby\/module\.ts/)
  assert.match(readFileSync(join(root, 'src/board/module.ts'), 'utf8'), /createPropertyService/)
  const again = run('docs/features/board-property.md')
  assert.equal(again.status, 1)
  assert.match(again.stderr, /refusing to overwrite/)
  assert.match(run('facts', 'board').stdout, /next migration: 0004/)
})
