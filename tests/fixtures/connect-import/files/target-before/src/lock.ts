declare function removeDirectoryNow(path: string): boolean

export function reclaimLock(path: string): boolean {
  return removeDirectoryNow(path)
}
