// node --test tests/ — commit-gate: command parsing, change scoping, and the hook against a throwaway repo
// whose vitest/typecheck/arch:check are stubs (no network, no install).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { commits, scope } from '../hooks/commit-gate.mjs'

const HOOK = new URL('../hooks/commit-gate.mjs', import.meta.url).pathname

const T = mkdtempSync(join(tmpdir(), 'cg-dirs-'))
mkdirSync(join(T, 'sub'))
mkdirSync(join(T, 'My Projects'))
const at = (dir, all = false, paths = []) => ({ dir, all, paths })

test('commits(): finds git commit in the forms Claude writes', () => {
  assert.deepEqual(commits('git commit -m "feat: x"', T), [at(T)])
  assert.deepEqual(commits('git -C sub commit -am "x"', T), [at(join(T, 'sub'), true)])
  assert.deepEqual(commits('cd sub && git add -A && git commit -m x', T), [at(join(T, 'sub'), false, [[]])])
  assert.deepEqual(commits('GIT_AUTHOR_DATE=now git commit --all -m y', T), [at(T, true)])
  assert.deepEqual(
    commits("git add src && git commit -m \"$(cat <<'EOF'\nfeat(board): x\n\nbody\nEOF\n)\"", T),
    [at(T, false, [['src']])],
  )
  assert.deepEqual(commits("git commit -q -F - <<'EOF'\nfeat: x\nEOF", T), [at(T)])
  assert.deepEqual(commits('(cd sub && git commit -m x)', T), [at(join(T, 'sub'))])
})

test('commits(): a git add earlier in the line and commit pathspecs are taken from the working tree', () => {
  assert.deepEqual(commits('git add src/board test/board && git commit -m x', T), [at(T, false, [['src/board', 'test/board']])])
  assert.deepEqual(commits('git commit -m x src/board/app/service.ts', T), [at(T, false, [['src/board/app/service.ts']])])
  assert.deepEqual(commits('git commit -am fix -- src/a test/b', T), [at(T, true, [['src/a', 'test/b']])])
  assert.deepEqual(commits('git commit -m x 2>&1 | tail -3', T), [at(T)])
  assert.deepEqual(commits('git -C sub add . && git commit -m x', T), [at(T)], 'an add in another dir is not this commit')
})

test('commits(): quoted, dynamic and missing cd/-C targets', () => {
  const spaced = join(T, 'My Projects')
  assert.deepEqual(commits(`cd "${spaced}" && git commit -m x`, T), [at(spaced)])
  assert.deepEqual(commits(`git -C "${spaced}" commit -m x`, T), [at(spaced)])
  assert.deepEqual(commits('cd "$(git rev-parse --show-toplevel)" && git commit -m x', T), [at(T)], 'dynamic: session cwd')
  assert.deepEqual(commits('cd nope && git commit -m x', T), [at(T)], 'missing: session cwd')
})

test('commits(): ignores what is not a commit, once per commit', () => {
  for (const line of [
    'git commit --dry-run -m x',
    'echo git commit',
    'echo "git commit"',
    'git log --grep commit',
    'git show HEAD',
    'pnpm test',
    "gh pr create --title x --body \"$(cat <<'EOF'\nTo reproduce:\ngit commit -m wip\nEOF\n)\"",
    'cat > docs/x.md <<EOF\ngit commit -m wip\nEOF',
  ]) {
    assert.deepEqual(commits(line, T), [], line)
  }
  assert.deepEqual(commits('git commit -m "docs: explain git commit gate; git commit runs tests"', T), [at(T)])
})

test('scope(): maps changed files to test folders', () => {
  assert.deepEqual(scope(['src/board/app/service.ts', 'test/board/p.test.ts']), ['board'])
  assert.deepEqual(scope(['migrations/0002_board_properties.sql']), ['board'])
  assert.deepEqual(scope(['src/lobby/module.ts', 'src/board/module.ts']), ['lobby', 'board'])
  assert.deepEqual(scope(['LOG.md', 'docs/CHANGELOG.md', 'docs/features/x.md', 'README.md']), [])
  for (const whole of [
    'src/shared/db.ts',
    'src/app.ts',
    'package.json',
    'pnpm-lock.yaml',
    'test/helpers/app.ts',
    'scripts/migrate.ts',
    'test/health.test.ts',
    'pnpm-workspace.yaml',
    '.github/workflows/ci.yml',
  ]) {
    assert.equal(scope([whole]), null, whole)
  }
})

function repo({ testsExit = 0, typecheckExit = 0, name = '' } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'cg-')), name)
  const put = (rel, text, mode) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
    if (mode) chmodSync(join(root, rel), mode)
  }
  put('package.json', JSON.stringify({ name: 'x', scripts: { typecheck: `node -e "process.exit(${typecheckExit})"`, 'arch:check': 'node -e 0' } }))
  put('node_modules/.bin/vitest', `#!/bin/sh\necho "vitest $*"\nexit ${testsExit}\n`, 0o755)
  put('.gitignore', 'node_modules\n')
  put('src/app.ts', 'export {}\n')
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' })
  g('init', '-q', '-b', 'main')
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.')
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return { root, put, g }
}
const run = (cwd, command) => {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
    encoding: 'utf8',
  })
  return { code: r.status, err: r.stderr }
}

test('blocks a commit that changes a context with no test folder', () => {
  const { root, put, g } = repo()
  put('src/board/app/service.ts', 'export {}\n')
  g('add', '.')
  const r = run(root, 'git commit -m "feat(board): x"')
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /test\/board\/ does not exist/)
})

test('runs the touched context tests and lets a green commit through', () => {
  const { root, put, g } = repo()
  put('src/board/app/service.ts', 'export {}\n')
  put('test/board/s.test.ts', '\n')
  g('add', '.')
  assert.equal(run(root, 'git commit -m "feat(board): x"').code, 0)
})

test('blocks when the tests are red, with their output', () => {
  const { root, put, g } = repo({ testsExit: 1 })
  put('src/board/app/service.ts', 'export {}\n')
  put('test/board/s.test.ts', '\n')
  g('add', '.')
  const r = run(root, 'git commit -m "feat(board): x"')
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /tests failed for board/)
  assert.match(r.err, /vitest run test\/board/)
})

test('-a picks up unstaged tracked changes', () => {
  const { root, put, g } = repo({ testsExit: 1 })
  put('src/lobby/x.ts', 'export {}\n')
  put('test/lobby/x.test.ts', '\n')
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.')
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lobby')
  put('src/lobby/x.ts', 'export const a = 1\n')
  assert.equal(run(root, 'git commit -m x').code, 0, 'nothing staged: nothing to check')
  assert.equal(run(root, 'git commit -am x').code, 2)
})

test('git add in the same command: the gate sees what it is about to stage', () => {
  const { root, put } = repo({ testsExit: 1 })
  put('src/board/app/service.ts', 'export {}\n')
  put('test/board/s.test.ts', '\n')
  const r = run(root, 'git add -A && git commit -m x')
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /tests failed for board/)
  const heredoc = run(root, "git add src/board test/board && git commit -m \"$(cat <<'EOF'\nfeat(board): x\n\nbody\nEOF\n)\"")
  assert.equal(heredoc.code, 2, heredoc.err)
  assert.equal(run(root, 'git add docs && git commit -m x').code, 0, 'adds nothing red')
})

test('git add of a new context with no tests blocks in the same command', () => {
  const { root, put } = repo()
  put('src/bank/domain/a.ts', 'export {}\n')
  const r = run(root, 'git add src/bank && git commit -m "feat(bank): x"')
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /test\/bank\/ does not exist/)
})

test('git commit <paths> checks the unstaged edits it commits', () => {
  const { root, put, g } = repo({ testsExit: 1 })
  put('src/board/app/service.ts', 'export {}\n')
  put('test/board/s.test.ts', '\n')
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.')
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'board')
  put('src/board/app/service.ts', 'export const a = 1\n')
  assert.equal(run(root, 'git commit -m x src/board/app/service.ts').code, 2)
})

test('code outside the contexts runs the whole suite', () => {
  const { root, put, g } = repo({ typecheckExit: 2 })
  put('scripts/migrate.ts', 'export {}\n')
  g('add', '.')
  const r = run(root, 'git commit -m "chore: scripts tweak"')
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /typecheck failed for the whole tree/)
})

test('a repo path with spaces, reached by a quoted cd or -C', () => {
  const { root, put, g } = repo({ testsExit: 1, name: 'My Projects' })
  put('src/board/app/service.ts', 'export {}\n')
  put('test/board/s.test.ts', '\n')
  g('add', '.')
  const parent = dirname(root)
  assert.equal(run(parent, `cd "${root}" && git commit -m x`).code, 2)
  assert.equal(run(parent, `git -C "${root}" commit -m x`).code, 2)
  assert.equal(run(root, 'git commit -m x').code, 2)
})

test('a heredoc that only mentions git commit runs nothing', () => {
  const { root, put, g } = repo({ testsExit: 1 })
  put('src/board/app/service.ts', 'export {}\n')
  put('test/board/s.test.ts', '\n')
  g('add', '.')
  assert.equal(run(root, "gh pr create --title x --body \"$(cat <<'EOF'\nTo reproduce:\ngit commit -m wip\nEOF\n)\"").code, 0)
})

test('docs-only commits pass without running checks', () => {
  const { root, put, g } = repo({ testsExit: 1 })
  put('LOG.md', '| row |\n')
  g('add', '.')
  assert.equal(run(root, 'git commit -m "chore(log): row"').code, 0)
})

test('non-commit commands and malformed input pass', () => {
  assert.equal(run(tmpdir(), 'pnpm test').code, 0)
  assert.equal(spawnSync('node', [HOOK], { input: '{', encoding: 'utf8' }).status, 0)
})

test('journals every decision in the git dir', () => {
  const { root, put, g } = repo()
  put('src/board/app/service.ts', 'export {}\n')
  g('add', '.')
  assert.equal(run(root, 'git commit -m "feat(board): x"').code, 2)
  put('test/board/s.test.ts', '\n')
  g('add', '.')
  assert.equal(run(root, 'git commit -m "feat(board): x"').code, 0)
  const log = readFileSync(join(root, '.git', 'monopoly-kit-hooks.log'), 'utf8').trim().split('\n')
  assert.equal(log.length, 2)
  assert.match(log[0], /^\S+Z commit-gate block board: the commit changes src\/board/)
  assert.match(log[1], /^\S+Z commit-gate allow board: tests, typecheck, arch:check green$/)
})
