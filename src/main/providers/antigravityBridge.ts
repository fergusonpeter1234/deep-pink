import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { ToolCall, ToolResult } from '@shared/types'
import { antigravityWebCallLimit, MAX_ANTIGRAVITY_WEB_CALLS } from '@shared/antigravity'
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from '../tools/web'
import type { ToolParam } from './types'

export const WEB_SERVER_NAME = 'deep_pink_web'
// Match the chat engine's limit; tell the agent before it attempts another call.
export { MAX_ANTIGRAVITY_WEB_CALLS }

/** Google adds a display-only toolSummary argument to eager MCP calls. */
export function webArguments(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid web tool arguments.')
  const { toolSummary: _summary, ...args } = value as Record<string, unknown>
  void _summary
  const keys = name === 'web_search' ? ['query', 'max_results'] : name === 'web_fetch' ? ['url', 'max_chars'] : []
  if (!keys.length || Object.keys(args).some((key) => !keys.includes(key))) throw new Error('Unsupported web tool arguments.')
  const required = name === 'web_search' ? 'query' : 'url'
  if (typeof args[required] !== 'string' || !(args[required] as string).trim()) throw new Error(`Missing ${required}.`)
  const optional = name === 'web_search' ? 'max_results' : 'max_chars'
  if (args[optional] != null && (typeof args[optional] !== 'number' || !Number.isFinite(args[optional]))) {
    throw new Error(`Invalid ${optional}.`)
  }
  return Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]))
}

export function webToolsFor(tools: ToolParam[] = []): ToolParam[] {
  const names = new Set(tools.map((tool) => tool.function.name))
  return [WEB_SEARCH_TOOL, WEB_FETCH_TOOL].filter((tool) => names.has(tool.function.name))
}

/**
 * A private stdio MCP helper, launched by Antigravity using Electron's Node
 * runtime. It only forwards the two declared web tools to the parent app.
 * No shell, filesystem or arbitrary networking capability is exposed to models.
 */
export const WEB_BRIDGE_SCRIPT = String.raw`
'use strict'
const { readFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const names = new Set(config.tools.map(tool => tool.name))
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  void (async () => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id === undefined) return
    try {
      let result
      if (message.method === 'initialize') {
        result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'deep-pink-web', version: '1.0.0' } }
      } else if (message.method === 'ping') result = {}
      else if (message.method === 'tools/list') result = { tools: config.tools }
      else if (message.method === 'tools/call') {
        if (!names.has(message.params.name)) throw new Error('Web tool is not enabled.')
        const response = await fetch(config.endpoint, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token },
          body: JSON.stringify({ name: message.params.name, arguments: message.params.arguments }),
          signal: AbortSignal.timeout(120000) })
        if (!response.ok) throw new Error('Deep Pink web bridge request failed.')
        result = await response.json()
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported MCP method.' } })
        return
      }
      send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } })
    }
  })()
})
`

export async function createWebBridge(
  tools: ToolParam[],
  handle: (call: ToolCall) => Promise<ToolResult>,
  signal?: AbortSignal,
  webToolLimit = MAX_ANTIGRAVITY_WEB_CALLS
): Promise<{ endpoint: string; token: string; close: () => Promise<void> }> {
  const maxCalls = antigravityWebCallLimit(webToolLimit)
  const token = randomBytes(32).toString('hex')
  const path = `/${randomUUID()}`
  const allowed = new Set(webToolsFor(tools).map((tool) => tool.function.name))
  let closed = false
  let requests = 0
  const server = createServer((req, res) => {
    const reply = (status: number, value: unknown): void => {
      if (res.destroyed) return
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const auth = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (closed || req.method !== 'POST' || req.url !== path || req.headers.origin ||
        auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      reply(403, { error: 'Forbidden' })
      req.resume()
      return
    }
    let bytes = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 64 * 1024) req.destroy()
      else chunks.push(chunk)
    })
    req.on('error', () => undefined)
    req.on('end', () => {
      void (async () => {
        try {
          signal?.throwIfAborted()
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name?: unknown; arguments?: unknown }
          if (typeof input.name !== 'string' || !allowed.has(input.name)) throw new Error('Web tool is not enabled.')
          const args = webArguments(input.name, input.arguments)
          if (requests >= maxCalls) {
            throw new Error('Deep Pink’s web-tool budget for this reply is exhausted. Finish the answer using the results already collected; do not call another tool.')
          }
          requests++
          const result = await handle({ id: `antigravity-web-${randomUUID()}`, name: input.name, arguments: JSON.stringify(args) })
          const remaining = maxCalls - requests
          const budget = remaining === 0
            ? '\n\n[Deep Pink: The web-tool budget is exhausted. Finish the answer using the results already collected. Do not call another tool.]'
            : remaining > 0
              ? `\n\n[Deep Pink: ${remaining} web-tool ${remaining === 1 ? 'call remains' : 'calls remain'}. This is a ceiling, not a target. Answer now if the evidence is sufficient; use another call only for a material gap. Finish with the information already collected when the budget runs out.]`
              : ''
          reply(200, { content: [{ type: 'text', text: result.content + budget }], isError: result.isError })
        } catch (error) {
          reply(200, { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Web tool failed.' }], isError: true })
        }
      })()
    })
  })
  server.requestTimeout = 125_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  server.on('error', () => undefined)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start the Antigravity web bridge.')
  return {
    endpoint: `http://127.0.0.1:${address.port}${path}`,
    token,
    close: async () => {
      closed = true
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}
