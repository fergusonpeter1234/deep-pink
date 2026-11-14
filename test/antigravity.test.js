const { suite } = require('./support/harness')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

suite('Antigravity restricted transport', async ({ check, subject }) => {
  const { streamAntigravityChat, createRestrictedProfile, validateRestrictedProfile,
    compatibleAntigravityVersion, WEB_SEARCH_TOOL, providerForModel, modelIdForProvider,
    providerModelId, DEFAULT_SETTINGS, assembleContext, webToolsFor, webArguments, createWebBridge,
    MAX_ANTIGRAVITY_WEB_CALLS, antigravityTranscript, antigravityWebCallLimit } = subject

  check('Antigravity model ids retain their namespace',
    providerForModel('antigravity:gemini-test') === 'antigravity' &&
    modelIdForProvider('antigravity', 'gemini-test') === 'antigravity:gemini-test' &&
    providerModelId('antigravity:gemini-test') === 'gemini-test')
  check('OpenRouter ids are preserved', providerForModel('google/gemini-test') === 'openrouter' &&
    providerModelId('google/gemini-test') === 'google/gemini-test')
  check('unknown and older CLI restriction versions fail closed',
    compatibleAntigravityVersion('1.5.8') && compatibleAntigravityVersion('1.5.9') &&
    !compatibleAntigravityVersion('1.5.7') && !compatibleAntigravityVersion('1.6.0') &&
    !compatibleAntigravityVersion('unexpected'))
  check('provider starts disabled', DEFAULT_SETTINGS.antigravity.enabled === false)
  check('the default research budget is independent of thinking effort', DEFAULT_SETTINGS.antigravity.webToolLimit === 4)
  check('research budgets are bounded and malformed values use the default',
    antigravityWebCallLimit(NaN) === 4 && antigravityWebCallLimit(undefined) === 4 &&
    antigravityWebCallLimit(100) === MAX_ANTIGRAVITY_WEB_CALLS && antigravityWebCallLimit(-1) === 1)
  check('only canonical web schemas can be exposed', webToolsFor([
    WEB_SEARCH_TOOL, { type: 'function', function: { name: 'shell', parameters: {} } }
  ]).length === 1)
  check('display-only metadata is stripped from web arguments',
    JSON.stringify(webArguments('web_search', { toolSummary: 'Search', query: 'test' })) === '{"query":"test"}')
  let badArguments = false
  try { webArguments('web_search', { query: 'test', command: 'echo unsafe' }) } catch { badArguments = true }
  check('unexpected web arguments are refused', badArguments)

  const replay = antigravityTranscript({ model: 'antigravity:gemini-test', attribution: false, messages: [
    { role: 'system', content: 'Preserve the user preferences.' },
    { role: 'user', content: 'An earlier lookup.' },
    { role: 'assistant', content: 'Already answered.', tool_calls: [
      { id: 'old-search', type: 'function', function: { name: 'web_search', arguments: '{"query":"earlier"}' } }
    ] },
    { role: 'tool', tool_call_id: 'old-search', content: 'Historical evidence.' },
    { role: 'user', content: '/browser current question' }
  ] })
  const replayText = replay.input[0].text
  check('current request is distinguished from already completed conversation turns',
    replayText.includes('Historical user:\nAn earlier lookup.') &&
    replayText.includes('Historical assistant:\nAlready answered.') &&
    replayText.endsWith('Current user request:\n/browser current question'))
  check('historical tool results retain their call association',
    replayText.includes('[old-search] web_search') && replayText.includes('Historical tool [tool call old-search]'))
  check('research guidance preserves user instructions and permits requested depth',
    replay.instructions.startsWith('Preserve the user preferences.') &&
    replay.instructions.includes('Use additional research when the user requests depth') &&
    replay.instructions.includes('safety ceiling, never a research target'))
  const limitedPrompt = antigravityTranscript({ model: 'antigravity:gemini-test', attribution: false,
    antigravityWebToolLimit: 8, tools: [WEB_SEARCH_TOOL], messages: [{ role: 'user', content: 'Research a question.' }] })
  check('the selected research budget is explained before the first model call',
    limitedPrompt.instructions.includes('up to 8 web-tool calls') && limitedPrompt.instructions.includes('Do not claim exhaustive research'))

  let boundaryCalls = 0
  const bridge = await createWebBridge([WEB_SEARCH_TOOL], async (call) => {
    boundaryCalls += 1
    return { toolCallId: call.id, name: call.name, content: 'fixture', isError: false, durationMs: 1 }
  })
  try {
    const unauthorized = await fetch(bridge.endpoint, { method: 'POST', body: '{}' })
    check('bridge refuses requests without its per-request secret', unauthorized.status === 403 && boundaryCalls === 0)
    const browser = await fetch(bridge.endpoint, { method: 'POST',
      headers: { Authorization: 'Bearer ' + bridge.token, Origin: 'https://untrusted.test' }, body: '{}' })
    check('bridge refuses browser-origin requests', browser.status === 403 && boundaryCalls === 0)
    const unsupported = await fetch(bridge.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token },
      body: JSON.stringify({ name: 'shell', arguments: { command: 'unsafe' } }) })
    check('bridge refuses undeclared tools', (await unsupported.json()).isError === true && boundaryCalls === 0)
    let last
    for (let i = 0; i < MAX_ANTIGRAVITY_WEB_CALLS; i++) {
      const response = await fetch(bridge.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token },
        body: JSON.stringify({ name: 'web_search', arguments: { query: 'fixture' } }) })
      last = await response.json()
    }
    check('last allowed web result tells the agent to finish',
      boundaryCalls === MAX_ANTIGRAVITY_WEB_CALLS && !last.isError && last.content[0].text.includes('budget is exhausted'))
    const overBudget = await fetch(bridge.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token },
      body: JSON.stringify({ name: 'web_search', arguments: { query: 'fixture' } }) })
    check('bridge does not execute calls past the engine budget',
      (await overBudget.json()).isError === true && boundaryCalls === MAX_ANTIGRAVITY_WEB_CALLS)
  } finally { await bridge.close() }

  let limitedCalls = 0
  const limitedBridge = await createWebBridge([WEB_SEARCH_TOOL], async (call) => {
    limitedCalls++
    return { toolCallId: call.id, name: call.name, content: 'Evidence.', isError: false, durationMs: 1 }
  }, undefined, 2)
  try {
    const invoke = async () => (await fetch(limitedBridge.endpoint, { method: 'POST',
      headers: { Authorization: 'Bearer ' + limitedBridge.token },
      body: JSON.stringify({ name: 'web_search', arguments: { query: 'fixture' } }) })).json()
    const first = await invoke()
    const last = await invoke()
    const refused = await invoke()
    check('every web result reports remaining budget and allows an early answer',
      !first.isError && first.content[0].text.includes('1 web-tool call remains') &&
      first.content[0].text.includes('Answer now if the evidence is sufficient'))
    check('the selected budget keeps the last result and stops further execution',
      !last.isError && last.content[0].text.startsWith('Evidence.') &&
      last.content[0].text.includes('budget is exhausted') && refused.isError && limitedCalls === 2)
  } finally { await limitedBridge.close() }

  const profile = createRestrictedProfile()
  try {
    validateRestrictedProfile(profile)
    fs.writeFileSync(profile.agent, 'name: default-agent')
    let changed = false
    try { validateRestrictedProfile(profile) } catch { changed = true }
    check('changed restricted agent fails preflight', changed)
    fs.unlinkSync(profile.agent)
    let missing = false
    try { validateRestrictedProfile(profile) } catch { missing = true }
    check('missing restricted agent fails preflight', missing)
  } finally { fs.rmSync(profile.root, { recursive: true, force: true }) }

  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.web.enabled = true
  settings.web.engine = 'openrouter'
  const thread = { config: { model: 'antigravity:gemini-test', webAccessEnabled: true,
    repoPaths: ['/should/not/be/read'] } }
  const context = assembleContext(thread, settings, 'antigravity')
  check('Antigravity uses app web tools even with OpenRouter web selected',
    context.tools.length === 2 && context.tools.every((t) => ['web_search', 'web_fetch'].includes(t.function.name)))
  check('attached repositories are excluded from Antigravity prompts',
    !context.segments.some((segment) => segment.source === 'repo'))
  for (const disabledPromptSegments of [['web'], ['tools']]) {
    const off = assembleContext({ config: { ...thread.config, disabledPromptSegments } }, settings, 'antigravity')
    check(`prompt toggles disable web: ${disabledPromptSegments}`, off.tools.length === 0)
  }

  // Drive the real provider with a simulated CLI. No sign-in or real model calls.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-pink-agy-bin-'))
  fs.writeFileSync(path.join(directory, process.platform === 'win32' ? 'agy.exe' : 'agy'), '', { mode: 0o755 })
  const oldPath = process.env.PATH
  const oldSpawn = childProcess.spawn
  process.env.PATH = directory
  try {
    for (const scenario of ['plain', 'images', 'web', 'shell', 'unrelated-mcp', 'unobserved-permission', 'bad-arguments', 'unsupported-version', 'abort']) {
      let root
      let launchArgs
      let prompt
      let clientCapabilities
      let selectedEffort
      let webCalls = 0
      let permissionReply
      const controller = new AbortController()
      childProcess.spawn = (_binary, args) => {
        launchArgs = args
        root = path.dirname(args[args.indexOf('--gemini-dir') + 1])
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        let closed = false
        const close = () => { if (!closed) { closed = true; child.emit('close', 0, null) } }
        child.kill = close
        const emit = (message) => { if (!closed) child.stdout.write(JSON.stringify(message) + '\n') }
        const notification = (update) => emit({ method: 'session/update', params: { sessionId: 'test-session', update } })
        let turnId
        const complete = () => {
          notification({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking.' } })
          notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Restricted response.' } })
          emit({ id: turnId, result: { stopReason: 'end_turn', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } } })
        }
        child.stdin = new Writable({ write(chunk, _encoding, done) {
          const message = JSON.parse(chunk.toString())
          queueMicrotask(() => {
            if (message.method === 'initialize') {
              clientCapabilities = message.params.clientCapabilities
              emit({ id: message.id, result: { protocolVersion: 1, agentInfo: { version: scenario === 'unsupported-version' ? '2.0.0' : '1.5.8' } } })
            } else if (message.method === 'session/new') {
              emit({ id: message.id, result: { sessionId: 'test-session' } })
            } else if (message.method === 'session/set_config_option') {
              if (message.params.configId === 'thought_level') selectedEffort = message.params.value
              emit({ id: message.id, result: { configOptions: [{ id: 'thought_level', currentValue: selectedEffort ?? 'medium',
                options: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, name: value })) }] } })
            } else if (message.method === 'session/prompt') {
              turnId = message.id
              prompt = message.params.prompt
              if (scenario === 'abort') { controller.abort(); return }
              if (scenario === 'unobserved-permission') {
                emit({ id: 901, method: 'session/request_permission', params: {
                  sessionId: 'test-session', toolCall: { toolCallId: 'unknown', rawInput: { query: 'test' } },
                  options: [{ kind: 'allow_once', optionId: 'once' }]
                } })
              } else if (scenario === 'unrelated-mcp') {
                notification({ sessionUpdate: 'tool_call', toolCallId: 'unsafe-call', name: 'mcp_personal_shell', rawInput: {} })
              } else if (scenario === 'bad-arguments') {
                notification({ sessionUpdate: 'tool_call', toolCallId: 'bad-call', name: 'mcp_deep_pink_web_web_search', rawInput: { query: 'test', command: 'unsafe' } })
              } else if (scenario === 'shell') {
                notification({ sessionUpdate: 'tool_call', toolCallId: 'unsafe-call', name: 'run_command', rawInput: { CommandLine: 'unsafe' } })
              } else if (scenario === 'web') {
                const call = { toolCallId: 'web-call', name: 'mcp_deep_pink_web_web_search', rawInput: { query: 'test', toolSummary: 'Search' } }
                notification({ sessionUpdate: 'tool_call', ...call })
                emit({ id: 900, method: 'session/request_permission', params: {
                  sessionId: 'test-session', toolCall: call,
                  options: [{ kind: 'allow_once', optionId: 'once' }]
                } })
              } else complete()
            } else if (message.id === 901) {
              permissionReply = message
              complete()
            } else if (message.id === 900) {
              permissionReply = message
              const config = JSON.parse(fs.readFileSync(path.join(root, 'web-bridge.json'), 'utf8'))
              void fetch(config.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + config.token },
                body: JSON.stringify({ name: 'web_search', arguments: { query: 'test', toolSummary: 'Search' } })
              }).then(() => complete()).catch((error) => emit({ id: turnId, error: { message: error.message } }))
            }
          })
          done()
        } })
        child.stdin.on('finish', close)
        return child
      }
      let result
      let error
      try {
        result = await streamAntigravityChat({
          model: 'antigravity:gemini-test', attribution: false, signal: controller.signal,
          includeReasoning: scenario !== 'plain',
          reasoning: { effort: 'max' },
          messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: scenario === 'images'
            ? [{ type: 'text', text: 'Describe this.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } }]
            : '/browser test' }],
          tools: scenario === 'web' ? [WEB_SEARCH_TOOL] : []
        }, { onDynamicToolCall: async (call) => {
          webCalls += 1
          return { toolCallId: call.id, name: call.name, content: 'Fixture result.', isError: false, durationMs: 1 }
        } })
      } catch (caught) { error = caught }
      const fails = ['shell', 'unrelated-mcp', 'bad-arguments', 'unsupported-version', 'abort'].includes(scenario)
      check(`transport outcome: ${scenario}`, fails ? Boolean(error) : result?.content === 'Restricted response.', { error: error?.message })
      check(`temporary state removed: ${scenario}`, root && !fs.existsSync(root))
      check(`client file and terminal tools disabled: ${scenario}`,
        clientCapabilities.terminal === false && clientCapabilities.fs.readTextFile === false && clientCapabilities.fs.writeTextFile === false)
      check(`isolated launch: ${scenario}`, launchArgs.includes('--include-default-customizations=false') &&
        launchArgs.includes('--agent') && !launchArgs.includes('--dangerously-skip-permissions'))
      if (scenario === 'plain') {
        check('transcript wrapping prevents slash-command expansion', prompt[0].text.startsWith('Conversation transcript'))
        check('reported token counts are retained', result.usage.totalTokens === 14)
        check('reasoning visibility preference is respected', result.reasoning === '')
        check('research guidance and hidden reasoning do not lower the selected effort', selectedEffort === 'xhigh')
      }
      if (scenario === 'images') check('image bytes are sent directly through ACP',
        prompt[1]?.type === 'image' && prompt[1]?.mimeType === 'image/png' && prompt[1]?.data === 'dGVzdA==')
      if (scenario === 'web') check('only the known web call is approved and executed',
        webCalls === 1 && permissionReply.result.outcome.optionId === 'once' && result.toolCallsHandled)
      else check(`no web tools executed: ${scenario}`, webCalls === 0)
      if (scenario === 'unobserved-permission') check('unobserved permission requests are cancelled', permissionReply.result.outcome.outcome === 'cancelled')
    }
  } finally {
    childProcess.spawn = oldSpawn
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
