// Program/data separation for testing cleanup.mjs exports: this file is the
// fixed program; argv carries only the export name and JSON args.
//
// Usage: node call-export-via-node.mjs <exportName> <argsJson>

import { widenUniquePrefixes } from '../../../skills/ce-review-cleanup/scripts/cleanup.mjs'

const [exportName, argsJson] = process.argv.slice(2)

if (exportName !== 'widenUniquePrefixes') {
  throw new Error(`no exported function named ${exportName}`)
}

const args = JSON.parse(argsJson)
const result = widenUniquePrefixes(args)
process.stdout.write(
  JSON.stringify(result === undefined ? { __undefined: true } : result),
)
