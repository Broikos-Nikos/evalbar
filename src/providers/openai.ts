/**
 * Any endpoint that speaks OpenAI's chat completions: the cloud APIs that do,
 * and the local servers (llama.cpp, LM Studio, vLLM) by their base URL.
 *
 * What it records, because 07-evaluation/01 section 6 says a harness that does
 * not is measuring something else:
 *
 * - usage from the response's own block, cached input separately, and null
 *   rather than zero when the endpoint sends none: a cost of $0.00 is almost
 *   never a measurement;
 * - the model the response names, since an alias can resolve to another;
 * - finish_reason, so an answer cut off by the token limit is counted as cut
 *   off and not graded as wrong;
 * - the attempts, because a pass that took four is a different fact.
 *
 * 429 and 5xx are retried with jittered exponential backoff, honouring
 * Retry-After; 401 and 403 stop the run, since every case would get them;
 * every attempt has a hard deadline, because a stalled connection can hold a
 * case forever.
 */
import type { Case, Message } from '../cases.ts'
import { ProviderError, type Provider, type Reply } from './types.ts'

export type OpenAiOptions = {
  baseUrl: string
  model: string
  /** the name of the environment variable that holds the key; the key itself is never written anywhere */
  apiKeyEnv?: string
  timeoutMs: number
  retries: number
  temperature?: number
  seed?: number
  maxTokens?: number
  /** prepended to every case that has no system message of its own */
  system?: string
  /** milliseconds before the first retry; the tests make it small */
  backoffMs?: number
}

/** A string becomes one user turn; a system prompt goes first unless the case brings its own. */
export function toMessages(input: Case['input'], system?: string): Message[] {
  const turns: Message[] = typeof input === 'string' ? [{ role: 'user', content: input }] : input
  return system && !turns.some((m) => m.role === 'system') ? [{ role: 'system', content: system }, ...turns] : turns
}

const RETRY = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function excerpt(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 200 ? `${one.slice(0, 200)}...` : one
}

export function openaiProvider(o: OpenAiOptions): Provider {
  const url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const key = o.apiKeyEnv ? process.env[o.apiKeyEnv] : undefined
  if (o.apiKeyEnv && !key) throw new ProviderError('auth', `the environment variable ${o.apiKeyEnv} is not set`, { fatal: true })
  const base = o.backoffMs ?? 1000

  async function once(messages: Message[]): Promise<{ reply: Omit<Reply, 'attempts'> } | { retryAfterMs: number | null; error: ProviderError }> {
    const body: Record<string, unknown> = { model: o.model, messages }
    if (o.temperature !== undefined) body.temperature = o.temperature
    if (o.maxTokens !== undefined) body.max_tokens = o.maxTokens
    if (o.seed !== undefined) body.seed = o.seed
    const started = performance.now()
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs),
      })
    } catch (e) {
      const err = e as Error
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
      return {
        retryAfterMs: null,
        error: timedOut
          ? new ProviderError('timeout', `no response within ${o.timeoutMs} ms`)
          : new ProviderError('network', `${url}: ${(err.cause as Error | undefined)?.message ?? err.message}`),
      }
    }
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      const err = e as Error
      return { retryAfterMs: null, error: new ProviderError(err.name === 'TimeoutError' ? 'timeout' : 'network', `the body did not arrive: ${err.message}`) }
    }
    const latencyMs = performance.now() - started
    if (!res.ok) {
      const after = Number(res.headers.get('retry-after'))
      const message = `HTTP ${res.status} from ${url}: ${excerpt(text)}`
      if (res.status === 401 || res.status === 403) return { retryAfterMs: null, error: new ProviderError('auth', message, { status: res.status, fatal: true }) }
      if (RETRY.has(res.status)) return { retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : null, error: new ProviderError('http', message, { status: res.status }) }
      return { retryAfterMs: null, error: new ProviderError('http', message, { status: res.status, fatal: res.status === 404 }) }
    }
    let json: {
      model?: string
      choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
    }
    try {
      json = JSON.parse(text)
    } catch {
      return { retryAfterMs: null, error: new ProviderError('protocol', `the response was not JSON: ${excerpt(text)}`) }
    }
    const choice = json.choices?.[0]
    if (!choice?.message) return { retryAfterMs: null, error: new ProviderError('protocol', `the response had no choices[0].message: ${excerpt(text)}`) }
    const u = json.usage
    const usage =
      u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number'
        ? { input: u.prompt_tokens, output: u.completion_tokens, cachedInput: u.prompt_tokens_details?.cached_tokens ?? 0 }
        : null
    return {
      reply: {
        text: choice.message.content ?? choice.message.refusal ?? '',
        usage,
        model: json.model ?? null,
        finish: choice.finish_reason ?? null,
        latencyMs,
      },
    }
  }

  return {
    describe: `${o.model} at ${o.baseUrl}`,
    async call(_id, input) {
      const messages = toMessages(input, o.system)
      let attempts = 0
      for (;;) {
        attempts++
        const r = await once(messages)
        if ('reply' in r) return { ...r.reply, attempts }
        const e = r.error
        const retryable = !e.fatal && (e.kind === 'timeout' || e.kind === 'network' || (e.kind === 'http' && RETRY.has(e.status ?? 0)))
        if (!retryable || attempts > o.retries) throw new ProviderError(e.kind, e.message, { status: e.status, fatal: e.fatal, attempts })
        const jittered = base * 2 ** (attempts - 1) * (0.5 + Math.random())
        await sleep(Math.min(60_000, r.retryAfterMs ?? jittered))
      }
    },
    async close() {},
  }
}
