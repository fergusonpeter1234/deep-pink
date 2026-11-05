const { suite } = require('./support/harness')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

suite('Codex web search recovery', async ({ check, subject }) => {
  const { assembleContext, streamCodexChat, DEFAULT_SETTINGS, WEB_SEARCH_TOOL } = subject
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.codex.nativeWebSearch = true
  settings.web.enabled = true
  const thread = { config: { model: 'codex:test-model', webAccessEnabled: true } }
  const context = assembleContext(thread, settings, 'codex')
  check('native mode keeps both client web tools available for recovery',
    context.codexNativeWebSearch &&
    context.tools.map((t) => t.function.name).join(',') === 'web_search,web_fetch')
  check('native instructions explain when to use fallback tools',
    context.systemText.includes('If native search is unavailable or fails'))

  for (const config of [
    { webAccessEnabled: false },
    { disabledPromptSegments: ['web'] },
    { disabledPromptSegments: ['tools'] }
  ]) {
    const disabled = assembleContext({ config: { ...thread.config, ...config } }, settings, 'codex')
    check(`web controls disable native and fallback access: ${JSON.stringify(config)}`,
      !disabled.codexNativeWebSearch && disabled.tools.length === 0)
  }

  // Use the real provider and its JSON-RPC transport with a simulated child.
  // No real Codex process, credentials or search endpoint is used by this suite.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-pink-codex-bin-'))
  const binary = path.join(binDir, process.platform === 'win32' ? 'codex.exe' : 'codex')
  fs.writeFileSync(binary, '', { mode: 0o755 })
  const originalPath = process.env.PATH
  const originalSpawn = childProcess.spawn
  process.env.PATH = binDir
  try {
    for (const scenario of [
      { native: true, namespace: 'codex_app', tool: 'web_search', allowed: true },
      { native: false, namespace: null, tool: 'web_search', allowed: true },
      { native: false, namespace: '', tool: 'web_search', allowed: true },
      { native: true, namespace: 'unrelated', tool: 'web_search', allowed: false },
      { native: true, namespace: 'codex_app', tool: 'shell', allowed: false }
    ]) {
      let threadParams
      let launchArgs
      let handled = 0
      let reply
      childProcess.spawn = (_binary, args) => {
        launchArgs = args
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        let closed = false
        const close = () => {
          if (closed) return
          closed = true
          child.emit('close', 0, null)
        }
        child.kill = close
        const emit = (message) => child.stdout.write(`${JSON.stringify(message)}\n`)
        child.stdin = new Writable({
          write(chunk, _encoding, done) {
            const message = JSON.parse(chunk.toString())
            queueMicrotask(() => {
              if (message.method === 'initialize') {
                emit({ id: message.id, result: {} })
              } else if (message.method === 'thread/start') {
                threadParams = message.params
                emit({ id: message.id, result: { thread: { id: 'test-thread' } } })
              } else if (message.method === 'turn/start') {
                emit({ id: message.id, result: {} })
                emit({ id: 900, method: 'item/tool/call', params: {
                  threadId: 'test-thread', turnId: 'test-turn', callId: 'search-call',
                  namespace: scenario.namespace, tool: scenario.tool,
                  arguments: { query: 'current release notes' }
                } })
              } else if (message.id === 900) {
                reply = message
                emit({ method: 'item/agentMessage/delta', params: { delta: 'Search completed.' } })
                emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
              } else if (message.method === 'account/usage/read') {
                emit({ id: message.id, result: {} })
              }
            })
            done()
          }
        })
        child.stdin.on('finish', close)
        return child
      }
      const result = await streamCodexChat({
        model: 'codex:test-model', messages: [{ role: 'user', content: 'Search current release notes.' }],
        nativeWebSearch: scenario.native, tools: [WEB_SEARCH_TOOL], attribution: false
      }, {
        onDynamicToolCall: async (call) => {
          handled += 1
          return { toolCallId: call.id, name: call.name, content: 'Retrieved live results.', isError: false, durationMs: 1 }
        }
      })
      check(`tool authorization: ${JSON.stringify(scenario)}`,
        scenario.allowed
          ? handled === 1 && reply.result?.success === true && result.toolCalls.length === 1
          : handled === 0 && Boolean(reply.error) && result.toolCalls.length === 0,
        { handled, reply })
      if (scenario.native) {
        check('native preference preserves live search while registering fallback',
          launchArgs.includes('web_search="live"') &&
          launchArgs[launchArgs.indexOf('standalone_web_search') - 1] === '--enable')
        check('native turn registers the fallback tool and recovery instructions',
          threadParams.dynamicTools.some((t) => t.name === 'web_search') &&
          threadParams.developerInstructions.includes('If native search is unavailable or fails'))
      }
    }
  } finally {
    childProcess.spawn = originalSpawn
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    fs.rmSync(binDir, { recursive: true, force: true })
  }
})
