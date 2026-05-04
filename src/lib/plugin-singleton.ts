/**
 * Per-process register-once guard for the Systematic plugin factory.
 *
 * OpenCode invokes the plugin factory more than once per process when the
 * same plugin is referenced by multiple config sources (for example a
 * user-level `~/.config/opencode/opencode.json` AND a project-level
 * `opencode.json`). Each invocation evaluates the plugin module fresh —
 * module-local variables reset between calls — so the guard state must
 * live on `globalThis` to persist across module instances within the
 * same process.
 *
 * On the first invocation `doInit` runs and the resulting hooks promise
 * is cached on `globalThis`; the caller receives `{ isFirst: true, hooks }`.
 * On every subsequent invocation in the same PID `doInit` is skipped, the
 * cached promise is awaited (so sticky rejections still propagate),
 * `onDuplicate` fires exactly once, and the caller receives
 * `{ isFirst: false, hooks: {} as T }`. Across PIDs the guard is treated
 * as absent and init runs fresh — `globalThis` is per-process, but the
 * explicit PID check adds defensive belt-and-suspenders against any
 * state-leakage edge case.
 *
 * **Why empty hooks on duplicate invocations.** A whole-hooks singleton
 * that returns the same hooks reference to both invocations does not
 * deduplicate host-side tool registration: OpenCode iterates each plugin
 * source's returned hook surface and registers every tool entry it finds,
 * even when two sources return the same JS reference. Returning `{}` from
 * the duplicate path is the only shape that prevents host-side double
 * registration of `systematic_skill`, the `config` hook, and the
 * `experimental.chat.system.transform` hook. The Phase 0 follow-up probe
 * (see `docs/plans/2026-05-01-001-fix-idempotent-plugin-registration-plan.md`)
 * verified the duplicate `systematic_skill` entry in OpenCode's
 * `client.tool.list(...)` output, which is the LLM-visible tool catalog.
 *
 * **Known limitation — rejected init is sticky.** If `doInit()` rejects,
 * the rejected promise is stored on `globalThis` and every subsequent
 * invocation in the same PID returns the same rejection without retrying
 * init. This is intentional: re-running heavy init on every call would
 * defeat the guard's purpose. Recovery requires a process restart.
 */

const SINGLETON_KEY: unique symbol = Symbol.for('systematic.singleton.v1')

interface SingletonState<T> {
  pid: number
  loadedAt: number
  hooksPromise: Promise<T>
  warned: boolean
}

/**
 * Type-safe view onto `globalThis` for our symbol-keyed singleton slot.
 *
 * TypeScript's `declare global { var ... }` augmentation does not accept
 * computed property keys, so a unique-symbol-keyed slot on `globalThis`
 * is reachable only via an intersection cast. The cast is contained at
 * a single point and the property type drives subsequent reads and writes —
 * callers do not re-assert the value's shape with additional casts.
 */
type GlobalWithSingleton<T> = typeof globalThis & {
  [SINGLETON_KEY]?: SingletonState<T>
}

export interface PlugInOnceOptions<T> {
  /** Heavy init work that should run at most once per process. */
  doInit: () => Promise<T>
  /**
   * Called exactly once on the first duplicate invocation in the same
   * process. Subsequent duplicates are silent. Receives the same `pid`
   * value the guard used for its identity check (so test overrides flow
   * through faithfully). Implementations must not throw; fire-and-forget
   * side effects (logging, metrics) are expected. Synchronous exceptions
   * are swallowed defensively.
   */
  onDuplicate?: (pid: number) => void
  /** Test override; defaults to `process.pid`. */
  pid?: number
}

/**
 * Result envelope for `plugInOnce(...)`.
 *
 * - `isFirst: true` — caller should return `hooks` to OpenCode.
 * - `isFirst: false` — caller MUST return `hooks` (which is an empty `{}`)
 *   so the host loader does not register tools or hooks twice.
 *
 * Callers that just `return result.hooks` do the right thing in both
 * cases without needing to inspect `isFirst`.
 */
export interface PlugInOnceResult<T> {
  isFirst: boolean
  hooks: T
}

/**
 * Run `doInit` at most once per process; on duplicate invocations resolve to
 * empty hooks so the OpenCode host does not double-register tools and hooks.
 */
export async function plugInOnce<T>({
  doInit,
  onDuplicate,
  pid,
}: PlugInOnceOptions<T>): Promise<PlugInOnceResult<T>> {
  const currentPid = pid ?? process.pid
  const g = globalThis as unknown as GlobalWithSingleton<T>
  const existing = g[SINGLETON_KEY]

  if (existing && existing.pid === currentPid) {
    if (!existing.warned) {
      existing.warned = true
      try {
        onDuplicate?.(currentPid)
      } catch {
        // onDuplicate must not block plugin init.
      }
    }
    // Await the cached init so sticky rejections still propagate to the
    // duplicate caller. The resolved value is intentionally discarded —
    // duplicate callers receive empty hooks so the host registers nothing.
    await existing.hooksPromise
    return { isFirst: false, hooks: {} as T }
  }

  const hooksPromise = doInit()
  g[SINGLETON_KEY] = {
    pid: currentPid,
    loadedAt: Date.now(),
    hooksPromise,
    warned: false,
  }
  const hooks = await hooksPromise
  return { isFirst: true, hooks }
}

/**
 * Test-only: clear the singleton state so the next invocation re-runs
 * init. Must not be called in production code paths.
 */
export function _resetPluginSingleton(): void {
  const g = globalThis as unknown as GlobalWithSingleton<unknown>
  delete g[SINGLETON_KEY]
}
