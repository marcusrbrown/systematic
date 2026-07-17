/** Real Pi session-construction for `systematic_delegate`. `noExtensions: true` is the structural depth-1 boundary preventing the child from re-registering `systematic_delegate` or any project/user extension. */
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent'

/** `DefaultResourceLoaderOptions` is not exported by the package, so it's derived from the constructor's parameter type. */
type DefaultResourceLoaderOptions = ConstructorParameters<
  typeof DefaultResourceLoader
>[0]

import type {
  CreateDelegateSession,
  DelegateSessionLike,
} from './pi-delegate-tool.js'
import { DELEGATE_TOOL_NAME } from './pi-delegate-tool.js'

export interface PiDelegateSessionRuntime {
  getAgentDir: () => string
  createResourceLoader: (
    options: DefaultResourceLoaderOptions,
  ) => ResourceLoader & { reload: () => Promise<void> }
  createInMemorySessionManager: (
    cwd: string,
  ) => ReturnType<typeof SessionManager.inMemory>
  createAgentSession: (
    options: CreateAgentSessionOptions,
  ) => Promise<CreateAgentSessionResult>
}

export const REAL_PI_DELEGATE_SESSION_RUNTIME: PiDelegateSessionRuntime = {
  getAgentDir,
  createResourceLoader: (options) => new DefaultResourceLoader(options),
  createInMemorySessionManager: (cwd) => SessionManager.inMemory(cwd),
  createAgentSession,
}

export function buildDelegateResourceLoaderOptions(options: {
  cwd: string
  agentDir: string
  systemPromptOverride: string
}): DefaultResourceLoaderOptions {
  const { cwd, agentDir, systemPromptOverride } = options
  return {
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPromptOverride,
    appendSystemPromptOverride: () => [],
  }
}

export function buildDelegateAgentSessionOptions(options: {
  cwd: string
  agentDir: string
  model: CreateAgentSessionOptions['model']
  allowedToolNames: string[]
  resourceLoader: ResourceLoader
  sessionManager: ReturnType<typeof SessionManager.inMemory>
}): CreateAgentSessionOptions {
  const {
    cwd,
    agentDir,
    model,
    allowedToolNames,
    resourceLoader,
    sessionManager,
  } = options
  return {
    cwd,
    agentDir,
    model,
    tools: allowedToolNames,
    customTools: [],
    resourceLoader,
    sessionManager,
  }
}

export function createDelegateSessionWith(
  runtime: PiDelegateSessionRuntime,
): CreateDelegateSession {
  return async (options): Promise<DelegateSessionLike> => {
    const { model, cwd, systemPromptOverride, allowedToolNames } = options

    if (allowedToolNames.includes(DELEGATE_TOOL_NAME)) {
      throw new Error(
        `Refusing to construct delegate child session: allowedToolNames included ${DELEGATE_TOOL_NAME} (fail-closed re-entry guard).`,
      )
    }

    const agentDir = runtime.getAgentDir()

    const resourceLoader = runtime.createResourceLoader(
      buildDelegateResourceLoaderOptions({
        cwd,
        agentDir,
        systemPromptOverride,
      }),
    )

    await resourceLoader.reload()

    const sessionManager = runtime.createInMemorySessionManager(cwd)

    const { session } = await runtime.createAgentSession(
      buildDelegateAgentSessionOptions({
        cwd,
        agentDir,
        model,
        allowedToolNames,
        resourceLoader,
        sessionManager,
      }),
    )

    return session
  }
}

export const createRealPiDelegateSession: CreateDelegateSession =
  createDelegateSessionWith(REAL_PI_DELEGATE_SESSION_RUNTIME)
