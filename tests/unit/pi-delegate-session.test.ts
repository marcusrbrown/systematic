import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
} from '@earendil-works/pi-coding-agent'
import { buildAgentCatalog } from '../../src/lib/agent-resolver.js'
import {
  buildDelegateAgentSessionOptions,
  buildDelegateResourceLoaderOptions,
  createDelegateSessionWith,
  type PiDelegateSessionRuntime,
} from '../../src/lib/pi-delegate-session.js'
import { DELEGATE_TOOL_NAME } from '../../src/lib/pi-delegate-tool.js'

function makeTempAgentsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pi-delegate-session-recursion-test-'),
  )
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

describe('buildDelegateResourceLoaderOptions', () => {
  test('requests depth-1 structural isolation, parent cwd, and an authoritative override system prompt', () => {
    const options = buildDelegateResourceLoaderOptions({
      cwd: '/parent/cwd',
      agentDir: '/agent/dir',
      systemPromptOverride: 'Persona body text.',
    })

    expect(options.cwd).toBe('/parent/cwd')
    expect(options.agentDir).toBe('/agent/dir')
    expect(options.noExtensions).toBe(true)
    expect(options.noSkills).toBe(true)
    expect(options.noPromptTemplates).toBe(true)
    expect(options.noThemes).toBe(true)
    expect(options.noContextFiles).toBe(true)
    expect(options.systemPromptOverride?.(undefined)).toBe('Persona body text.')
    expect(options.systemPromptOverride?.('anything else')).toBe(
      'Persona body text.',
    )
    expect(options.appendSystemPromptOverride?.(['leaked context'])).toEqual([])
  })
})

describe('buildDelegateAgentSessionOptions', () => {
  test('requests parent model/cwd, exact mapped tools, empty customTools, and the given loader/session manager', () => {
    const model = { provider: 'anthropic', id: 'claude' }
    const resourceLoader = { marker: 'resource-loader' } as never
    const sessionManager = { marker: 'session-manager' } as never

    const options = buildDelegateAgentSessionOptions({
      cwd: '/parent/cwd',
      agentDir: '/agent/dir',
      model: model as CreateAgentSessionOptions['model'],
      allowedToolNames: ['read', 'grep'],
      resourceLoader,
      sessionManager,
    })

    expect(options.cwd).toBe('/parent/cwd')
    expect(options.agentDir).toBe('/agent/dir')
    expect(options.model).toBe(model)
    expect(options.tools).toEqual(['read', 'grep'])
    expect(options.customTools).toEqual([])
    expect(options.resourceLoader).toBe(resourceLoader)
    expect(options.sessionManager).toBe(sessionManager)
  })

  test('includes thinkingLevel when given', () => {
    const options = buildDelegateAgentSessionOptions({
      cwd: '/parent/cwd',
      agentDir: '/agent/dir',
      model: { provider: 'p', id: 'm' } as CreateAgentSessionOptions['model'],
      thinkingLevel: 'high',
      allowedToolNames: ['read'],
      resourceLoader: {} as never,
      sessionManager: {} as never,
    })

    expect(options.thinkingLevel).toBe('high')
  })

  test('omits the thinkingLevel key entirely when not given (child inherits Pi default)', () => {
    const options = buildDelegateAgentSessionOptions({
      cwd: '/parent/cwd',
      agentDir: '/agent/dir',
      model: { provider: 'p', id: 'm' } as CreateAgentSessionOptions['model'],
      allowedToolNames: ['read'],
      resourceLoader: {} as never,
      sessionManager: {} as never,
    })

    expect(Object.hasOwn(options, 'thinkingLevel')).toBe(false)
  })
})

function createFakeRuntime(): {
  runtime: PiDelegateSessionRuntime
  calls: {
    getAgentDirCalls: number
    createResourceLoaderArgs: unknown[]
    reloadCalls: number
    createInMemorySessionManagerArgs: unknown[]
    createAgentSessionArgs: unknown[]
    callOrder: string[]
  }
} {
  const calls = {
    getAgentDirCalls: 0,
    createResourceLoaderArgs: [] as unknown[],
    reloadCalls: 0,
    createInMemorySessionManagerArgs: [] as unknown[],
    createAgentSessionArgs: [] as unknown[],
    callOrder: [] as string[],
  }

  const runtime: PiDelegateSessionRuntime = {
    getAgentDir: () => {
      calls.getAgentDirCalls += 1
      return '/fake/agent-dir'
    },
    createResourceLoader: (options) => {
      calls.createResourceLoaderArgs.push(options)
      return {
        getExtensions: () =>
          ({ extensions: [], errors: [], runtime: {} }) as never,
        getSkills: () => ({ skills: [], diagnostics: [] }) as never,
        getPrompts: () => ({ prompts: [], diagnostics: [] }) as never,
        getThemes: () => ({ themes: [], diagnostics: [] }) as never,
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => undefined,
        getAppendSystemPrompt: () => [],
        extendResources: () => {},
        reload: async () => {
          calls.reloadCalls += 1
          calls.callOrder.push('reload')
        },
      } as never
    },
    createInMemorySessionManager: (cwd) => {
      calls.createInMemorySessionManagerArgs.push(cwd)
      return { marker: 'in-memory-session-manager', cwd } as never
    },
    createAgentSession: async (options) => {
      calls.createAgentSessionArgs.push(options)
      calls.callOrder.push('createAgentSession')
      return {
        session: { marker: 'fake-session' },
        extensionsResult: { extensions: [], errors: [] },
      } as unknown as CreateAgentSessionResult
    },
  }

  return { runtime, calls }
}

describe('createDelegateSessionWith: live adapter contract, no provider required', () => {
  test('requests parent cwd/model, structural depth-1 loader flags, authoritative prompt, in-memory session manager, exact tools, and calls reload() before createAgentSession', async () => {
    const { runtime, calls } = createFakeRuntime()
    const createSession = createDelegateSessionWith(runtime)

    const model = { provider: 'anthropic', id: 'claude' }
    const session = await createSession({
      agentName: 'git-analyzer',
      model: model as CreateAgentSessionOptions['model'],
      cwd: '/parent/cwd',
      systemPromptOverride: 'Persona body.',
      allowedToolNames: ['read', 'grep'],
    })

    expect(session).toEqual({ marker: 'fake-session' } as never)
    expect(calls.getAgentDirCalls).toBe(1)

    expect(calls.createResourceLoaderArgs).toHaveLength(1)
    const loaderOptions = calls.createResourceLoaderArgs[0] as ReturnType<
      typeof buildDelegateResourceLoaderOptions
    >
    expect(loaderOptions.cwd).toBe('/parent/cwd')
    expect(loaderOptions.agentDir).toBe('/fake/agent-dir')
    expect(loaderOptions.noExtensions).toBe(true)
    expect(loaderOptions.noSkills).toBe(true)
    expect(loaderOptions.noPromptTemplates).toBe(true)
    expect(loaderOptions.noThemes).toBe(true)
    expect(loaderOptions.noContextFiles).toBe(true)
    expect(loaderOptions.systemPromptOverride?.(undefined)).toBe(
      'Persona body.',
    )
    expect(loaderOptions.appendSystemPromptOverride?.(['x'])).toEqual([])

    expect(calls.reloadCalls).toBe(1)
    expect(calls.createInMemorySessionManagerArgs).toEqual(['/parent/cwd'])

    expect(calls.createAgentSessionArgs).toHaveLength(1)
    const sessionOptions = calls
      .createAgentSessionArgs[0] as CreateAgentSessionOptions
    expect(sessionOptions.cwd).toBe('/parent/cwd')
    expect(sessionOptions.agentDir).toBe('/fake/agent-dir')
    expect(sessionOptions.model).toBe(model)
    expect(sessionOptions.tools).toEqual(['read', 'grep'])
    expect(sessionOptions.customTools).toEqual([])
    expect(sessionOptions.sessionManager).toEqual({
      marker: 'in-memory-session-manager',
      cwd: '/parent/cwd',
    } as never)

    // reload() must be called before createAgentSession() is invoked.
    expect(calls.callOrder).toEqual(['reload', 'createAgentSession'])
  })

  test('threads thinkingLevel through to the created session options when given, and omits it when not', async () => {
    const { runtime, calls } = createFakeRuntime()
    const createSession = createDelegateSessionWith(runtime)

    await createSession({
      agentName: 'git-analyzer',
      model: { provider: 'p', id: 'm' } as CreateAgentSessionOptions['model'],
      thinkingLevel: 'high',
      cwd: '/parent/cwd',
      systemPromptOverride: 'Persona body.',
      allowedToolNames: ['read'],
    })

    const withThinking = calls
      .createAgentSessionArgs[0] as CreateAgentSessionOptions
    expect(withThinking.thinkingLevel).toBe('high')

    const { runtime: runtime2, calls: calls2 } = createFakeRuntime()
    const createSession2 = createDelegateSessionWith(runtime2)
    await createSession2({
      agentName: 'git-analyzer',
      model: { provider: 'p', id: 'm' } as CreateAgentSessionOptions['model'],
      cwd: '/parent/cwd',
      systemPromptOverride: 'Persona body.',
      allowedToolNames: ['read'],
    })

    const withoutThinking = calls2
      .createAgentSessionArgs[0] as CreateAgentSessionOptions
    expect(Object.hasOwn(withoutThinking, 'thinkingLevel')).toBe(false)
  })

  test('fails closed and never constructs a resource loader when allowedToolNames includes the delegate tool', async () => {
    const { runtime, calls } = createFakeRuntime()
    const createSession = createDelegateSessionWith(runtime)

    await expect(
      createSession({
        agentName: 'malicious',
        model: { provider: 'p', id: 'm' } as CreateAgentSessionOptions['model'],
        cwd: '/cwd',
        systemPromptOverride: 'x',
        allowedToolNames: ['read', DELEGATE_TOOL_NAME],
      }),
    ).rejects.toThrow(/fail-closed re-entry guard/)

    expect(calls.getAgentDirCalls).toBe(0)
    expect(calls.createResourceLoaderArgs).toHaveLength(0)
    expect(calls.createAgentSessionArgs).toHaveLength(0)
  })
})

/**
 * Boundary characterization: systematic_delegate child-session cannot resolve
 * extensions or re-enter systematic_delegate.
 *
 * Pre-assertion evidence (observed current behavior from tests above):
 *
 *   • buildDelegateResourceLoaderOptions (lines 14-35) — options include
 *     noExtensions: true, noSkills: true, noPromptTemplates: true,
 *     noThemes: true, noContextFiles: true; systemPromptOverride always
 *     returns the persona body; appendSystemPromptOverride always returns [].
 *
 *   • createDelegateSessionWith happy-path (lines 123-173) — the runtime's
 *     createResourceLoader is called with loaderOptions.noExtensions === true;
 *     fake runtime returns getExtensions() → { extensions: [], errors: [] }
 *     (consistent with what Pi's DefaultResourceLoader does under noExtensions: true).
 *
 *   • createDelegateSessionWith re-entry guard (lines 175-192) — throws
 *     /fail-closed re-entry guard/ before any getAgentDir/createResourceLoader/
 *     createAgentSession call when DELEGATE_TOOL_NAME is in allowedToolNames.
 *
 * Two-layer depth-1 boundary:
 *   Layer 1 (structural)   — noExtensions: true prevents Pi's DefaultResourceLoader
 *     from discovering any extensions; systematic_delegate (registered by Systematic's
 *     Pi extension) is never re-installed in the child session.
 *   Layer 2 (tool-allowlist) — explicit throw before resource loader construction
 *     if DELEGATE_TOOL_NAME appears in allowedToolNames; defense-in-depth.
 *
 * SCOPE STATEMENT (R12 / plan §Unit 3):
 *   These two layers bound systematic_delegate's OWN recursion.
 *   They do NOT bound global end-to-end delegation depth when pi-subagents
 *   or other third-party delegation engines create their own child sessions.
 *   Those paths are governed by their own limits/config and are outside
 *   Systematic's bounded-delegate guarantees.
 *   See also: tests/integration/pi.test.ts — combined-path bounded execution.
 *
 * REACHABILITY NOTE: Layer 2 below (the `createDelegateSessionWith` throw on
 * `DELEGATE_TOOL_NAME` in `allowedToolNames`) is defense-in-depth for a
 * hypothetical caller that bypasses tool-allowlist resolution entirely. For
 * an actual persona whose frontmatter declares `systematic_delegate` as one
 * of its own tools (the literal shape of a direct recursive delegation
 * attempt), the guard that ACTUALLY fires first is
 * `resolveToolAllowlist`'s "Unknown declared tool" fail-closed rejection in
 * `src/lib/agent-resolver.ts` — reached at catalog-build time via
 * `buildAgentCatalog`, well before `createDelegateSessionWith` is ever
 * called. See the "direct recursive delegation attempt" test at the end of
 * this describe block below.
 */
describe('systematic_delegate child-session boundary: noExtensions + re-entry guard (R12)', () => {
  test('Layer 1 — structural: child resource loader receives noExtensions: true, preventing extension registration in the child session', async () => {
    // Characterization: createDelegateSessionWith passes noExtensions: true
    // to the runtime's createResourceLoader. In the real Pi runtime, Pi's
    // DefaultResourceLoader respects this flag and skips extension discovery
    // entirely, returning { extensions: [], errors: [] } from getExtensions().
    // The fake runtime below returns the same shape (lines ~90-93), which is
    // the expected consequence of noExtensions: true — the child session sees
    // no extensions, so systematic_delegate is never re-registered.
    const { runtime, calls } = createFakeRuntime()
    const createSession = createDelegateSessionWith(runtime)

    await createSession({
      agentName: 'any-persona',
      model: {
        provider: 'anthropic',
        id: 'claude',
      } as CreateAgentSessionOptions['model'],
      cwd: '/parent/cwd',
      systemPromptOverride: 'Persona body.',
      allowedToolNames: ['read'],
    })

    expect(calls.createResourceLoaderArgs).toHaveLength(1)
    const loaderOptions = calls.createResourceLoaderArgs[0] as ReturnType<
      typeof buildDelegateResourceLoaderOptions
    >

    // Named boundary assertion — Layer 1 (structural guard):
    // noExtensions: true is the primary barrier. Pi's DefaultResourceLoader
    // will not discover or load ANY extension — Systematic's Pi extension
    // (and thus systematic_delegate) cannot be re-registered in the child.
    expect(loaderOptions.noExtensions).toBe(true)

    // Full structural isolation profile (corroborating flags):
    expect(loaderOptions.noSkills).toBe(true)
    expect(loaderOptions.noPromptTemplates).toBe(true)
    expect(loaderOptions.noThemes).toBe(true)
    expect(loaderOptions.noContextFiles).toBe(true)

    // Authoritative persona prompt replaces the parent system prompt.
    expect(loaderOptions.systemPromptOverride?.(undefined)).toBe(
      'Persona body.',
    )
    // No leaked context from the parent system prompt.
    expect(
      loaderOptions.appendSystemPromptOverride?.(['leaked context']),
    ).toEqual([])

    // Scope: this bounds systematic_delegate's child — NOT a global
    // end-to-end depth bound. External delegation engines (pi-subagents
    // etc.) spawn their own sessions outside this boundary entirely.
  })

  test('Layer 2 — tool-allowlist: fail-closed re-entry guard fires before any resource-loader construction when DELEGATE_TOOL_NAME is in allowedToolNames', async () => {
    // Characterization: the explicit allowedToolNames check in
    // createDelegateSessionWith (src/lib/pi-delegate-session.ts lines 97-101)
    // fires synchronously before getAgentDir(), createResourceLoader(), or
    // createAgentSession() are called. This is defense-in-depth: even if
    // noExtensions somehow failed to prevent systematic_delegate registration,
    // the explicit check prevents it from appearing in the child's tool allowlist.
    //
    // Evidence from lines 175-192 above confirms the same guard. This test
    // re-pins it as a named boundary assertion in the boundary characterization
    // describe block, with an explicit scope comment.
    const { runtime, calls } = createFakeRuntime()
    const createSession = createDelegateSessionWith(runtime)

    await expect(
      createSession({
        agentName: 'any-persona',
        model: {
          provider: 'p',
          id: 'm',
        } as CreateAgentSessionOptions['model'],
        cwd: '/cwd',
        systemPromptOverride: 'body',
        // Including DELEGATE_TOOL_NAME triggers the fail-closed guard.
        allowedToolNames: ['read', DELEGATE_TOOL_NAME],
      }),
    ).rejects.toThrow(/fail-closed re-entry guard/)

    // Guard fires before any runtime I/O — nothing was constructed.
    expect(calls.getAgentDirCalls).toBe(0)
    expect(calls.createResourceLoaderArgs).toHaveLength(0)
    expect(calls.createAgentSessionArgs).toHaveLength(0)

    // Scope: this re-entry guard is for systematic_delegate's OWN recursion.
    // It is NOT a global depth bound. pi-subagents and other external delegation
    // engines bypass this entirely — they do not call createDelegateSessionWith.
  })

  /**
   * Direct recursive delegation characterization (R12): a persona whose
   * frontmatter declares `systematic_delegate` as one of its own tools —
   * the literal shape of a "call systematic_delegate again from inside a
   * delegated persona" attempt — is caught at catalog-build time via
   * `buildAgentCatalog`, NOT at Layer 2's `createDelegateSessionWith`
   * re-entry guard above.
   *
   * `systematic_delegate` (the Pi tool name) is absent from
   * `OPENCODE_TO_PI_TOOL` in `src/lib/agent-resolver.ts` and is not the
   * specially-denylisted `Task` (the OpenCode tool name) either, so
   * `resolveToolAllowlist` throws its generic "Unknown declared tool"
   * fail-closed error — the same code path any unknown/typo'd tool name
   * hits. `buildAgentCatalog` calls `resolveToolAllowlist(entry.toolsSource)`
   * for every persona file at catalog-build time, long before any delegate
   * tool call ever executes — so this is the ACTUAL, reachable guard for a
   * real declared-tool recursion attempt. `pi-delegate-tool.ts`'s
   * `validateDelegateRequest` also calls `resolveToolAllowlist` (as a
   * second, redundant check against the same already-validated catalog
   * entries), and Layer 2's `createDelegateSessionWith` re-entry guard is
   * defense-in-depth for a hypothetical future caller that bypasses
   * `resolveToolAllowlist` entirely — neither is what this attempt shape
   * actually hits first.
   */
  test('direct recursive delegation attempt: a persona declaring systematic_delegate as one of its own tools fails at buildAgentCatalog — the ACTUAL reachable guard, not the Layer 2 re-entry guard above', () => {
    const dir = makeTempAgentsDir({
      'a/self-delegating-recursive.md':
        '---\nname: self-delegating-recursive\ndescription: D\ntools: Read, systematic_delegate\n---\nBody',
    })

    expect(() => buildAgentCatalog(dir)).toThrow(
      /self-delegating-recursive\.md/,
    )
    // The actual, reachable failure reason: an unknown/unmappable declared
    // tool name, not a "re-entry guard"/"recursion" message. Because
    // systematic_delegate is never mapped as a valid Pi tool declaration in
    // the first place, catalog construction never gets far enough to reach
    // Layer 2's re-entry-specific check above.
    expect(() => buildAgentCatalog(dir)).toThrow(
      /Unknown declared tool "systematic_delegate"/,
    )
  })
})
