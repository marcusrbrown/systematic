// Bun test preload (see bunfig.toml `[test].preload`). Runs once before any
// test file. `SYSTEMATIC_PROFILE` selects the active model profile
// (src/lib/config.ts), so an ambient value in the developer's or CI's shell
// would otherwise silently steer config-loading assertions across every
// suite. Clearing it here makes the whole suite hermetic by construction
// -- tests that deliberately want the variable set still set it themselves
// (e.g. `withEnvProfile` in tests/unit/config.test.ts) and restore it
// afterward.
delete process.env.SYSTEMATIC_PROFILE
