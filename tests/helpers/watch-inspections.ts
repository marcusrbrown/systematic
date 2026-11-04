import { spyOn } from 'bun:test'
import fs from 'node:fs'

/**
 * Records every path a test run inspects: `lstat` calls and the directories
 * opened for listing. `stop` restores the real functions.
 */
export function watchInspections() {
  const statted: string[] = []
  const listed: string[] = []
  const realLstat = fs.lstatSync.bind(fs)
  const realOpendir = fs.opendirSync.bind(fs)
  const realReaddir = fs.readdirSync.bind(fs)
  const lstatSpy = spyOn(fs, 'lstatSync').mockImplementation(((
    target: fs.PathLike,
    ...rest: unknown[]
  ) => {
    statted.push(String(target))
    return (realLstat as (...args: unknown[]) => unknown)(target, ...rest)
  }) as typeof fs.lstatSync)
  const opendirSpy = spyOn(fs, 'opendirSync').mockImplementation(((
    target: fs.PathLike,
    ...rest: unknown[]
  ) => {
    listed.push(String(target))
    return (realOpendir as (...args: unknown[]) => fs.Dir)(target, ...rest)
  }) as typeof fs.opendirSync)
  const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation(((
    target: fs.PathLike,
    ...rest: unknown[]
  ) => {
    listed.push(String(target))
    return (realReaddir as (...args: unknown[]) => unknown)(target, ...rest)
  }) as typeof fs.readdirSync)
  return {
    statted,
    listed,
    stop: () => {
      lstatSpy.mockRestore()
      opendirSpy.mockRestore()
      readdirSpy.mockRestore()
    },
  }
}
