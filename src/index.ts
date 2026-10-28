import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@opencode-ai/plugin'
import { createOpenCodeV1Hooks } from './lib/opencode-v1.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolved here, not in the adapter: this entry (and the bundled `dist/*.js`
// chunks it builds into) sits one level below the package root, while
// `src/lib/` sits two levels below it.
const packageRoot = path.resolve(__dirname, '..')

// OpenCode's plugin loader requires a default export only. The hooks, the
// `REGISTERED_PLUGIN_HOOKS` inventory and the shared-core wiring live in
// `src/lib/opencode-v1.ts`.
const SystematicPlugin: Plugin = async (input) => {
  return createOpenCodeV1Hooks(input, { packageRoot })
}

export default SystematicPlugin
