import fs from 'node:fs'

/**
 * Tracks temp directories a test file creates so they are removed even when an
 * assertion throws before the test's own cleanup runs. Create one tracker per
 * test file and call `cleanup` from `afterEach` or `afterAll`.
 */
export function createTempDirTracker() {
  const dirs: string[] = []
  return {
    track<T extends string>(dir: T): T {
      dirs.push(dir)
      return dir
    },
    cleanup(): void {
      for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
