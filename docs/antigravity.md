# Antigravity provider

Deep Pink can use Gemini through the locally installed Antigravity CLI and its cached Google sign-in. This is an experimental provider, disabled by default. It does not require an OpenRouter API key.

1. Install Antigravity CLI and sign in by running `agy` in a terminal.
2. Show experimental features in Deep Pink, then open Settings → Antigravity.
3. Enable the provider and refresh the model picker. Select a model labeled Antigravity.

The current integration accepts CLI 1.5.8 and later patches in the 1.5 series. Unknown series are rejected because the tool restrictions have not been verified for them. A newer series needs validation and an integration update before it is accepted. Deep Pink discovers Gemini models and thinking levels from ACP session options; unsupported third-party models are not advertised.

## Request behavior

The Electron main process launches `agy acp` and communicates over standard input/output using ACP JSON-RPC version 1. A fresh, private temporary directory contains the workspace, CLI configuration, logs, and restricted custom agent. Antigravity reuses its cached credentials without Deep Pink copying credentials into this directory.

Each request supplies the Deep Pink conversation as a transcript, passes system instructions through Antigravity's custom system-instruction support, and sends image attachments as ACP image content. Transcript wrapping prevents a user message beginning with a slash command from becoming a CLI command. Model choice and reasoning effort use ACP session options. Responses, reasoning, context-window information and reported token counts are translated into Deep Pink events.

The provider does not offer temperature or maximum-output-token controls. Antigravity manages them. It does not report a monetary cost, so Deep Pink omits the per-reply cost chip for this provider. A zero in stored usage is not a claim that the subscription is free.

## Restrictions

The generated agent declares `tools: []`, disables subagent selection, and opts out of default components. File, command and browser-interaction permissions are explicitly denied. The ACP client advertises no file or terminal capabilities. Personal MCP servers, hooks, plugins, instructions and repository customizations are not imported into the temporary workspace/profile.

The app validates the exact generated agent and restriction settings before starting a session. This is necessary because Antigravity can accept a missing custom-agent name without returning an error. Unknown ACP client capabilities and permission requests are rejected. Unexpected model tool calls stop the session. Antigravity can retain internal task-management declarations; Deep Pink does not permit these calls.

These controls remove model capabilities. They are distinct from Codex's operating-system read-only/no-network sandbox policy: the Antigravity runtime still needs to read its configuration and credentials, contact its model service, open localhost sockets, and write its own temporary runtime files.

## Optional web access

When Web access is off, the profile contains no MCP servers and no web tools. Disabling the web or tool prompt segment also removes web access.

When Web access is on, Deep Pink creates a private stdio MCP helper with only `web_search` and `web_fetch`, using its own Node runtime. Definitions are loaded eagerly, so the model does not need a file-reading tool to inspect their schemas. The helper forwards calls to a temporary loopback endpoint authenticated with a random per-request token. The app checks tool names and arguments, rejects browser origins, caps request sizes and tool calls, and executes only the chat engine's guarded web functions. Page fetches retain Deep Pink's public-URL restrictions and domain blocklist.

Only matching web-tool permission requests can receive an `allow_once` response. No general command, file, browser or personal MCP permission is granted. Native Antigravity search/page tools are not used.

## Cleanup and validation

Cancellation stops the ACP process and its helpers. Normal completion also stops them before deleting the temporary profile, including Antigravity conversation databases and logs. App shutdown waits for active Antigravity sessions to clean up. As with other temporary files, an operating-system crash or forced kill can leave a directory under the system temporary folder.

Regression checks in `test/antigravity.test.js` cover model namespaces, profile validation, version checks, prompt boundaries, web-tool approval, forbidden tool calls, cancellation and cleanup. The repository's Electron suites are intended to run in the cloud.

References: [Antigravity ACP](https://antigravity.google/docs/ide/extensions/acp/), [custom-agent tool restrictions](https://github.com/google-antigravity/antigravity-cli/issues/1080), [eager MCP tools](https://antigravity.google/docs/mcp/).
