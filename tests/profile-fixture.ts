import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST_FILE } from '../src/profiles.ts'

export interface ProfileFixture {
  readonly root: string
  readonly manifestPath: string
  readonly defaultProfile: string
  readonly skillProfile: string
  readonly skill: string
  readonly skillPath: string
  readonly soulPath: (profile: string) => string
  readonly guidance: (profile: string) => string
}

export const FIXTURE_MANIFEST = {
  default: 'base',
  profiles: {
    base: { soul: 'base/SOUL.md', skills: [] },
    stack: { soul: 'stack/SOUL.md', skills: ['stack/skills/stack-only'] },
  },
} as const

const guidance = (profile: string): string =>
  `${profile.toUpperCase()}-SOUL guidance of the ${profile} fixture profile.\n`

export const writeProfileFixture = (
  root: string,
  manifest: unknown = FIXTURE_MANIFEST
): ProfileFixture => {
  for (const profile of Object.keys(FIXTURE_MANIFEST.profiles)) {
    mkdirSync(join(root, profile), { recursive: true })
    writeFileSync(join(root, profile, 'SOUL.md'), guidance(profile))
  }
  const skillPath = join(root, FIXTURE_MANIFEST.profiles.stack.skills[0])
  mkdirSync(skillPath, { recursive: true })
  writeFileSync(
    join(skillPath, 'SKILL.md'),
    [
      '---',
      'name: stack-only',
      'description: stack-only fixture skill',
      '---',
      'STACK-ONLY-BODY available only in the stack profile.',
      '',
    ].join('\n')
  )
  const manifestPath = join(root, MANIFEST_FILE)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return {
    root,
    manifestPath,
    defaultProfile: FIXTURE_MANIFEST.default,
    skillProfile: 'stack',
    skill: 'stack-only',
    skillPath,
    soulPath: profile => join(root, profile, 'SOUL.md'),
    guidance,
  }
}

export const installProfileFixture = (root: string): ProfileFixture => {
  const fixture = writeProfileFixture(root)
  process.env.DEV_PROFILES = root
  return fixture
}
