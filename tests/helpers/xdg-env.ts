/**
 * Runs `fn` with `XDG_CONFIG_HOME` set to `value` (or deleted when `undefined`),
 * then restores whatever was there before, even if `fn` throws.
 *
 * `tests/setup.ts` clears the variable for the whole suite, so a test that
 * wants it set says so here instead of leaking the developer's real value.
 */
export function withXdgConfigHome<T>(
  value: string | undefined,
  fn: () => T,
): T {
  const previous = process.env.XDG_CONFIG_HOME
  if (value === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
}
