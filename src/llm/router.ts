import type { CompressionLlmProvider } from '../executor/compression.js'
import type { ExecutorLlmProvider } from '../executor/step.js'
import type { IntakeLlmProvider } from '../intake/llm.js'
import type { PanelMemberLlmProvider } from '../panel/member.js'
import {
  DEFAULT_COMPRESSION_MODEL,
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_INTAKE_MODEL,
  DEFAULT_PANEL_MODEL,
  DEFAULT_VERIFIER_MODEL
} from './models.js'
import { AnthropicProvider } from './anthropic.js'
import { GeminiProvider } from './gemini.js'
import { NvidiaProvider } from './nvidia.js'
import { OpenRouterProvider } from './openrouter.js'

/**
 * Role-specific provider configuration for the Week 6 pipeline.
 */
export interface ProviderConfig {
  anthropicApiKey?: string
  geminiApiKey?: string
  openrouterApiKey?: string
  nvidiaApiKey?: string
  openrouterPath?: 'free' | 'paid'
  openrouterSiteUrl?: string
  openrouterSiteName?: string
  executorModel?: string
  verifierModel?: string
  intakeModel?: string
  panelModel?: string
  compressionModel?: string
}

/**
 * Provider bundle used by the pipeline to satisfy every Week 6 LLM role.
 */
export interface ProviderBundle {
  intakeProvider: IntakeLlmProvider
  panelProvider: PanelMemberLlmProvider
  executorProvider: ExecutorLlmProvider
  verifierProvider: IntakeLlmProvider | PanelMemberLlmProvider | ExecutorLlmProvider | CompressionLlmProvider
  compressionProvider: CompressionLlmProvider
}

type ProviderWithDefaultModel<T> = T & {
  getDefaultModel(): string
}

interface ResolvedProviderConfig {
  anthropicApiKey?: string
  geminiApiKey?: string
  openrouterApiKey?: string
  nvidiaApiKey?: string
  openrouterPath: 'free' | 'paid'
  openrouterSiteUrl?: string
  openrouterSiteName?: string
  executorModel: string
  verifierModel: string
  intakeModel: string
  panelModel: string
  compressionModel: string
}

const DEFAULT_PROVIDER_CONFIG = {
  openrouterPath: 'paid',
  executorModel: DEFAULT_EXECUTOR_MODEL,
  verifierModel: DEFAULT_VERIFIER_MODEL,
  intakeModel: DEFAULT_INTAKE_MODEL,
  panelModel: DEFAULT_PANEL_MODEL,
  compressionModel: DEFAULT_COMPRESSION_MODEL
} as const

/**
 * Creates the concrete providers used by the top-level pipeline.
 *
 * Executor and verifier must come from different provider families. This is a
 * hard architectural invariant and is enforced before any work begins.
 */
export function createProviders(config: ProviderConfig): ProviderBundle {
  const resolvedConfig: ResolvedProviderConfig = {
    ...DEFAULT_PROVIDER_CONFIG,
    ...config
  }

  const executorFamily = getModelFamily(resolvedConfig.executorModel)
  const verifierFamily = getModelFamily(resolvedConfig.verifierModel)

  if (executorFamily === verifierFamily) {
    throw new Error(
      `Executor and verifier models must use different provider families. Received executor=${resolvedConfig.executorModel} and verifier=${resolvedConfig.verifierModel}.`
    )
  }

  const anthropicProvider = new AnthropicProvider(resolvedConfig.anthropicApiKey)
  const geminiProvider = new GeminiProvider(resolvedConfig.geminiApiKey)
  const nvidiaProvider = new NvidiaProvider(resolvedConfig.nvidiaApiKey)
  const openrouterProvider = resolvedConfig.openrouterApiKey === undefined
    ? null
    : new OpenRouterProvider({
      apiKey: resolvedConfig.openrouterApiKey,
      path: resolvedConfig.openrouterPath,
      modelId: resolvedConfig.executorModel,
      siteUrl: resolvedConfig.openrouterSiteUrl,
      siteName: resolvedConfig.openrouterSiteName
    })

  const intakeProvider = withDefaultModel(selectProvider(
    resolvedConfig.intakeModel,
    resolvedConfig,
    anthropicProvider,
    geminiProvider,
    nvidiaProvider,
    openrouterProvider
  ), resolvedConfig.intakeModel)
  const panelProvider = withDefaultModel(selectProvider(
    resolvedConfig.panelModel,
    resolvedConfig,
    anthropicProvider,
    geminiProvider,
    nvidiaProvider,
    openrouterProvider
  ), resolvedConfig.panelModel)
  const executorProvider = withDefaultModel(selectProvider(
    resolvedConfig.executorModel,
    resolvedConfig,
    anthropicProvider,
    geminiProvider,
    nvidiaProvider,
    openrouterProvider
  ), resolvedConfig.executorModel)
  const verifierProvider = withDefaultModel(selectProvider(
    resolvedConfig.verifierModel,
    resolvedConfig,
    anthropicProvider,
    geminiProvider,
    nvidiaProvider,
    openrouterProvider
  ), resolvedConfig.verifierModel)
  const compressionProvider = withDefaultModel(selectProvider(
    resolvedConfig.compressionModel,
    resolvedConfig,
    anthropicProvider,
    geminiProvider,
    nvidiaProvider,
    openrouterProvider
  ), resolvedConfig.compressionModel)

  return {
    intakeProvider,
    panelProvider,
    executorProvider,
    verifierProvider,
    compressionProvider
  }
}

function withDefaultModel<T extends object>(provider: T, model: string): ProviderWithDefaultModel<T> {
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === 'getDefaultModel') {
        return () => model
      }

      return Reflect.get(target, property, receiver)
    }
  }) as ProviderWithDefaultModel<T>
}

function selectProvider(
  modelId: string,
  config: ResolvedProviderConfig,
  anthropicProvider: AnthropicProvider,
  geminiProvider: GeminiProvider,
  nvidiaProvider: NvidiaProvider,
  openrouterProvider: OpenRouterProvider | null
): IntakeLlmProvider & PanelMemberLlmProvider & ExecutorLlmProvider & CompressionLlmProvider {
  const providerType = selectProviderType(modelId, config)

  if (providerType === 'gemini') {
    return geminiProvider
  }

  if (providerType === 'anthropic') {
    return anthropicProvider
  }

  if (providerType === 'nvidia') {
    return nvidiaProvider
  }

  if (openrouterProvider === null) {
    throw new Error(`Model ${modelId} requires OpenRouterProvider but no OPENROUTER_API_KEY was configured.`)
  }

  return openrouterProvider
}

/**
 * Returns the underlying model family used for cross-family enforcement.
 */
export function getModelFamily(modelId: string): string {
  const base = modelId.replace(/:free$/, '')

  if (isNvidiaModel(base)) {
    return 'nvidia'
  }

  if (base.includes('/')) {
    return base.split('/')[0] ?? 'unknown'
  }

  if (base.startsWith('claude-')) {
    return 'anthropic'
  }

  if (base.startsWith('gemini-') || base.startsWith('gemma-')) {
    return 'google'
  }

  if (base.startsWith('gpt-') || base.startsWith('o1-') || base.startsWith('o3-')) {
    return 'openai'
  }

  return 'unknown'
}

/**
 * Selects which concrete provider should serve a given model ID.
 */
export function selectProviderType(modelId: string, config: ProviderConfig): 'openrouter' | 'gemini' | 'anthropic' | 'nvidia' {
  const base = modelId.replace(/:free$/, '')

  if (isNvidiaModel(base) && config.nvidiaApiKey !== undefined) {
    return 'nvidia'
  }

  if (base.includes('/') && config.openrouterApiKey !== undefined) {
    return 'openrouter'
  }

  if (base.startsWith('gemini-') || base.startsWith('gemma-')) {
    return 'gemini'
  }

  if (base.startsWith('claude-')) {
    return 'anthropic'
  }

  if (config.openrouterApiKey !== undefined) {
    return 'openrouter'
  }

  throw new Error(`Cannot determine provider for model: ${modelId}. Check your API key configuration.`)
}

function isNvidiaModel(modelId: string): boolean {
  return modelId.startsWith('minimaxai/') || modelId.startsWith('z-ai/')
}
