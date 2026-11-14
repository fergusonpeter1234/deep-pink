import type { ChatModel } from './types'

export type ChatProvider = ChatModel['provider']

const CODEX_PREFIX = 'codex:'
const ANTIGRAVITY_PREFIX = 'antigravity:'

/** OpenRouter model ids are kept as-is for existing settings and thread data. */
export function providerForModel(model: string | null | undefined): ChatProvider {
  if (model?.startsWith(CODEX_PREFIX)) return 'codex'
  if (model?.startsWith(ANTIGRAVITY_PREFIX)) return 'antigravity'
  return 'openrouter'
}

/** The id stored in settings and threads is namespaced to avoid provider collisions. */
export function modelIdForProvider(provider: ChatProvider, id: string): string {
  return provider === 'openrouter' ? id : `${provider}:${id}`
}

export function providerModelId(model: string): string {
  const provider = providerForModel(model)
  return provider === 'openrouter' ? model : model.slice(provider.length + 1)
}
