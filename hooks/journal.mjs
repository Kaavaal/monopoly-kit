// One line per hook decision in <git dir>/monopoly-kit-hooks.log, so a feature can count what the hooks checked
// and what they stopped. Best effort: never throws, never changes a decision. Outside git it writes nothing.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function journal(root, hook, decision, detail) {
  try {
    const dir = execFileSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    appendFileSync(join(dir, 'monopoly-kit-hooks.log'), `${at} ${hook} ${decision} ${detail.replace(/\s+/g, ' ').slice(0, 300)}\n`)
  } catch {}
}
