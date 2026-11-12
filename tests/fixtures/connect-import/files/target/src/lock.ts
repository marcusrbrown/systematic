declare function removeDirectory(path: string): boolean

export function reclaimLock(path: string): boolean {
  return removeDirectory(path)
}
