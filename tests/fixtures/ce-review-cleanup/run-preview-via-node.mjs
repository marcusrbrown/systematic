// Program/data separation for testing cleanup.mjs's runPreview(): this file
// is the fixed program; argv carries only the JSON options.
//
// Usage: node run-preview-via-node.mjs <optionsJson>

import { runPreview } from '../../../skills/ce-review-cleanup/scripts/cleanup.mjs'

const [optionsJson] = process.argv.slice(2)

const options = JSON.parse(optionsJson)
const result = runPreview(options)
process.stdout.write(JSON.stringify(result))
