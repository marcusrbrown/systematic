/**
 * Canonical OpenCode-accepted agent color tokens.
 *
 * These values are validated by OpenCode's `/config` HttpApi schema;
 * any other value is rejected and surfaces to the user as
 * `400: (empty response body)` on TUI launch.
 *
 * See anomalyco/opencode commits 2793502db / 96a534d8c for the
 * server-side schema (PR #346 / v2.9.2 history).
 */
export const OPENCODE_AGENT_COLOR_TOKENS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
] as const

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/

/**
 * Check whether a value is a valid agent color — either a hex literal
 * (`#RRGGBB`) or a named token from `OPENCODE_AGENT_COLOR_TOKENS`.
 */
export function isValidAgentColor(value: string): boolean {
  if (HEX_COLOR_REGEX.test(value)) return true
  return (OPENCODE_AGENT_COLOR_TOKENS as readonly string[]).includes(value)
}
