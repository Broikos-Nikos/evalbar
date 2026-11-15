/**
 * The guard. A model writes SQL, this decides whether it may run.
 *
 * It is an allowlist, not a blocklist: one SELECT, over tables it was told
 * about, touching no protected column, with a row cap. A blocklist of bad words
 * is the thing every bypass in `data/corpus.json` is written against, so the
 * keywords below are a second line and the first line is the shape of the
 * statement.
 *
 * It works on tokens, never on the raw string, because the whole class of
 * bypasses is a string that means one thing to a filter and another to the
 * database: a keyword inside a comment, a semicolon spelled in another
 * alphabet, a table name in brackets the filter took for a subquery. Every hole
 * found so far (`tools/redteam.ts`) was a place where this file read a query
 * differently from SQLite, so anything it cannot read is refused rather than
 * guessed at, and `tools/plan.ts` asks SQLite's own planner whether each query
 * this file lets through stays inside the policy.
 *
 * What it cannot do is price a query. See `EXPENSIVE` in the corpus: those pass,
 * on purpose, and the README says so.
 */

export type Policy = {
  /** table name, lower case, to its columns */
  tables: Record<string, string[]>
  /** columns that may never be read, in any table, under any name */
  protectedColumns: string[]
  maxRows: number
  maxJoins: number
}

export type Verdict = {
  allow: boolean
  /** every reason found, not just the first: a refusal should say all of what was wrong */
  reasons: string[]
  /** the statement to run: comments stripped, row cap applied. null when refused. */
  sql: string | null
}

type Tok = { k: 'word' | 'num' | 'str' | 'qid' | 'punct' | 'comment'; v: string; s: number; e: number }

const FORBIDDEN = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'REPLACE', 'MERGE', 'UPSERT',
  'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'CALL', 'COPY', 'ATTACH', 'DETACH', 'PRAGMA', 'SET', 'INTO',
  'LOCK', 'VACUUM', 'REINDEX', 'ANALYZE', 'DO', 'LOAD', 'HANDLER', 'RENAME', 'COMMENT', 'RECURSIVE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'PREPARE', 'DECLARE', 'OUTFILE', 'DUMPFILE',
])

/** REPLACE is also a string function in every dialect; only the statement is forbidden. */
const FUNCTION_OK = new Set(['REPLACE'])

const FORBIDDEN_FUNCTIONS = new Set([
  'pg_sleep', 'sleep', 'benchmark', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'lo_import', 'lo_export',
  'load_file', 'dblink', 'dblink_exec', 'xp_cmdshell', 'openrowset', 'opendatasource', 'set_config',
  'pg_terminate_backend', 'pg_cancel_backend', 'nextval', 'setval', 'lastval', 'generate_series',
  'randomblob', 'zeroblob', 'load_extension', 'readfile', 'writefile', 'fts3_tokenizer', 'current_setting',
])

const CATALOGS = new Set([
  'information_schema', 'mysql', 'sys', 'performance_schema', 'sysobjects', 'syscolumns', 'sqlite_master',
  'sqlite_schema', 'sqlite_temp_master', 'sqlite_sequence', 'sqlite_stat1',
])

/** Functions whose parentheses contain FROM without it introducing a table. */
const FROM_IN_FUNCTION = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY', 'POSITION'])

/** Words that end a FROM clause at the depth it was opened. */
const FROM_ENDS = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'UNION', 'INTERSECT', 'EXCEPT', 'OFFSET', 'FETCH', 'RETURNING'])

/** Words that can follow a table name and are not its alias. */
const NOT_AN_ALIAS = new Set([...FROM_ENDS, 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING', 'INDEXED', 'NOT'])

/** What may open a parenthesis where a table is expected: anything else is a table hidden in brackets. */
const SUBQUERY_STARTS = new Set(['SELECT', 'WITH', 'VALUES'])

const PUNCT = new Set(['(', ')', ',', '.', '*', '=', '<', '>', '!', '+', '-', '/', '%', '|', ':', ';'])
const MAX_LENGTH = 4000

const isAlpha = (c: string) => /[A-Za-z_]/.test(c)
const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c)
const up = (t: Tok | undefined) => (t && t.k === 'word' ? t.v.toUpperCase() : '')
const isName = (t: Tok | undefined) => !!t && (t.k === 'word' || t.k === 'qid')

function tokenize(sql: string, why: string[]): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const s = i
    if (/\s/.test(c)) { i++; continue }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      out.push({ k: 'comment', v: sql.slice(s, i), s, e: i })
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      if (sql[i + 2] === '!' || sql[i + 2] === '+') why.push('an executable comment: some databases run what is inside it')
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      if (depth > 0) why.push('an unterminated comment')
      out.push({ k: 'comment', v: sql.slice(s, i), s, e: i })
      continue
    }
    if (c === "'") {
      i++
      let closed = false
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; closed = true; break }
        i++
      }
      if (!closed) why.push('an unterminated string')
      const body = sql.slice(s, i)
      if (body.includes('\\')) why.push('a backslash inside a string: databases disagree on whether it escapes the quote')
      out.push({ k: 'str', v: body, s, e: i })
      continue
    }
    if (c === '"' || c === '`') {
      i++
      let closed = false
      while (i < sql.length) {
        if (sql[i] === c && sql[i + 1] === c) { i += 2; continue }
        if (sql[i] === c) { i++; closed = true; break }
        i++
      }
      if (!closed) why.push('an unterminated quoted name')
      out.push({ k: 'qid', v: sql.slice(s + 1, closed ? i - 1 : i).replace(new RegExp(c + c, 'g'), c), s, e: i })
      continue
    }
    if (/[0-9]/.test(c)) {
      while (i < sql.length && /[0-9.]/.test(sql[i])) i++
      if (/[eE]/.test(sql[i] ?? '') && /[0-9+-]/.test(sql[i + 1] ?? '')) { i += 2; while (/[0-9]/.test(sql[i] ?? '')) i++ }
      if (isWord(sql[i] ?? ' ')) why.push('a malformed number: a hex or suffixed literal is read differently by different databases')
      out.push({ k: 'num', v: sql.slice(s, i), s, e: i })
      continue
    }
    if (isAlpha(c)) {
      while (i < sql.length && isWord(sql[i])) i++
      const w = sql.slice(s, i)
      if (/^[EeUu]$/.test(w) && (sql[i] === "'" || sql[i] === '&')) why.push('an escape-string prefix: its quoting rules differ from a plain string')
      out.push({ k: 'word', v: w, s, e: i })
      continue
    }
    if (c.charCodeAt(0) > 127) { why.push('a non-ASCII character outside a string, which can spell a keyword or a semicolon the filter will not recognise'); i++; continue }
    if (PUNCT.has(c)) { out.push({ k: 'punct', v: c, s, e: ++i }); continue }
    why.push(`the character ${JSON.stringify(c)}, which this guard does not accept in a query`)
    i++
  }
  return out
}

/** Index of the parenthesis that closes the one at `open`, or -1. */
function closing(t: Tok[], open: number): number {
  let depth = 0
  for (let i = open; i < t.length; i++) {
    if (t[i].v === '(' && t[i].k === 'punct') depth++
    else if (t[i].v === ')' && t[i].k === 'punct' && --depth === 0) return i
  }
  return -1
}

/** A CTE's name, the token range of its body, and the token positions of its column list, which name and never read. */
type Cte = { name: string; from: number; to: number; columns: number[] }

/**
 * The common table expressions, read from the WITH clause and nowhere else.
 * The first version collected any `name AS (` it saw, so a WINDOW clause named
 * after a table that is not on the allowlist made that table look like a CTE,
 * and its rows came back.
 */
function readWith(body: Tok[], why: string[]): Cte[] {
  const ctes: Cte[] = []
  if (up(body[0]) !== 'WITH') return ctes
  let i = 1
  if (up(body[i]) === 'RECURSIVE') i++
  for (;;) {
    const name = body[i]
    if (!isName(name)) { why.push('a WITH clause this guard cannot read'); return ctes }
    i++
    const columns: number[] = []
    if (body[i]?.v === '(') {
      const end = closing(body, i)
      if (end < 0 || body.slice(i + 1, end).some((t) => !(isName(t) || t.v === ','))) { why.push('a WITH clause this guard cannot read'); return ctes }
      for (let k = i + 1; k < end; k++) if (isName(body[k])) columns.push(k)
      i = end + 1
    }
    if (up(body[i]) !== 'AS') { why.push('a WITH clause this guard cannot read'); return ctes }
    i++
    if (up(body[i]) === 'NOT') i++
    if (up(body[i]) === 'MATERIALIZED') i++
    if (body[i]?.v !== '(') { why.push('a WITH clause this guard cannot read'); return ctes }
    const end = closing(body, i)
    if (end < 0) { why.push('a WITH clause this guard cannot read'); return ctes }
    ctes.push({ name: name.v.toLowerCase(), from: i + 1, to: end - 1, columns })
    i = end + 1
    if (body[i]?.v === ',') { i++; continue }
    break
  }
  if (up(body[i]) !== 'SELECT') why.push(`after the WITH clause the statement starts with ${body[i] ? JSON.stringify(body[i].v) : 'nothing'}, not SELECT`)
  return ctes
}

/** One level of parentheses: what opened it, and where its FROM clause stands. */
type Frame = { fn: string; inFrom: boolean; expect: boolean }

export function guard(sql: string, policy: Policy): Verdict {
  const why: string[] = []
  if (sql.length > MAX_LENGTH) return { allow: false, reasons: [`longer than ${MAX_LENGTH} characters`], sql: null }
  if (sql.includes('\u0000')) return { allow: false, reasons: ['a null byte'], sql: null }

  const all = tokenize(sql, why)
  const toks = all.filter((t) => t.k !== 'comment')
  if (!toks.length) return { allow: false, reasons: ['an empty statement'], sql: null }

  // 1. one statement
  const semis = toks.reduce<number[]>((a, t, i) => (t.k === 'punct' && t.v === ';' ? [...a, i] : a), [])
  if (semis.some((i) => i < toks.length - 1)) why.push('more than one statement')
  const body = semis.length && semis[semis.length - 1] === toks.length - 1 ? toks.slice(0, -1) : toks

  // 2. it starts as a read
  const head = up(body[0])
  if (head !== 'SELECT' && head !== 'WITH') why.push(`it starts with ${body[0] ? JSON.stringify(body[0].v) : 'nothing'}, not SELECT or WITH`)

  const protectedCols = new Set(policy.protectedColumns.map((c) => c.toLowerCase()))
  const known = new Set(Object.keys(policy.tables))
  const holdsProtected = (t: string) => policy.tables[t]?.some((c) => protectedCols.has(c.toLowerCase())) ?? false
  const ctes = readWith(body, why)
  const cteNames = new Set(ctes.map((c) => c.name))

  // 3. one walk: keywords, functions and catalogs on every token, and a FROM
  //    clause tracked per parenthesis depth, so that a table is checked wherever
  //    SQLite would read one: after FROM, after a comma in a FROM list, after
  //    JOIN, and after a subquery that closes in the middle of a FROM list.
  const referenced: string[] = []
  const cteRefs: { name: string; at: number }[] = []
  /** token positions where a protected table or its alias is declared, not read */
  const declared = new Set<number>()
  /** a protected table's name and aliases, to its table */
  const rowNames = new Map<string, string>()
  const frames: Frame[] = [{ fn: '', inFrom: false, expect: false }]
  let joins = 0
  for (let i = 0; i < body.length; i++) {
    const t = body[i], u = up(t), lo = t.v.toLowerCase(), next = body[i + 1]
    const f = frames[frames.length - 1]

    if (t.k === 'qid' && protectedCols.has(lo)) why.push(`the protected column ${t.v}`)
    // SQLite reads a string as a name wherever its grammar wants one and a string cannot go: next to a dot
    // (customers.'card_number' is the column), in a USING list, and where a table belongs (below)
    if (t.k === 'str' && (body[i - 1]?.v === '.' || next?.v === '.')) why.push('a name in single quotes next to a dot, which SQLite reads as a column or a table')
    if (t.k === 'str' && f.fn === 'USING') why.push('a column name in single quotes in USING, which SQLite reads as a name')
    if (t.k === 'word') {
      if (FORBIDDEN.has(u) && !(FUNCTION_OK.has(u) && next?.v === '(')) why.push(`the keyword ${u}`)
      if (FORBIDDEN_FUNCTIONS.has(lo)) why.push(`the function ${lo}`)
      if (CATALOGS.has(lo) || lo.startsWith('pg_') || lo.startsWith('sqlite_stat')) why.push(`the system catalog ${lo}`)
      if (protectedCols.has(lo)) why.push(`the protected column ${lo}`)
      if (u === 'JOIN') joins++
    }

    if (t.k === 'punct' && t.v === '(') {
      if (f.inFrom && f.expect) {
        // where a table is expected, a parenthesis must open a subquery; SQLite also accepts a table name in
        // brackets here, which the first version walked past and never checked
        if (!SUBQUERY_STARTS.has(up(next))) why.push('a table reference in parentheses')
        f.expect = false
      }
      frames.push({ fn: up(body[i - 1]), inFrom: false, expect: false })
      continue
    }
    if (t.k === 'punct' && t.v === ')') { if (frames.length > 1) frames.pop(); continue }
    if (u === 'FROM') {
      if (!FROM_IN_FUNCTION.has(f.fn)) { f.inFrom = true; f.expect = true }
      continue
    }
    if (!f.inFrom) continue
    if (FROM_ENDS.has(u)) { f.inFrom = false; f.expect = false; continue }
    if (t.k === 'punct' && t.v === ',') { f.expect = true; continue }
    if (u === 'JOIN') { f.expect = true; continue }
    if (f.expect && t.k === 'str') { why.push('a table name in single quotes, which SQLite reads as a name'); f.expect = false; continue }
    if (!f.expect || !isName(t)) continue

    // a table reference
    f.expect = false
    if (next?.v === '.') { why.push(`the schema-qualified table ${lo}.${body[i + 2]?.v ?? ''}`); i += 2; continue }
    if (next?.v === '(') { why.push(`the table function ${lo}`); continue }
    if (cteNames.has(lo)) cteRefs.push({ name: lo, at: i })
    else if (known.has(lo)) referenced.push(lo)
    else { why.push(`the table ${lo}, which is not on the allowlist`); continue }
    if (known.has(lo) && holdsProtected(lo)) {
      declared.add(i)
      rowNames.set(lo, lo)
      const a = up(next) === 'AS' ? i + 2 : isName(next) && !NOT_AN_ALIAS.has(up(next)) ? i + 1 : -1
      if (a > 0 && isName(body[a])) { declared.add(a); rowNames.set(body[a].v.toLowerCase(), lo) }
    }
  }
  if (joins > policy.maxJoins) why.push(`${joins} joins, more than the ${policy.maxJoins} allowed`)

  // 4. recursion. SQLite runs a CTE that names itself as recursive with or without the RECURSIVE keyword, so the
  //    keyword ban alone let an unbounded query through. Any cycle between CTEs is refused.
  const edges = new Map<string, Set<string>>(ctes.map((c) => [c.name, new Set<string>()]))
  for (const r of cteRefs) for (const c of ctes) if (r.at >= c.from && r.at <= c.to) edges.get(c.name)!.add(r.name)
  const cyclic = (start: string) => {
    const seen = new Set<string>(), stack = [...(edges.get(start) ?? [])]
    while (stack.length) {
      const n = stack.pop()!
      if (n === start) return true
      if (seen.has(n)) continue
      seen.add(n)
      stack.push(...(edges.get(n) ?? []))
    }
    return false
  }
  for (const c of ctes) if (cyclic(c.name)) why.push(`the CTE ${c.name} refers to itself, so it can run without end`)

  // 5. SELECT * over a table that holds a protected column
  body.forEach((t, i) => {
    if (t.v !== '*' || t.k !== 'punct') return
    const p = body[i - 1], n = body[i + 1]
    const star = (up(p) === 'SELECT' || p?.v === ',' || p?.v === '.' || /^(DISTINCT|ALL)$/.test(up(p))) && (!n || n.v === ',' || up(n) === 'FROM' || n.v === ')')
    if (!star) return
    for (const tb of new Set(referenced)) if (holdsProtected(tb)) why.push(`SELECT * over ${tb}, which holds a protected column`)
  })

  // 6. a whole row read as one value. Postgres turns `c` in `SELECT c FROM customers c`, or row_to_json(c), into
  //    every column of the row, protected ones included, without the column ever being named.
  //    A name right after AS, or in a CTE's column list, is being given, not read.
  for (const c of ctes) for (const k of c.columns) declared.add(k)
  body.forEach((t, i) => {
    if (!isName(t) || declared.has(i) || up(body[i - 1]) === 'AS') return
    const table = rowNames.get(t.v.toLowerCase())
    if (table && body[i + 1]?.v !== '.' && body[i - 1]?.v !== '.') why.push(`the whole row of ${table} read as one value`)
  })

  // 7. the row cap, on the one place it holds: the outermost LIMIT, which must be LIMIT n, LIMIT n OFFSET m or
  //    LIMIT m, n, all plain numbers. The first version only looked at the token after LIMIT, so LIMIT 0, 100000
  //    capped the offset and LIMIT 1 + 99999 kept its own size.
  let capped = ''
  if (!why.length) {
    let depth = 0, at = -1, offsetAt = -1
    body.forEach((t, i) => {
      if (t.v === '(') depth++
      else if (t.v === ')') depth--
      else if (depth === 0 && up(t) === 'LIMIT') at = i
      else if (depth === 0 && up(t) === 'OFFSET') offsetAt = i
    })
    let text = ''
    let cursor = 0
    for (const t of all) {
      if (t.k === 'comment') { text += sql.slice(cursor, t.s) + ' '; cursor = t.e }
    }
    text += sql.slice(cursor)
    text = text.trim().replace(/;\s*$/, '').trim()
    const plain = (x: Tok | undefined) => !!x && x.k === 'num' && /^\d+$/.test(x.v)
    if (at < 0) {
      if (offsetAt >= 0) why.push('an OFFSET with no LIMIT, so the row cap has nowhere to go')
      else capped = `${text} LIMIT ${policy.maxRows}`
    } else {
      const rest = body.slice(at + 1)
      const offsetFirst = rest.length === 3 && rest[1].v === ','
      const ok = (rest.length === 1 && plain(rest[0])) || (rest.length === 3 && plain(rest[0]) && plain(rest[2]) && (up(rest[1]) === 'OFFSET' || offsetFirst))
      if (!ok) why.push('a LIMIT that is not LIMIT n, LIMIT n OFFSET m or LIMIT m, n with plain numbers')
      else capped = Number((offsetFirst ? rest[2] : rest[0]).v) > policy.maxRows ? replaceLimit(text, policy.maxRows) : text
    }
  }

  const reasons = [...new Set(why)]
  return reasons.length ? { allow: false, reasons, sql: null } : { allow: true, reasons: [], sql: capped }
}

/**
 * Replace the row count of the outermost LIMIT: the number after LIMIT, or after the comma in LIMIT m, n, where
 * SQLite reads the first number as the offset. Re-tokenizes the cleaned text so offsets are its own.
 */
function replaceLimit(text: string, max: number): string {
  const t = tokenize(text, []).filter((x) => x.k !== 'comment')
  let depth = 0, at = -1
  t.forEach((x, i) => {
    if (x.v === '(') depth++
    else if (x.v === ')') depth--
    else if (depth === 0 && up(x) === 'LIMIT') at = i
  })
  const n = t[at + 2]?.v === ',' ? t[at + 3] : t[at + 1]
  return text.slice(0, n.s) + String(max) + text.slice(n.e)
}

/** The shop the corpus and the page both use: five tables to read, one to refuse. */
export const SHOP: Policy = {
  tables: {
    customers: ['id', 'name', 'email', 'country', 'created_at', 'card_number'],
    orders: ['id', 'customer_id', 'total', 'status', 'created_at'],
    order_items: ['id', 'order_id', 'product_id', 'qty', 'price'],
    products: ['id', 'name', 'price', 'stock', 'category'],
    shipments: ['id', 'order_id', 'carrier', 'status', 'shipped_at'],
  },
  protectedColumns: ['card_number', 'password_hash', 'api_key'],
  maxRows: 500,
  maxJoins: 4,
}
