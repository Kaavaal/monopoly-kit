#!/usr/bin/env node
// monopoly-slice: one CRUD vertical slice of monopoly-online from a plan file, in the shape of the first slice
// (lobby/players, written by hand in F1): migration, domain, service, sqlite repo, Fastify routes, module wiring
// and the HTTP test matrix. Deterministic, never overwrites a file, and prints what it could not do as NEEDS
// lines for Claude. Run from the repo root:
//   monopoly-slice facts [context]              what a plan needs: contexts, their apis, next migration, exemplar
//   monopoly-slice <plan.md> [--dry-run]         generate the slice in the plan's ```json slice block
//   monopoly-slice log-row <plan.md> <tests>     append the LOG.md row for the commit at HEAD
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const up = s => s[0].toUpperCase() + s.slice(1)
const low = s => s[0].toLowerCase() + s.slice(1)
const snake = s => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
const CONST = s => snake(s).toUpperCase()
const singular = s => (s.endsWith('ies') ? `${s.slice(0, -3)}y` : s.replace(/s$/, ''))
const q = v => (typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v))
/** A TS object literal: { name: 'Alpha', price: 1 } */
const lit = o => (Object.keys(o).length ? `{ ${Object.entries(o).map(([k, v]) => `${k}: ${v && typeof v === 'object' ? lit(v) : q(v)}`).join(', ')} }` : '{}')

// ---------------------------------------------------------------- spec

export function readSpec(markdown) {
  const block = markdown.match(/```json slice\n([\s\S]*?)\n```/)
  if (!block) throw new Error('the plan has no ```json slice block')
  return JSON.parse(block[1])
}

// Field names become JS identifiers (validator params, route schema consts, test fixtures).
const RESERVED = new Set(
  ('arguments await break case catch class const continue debugger default delete do else enum eval export extends ' +
    'false finally for function if implements import in instanceof interface let new null package private protected ' +
    'public return static super switch this throw true try typeof var void while with yield').split(' '),
)

/** Checks the spec and fills defaults; throws one error listing every problem. */
export function normalize(spec, root) {
  const problems = []
  const s = { ...spec, fields: (spec.fields ?? []).map(f => ({ ...f })) }
  if (!/^[a-z]+$/.test(s.context ?? '')) problems.push('context must be lowercase letters')
  else if (!existsSync(join(root, 'src', s.context, 'module.ts'))) problems.push(`src/${s.context}/module.ts does not exist`)
  if (!/^[A-Z][A-Za-z]+$/.test(s.entity ?? '')) problems.push('entity must be PascalCase, e.g. Property')
  const usual = plural(low(s.entity ?? 'x')).toLowerCase()
  s.plural ??= usual
  if (!/^[a-z]+$/.test(s.plural)) problems.push(`plural must be lowercase letters (it is the table and the route), e.g. "${usual}"`)
  if (!s.fields.length) problems.push('fields is empty')
  const seen = new Set()
  const fixtures = new Map()
  for (const f of s.fields) {
    const at = `field ${f.name ?? '?'}`
    if (!/^[a-z][A-Za-z0-9]*$/.test(f.name ?? '') || ['id', 'createdAt'].includes(f.name)) problems.push(`${at}: bad or reserved name`)
    else if (RESERVED.has(f.name) || (f.type === 'ref' && RESERVED.has(f.name.slice(0, -2)))) problems.push(`${at}: a JS reserved word; rename it`)
    else if (s.entity && f.name === low(s.entity)) problems.push(`${at}: same name as the entity's variable; rename it, e.g. ${f.name}Text`)
    if (seen.has(f.name)) problems.push(`${at}: duplicate name`)
    seen.add(f.name)
    if (f.optional && f.type !== 'ref') problems.push(`${at}: only ref fields can be optional`)
    if (f.type === 'text') {
      f.min ??= 1
      if (!Number.isInteger(f.min) || f.min < 0) problems.push(`${at}: text min must be an integer >= 0`)
      if (!Number.isInteger(f.max) || f.max < Math.max(f.min, 1)) problems.push(`${at}: text needs an integer max >= min`)
    } else if (f.type === 'enum') {
      if (!Array.isArray(f.values) || f.values.length < 2 || !f.values.every(v => /^[a-z0-9-]+$/.test(v))) {
        problems.push(`${at}: enum needs 2+ lowercase values`)
      }
    } else if (f.type === 'int') {
      if (!Number.isInteger(f.min)) problems.push(`${at}: int needs an integer min`)
      if (f.max !== undefined && !(Number.isInteger(f.max) && f.max > f.min)) problems.push(`${at}: int max must be > min`)
    } else if (f.type === 'ref') {
      const [ctx, plural] = String(f.ref ?? '').split('.')
      if (!f.name.endsWith('Id')) problems.push(`${at}: a ref field name ends in Id, e.g. ownerId`)
      if (!ctx || !plural || ctx === s.context) problems.push(`${at}: ref is "<other context>.<plural>", e.g. lobby.players`)
      else if (!existsSync(join(root, 'src', ctx, 'module.ts'))) problems.push(`${at}: src/${ctx}/module.ts does not exist`)
      if (!f.fixture?.url || typeof f.fixture.body !== 'object') problems.push(`${at}: ref needs fixture { url, body } to create one in tests`)
      else {
        // Each ref POSTs its fixture in beforeEach: the same body twice hits the other slice's unique fields (409).
        const key = JSON.stringify([f.fixture.url, f.fixture.body])
        if (fixtures.has(key)) problems.push(`${at}: same fixture as ${fixtures.get(key)}; give it its own body (e.g. another name)`)
        else fixtures.set(key, f.name)
      }
      Object.assign(f, { refContext: ctx, refPlural: plural, check: `${f.name.slice(0, -2)}Exists` })
    } else problems.push(`${at}: type must be text, enum, int or ref`)
  }
  if (problems.length) throw new Error(`plan problems:\n- ${problems.join('\n- ')}`)
  return s
}

// ---------------------------------------------------------------- naming

function names(s, root) {
  const E = s.entity
  const e = low(E)
  const first = !existsSync(join(root, 'src', s.context, 'app', 'service.ts'))
  return {
    E, e, P: s.plural, C: s.context, Ctx: up(s.context),
    service: first ? 'service' : `${e}Service`,
    routes: first ? 'routes' : `${e}Routes`,
    unique: s.fields.filter(f => f.type === 'text' && f.unique),
    refs: s.fields.filter(f => f.type === 'ref'),
    files: {
      domain: `src/${s.context}/domain/${e}.ts`,
      service: `src/${s.context}/app/${first ? 'service' : `${e}Service`}.ts`,
      repo: `src/${s.context}/infra/sqlite/${e}Repo.ts`,
      routes: `src/${s.context}/infra/http/${first ? 'routes' : `${e}Routes`}.ts`,
      test: `test/${s.context}/${e}.test.ts`,
    },
  }
}

const tsType = f => ({ text: 'string', enum: up(f.name), int: 'number', ref: f.optional ? 'string | null' : 'string' })[f.type]
/** A column in SQL text, quoted: group, order, index… are SQLite keywords. */
const col = f => `"${snake(f.name)}"`
const plural = w => (/[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(w) ? `${w}es` : `${w}s`)
const valuesConst = f => CONST(plural(f.name))

export function nextMigration(root) {
  const dir = join(root, 'migrations')
  const nums = (existsSync(dir) ? readdirSync(dir) : []).map(f => Number(f.match(/^(\d{4})_/)?.[1] ?? 0))
  return String(Math.max(0, ...nums) + 1).padStart(4, '0')
}

// ---------------------------------------------------------------- templates

function migration(s, n) {
  const cols = s.fields.map(f => {
    const c = col(f)
    if (f.type === 'text') return `  ${c} TEXT NOT NULL`
    if (f.type === 'enum') return `  ${c} TEXT NOT NULL CHECK (${c} IN (${f.values.map(v => `'${v}'`).join(', ')}))`
    if (f.type === 'int') return `  ${c} INTEGER NOT NULL CHECK (${c} >= ${f.min}${f.max !== undefined ? ` AND ${c} <= ${f.max}` : ''})`
    return `  ${c} TEXT${f.optional ? '' : ' NOT NULL'}`
  })
  const idx = n.unique.map(f => `CREATE UNIQUE INDEX ${s.plural}_${snake(f.name)}_nocase ON ${s.plural} (${col(f)} COLLATE NOCASE);\n`)
  return `CREATE TABLE ${s.plural} (\n  id TEXT PRIMARY KEY,\n${cols.join(',\n')},\n  created_at TEXT NOT NULL\n);\n${idx.join('')}`
}

function domain(s, n) {
  const { E, e } = n
  const validated = s.fields.some(f => f.type !== 'ref')
  const out = [`// ${E}: ${s.summary ?? `a ${e} of the ${s.context} context`}.`, ...(validated ? ["import { invalid } from '../../shared/errors.js';"] : []), '']
  for (const f of s.fields.filter(f => f.type === 'enum')) {
    out.push(`export const ${valuesConst(f)} = [${f.values.map(v => `'${v}'`).join(', ')}] as const;`)
    out.push(`export type ${up(f.name)} = (typeof ${valuesConst(f)})[number];`, '')
  }
  const bounds = s.fields.filter(f => f.type === 'text' || f.type === 'int')
  for (const f of bounds) {
    out.push(`export const ${CONST(f.name)}_MIN = ${f.min};`)
    if (f.max !== undefined) out.push(`export const ${CONST(f.name)}_MAX = ${f.max};`)
  }
  if (bounds.length) out.push('')
  out.push(`export interface ${E} {`, '  id: string;', ...s.fields.map(f => `  ${f.name}: ${tsType(f)};`), '  createdAt: string;', '}', '')
  out.push(
    `export interface ${E}Repository {`,
    `  insert(${e}: ${E}): void;`,
    `  update(${e}: ${E}): void;`,
    `  /** Returns false when no ${e} has this id. */`,
    '  delete(id: string): boolean;',
    `  findById(id: string): ${E} | undefined;`,
    ...n.unique.flatMap(f => ['  /** Case-insensitive. */', `  findBy${up(f.name)}(${f.name}: string): ${E} | undefined;`]),
    `  list(): ${E}[];`,
    '}',
    '',
  )
  if (n.refs.length) {
    out.push(`/** What ${E} needs from other contexts; module.ts wires it from their apis. */`, `export interface ${E}Refs {`)
    for (const f of n.refs) out.push(`  /** ${f.ref} */`, `  ${f.check}(id: string): boolean;`)
    out.push('}', '')
  }
  for (const f of s.fields) {
    const K = CONST(f.name)
    if (f.type === 'text') {
      out.push(
        '/** Trims, then counts code points (as JSON schema minLength/maxLength do). */',
        `export function validate${up(f.name)}(${f.name}: string): string {`,
        `  const trimmed = ${f.name}.trim();`,
        '  const length = [...trimmed].length;',
        `  if (length < ${K}_MIN || length > ${K}_MAX) {`,
        `    throw invalid(\`${f.name} must be \${${K}_MIN}-\${${K}_MAX} characters, not blank\`);`,
        '  }',
        '  return trimmed;',
        '}',
        '',
      )
    } else if (f.type === 'enum') {
      out.push(
        `export function validate${up(f.name)}(${f.name}: string): ${up(f.name)} {`,
        `  if (!(${valuesConst(f)} as readonly string[]).includes(${f.name})) {`,
        `    throw invalid(\`${f.name} must be one of \${${valuesConst(f)}.join(', ')}\`);`,
        '  }',
        `  return ${f.name} as ${up(f.name)};`,
        '}',
        '',
      )
    } else if (f.type === 'int') {
      const hi = f.max !== undefined
      out.push(
        `export function validate${up(f.name)}(${f.name}: number): number {`,
        `  if (!Number.isInteger(${f.name}) || ${f.name} < ${K}_MIN${hi ? ` || ${f.name} > ${K}_MAX` : ''}) {`,
        `    throw invalid(\`${f.name} must be an integer ${hi ? `from \${${K}_MIN} to \${${K}_MAX}` : `of at least \${${K}_MIN}`}\`);`,
        '  }',
        `  return ${f.name};`,
        '}',
        '',
      )
    }
  }
  return `${out.join('\n').trimEnd()}\n`
}

function service(s, n) {
  const { E, e, P } = n
  const validators = s.fields.filter(f => f.type !== 'ref').map(f => `validate${up(f.name)}`)
  const errs = ['conflict', ...(n.refs.length ? ['invalid'] : []), 'notFound'].filter(x => x !== 'conflict' || n.unique.length)
  const types = [`type ${E}`, ...(n.refs.length ? [`type ${E}Refs`] : []), `type ${E}Repository`]
  const input = s.fields.map(f => {
    const t = f.type === 'int' ? 'number' : f.type === 'ref' ? (f.optional ? 'string | null' : 'string') : 'string'
    return `${f.name}${f.optional ? '?' : ''}: ${t}`
  })
  const value = f => (f.type === 'ref' ? `check${up(f.name)}(input.${f.name}${f.optional ? ' ?? null' : ''})` : `validate${up(f.name)}(input.${f.name})`)
  const patched = f => (f.type === 'ref' ? `check${up(f.name)}(patch.${f.name})` : `validate${up(f.name)}(patch.${f.name})`)
  const out = [
    `// ${n.Ctx} use cases for ${P}.${n.unique.length ? ' Uniqueness is checked here, before the write (see ARCHITECTURE.md, Errors).' : ''}`,
    "import { randomUUID } from 'node:crypto';",
    '',
    `import { ${errs.join(', ')} } from '../../shared/errors.js';`,
    `import { ${[...types, ...validators].join(', ')} } from '../domain/${e}.js';`,
    '',
    `export type ${E}Service = ReturnType<typeof create${E}Service>;`,
    '',
    `export interface ${E}Input {`,
    ...input.map(x => `  ${x};`),
    '}',
    '',
    `export function create${E}Service(${P}: ${E}Repository${n.refs.length ? `, refs: ${E}Refs` : ''}) {`,
    `  function get(id: string): ${E} {`,
    `    const ${e} = ${P}.findById(id);`,
    `    if (!${e}) throw notFound(\`${e} \${id} not found\`);`,
    `    return ${e};`,
    '  }',
    '',
  ]
  for (const f of n.unique) {
    out.push(
      `  function assert${up(f.name)}Free(${f.name}: string, exceptId?: string): void {`,
      `    const holder = ${P}.findBy${up(f.name)}(${f.name});`,
      `    if (holder && holder.id !== exceptId) throw conflict(\`${f.name} \${${f.name}} is taken\`);`,
      '  }',
      '',
    )
  }
  for (const f of n.refs) {
    const t = f.optional ? 'string | null' : 'string'
    out.push(
      `  function check${up(f.name)}(${f.name}: ${t}): ${t} {`,
      `    if (${f.optional ? `${f.name} !== null && ` : ''}!refs.${f.check}(${f.name})) throw invalid(\`${f.name} \${${f.name}} is not a known ${singular(f.refPlural)}\`);`,
      `    return ${f.name};`,
      '  }',
      '',
    )
  }
  out.push(
    '  return {',
    `    create(input: ${E}Input): ${E} {`,
    `      const ${e}: ${E} = {`,
    '        id: randomUUID(),',
    ...s.fields.map(f => `        ${f.name}: ${value(f)},`),
    '        createdAt: new Date().toISOString(),',
    '      };',
    ...n.unique.map(f => `      assert${up(f.name)}Free(${e}.${f.name});`),
    `      ${P}.insert(${e});`,
    `      return ${e};`,
    '    },',
    '',
    `    list(): ${E}[] {`,
    `      return ${P}.list();`,
    '    },',
    '',
    '    get,',
    '',
    `    update(id: string, patch: Partial<${E}Input>): ${E} {`,
    `      const ${e} = { ...get(id) };`,
    ...s.fields.map(f => `      if (patch.${f.name} !== undefined) ${e}.${f.name} = ${patched(f)};`),
    ...n.unique.map(f => `      assert${up(f.name)}Free(${e}.${f.name}, id);`),
    `      ${P}.update(${e});`,
    `      return ${e};`,
    '    },',
    '',
    '    remove(id: string): void {',
    `      if (!${P}.delete(id)) throw notFound(\`${e} \${id} not found\`);`,
    '    },',
    '  };',
    '}',
  )
  return `${out.join('\n')}\n`
}

function repo(s, n) {
  const { E, e, P } = n
  const enumTypes = s.fields.filter(f => f.type === 'enum').map(f => up(f.name))
  const map = f => {
    const c = `row.${snake(f.name)}`
    if (f.type === 'int') return `Number(${c})`
    if (f.type === 'enum') return `String(${c}) as ${up(f.name)}`
    if (f.type === 'ref' && f.optional) return `${c} === null ? null : String(${c})`
    return `String(${c})`
  }
  const cols = s.fields.map(col)
  const params = { id: `${e}.id`, ...Object.fromEntries(s.fields.map(f => [f.name, `${e}.${f.name}`])) }
  const runArgs = keys => `{ ${keys.map(k => `${k}: ${params[k] ?? `${e}.${k}`}`).join(', ')} }`
  return `// ${E}Repository on node:sqlite. Columns are snake_case; rows map to the camelCase domain type.
import type { Db } from '../../../shared/db.js';
import type { ${[...enumTypes, E, `${E}Repository`].sort().join(', ')} } from '../../domain/${e}.js';

function to${E}(row: Record<string, unknown>): ${E} {
  return {
    id: String(row.id),
${s.fields.map(f => `    ${f.name}: ${map(f)},`).join('\n')}
    createdAt: String(row.created_at),
  };
}

export function create${E}Repo(db: Db): ${E}Repository {
  const insert = db.prepare(
    'INSERT INTO ${P} (id, ${cols.join(', ')}, created_at) VALUES (:id, ${s.fields.map(f => `:${f.name}`).join(', ')}, :createdAt)',
  );
  const update = db.prepare(
    'UPDATE ${P} SET ${s.fields.map(f => `${col(f)} = :${f.name}`).join(', ')} WHERE id = :id',
  );
  const remove = db.prepare('DELETE FROM ${P} WHERE id = ?');
  const byId = db.prepare('SELECT * FROM ${P} WHERE id = ?');
${n.unique.map(f => `  const by${up(f.name)} = db.prepare('SELECT * FROM ${P} WHERE ${col(f)} = ? COLLATE NOCASE');\n`).join('')}  const all = db.prepare('SELECT * FROM ${P} ORDER BY created_at, id');

  return {
    insert(${e}) {
      insert.run(${runArgs(['id', ...s.fields.map(f => f.name), 'createdAt'])});
    },
    update(${e}) {
      update.run(${runArgs(['id', ...s.fields.map(f => f.name)])});
    },
    delete(id) {
      return Number(remove.run(id).changes) > 0;
    },
    findById(id) {
      const row = byId.get(id);
      return row && to${E}(row);
    },
${n.unique.map(f => `    findBy${up(f.name)}(${f.name}) {\n      const row = by${up(f.name)}.get(${f.name});\n      return row && to${E}(row);\n    },\n`).join('')}    list() {
      return all.all().map(to${E});
    },
  };
}
`
}

function fieldSchema(f) {
  const K = CONST(f.name)
  if (f.type === 'text') return `{ type: 'string', minLength: ${K}_MIN, maxLength: ${K}_MAX }`
  if (f.type === 'enum') return `{ type: 'string', enum: ${valuesConst(f)} }`
  if (f.type === 'int') return `{ type: 'integer', minimum: ${K}_MIN${f.max !== undefined ? `, maximum: ${K}_MAX` : ''} }`
  return f.optional ? "{ type: ['string', 'null'], format: 'uuid' }" : "{ type: 'string', format: 'uuid' }"
}

function routes(s, n) {
  const { E, e, P } = n
  const consts = s.fields.flatMap(f =>
    f.type === 'enum' ? [valuesConst(f)] : f.type === 'ref' ? [] : [`${CONST(f.name)}_MIN`, ...(f.max !== undefined ? [`${CONST(f.name)}_MAX`] : [])],
  )
  const resp = f => ({ text: "{ type: 'string' }", enum: "{ type: 'string' }", int: "{ type: 'integer' }", ref: f.optional ? "{ type: ['string', 'null'] }" : "{ type: 'string' }" })[f.type]
  const required = s.fields.filter(f => !f.optional).map(f => `'${f.name}'`)
  return `// ${n.Ctx} HTTP routes for ${P}. Schemas reject bad input with 400 before the service runs; the domain re-checks.
import type { FastifyInstance } from 'fastify';

import type { ${E}Input, ${E}Service } from '../../app/${n.service}.js';
${consts.length ? `import { ${consts.sort().join(', ')} } from '../../domain/${e}.js';\n` : ''}
${s.fields.map(f => `const ${f.name} = ${fieldSchema(f)} as const;`).join('\n')}

const ${e} = {
  type: 'object',
  required: ['id', ${s.fields.map(f => `'${f.name}'`).join(', ')}, 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
${s.fields.map(f => `    ${f.name}: ${resp(f)},`).join('\n')}
    createdAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

type IdParams = { id: string };

export function register${E}Routes(app: FastifyInstance, ${P}: ${E}Service): void {
  app.post<{ Body: ${E}Input }>(
    '/${P}',
    {
      schema: {
        body: {
          type: 'object',
          required: [${required.join(', ')}],
          properties: { ${s.fields.map(f => f.name).join(', ')} },
          additionalProperties: false,
        },
        response: { 201: ${e} },
      },
    },
    async (req, reply) => reply.status(201).send(${P}.create(req.body)),
  );

  app.get(
    '/${P}',
    { schema: { response: { 200: { type: 'array', items: ${e} } } } },
    async () => ${P}.list(),
  );

  app.get<{ Params: IdParams }>(
    '/${P}/:id',
    { schema: { params: idParams, response: { 200: ${e} } } },
    async (req) => ${P}.get(req.params.id),
  );

  app.patch<{ Params: IdParams; Body: Partial<${E}Input> }>(
    '/${P}/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: { ${s.fields.map(f => f.name).join(', ')} },
          additionalProperties: false,
          minProperties: 1,
        },
        response: { 200: ${e} },
      },
    },
    async (req) => ${P}.update(req.params.id, req.body),
  );

  app.delete<{ Params: IdParams }>(
    '/${P}/:id',
    { schema: { params: idParams, response: { 204: { type: 'null' } } } },
    async (req, reply) => {
      ${P}.remove(req.params.id);
      return reply.status(204).send();
    },
  );
}
`
}

function moduleFile(s, n, current) {
  const header = current.split('\n')[0].startsWith('//') ? current.split('\n')[0] : `// ${n.Ctx} context.`
  const refCtxs = [...new Set(n.refs.map(f => f.refContext))].sort()
  const deps = ['db: Db', ...refCtxs.map(c => `${c}: ${up(c)}Api`)].join('; ')
  const imports = [
    "import type { FastifyInstance } from 'fastify';",
    '',
    ...refCtxs.map(c => `import type { ${up(c)}Api } from '../${c}/module.js';`),
    "import type { Db } from '../shared/db.js';",
    `import { create${n.E}Service } from './app/${n.service}.js';`,
    `import { register${n.E}Routes } from './infra/http/${n.routes}.js';`,
    `import { create${n.E}Repo } from './infra/sqlite/${n.e}Repo.js';`,
  ]
  const refsArg = n.refs.length
    ? `, {\n${n.refs.map(f => `    ${f.check}: (id) => deps.${f.refContext}.${f.refPlural}.exists(id),`).join('\n')}\n  }`
    : ''
  return `${header}
${imports.join('\n')}

export interface ${n.Ctx}Api {}

export function create${n.Ctx}Module(deps: { ${deps} }): {
  register(app: FastifyInstance): void;
  api: ${n.Ctx}Api;
} {
  const ${n.P} = create${n.E}Service(create${n.E}Repo(deps.db)${refsArg});
  return {
    register(app) {
      register${n.E}Routes(app, ${n.P});
    },
    api: {},
  };
}
`
}

// ---------------------------------------------------------------- tests

/** Sample text, short enough to leave room for a space on each side when max allows (schemas count before trim). */
function textSample(f, i) {
  const base = i === 1 ? 'Alpha' : 'Bravo'
  return base.length >= f.min && base.length + 2 <= f.max ? base : (i === 1 ? 'a' : 'b').repeat(Math.max(f.min, 1))
}

/** Spaces per side in the trim tests, up to 2 within max; 0 = no room, those tests are skipped. */
const padOf = f => Math.min(2, Math.floor((f.max - textSample(f, 1).length) / 2))

function samples(s) {
  const pick = (f, i) => {
    if (f.type === 'text') return textSample(f, i)
    if (f.type === 'enum') return f.values[(i - 1) % f.values.length]
    if (f.type === 'int') return f.max !== undefined ? Math.min(f.min + i - 1, f.max) : f.min + i - 1
    return null
  }
  return [1, 2].map(i => Object.fromEntries(s.fields.filter(f => f.type !== 'ref').map(f => [f.name, pick(f, i)])))
}

function testFile(s, n) {
  const { E, e, P } = n
  const [one, two] = samples(s)
  const text = s.fields.filter(f => f.type === 'text')
  const valid = i => {
    const own = lit(i === 1 ? one : two).slice(1, -1).trim()
    return `{ ${[own, ...n.refs.map(f => `${f.name}: refs.${f.name}`)].filter(Boolean).join(', ')} }`
  }
  const bad = []
  for (const f of s.fields) {
    const K = f.name
    if (f.type === 'text') {
      // Blank and padded-short values pass the schema (it counts before trim), so the domain validator must catch them.
      if (f.min >= 1) bad.push([`empty ${K}`, `{ ${K}: '' }`], [`blank ${K}`, `{ ${K}: '${' '.repeat(Math.min(Math.max(3, f.min), f.max))}' }`])
      if (f.min >= 2 && f.min + 1 <= f.max) bad.push([`padded ${f.min - 1}-character ${K}`, `{ ${K}: ' ${'a'.repeat(f.min - 1)} ' }`])
      bad.push([`${f.max + 1}-character ${K}`, `{ ${K}: 'a'.repeat(${f.max + 1}) }`])
    } else if (f.type === 'enum') bad.push([`unknown ${K}`, `{ ${K}: 'nope' }`])
    else if (f.type === 'int') {
      bad.push([`${K} below ${f.min}`, `{ ${K}: ${f.min - 1} }`], [`fractional ${K}`, `{ ${K}: ${f.min + 0.5} }`])
      if (f.max !== undefined) bad.push([`${K} above ${f.max}`, `{ ${K}: ${f.max + 1} }`])
    } else bad.push([`non-uuid ${K}`, `{ ${K}: 'nope' }`], [`unknown ${K}`, `{ ${K}: UNKNOWN_ID }`])
  }
  const missing = s.fields.filter(f => !f.optional).map(f => f.name)
  const firstText = text[0]
  const editable = s.fields.find(f => f.type !== 'ref') ?? s.fields[0]
  const editValue = f => (f.type !== 'ref' ? q(two[f.name]) : f.optional ? 'null' : `refs.${f.name}`)
  const padded = (f, v) => `'${' '.repeat(padOf(f))}${v}${' '.repeat(padOf(f))}'`
  const fixtures = n.refs.map(
    f => `  const ${f.name.slice(0, -2)} = await app.inject({ method: 'POST', url: '${f.fixture.url}', payload: ${lit(f.fixture.body)} });
  expect(${f.name.slice(0, -2)}.statusCode).toBe(201);`,
  )
  const out = [
    "import type { FastifyInstance } from 'fastify';",
    "import { afterEach, beforeEach, describe, expect, it } from 'vitest';",
    '',
    "import { makeTestApp } from '../helpers/app.js';",
    '',
    '// Generated by monopoly-slice from the plan; /monopoly-kit:feature-tests adds the domain-specific cases.',
    'const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;',
    "const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';",
    '',
    'let app: FastifyInstance;',
    ...(n.refs.length ? [`let refs: { ${n.refs.map(f => `${f.name}: string`).join('; ')} };`] : []),
    '',
    'beforeEach(async () => {',
    '  app = makeTestApp().app;',
    ...fixtures,
    ...(n.refs.length ? [`  refs = { ${n.refs.map(f => `${f.name}: ${f.name.slice(0, -2)}.json().id`).join(', ')} };`] : []),
    '});',
    '',
    'afterEach(async () => {',
    '  await app.close();',
    '});',
    '',
    `const valid = (i: 1 | 2 = 1) => (i === 1 ? ${valid(1)} : ${valid(2)});`,
    '',
    'function create(payload: object) {',
    `  return app.inject({ method: 'POST', url: '/${P}', payload });`,
    '}',
    '',
    'async function createOk(payload: object = valid()) {',
    '  const res = await create(payload);',
    '  expect(res.statusCode).toBe(201);',
    '  return res.json();',
    '}',
    '',
    'function patch(id: string, payload: object) {',
    `  return app.inject({ method: 'PATCH', url: \`/${P}/\${id}\`, payload });`,
    '}',
    '',
    'function expectError(res: { statusCode: number; json(): unknown }, status: number, code: string) {',
    '  expect(res.statusCode).toBe(status);',
    '  expect(res.json()).toEqual({ error: { code, message: expect.any(String) } });',
    '}',
    '',
    `describe('POST /${P}', () => {`,
    `  it('creates a ${e}', async () => {`,
    '    const res = await create(valid());',
    '    expect(res.statusCode).toBe(201);',
    '    const body = res.json();',
    '    expect(body).toEqual({ ...valid(), id: expect.stringMatching(UUID), createdAt: expect.any(String) });',
    '    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);',
    '  });',
    ...n.refs
      .filter(f => f.optional)
      .flatMap(f => [
        '',
        `  it('creates a ${e} without ${f.name}', async () => {`,
        '    const payload: Record<string, unknown> = valid();',
        `    delete payload.${f.name};`,
        `    expect((await createOk(payload)).${f.name}).toBeNull();`,
        '  });',
      ]),
    ...text.flatMap(f => [
      ...(padOf(f)
        ? [
            '',
            `  it('trims ${f.name}', async () => {`,
            `    expect((await createOk({ ...valid(), ${f.name}: ${padded(f, one[f.name])} })).${f.name}).toBe('${one[f.name]}');`,
            '  });',
          ]
        : []),
      '',
      `  it('accepts ${f.max} characters of ${f.name}, counted as code points', async () => {`,
      `    await createOk({ ...valid(), ${f.name}: '🎲'.repeat(${f.max}) });`,
      '  });',
    ]),
    '',
    `  it.each(${q(missing).replace(/"/g, "'").replace(/,/g, ', ')})('rejects a body without %s with 400', async (key) => {`,
    '    const payload: Record<string, unknown> = valid();',
    '    delete payload[key];',
    "    expectError(await create(payload), 400, 'invalid');",
    '  });',
    '',
    "  it('rejects an unknown field with 400', async () => {",
    "    expectError(await create({ ...valid(), nope: 1 }), 400, 'invalid');",
    '  });',
    '',
    '  it.each([',
    ...bad.map(([label, over]) => `    ['${label}', ${over}],`),
    "  ])('rejects %s with 400', async (_, over) => {",
    "    expectError(await create({ ...valid(), ...over }), 400, 'invalid');",
    '  });',
    ...n.unique.flatMap(f => [
      '',
      `  it('rejects a duplicate ${f.name} with 409, in any case${padOf(f) ? ' and padded' : ''}', async () => {`,
      '    await createOk();',
      `    expectError(await create({ ...valid(2), ${f.name}: '${one[f.name]}' }), 409, 'conflict');`,
      `    expectError(await create({ ...valid(2), ${f.name}: '${one[f.name].toUpperCase()}' }), 409, 'conflict');`,
      ...(padOf(f) ? [`    expectError(await create({ ...valid(2), ${f.name}: ' ${one[f.name].toLowerCase()} ' }), 409, 'conflict');`] : []),
      '  });',
    ]),
    '});',
    '',
    `describe('GET /${P}', () => {`,
    "  it('returns an empty list', async () => {",
    `    const res = await app.inject({ method: 'GET', url: '/${P}' });`,
    '    expect(res.statusCode).toBe(200);',
    '    expect(res.json()).toEqual([]);',
    '  });',
    '',
    `  it('returns every ${e}', async () => {`,
    '    const a = await createOk(valid(1));',
    '    const b = await createOk(valid(2));',
    `    const res = await app.inject({ method: 'GET', url: '/${P}' });`,
    '    expect(res.statusCode).toBe(200);',
    '    expect(res.json()).toHaveLength(2);',
    '    expect(res.json()).toEqual(expect.arrayContaining([a, b]));',
    '  });',
    '});',
    '',
    `describe('GET /${P}/:id', () => {`,
    `  it('returns the ${e}', async () => {`,
    '    const a = await createOk();',
    `    const res = await app.inject({ method: 'GET', url: \`/${P}/\${a.id}\` });`,
    '    expect(res.statusCode).toBe(200);',
    '    expect(res.json()).toEqual(a);',
    '  });',
    '',
    "  it('answers 404 for an unknown id', async () => {",
    `    expectError(await app.inject({ method: 'GET', url: \`/${P}/\${UNKNOWN_ID}\` }), 404, 'not_found');`,
    '  });',
    '',
    "  it('answers 400 for a non-uuid id', async () => {",
    `    expectError(await app.inject({ method: 'GET', url: '/${P}/nope' }), 400, 'invalid');`,
    '  });',
    '});',
    '',
    `describe('PATCH /${P}/:id', () => {`,
    "  it('updates every field', async () => {",
    '    const a = await createOk(valid(1));',
    '    const changes = valid(2);',
    '    const res = await patch(a.id, changes);',
    '    expect(res.statusCode).toBe(200);',
    '    expect(res.json()).toEqual({ ...a, ...changes });',
    `    const got = await app.inject({ method: 'GET', url: \`/${P}/\${a.id}\` });`,
    '    expect(got.json()).toEqual({ ...a, ...changes });',
    '  });',
    '',
    `  it('updates ${editable.name} and keeps the rest', async () => {`,
    '    const a = await createOk();',
    `    const res = await patch(a.id, { ${editable.name}: ${editValue(editable)} });`,
    '    expect(res.statusCode).toBe(200);',
    `    expect(res.json()).toEqual({ ...a, ${editable.name}: ${editValue(editable)} });`,
    '  });',
    ...text.filter(padOf).flatMap(f => [
      '',
      `  it('trims ${f.name}', async () => {`,
      '    const a = await createOk();',
      `    expect((await patch(a.id, { ${f.name}: ${padded(f, two[f.name])} })).json().${f.name}).toBe('${two[f.name]}');`,
      '  });',
    ]),
    ...n.refs
      .filter(f => f.optional)
      .flatMap(f => [
        '',
        `  it('clears ${f.name} with null', async () => {`,
        '    const a = await createOk();',
        `    expect((await patch(a.id, { ${f.name}: null })).json().${f.name}).toBeNull();`,
        '  });',
      ]),
    '',
    '  it.each([',
    ...bad.map(([label, over]) => `    ['${label}', ${over}],`),
    "    ['unknown field', { nope: 1 }],",
    "    ['empty body', {}],",
    "  ])('rejects %s with 400', async (_, payload) => {",
    '    const a = await createOk();',
    "    expectError(await patch(a.id, payload), 400, 'invalid');",
    '  });',
    ...n.unique.flatMap(f => [
      '',
      `  it('rejects a ${f.name} taken by another ${e}, in any case, with 409', async () => {`,
      '    await createOk(valid(1));',
      '    const b = await createOk(valid(2));',
      `    expectError(await patch(b.id, { ${f.name}: '${one[f.name]}' }), 409, 'conflict');`,
      `    expectError(await patch(b.id, { ${f.name}: '${one[f.name].toLowerCase()}' }), 409, 'conflict');`,
      '  });',
      '',
      `  it('changes the case of its own ${f.name}', async () => {`,
      '    const a = await createOk();',
      `    expect((await patch(a.id, { ${f.name}: '${one[f.name].toUpperCase()}' })).json().${f.name}).toBe('${one[f.name].toUpperCase()}');`,
      '  });',
    ]),
    '',
    "  it('answers 404 for an unknown id', async () => {",
    `    expectError(await patch(UNKNOWN_ID, { ${editable.name}: ${editValue(editable)} }), 404, 'not_found');`,
    '  });',
    '',
    "  it('answers 400 for a non-uuid id', async () => {",
    `    expectError(await patch('nope', { ${editable.name}: ${editValue(editable)} }), 400, 'invalid');`,
    '  });',
    '});',
    '',
    `describe('DELETE /${P}/:id', () => {`,
    `  it('deletes the ${e}', async () => {`,
    '    const a = await createOk();',
    `    const res = await app.inject({ method: 'DELETE', url: \`/${P}/\${a.id}\` });`,
    '    expect(res.statusCode).toBe(204);',
    "    expect(res.body).toBe('');",
    `    expectError(await app.inject({ method: 'GET', url: \`/${P}/\${a.id}\` }), 404, 'not_found');`,
    '  });',
    ...(firstText && firstText.unique
      ? [
          '',
          `  it('frees the ${firstText.name} for reuse', async () => {`,
          '    const a = await createOk();',
          `    await app.inject({ method: 'DELETE', url: \`/${P}/\${a.id}\` });`,
          '    await createOk();',
          '  });',
        ]
      : []),
    '',
    "  it('answers 404 for an unknown id', async () => {",
    `    expectError(await app.inject({ method: 'DELETE', url: \`/${P}/\${UNKNOWN_ID}\` }), 404, 'not_found');`,
    '  });',
    '',
    "  it('answers 400 for a non-uuid id', async () => {",
    `    expectError(await app.inject({ method: 'DELETE', url: '/${P}/nope' }), 400, 'invalid');`,
    '  });',
    '});',
  ]
  return `${out.join('\n')}\n`
}

// ---------------------------------------------------------------- generate

const PLACEHOLDER = /register\(\)\s*\{\s*\},[\s\S]*api:\s*\{\s*\},/

export function plan(spec, root) {
  const s = normalize(spec, root)
  const n = names(s, root)
  const files = new Map()
  const needs = []
  const num = nextMigration(root)
  files.set(`migrations/${num}_${s.context}_${s.plural}.sql`, migration(s, n))
  files.set(n.files.domain, domain(s, n))
  files.set(n.files.service, service(s, n))
  files.set(n.files.repo, repo(s, n))
  files.set(n.files.routes, routes(s, n))
  files.set(n.files.test, testFile(s, n))

  const modPath = `src/${s.context}/module.ts`
  const mod = readFileSync(join(root, modPath), 'utf8')
  const refCtxs = [...new Set(n.refs.map(f => f.refContext))].sort()
  const edits = new Map()
  if (PLACEHOLDER.test(mod) && !/create\w+Service\(/.test(mod)) edits.set(modPath, moduleFile(s, n, mod))
  else {
    const newDeps = refCtxs.filter(c => !new RegExp(`\\b${c}\\s*:\\s*${up(c)}Api\\b`).test(mod))
    const deps = newDeps.length
      ? `add ${newDeps.map(c => `${c}: ${up(c)}Api`).join('; ')} to deps (${newDeps.map(c => `import type { ${up(c)}Api } from '../${c}/module.js'`).join('; ')}), `
      : ''
    const refsArg = n.refs.length ? `, { ${n.refs.map(f => `${f.check}: (id) => deps.${f.refContext}.${f.refPlural}.exists(id)`).join(', ')} }` : ''
    needs.push(
      `${modPath}: wire the new slice next to the existing one — ${deps}create${n.E}Service(create${n.E}Repo(deps.db)${refsArg}) and register${n.E}Routes(app, …) in register().`,
    )
  }

  const appTs = readFileSync(join(root, 'src/app.ts'), 'utf8')
  const order = c => appTs.indexOf(`create${up(c)}Module(`)
  for (const c of refCtxs) {
    if (order(c) < 0 || order(c) > order(s.context)) throw new Error(`src/app.ts must create the ${c} module before ${s.context} (ARCHITECTURE.md, dependency order)`)
  }
  // Pass each referenced api into create<Ctx>Module once; an earlier slice may already pass it.
  const call = new RegExp(`create${n.Ctx}Module\\(\\{([^}]*)\\}\\)`)
  const passed = (appTs.match(call)?.[1] ?? '').split(',').map(a => a.trim()).filter(Boolean)
  const toPass = refCtxs.filter(c => !passed.some(a => new RegExp(`^${c}\\b`).test(a)))
  if (toPass.length && call.test(appTs)) {
    edits.set('src/app.ts', appTs.replace(call, `create${n.Ctx}Module({ ${[...passed, ...toPass.map(c => `${c}: ${c}.api`)].join(', ')} })`))
  } else if (toPass.length) needs.push(`src/app.ts: pass ${toPass.map(c => `${c}: ${c}.api`).join(', ')} into create${n.Ctx}Module.`)
  for (const target of new Set(n.refs.map(f => `${f.refContext}.${f.refPlural}`))) {
    const [c, p] = target.split('.')
    const api = interfaceBody(readFileSync(join(root, 'src', c, 'module.ts'), 'utf8'), `${up(c)}Api`) ?? ''
    if (!new RegExp(`\\b${p}\\s*:\\s*\\{[^}]*\\bexists\\s*\\(`).test(api)) {
      needs.push(
        `src/${c}/module.ts: ${up(c)}Api has no ${p}.exists(id). Add \`${p}: { exists(id: string): boolean }\` to the interface and implement it in the returned api from that context's own repository or service — the only edit this slice makes outside ${s.context}.`,
      )
    }
  }
  return { s, n, files, edits, needs, migration: num }
}

/** The body of `export interface <name> { … }`, nested braces included. */
function interfaceBody(text, name) {
  const at = text.search(new RegExp(`export interface ${name}\\s*\\{`))
  if (at < 0) return undefined
  const open = text.indexOf('{', at)
  for (let i = open, depth = 0; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return undefined
}

export function facts(root, only) {
  const src = join(root, 'src')
  const contexts = readdirSync(src, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'shared').map(d => d.name)
  const lines = [`next migration: ${nextMigration(root)}`, '']
  for (const c of contexts) {
    const mod = readFileSync(join(src, c, 'module.ts'), 'utf8')
    const api = interfaceBody(mod, `${up(c)}Api`)?.trim() || '(empty)'
    const slices = existsSync(join(src, c, 'domain')) ? readdirSync(join(src, c, 'domain')).map(f => f.replace(/\.ts$/, '')) : []
    lines.push(`context ${c}${c === only ? '  <- target' : ''}`, `  slices: ${slices.join(', ') || 'none'}`, `  ${up(c)}Api: ${api.replace(/\n\s*/g, ' ')}`)
  }
  const exemplar = contexts.find(c => existsSync(join(src, c, 'domain')))
  if (exemplar) {
    lines.push('', `exemplar slice: ${exemplar}`)
    const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(x => (x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)]))
    for (const f of [...walk(join(src, exemplar)), ...(existsSync(join(root, 'test', exemplar)) ? walk(join(root, 'test', exemplar)) : [])]) {
      lines.push(`  ${f.slice(root.length + 1)} (${readFileSync(f, 'utf8').split('\n').length - 1} lines)`)
    }
  }
  lines.push(
    '',
    'generator conventions (from the exemplar): uuid id + createdAt added automatically; text is trimmed and its',
    'length counted in code points; unique text is case-insensitive (NOCASE index + service check -> 409);',
    'unknown body fields -> 400; ref fields are validated through the other context api (exists) -> 400.',
  )
  return lines.join('\n')
}

/** The LOG.md row CLAUDE.md asks for after a feature commit; minutes count from the plan's `Started:` line, if a date. */
export function logRow({ plan: planText, tests, now, branch, sha, subject }) {
  const started = Date.parse(planText.match(/^Started: (\S+)/m)?.[1] ?? '')
  const mins = Number.isNaN(started) ? '' : `, ${((Date.parse(now) - started) / 60000).toFixed(1)} min since first prompt`
  return `| ${now} | ${branch} | ${sha} | ${subject} | ${tests} tests passing${mins} |`
}

function main(argv) {
  const root = process.cwd()
  if (!existsSync(join(root, 'src/app.ts')) || !existsSync(join(root, 'migrations'))) {
    console.error('run monopoly-slice from the monopoly-online repo root')
    return 2
  }
  if (argv[0] === 'facts') {
    console.log(facts(root, argv[1]))
    return 0
  }
  if (argv[0] === 'log-row') {
    const [, planPath, tests] = argv
    if (!planPath || !/^\d+$/.test(tests ?? '')) {
      console.error('usage: monopoly-slice log-row <plan.md> <tests-passing>')
      return 2
    }
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
    const branch = git('branch', '--show-current')
    if (!branch) {
      console.error('log-row: HEAD is detached; check out the feature branch first')
      return 2
    }
    const row = logRow({
      plan: readFileSync(planPath, 'utf8'),
      tests,
      now: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      branch,
      sha: git('rev-parse', '--short', 'HEAD'),
      subject: git('log', '-1', '--format=%s'),
    })
    if (!row.includes(' min since ')) console.error('log-row: the plan has no Started: date, so the row has no minutes')
    appendFileSync(join(root, 'LOG.md'), `${row}\n`)
    console.log(`LOG.md += ${row}`)
    return 0
  }
  if (!argv[0]) {
    console.error('usage: monopoly-slice facts [context] | <plan.md> [--dry-run] | log-row <plan.md> <tests-passing>')
    return 2
  }
  let result
  try {
    result = plan(readSpec(readFileSync(argv[0], 'utf8')), root)
  } catch (error) {
    console.error(String(error.message ?? error))
    return 1
  }
  const clash = [...result.files.keys()].filter(f => existsSync(join(root, f)))
  if (clash.length) {
    console.error(`refusing to overwrite: ${clash.join(', ')}`)
    return 1
  }
  const dry = argv.includes('--dry-run')
  for (const [file, text] of [...result.files, ...result.edits]) {
    if (!dry) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    console.log(`${result.edits.has(file) ? 'edited ' : 'created'} ${file} (${text.split('\n').length - 1} lines)`)
  }
  for (const need of result.needs) console.log(`NEEDS ${need}`)
  console.log(dry ? 'dry run: nothing written' : 'next: pnpm check')
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
