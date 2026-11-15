/**
 * Your own system as the thing under test, in any language.
 *
 * 07-evaluation/01's procedure says the runner calls the real entry point, never
 * a reconstructed API call: the prompt the eval sends to a vendor is not the
 * prompt your application sends, once retrieval, a system prompt and a
 * post-processor have had their turn. So evalbar starts your program once and
 * talks to it one line at a time:
 *
 *   evalbar writes   {"id": "q1", "input": "..."}          one line, then waits
 *   you write        {"output": "..."}                     one line back
 *                    {"output": "...", "usage": {"input": 812, "output": 64}}
 *                    {"error": "the index is down"}          an infrastructure fault, not a grade
 *
 * It is sent the input and the id, nothing else: not the expected answer and
 * not the tags, because ground truth that the system under test can read is
 * ground truth it can learn to echo (07-evaluation/01 section 4).
 *
 * A case that gets no line back within the timeout kills the process, is
 * recorded as an error, and the next case gets a fresh process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Case } from '../cases.ts'
import { ProviderError, type Provider, type Reply } from './types.ts'

export type CommandOptions = { command: string; cwd?: string; timeoutMs: number }

export function commandProvider(o: CommandOptions): Provider {
  let child: ChildProcessWithoutNullStreams | null = null
  let stderr = ''
  let waiting: { resolve: (line: string) => void; reject: (e: ProviderError) => void } | null = null
  const lines: string[] = []

  function start() {
    // per process: a killed process can still flush a line or fire its exit after the next one has started,
    // and neither may reach the case the next one is answering (found by the stall test, tick 4)
    let buffer = ''
    stderr = ''
    lines.length = 0
    const c = spawn(o.command, { cwd: o.cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    c.stdout.setEncoding('utf8')
    c.stderr.setEncoding('utf8')
    c.stdout.on('data', (chunk: string) => {
      if (child !== c) return
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        if (waiting) {
          const w = waiting
          waiting = null
          w.resolve(line)
        } else lines.push(line)
      }
    })
    c.stderr.on('data', (chunk: string) => {
      if (child !== c) return
      stderr = (stderr + chunk).slice(-2000)
    })
    c.on('exit', (code, signal) => {
      if (child !== c) return
      child = null
      if (waiting) {
        const w = waiting
        waiting = null
        // the line that names the error, not the last three: Node ends a crash with its own version number
        const said = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        const tail = said.find((l) => /error|exception|traceback/i.test(l)) ?? said.at(-1) ?? ''
        w.reject(new ProviderError('process', `the command exited (${signal ?? `code ${code}`}) before answering${tail ? `: ${tail}` : ''}`))
      }
    })
    c.on('error', (e) => {
      if (child !== c) return
      if (waiting) {
        const w = waiting
        waiting = null
        w.reject(new ProviderError('process', `the command could not start: ${e.message}`, { fatal: true }))
      }
    })
    c.stdin.on('error', () => {
      // a process that died mid-write; the exit handler reports it
    })
    child = c
    return c
  }

  function kill() {
    if (!child) return
    const c = child
    child = null
    c.stdin.destroy()
    if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
    else c.kill('SIGKILL')
  }

  function nextLine(): Promise<string> {
    const queued = lines.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject }
    })
  }

  /** One case at a time, whatever the runner's concurrency: the protocol is one line in, one line out. */
  let turn: Promise<unknown> = Promise.resolve()

  return {
    describe: `the command ${o.command}`,
    call(id: string, input: Case['input']): Promise<Reply> {
      const mine = turn.then(() => exchange(id, input))
      turn = mine.catch(() => {})
      return mine
    },
    async close() {
      await turn
      if (!child) return
      const c = child
      c.stdin.end()
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          kill()
          resolve()
        }, 2000)
        c.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    },
  }

  async function exchange(id: string, input: Case['input']): Promise<Reply> {
    const c = child ?? start()
    const started = performance.now()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        waiting = null
        kill()
        reject(new ProviderError('timeout', `no line back within ${o.timeoutMs} ms`))
      }, o.timeoutMs)
    })
    try {
      c.stdin.write(`${JSON.stringify({ id, input })}\n`)
      const line = await Promise.race([nextLine(), deadline])
      let msg: { output?: unknown; error?: unknown; usage?: { input?: number; output?: number } }
      try {
        msg = JSON.parse(line)
      } catch {
        throw new ProviderError('protocol', `the command wrote a line that is not JSON: ${line.slice(0, 120)}`)
      }
      if (typeof msg.error === 'string') throw new ProviderError('process', `the command reported: ${msg.error}`)
      if (typeof msg.output !== 'string') throw new ProviderError('protocol', `the command's line has no string "output": ${line.slice(0, 120)}`)
      const u = msg.usage
      return {
        text: msg.output,
        usage: u && typeof u.input === 'number' && typeof u.output === 'number' ? { input: u.input, output: u.output, cachedInput: 0 } : null,
        model: null,
        finish: null,
        latencyMs: performance.now() - started,
        attempts: 1,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
