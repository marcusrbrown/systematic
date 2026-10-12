import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const NOTES_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/

export interface GatedReleaseConfigInput {
  releasercYaml: string
  notesPath: string
  version: string
}

/**
 * Build the semantic-release config used by the gated publish job.
 *
 * The result is pure data: the publish job writes it as `.releaserc.json` and
 * runs no repo code. Every top-level key from `.releaserc.yaml` is kept; only
 * `plugins` is replaced. The release-notes-generator is dropped because the
 * committed changelog entry is the notes, and `verifyReleaseCmd` aborts the
 * run unless semantic-release computes exactly the approved version.
 */
export function buildGatedReleaseConfig({
  releasercYaml,
  notesPath,
  version,
}: GatedReleaseConfigInput): object {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid version "${version}": expected x.y.z`)
  }
  if (!NOTES_PATH_PATTERN.test(notesPath)) {
    throw new Error(
      `Invalid notesPath "${notesPath}": only A-Z a-z 0-9 . _ / - allowed`,
    )
  }

  const parsed = yaml.load(releasercYaml)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('.releaserc.yaml must contain a mapping at the top level')
  }
  const { plugins: _ungated, ...rest } = parsed as Record<string, unknown>
  if (rest.branches === undefined) {
    throw new Error('.releaserc.yaml is missing "branches"')
  }
  if (rest.tagFormat === undefined) {
    throw new Error('.releaserc.yaml is missing "tagFormat"')
  }

  return {
    ...rest,
    plugins: [
      '@semantic-release/commit-analyzer',
      [
        '@semantic-release/exec',
        {
          // `${nextRelease.version}` is templated by semantic-release (lodash)
          // before the command runs; the approved version is a literal.
          verifyReleaseCmd: `test "\${nextRelease.version}" = "${version}"`,
          generateNotesCmd: `cat '${notesPath}'`,
        },
      ],
      '@semantic-release/npm',
      [
        '@semantic-release/github',
        {
          releasedLabels: false,
          successComment: false,
          failComment: false,
          failTitle: false,
        },
      ],
      'semantic-release-export-data',
    ],
  }
}

function parseArgs(argv: string[]): {
  releaserc: string
  notes: string
  version: string
  out: string
} {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (
      flag === undefined ||
      !['--releaserc', '--notes', '--version', '--out'].includes(flag)
    ) {
      throw new Error(`Unknown argument: ${flag}`)
    }
    if (value === undefined) throw new Error(`${flag} requires a value`)
    values.set(flag, value)
  }
  const require = (flag: string): string => {
    const value = values.get(flag)
    if (value === undefined) throw new Error(`Missing required ${flag}`)
    return value
  }
  return {
    releaserc: require('--releaserc'),
    notes: require('--notes'),
    version: require('--version'),
    out: require('--out'),
  }
}

if (import.meta.main) {
  try {
    const { releaserc, notes, version, out } = parseArgs(process.argv.slice(2))
    const config = buildGatedReleaseConfig({
      releasercYaml: fs.readFileSync(releaserc, 'utf8'),
      notesPath: notes,
      version,
    })
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }
}
