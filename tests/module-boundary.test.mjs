// node --test tests/ — the module-boundary hook run as Claude Code runs it: JSON on stdin, exit code + stderr.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const HOOK = new URL('../hooks/module-boundary.mjs', import.meta.url).pathname
const root = mkdtempSync(join(tmpdir(), 'mb-'))
const put = (rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}
put('package.json', '{}')
put('src/lobby/module.ts', 'export {}\n')
put('src/board/domain/property.ts', 'export type Property = { id: string }\n')
put('src/board/app/legacy.ts', "import { x } from '../../lobby/infra/sqlite/playerRepo.js'\n")

function hook(tool_input, tool_name = 'Write') {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, cwd: root, tool_input }),
    encoding: 'utf8',
  })
  return { code: r.status, err: r.stderr }
}
const write = (rel, content) => hook({ file_path: join(root, rel), content })

const blocked = [
  ['deep import into another context', "import { PlayerRepo } from '../../lobby/infra/sqlite/playerRepo.js'"],
  ['type-only import', "import type { Player } from '../../lobby/domain/player.js'"],
  ['re-export', "export { createPlayer } from '../../lobby/app/playerService.js'"],
  ['export star', "export * from '../../lobby/domain/player.js'"],
  ['dynamic import', "const m = await import('../../lobby/infra/x.js')"],
  ['side-effect import', "import '../../lobby/infra/x.js'"],
  ['multi-line import', "import {\n  a,\n  b,\n} from '../../lobby/app/x.js'"],
  ['traversal back into lobby internals', "import { a } from '../../lobby/../lobby/infra/x.js'"],
  ['another context module subfolder', "import { a } from '../../lobby/module/x.js'"],
  ['dynamic import with a template literal', 'const m = await import(`../../lobby/infra/x.js`)'],
  ['multi-line dynamic import with a trailing comma', "const m = await import(\n  '../../lobby/infra/x.js',\n)"],
  ['dynamic import with options', "const m = await import('../../lobby/infra/x.json', { with: { type: 'json' } })"],
  ['import = require', "import x = require('../../lobby/infra/x.js')"],
  ["a comment with an apostrophe in the import list", "import {\n  a, // Claude's note\n} from '../../lobby/app/x.js'"],
  ['a comment with ; in the import list', "import {\n  a, // one; two\n} from '../../lobby/app/x.js'"],
]
for (const [name, line] of blocked) {
  test(`blocks: ${name}`, () => {
    const r = write('src/board/app/service.ts', `${line}\n`)
    assert.equal(r.code, 2, r.err)
    assert.match(r.err, /BLOCKED by monopoly-kit\/hooks\/module-boundary\.mjs/)
    assert.match(r.err, /src\/lobby\/module\.ts/)
  })
}

const allowed = [
  ['the other context module.ts', "import type { LobbyApi } from '../../lobby/module.js'"],
  ['module without extension', "import type { LobbyApi } from '../../lobby/module'"],
  ['shared', "import { notFound } from '../../shared/errors.js'"],
  ['own context', "import type { Property } from '../domain/property.js'"],
  ['a package', "import Fastify from 'fastify'"],
  ['node builtin', "import { DatabaseSync } from 'node:sqlite'"],
  ['a commented-out import', "// import { a } from '../../lobby/infra/x.js'"],
  ['an import in a block comment', "/*\nimport { a } from '../../lobby/infra/x.js'\n*/"],
]
for (const [name, line] of allowed) {
  test(`allows: ${name}`, () => {
    const r = write('src/board/app/service.ts', `${line}\n`)
    assert.equal(r.code, 0, r.err)
  })
}

test('allows the wiring layer src/app.ts to import every context', () => {
  assert.equal(write('src/app.ts', "import { x } from './lobby/infra/sqlite/playerRepo.js'\n").code, 0)
})

test('ignores tests and non-source files', () => {
  assert.equal(write('test/board/p.test.ts', "import { a } from '../../src/lobby/infra/x.js'\n").code, 0)
  assert.equal(write('src/board/README.md', "import { a } from '../lobby/infra/x.js'\n").code, 0)
})

test('Edit: blocks the cross-context import an edit adds', () => {
  const r = hook(
    {
      file_path: join(root, 'src/board/domain/property.ts'),
      old_string: 'export type Property',
      new_string: "import type { Player } from '../../lobby/domain/player.js'\nexport type Property",
    },
    'Edit',
  )
  assert.equal(r.code, 2, r.err)
})

test('Edit: an older violation in the file does not block an unrelated edit', () => {
  const r = hook(
    { file_path: join(root, 'src/board/app/legacy.ts'), old_string: 'import { x }', new_string: 'import { x as y }' },
    'Edit',
  )
  assert.equal(r.code, 0, r.err)
})

test('MultiEdit: blocks when any edit adds a violation', () => {
  const r = hook(
    {
      file_path: join(root, 'src/board/domain/property.ts'),
      edits: [
        { old_string: 'id: string', new_string: 'id: string; ownerId: string | null' },
        { old_string: 'export type', new_string: "import type { P } from '../../lobby/domain/player.js'\nexport type" },
      ],
    },
    'MultiEdit',
  )
  assert.equal(r.code, 2, r.err)
})

test('malformed input never blocks', () => {
  const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' })
  assert.equal(r.status, 0)
})
