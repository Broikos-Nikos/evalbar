/**
 * SQLite's own reading of a query, from EXPLAIN and EXPLAIN QUERY PLAN: the
 * tables it opens, the columns it reads, and whether it recurses.
 *
 * The guard is a second parser in front of the database, and every hole found in
 * it was a place where it read a query differently from SQLite: a table in
 * brackets, a WINDOW name, a column name in single quotes. This module asks the
 * first parser instead, without trusting anything the guard decided. It is the
 * judge in `tools/fuzz.ts`, and it never runs in the page.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Policy } from '../src/lib/guard.ts'

export type Plan = {
  /** tables SQLite opens, as `name` or `schema.name` outside main */
  tables: string[]
  /** columns SQLite reads from a table, as `table.column` */
  columns: string[]
  /** EXPLAIN QUERY PLAN shows a recursive step */
  recursive: boolean
  /** SQLite could not prepare it, so it cannot run either */
  error?: string
}

type Row = Record<string, unknown>

export function plan(db: DatabaseSync, sql: string): Plan {
  let code: Row[], eqp: Row[]
  try {
    code = db.prepare('EXPLAIN ' + sql).all() as Row[]
    eqp = db.prepare('EXPLAIN QUERY PLAN ' + sql).all() as Row[]
  } catch (e) {
    return { tables: [], columns: [], recursive: false, error: (e as Error).message }
  }
  const schema = db.prepare('SELECT type, name, tbl_name, rootpage FROM sqlite_schema').all() as { type: string; name: string; tbl_name: string; rootpage: number }[]
  const byRoot = new Map(schema.map((r) => [r.rootpage, r]))
  const colsOf = new Map<string, string[]>()
  const columnNames = (table: string, index?: string): string[] => {
    const key = index ?? table
    if (!colsOf.has(key)) {
      const q = index ? 'SELECT name FROM pragma_index_info(?) ORDER BY seqno' : 'SELECT name FROM pragma_table_info(?) ORDER BY cid'
      colsOf.set(key, (db.prepare(q).all(key) as { name: string }[]).map((r) => r.name))
    }
    return colsOf.get(key)!
  }

  const cursors = new Map<number, { table: string; index?: string }>()
  const tables = new Set<string>(), columns = new Set<string>()
  for (const r of code) {
    const op = r.opcode as string
    if (op === 'OpenRead' || op === 'OpenWrite' || op === 'ReopenIdx') {
      const root = r.p2 as number, schemaNo = r.p3 as number
      const entry = root === 1 ? { type: 'table', name: 'sqlite_schema', tbl_name: 'sqlite_schema' } : byRoot.get(root)
      const table = schemaNo !== 0 ? `schema ${schemaNo}.root ${root}` : entry ? entry.tbl_name : `root ${root}`
      cursors.set(r.p1 as number, { table, index: entry?.type === 'index' ? entry.name : undefined })
      tables.add(table)
    } else if (op === 'Column') {
      const c = cursors.get(r.p1 as number)
      if (!c || c.table.includes(' ')) continue
      const names = columnNames(c.table, c.index)
      columns.add(`${c.table}.${names[r.p2 as number] ?? `#${r.p2}`}`)
    }
  }
  const recursive = eqp.some((r) => /RECURSIVE STEP/i.test(String(r.detail)))
  return { tables: [...tables].sort(), columns: [...columns].sort(), recursive }
}

/** Everything in a plan that the policy forbids. Empty means SQLite's reading of the query stays inside it. */
export function breaches(p: Plan, policy: Policy): string[] {
  const out: string[] = []
  const protectedCols = new Set(policy.protectedColumns.map((c) => c.toLowerCase()))
  for (const t of p.tables) if (!(t.toLowerCase() in policy.tables)) out.push(`opens ${t}`)
  for (const c of p.columns) if (protectedCols.has(c.split('.')[1].toLowerCase())) out.push(`reads ${c}`)
  if (p.recursive) out.push('recurses')
  return out
}
