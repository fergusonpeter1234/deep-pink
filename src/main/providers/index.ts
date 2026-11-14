import { providerForModel } from '@shared/modelProviders'
import type { ChatModel, ProviderStatus } from '@shared/types'
import { loadSettings } from '../settings'
import * as codex from './codex'
import * as antigravity from './antigravity'
import {
  complete as completeOpenRouter,
  knownModel as knownOpenRouterModel,
  listModels as listOpenRouterModels,
  streamChat as streamOpenRouterChat
} from './openrouter'
import type { ChatRequest, StreamHandlers, StreamResult } from './types'

/** The catalog is composed here; each provider owns its discovery and transport. */
export async function listModels(force = false): Promise<ChatModel[]> {
  const settings = loadSettings()
  const [openrouter, codexModels, antigravityModels] = await Promise.allSettled([
    listOpenRouterModels(force),
    settings.codex.enabled ? codex.listModels(force) : Promise.resolve([]),
    settings.antigravity.enabled ? antigravity.listModels(force) : Promise.resolve([])
  ])

  const models: ChatModel[] = []
  if (openrouter.status === 'fulfilled') {
    models.push(...openrouter.value.map((model) => ({ ...model, provider: 'openrouter' as const })))
  }
  if (codexModels.status === 'fulfilled') models.push(...codexModels.value)
  if (antigravityModels.status === 'fulfilled') models.push(...antigravityModels.value)

  if (models.length) return models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
  const errors = [openrouter, codexModels, antigravityModels]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))
  throw new Error(errors.join('\n'))
}

export function knownModel(id: string): ChatModel | null {
  if (providerForModel(id) === 'antigravity') {
    return loadSettings().antigravity.enabled ? antigravity.knownModel(id) : null
  }
  if (providerForModel(id) === 'codex') {
    return loadSettings().codex.enabled ? codex.knownModel(id) : null
  }
  const model = knownOpenRouterModel(id)
  return model ? { ...model, provider: 'openrouter' } : null
}

export function providerStatus(): ProviderStatus {
  const settings = loadSettings()
  return {
    codex: { ...codex.status(), enabled: settings.codex.enabled },
    antigravity: { ...antigravity.status(), enabled: settings.antigravity.enabled }
  }
}

export function contextLimitFor(model: string): number | null {
  if (providerForModel(model) === 'antigravity') {
    return loadSettings().antigravity.enabled ? antigravity.contextLimitFor(model) : null
  }
  if (providerForModel(model) === 'codex') {
    return loadSettings().codex.enabled ? codex.contextLimitFor(model) : null
  }
  return knownOpenRouterModel(model)?.contextLength ?? null
}

export async function streamChat(
  request: ChatRequest,
  handlers: StreamHandlers = {}
): Promise<StreamResult> {
  if (providerForModel(request.model) === 'antigravity') {
    if (!loadSettings().antigravity.enabled) throw new Error('The Antigravity provider is disabled. Enable it in Settings › Antigravity.')
    return antigravity.streamChat(request, handlers)
  }
  if (providerForModel(request.model) !== 'codex') return streamOpenRouterChat(request, handlers)
  if (!loadSettings().codex.enabled) {
    throw new Error(
      'The Codex provider is disabled. Enable it in Settings › Codex to use Codex models.'
    )
  }
  return codex.streamChat(request, handlers)
}

export async function complete(request: Omit<ChatRequest, 'tools'>): Promise<StreamResult> {
  if (providerForModel(request.model) === 'antigravity') {
    if (!loadSettings().antigravity.enabled) throw new Error('The Antigravity provider is disabled. Enable it in Settings › Antigravity.')
    return antigravity.complete(request)
  }
  if (providerForModel(request.model) !== 'codex') return completeOpenRouter(request)
  if (!loadSettings().codex.enabled) {
    throw new Error(
      'The Codex provider is disabled. Enable it in Settings › Codex to use Codex models.'
    )
  }
  return codex.complete(request)
}

export { OpenRouterError } from './openrouter'
export type { ChatMessageParam, Citation, ContentPart, StreamResult, ToolParam } from './types'
