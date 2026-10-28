import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin as OpenCodeV2 } from '@opencode/plugin'
import type { PluginModule } from '@opencode-ai/plugin'
import { createOpenCodeV1Hooks } from './lib/opencode-v1.js'
import { setupOpenCodeV2 } from './lib/opencode-v2.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolved here, not in the adapter: this entry (and the bundled `dist/*.js`
// chunks it builds into) sits one level below the package root, while
// `src/lib/` sits two levels below it.
const packageRoot = path.resolve(__dirname, '..')

// One object serves both hosts. A v2 host calls `setup` and ignores `server`.
// A v1 host calls `server`. Both type imports above are erased by the build,
// so the shipped entry has no runtime dependency on either OpenCode package.
type SystematicPluginModule = OpenCodeV2.Plugin & PluginModule

// OpenCode's plugin loader requires a default export only. The hooks, the
// `REGISTERED_PLUGIN_HOOKS` inventory and the shared-core wiring live in
// `src/lib/opencode-v1.ts`.
const systematicPlugin = {
  id: 'systematic',
  async setup(ctx) {
    // A v1 host that receives an object default also calls `setup`, with a
    // reduced bridge that has no `location` or `session`. Do nothing there.
    if (!ctx.location || !ctx.session) return
    // Invalid config rejects here, as it throws on v1: the v2 host logs that
    // the plugin failed to load and carries on without it.
    await setupOpenCodeV2(ctx, { packageRoot })
  },
  server: async (input) => createOpenCodeV1Hooks(input, { packageRoot }),
} satisfies SystematicPluginModule

// What the declaration file shows. The object above is checked against both
// hosts' plugin types, but naming those types in the public declaration would
// put an import of each peer into `dist/index.d.ts`, and a consumer with only
// one of the two optional peers installed (and `skipLibCheck` off) would fail
// to resolve the other. Each host passes its own context to the entry it calls,
// so the public shape takes `unknown`.
interface SystematicPluginEntry {
  readonly id: string
  setup(ctx: unknown): Promise<void>
  server(input: unknown): Promise<unknown>
}

const entry: SystematicPluginEntry = systematicPlugin

export default entry
