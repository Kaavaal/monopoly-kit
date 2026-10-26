#!/usr/bin/env node
// PreToolUse hook (Edit|Write|MultiEdit): a bounded context imports another one only through its
// src/<context>/module.ts. Checks the file as it will be after the edit and blocks only the cross-context
// imports the edit adds, so an older violation never blocks an unrelated change. Scope: Edit, Write and
// MultiEdit; a Bash write (sed -i, a heredoc) never reaches this hook — `pnpm arch:check` is the backstop.
import { journal } from './journal.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"](?<spec>[^'"]+)['"]/g, // import x from '…', export { x } from '…'
  /\bimport\s*['"](?<spec>[^'"]+)['"]/g, // import '…'
  /\bimport\s*\(\s*(['"`])(?<spec>[^'"`$]+)\1\s*[,)]/g, // import('…'), import(`…`), import('…', { with })
  /\bimport\s+\w+\s*=\s*require\s*\(\s*['"](?<spec>[^'"]+)['"]/g, // import x = require('…')
]

/** Comments out, strings kept: a commented-out import is not an import, and a `//` in a string is not a comment. */
const stripComments = source =>
  source.replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, quote) => (quote ? m : ' '))

export function specifiers(source) {
  const code = stripComments(source)
  return SPECIFIERS.flatMap(re => [...code.matchAll(re)].map(m => m.groups.spec))
}

/** The file content after the tool call, the way the Edit tool applies old_string/new_string. */
export function contentAfter(input, before) {
  if (typeof input.content === 'string') return input.content
  const edits = Array.isArray(input.edits) ? input.edits : [input]
  return edits.reduce((text, { old_string: oldS = '', new_string: newS = '', replace_all: all }) => {
    if (oldS === '') return newS
    if (!text.includes(oldS)) return text
    return all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS)
  }, before)
}

/** Nearest ancestor holding package.json and src/: the project root. */
export function projectRoot(file) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src'))) return dir
  }
  return null
}

/** `src/<context>/…` → context, except shared/ and the wiring files at src/ root. */
export function contextOf(relPath) {
  const parts = relPath.split(sep)
  if (parts[0] !== 'src' || parts.length < 3 || parts[1] === 'shared') return null
  return parts[1]
}

/** Cross-context imports in `source` of `file`, as `<specifier> → <target>` strings. */
export function violations(source, file, root) {
  const own = contextOf(relative(root, file))
  if (!own) return []
  const found = new Set()
  for (const spec of specifiers(source)) {
    if (!spec.startsWith('.')) continue
    const target = relative(root, resolve(dirname(file), spec))
    const other = contextOf(target)
    if (!other || other === own) continue
    const inside = target.split(sep).slice(2).join('/').replace(/\.(js|ts|mjs|mts)$/, '')
    if (inside === 'module') continue
    found.add(`${spec} → ${target.split(sep).join('/')}`)
  }
  return [...found]
}

function main() {
  let event
  try {
    event = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return 0
  }
  const input = event.tool_input ?? {}
  const file = input.file_path
  if (typeof file !== 'string' || !/\.(ts|mts|js|mjs)$/.test(file)) return 0
  const root = projectRoot(resolve(event.cwd ?? '.', file))
  if (!root) return 0
  const abs = resolve(event.cwd ?? '.', file)
  const own = contextOf(relative(root, abs))
  if (!own) return 0
  const before = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  const old = new Set(violations(before, abs, root))
  const added = violations(contentAfter(input, before), abs, root).filter(v => !old.has(v))
  journal(root, 'module-boundary', added.length ? 'block' : 'allow', `${relative(root, abs)}${added.length ? `: ${added.join('; ')}` : ''}`)
  if (!added.length) return 0

  const others = [...new Set(added.map(v => v.split('→ ')[1].split('/')[1]))]
  process.stderr.write(
    `BLOCKED by monopoly-kit/hooks/module-boundary.mjs: ${relative(root, abs)} (context "${own}") would import ` +
      `another context's internals:\n${added.map(v => `  - ${v}`).join('\n')}\n` +
      `Contexts talk only through src/<context>/module.ts. Expose what "${own}" needs on the ` +
      `${others.map(o => `${o[0].toUpperCase()}${o.slice(1)}Api in src/${o}/module.ts`).join(', ')} and pass it into ` +
      `create${own[0].toUpperCase()}${own.slice(1)}Module from src/app.ts. Do not work around it (re-exports, ` +
      `dynamic imports, copying the code, writing the file through Bash).\n`,
  )
  return 2
}

if (import.meta.main) process.exitCode = main()
