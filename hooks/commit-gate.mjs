#!/usr/bin/env node
// PreToolUse hook (Bash): before a `git commit` runs, test the contexts the commit touches. A context with
// source changes and no test/<context>/ folder blocks too: every slice ships with its tests. Then typecheck
// and arch:check over the whole tree. Checks the working tree, not the staged snapshot. The hook runs before
// the command, so a `git add` earlier in the same line and `git commit <paths>` count by their pathspecs.
// Only *.md and docs/ changes pass untouched; a file outside src/<ctx>/, test/<ctx>/ and migrations/ runs the
// whole suite. A cd/-C target the hook cannot resolve ($VAR, $(…), missing) falls back to the session cwd.
// The command splitting follows lesson 5's git-guardrails, made quote- and heredoc-aware.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { journal } from './journal.mjs'

/** Heredoc bodies are data, not commands: drop them, keep the rest of the operator's line. */
const stripHeredocs = line =>
  line.replace(/<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1([^\n]*)\n(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)/g, '$3')

/** Simple commands of a shell line as unquoted words: split on && || ; | & ( ) and newlines outside quotes. */
export function simpleCommands(line) {
  const src = stripHeredocs(line)
  const commands = [[]]
  let word = null
  let quote = ''
  const end = () => {
    if (word !== null) commands.at(-1).push(word)
    word = null
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1] ?? ''
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && /["\\$`\n]/.test(next)) {
        if (next !== '\n') word += next
        i++
      } else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      word ??= ''
    } else if (c === '\\') {
      if (next !== '\n') word = (word ?? '') + next
      i++
    } else if (c === ' ' || c === '\t') end()
    else if (/[;&|\n()]/.test(c) && !(c === '(' && word?.endsWith('$')) && !(c === '&' && (word?.endsWith('>') || next === '>'))) {
      end()
      commands.push([])
    } else word = (word ?? '') + c
  }
  end()
  return commands.filter(words => words.length)
}

/** A cd/-C target; the session cwd when it is dynamic or missing, so the gate fails closed. */
function target(base, path, cwd) {
  const dir = resolve(base, path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
  return /[$`]/.test(path) || !existsSync(dir) ? cwd : dir
}

const VALUE_OPTIONS = /^--(message|file|reuse-message|reedit-message|template|author|date|cleanup|fixup|squash|trailer)$/
const redirect = word => /^\d*[<>]/.test(word)

/** `git commit` arguments → { all, specs }: specs are its pathspecs, [] for --pathspec-from-file, null for none. */
function commitArgs(args) {
  let all = false
  const specs = []
  let fromFile = false
  for (let j = 0; j < args.length; j++) {
    const a = args[j]
    if (a === '--') {
      specs.push(...args.slice(j + 1))
      break
    }
    if (redirect(a)) {
      if (/^\d*[<>]+$/.test(a)) j++
    } else if (!a.startsWith('-') || a === '-') specs.push(a)
    else if (a === '--all') all = true
    else if (a.startsWith('--pathspec-from-file')) {
      fromFile = true
      if (!a.includes('=')) j++
    } else if (VALUE_OPTIONS.test(a)) j++
    else if (!a.startsWith('--')) {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === 'a') all = true
        if ('mFCct'.includes(a[k])) {
          if (k === a.length - 1) j++
          break
        }
      }
    }
  }
  return { all, specs: fromFile ? [] : specs.length ? specs : null }
}

/**
 * Every `git … commit …` in the line: { dir, all, paths }. dir is resolved against cwd, `cd`s and -C. paths are
 * the pathspec groups the commit will take from the working tree ([] = all of it): each `git add` earlier in the
 * line in the same dir, and the commit's own pathspecs.
 */
export function commits(line, cwd) {
  const found = new Map()
  const added = []
  let base = cwd
  for (let words of simpleCommands(line)) {
    while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || words[0] === '{')) words = words.slice(1)
    const [head = '', ...rest] = words
    if (head === 'cd') {
      base = target(base, rest[0] ?? process.env.HOME ?? '/', cwd)
      continue
    }
    if (head !== 'git' && !head.endsWith('/git')) continue
    let dir = base
    let i = 0
    for (; i < rest.length; i++) {
      const word = rest[i]
      if (word === '-C') dir = target(dir, rest[++i] ?? '.', cwd)
      else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(word)) i++
      else if (!word.startsWith('-')) break
    }
    const [sub, ...args] = rest.slice(i)
    if (sub === 'add') {
      added.push({ dir, specs: args.filter(a => !a.startsWith('-') && !redirect(a)) })
      continue
    }
    if (sub !== 'commit' || args.includes('--dry-run')) continue
    const { all, specs } = commitArgs(args)
    const paths = added.filter(a => a.dir === dir).map(a => a.specs)
    if (specs) paths.push(specs)
    const commit = { dir, all, paths }
    found.set(JSON.stringify(commit), commit)
  }
  return [...found.values()]
}

/** Which test folders a set of changed files needs; null = whole suite, [] = nothing to check. */
export function scope(files) {
  const contexts = new Set()
  for (const file of files) {
    if (file.endsWith('.md') || file.startsWith('docs/')) continue
    const m = file.match(/^(?:src|test)\/([^/]+)\//) ?? file.match(/^migrations\/\d+_([a-z]+)_/)
    if (!m || m[1] === 'shared' || m[1] === 'helpers') return null
    contexts.add(m[1])
  }
  return [...contexts]
}

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .filter(Boolean)

function run(dir, args) {
  const r = spawnSync('pnpm', ['-s', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', CI: '1' } })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

/** Files the commit will hold, relative to root; null when git cannot tell (bad pathspec): check everything. */
function changed(root, { dir, all, paths }) {
  try {
    const files = new Set(git(root, 'diff', '--cached', '--name-only'))
    if (all) git(root, 'diff', '--name-only').forEach(f => files.add(f))
    for (const specs of paths) {
      git(dir, 'diff', '--name-only', '--no-relative', '--', ...specs).forEach(f => files.add(f))
      git(dir, 'ls-files', '--others', '--exclude-standard', '--full-name', '--', ...specs).forEach(f => files.add(f))
    }
    return [...files]
  } catch {
    return null
  }
}

function gate(commit) {
  let root
  try {
    root = git(commit.dir, 'rev-parse', '--show-toplevel')[0]
  } catch {
    return null
  }
  if (!existsSync(join(root, 'package.json')) || !existsSync(join(root, 'src'))) return null
  const files = changed(root, commit)
  const contexts = files && scope(files)
  if (contexts && !contexts.length) {
    journal(root, 'commit-gate', 'allow', 'docs only, no checks')
    return null
  }

  const label = contexts ? contexts.join(', ') : 'the whole tree'
  const block = reason => {
    journal(root, 'commit-gate', 'block', `${label}: ${reason.split('\n')[0]}`)
    return reason
  }
  const missing = (contexts ?? []).filter(c => !existsSync(join(root, 'test', c)))
  if (missing.length) return block(`the commit changes ${missing.map(c => `src/${c}`).join(', ')} but test/${missing[0]}/ does not exist — a slice ships with its tests (/monopoly-kit:feature-tests).`)
  const steps = [
    ['tests', ['exec', 'vitest', 'run', ...(contexts ?? []).map(c => `test/${c}`)]],
    ['typecheck', ['typecheck']],
    ['arch:check', ['arch:check']],
  ]
  let passed
  for (const [name, args] of steps) {
    const r = run(root, args)
    if (!r.ok) return block(`${name} failed for ${label}:\n${r.out.split('\n').slice(-30).join('\n')}`)
    if (name === 'tests') passed = r.out.match(/Tests\s+(\d+) passed/)?.[1]
  }
  journal(root, 'commit-gate', 'allow', `${label}: tests${passed ? ` (${passed} passed)` : ''}, typecheck, arch:check green`)
  return null
}

function main() {
  let event
  try {
    event = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return 0
  }
  const command = event.tool_input?.command
  if (typeof command !== 'string' || !/\bcommit\b/.test(command)) return 0
  for (const c of commits(command, event.cwd ?? process.cwd())) {
    const reason = gate(c)
    if (reason) {
      process.stderr.write(
        `BLOCKED by monopoly-kit/hooks/commit-gate.mjs: ${reason}\n` +
          'Fix the cause and commit again. Do not dodge the gate (splitting the commit, --no-verify, committing through another tool).\n',
      )
      return 2
    }
  }
  return 0
}

if (import.meta.main) process.exitCode = main()
