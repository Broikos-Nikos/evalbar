/**
 * An OpenAI-compatible endpoint that misbehaves on request, for the runner's
 * tests. The model name picks the behaviour:
 *
 *   oracle     the answer the test registered for the input
 *   null       an empty answer
 *   flaky      503 on the first call for an input, then the answer
 *   ratelimit  429 every time
 *   hang       never answers
 *   truncate   the answer, cut off: finish_reason "length"
 *   nousage    the answer with no usage block
 *   auth       401
 *   alias      the answer, from a model with another name
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

export type Fake = { url: string; calls: number; bodies: string[]; close: () => Promise<void> }

export async function fakeOpenAi(answers: Record<string, string>): Promise<Fake> {
  const seen = new Map<string, number>()
  const sockets = new Set<Socket>()
  const state = { calls: 0, bodies: [] as string[] }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    state.calls++
    state.bodies.push(raw)
    const body = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] }
    const input = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
    const answer = answers[input] ?? ''
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(payload))
    }
    const ok = (text: string, extra: { finish?: string; usage?: boolean; model?: string } = {}) =>
      send(200, {
        model: extra.model ?? body.model,
        choices: [{ message: { role: 'assistant', content: text }, finish_reason: extra.finish ?? 'stop' }],
        ...(extra.usage === false ? {} : { usage: { prompt_tokens: 10 + input.length, completion_tokens: 2 + text.length, prompt_tokens_details: { cached_tokens: 4 } } }),
      })
    // judges read the request and the answer out of the user turn the judge prompt builds
    const between = (tag: string) => input.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? ''
    const verdict = (v: 'pass' | 'fail') => ok(`{"reasoning": "the rule says so", "verdict": "${v}"}`)
    // a "qwen-" prefix keeps the behaviour and gives the model a family, for decision B10
    switch (body.model.replace(/^qwen-/, '')) {
      case 'judge-good':
        // the hidden rule the human labels follow: an answer that starts "Sure" and is about this request
        return verdict(between('answer').startsWith('Sure') && between('answer').includes(between('request')) ? 'pass' : 'fail')
      case 'judge-always-pass':
        return verdict('pass')
      case 'judge-garbage':
        return ok('I think this answer is quite good overall.')
      case 'oracle':
        return ok(answer)
      case 'null':
        return ok('')
      case 'flaky': {
        const n = (seen.get(input) ?? 0) + 1
        seen.set(input, n)
        return n === 1 ? send(503, { error: { message: 'overloaded' } }) : ok(answer)
      }
      case 'ratelimit':
        return send(429, { error: { message: 'slow down' } }, { 'retry-after': '0' })
      case 'hang':
        return // the socket stays open until the test closes the server
      case 'truncate':
        return ok(answer.slice(0, 2), { finish: 'length' })
      case 'nousage':
        return ok(answer, { usage: false })
      case 'auth':
        return send(401, { error: { message: 'invalid api key' } })
      case 'alias':
        return ok(answer, { model: 'some-other-model-2026' })
      default:
        return send(404, { error: { message: `no model ${body.model}` } })
    }
  })
  server.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get calls() {
      return state.calls
    },
    get bodies() {
      return state.bodies
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        server.close(() => r())
      }),
  }
}
