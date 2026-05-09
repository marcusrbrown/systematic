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
 * On every subsequent invocation in the same PID `doInit` is skipped and
 * the cached resolved hooks are returned directly to every caller.
 * Across PIDs the guard is treated as absent and init runs fresh —
 * `globalThis` is per-process, but the explicit PID check adds defensive
 * belt-and-suspenders against any state-leakage edge case.
 *
 * The singleton returns the same hooks reference to every caller within a
 * process — first and duplicate alike. OpenCode may register the same hook
 * surface once per configured plugin source; that is preferable to suppressing
 * duplicates with an empty object because every source keeps the full tools,
 * commands, skills, and hooks surface.
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
  /** Test override; defaults to `process.pid`. */
  pid?: number
}

/**
 * Result envelope for `plugInOnce(...)`.
 *
 * - `isFirst: true` — caller was the first invocation in this process.
 * - `isFirst: false` — `doInit` was skipped; the cached result is returned.
 *
 * In both cases `hooks` is the real resolved value of `doInit()`. Callers
 * return `result.hooks` unconditionally without inspecting `isFirst`.
 */
export interface PlugInOnceResult<T> {
  isFirst: boolean
  hooks: T
}

/**
 * Run `doInit` at most once per process; on duplicate invocations return the
 * cached real hook surface so every config source sees the same surface.
 */
export async function plugInOnce<T>({
  doInit,
  pid,
}: PlugInOnceOptions<T>): Promise<PlugInOnceResult<T>> {
  const currentPid = pid ?? process.pid
  const g = globalThis as unknown as GlobalWithSingleton<T>
  const existing = g[SINGLETON_KEY]

  if (existing && existing.pid === currentPid) {
    const hooks = await existing.hooksPromise
    return { isFirst: false, hooks }
  }

  const hooksPromise = doInit()
  g[SINGLETON_KEY] = {
    pid: currentPid,
    loadedAt: Date.now(),
    hooksPromise,
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
