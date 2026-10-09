import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { makeBrowserProfileOwner, type BrowserProfileOptions } from '../../src/web-profile.ts'

const CHROME_UTC_2100 = 15_770_000_000_000_000n
const COOKIE_SCHEMA = [
  'CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)',
  'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL)',
  'CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port)',
  "INSERT INTO meta VALUES ('version', '24'), ('last_compatible_version', '24')",
]

export interface ChromeSourceFixture {
  readonly userData: string
  readonly cookiesPath: string
  readonly downloads: string
  readonly writeCookies: (token: string) => void
}

export const makeChromeSource = (
  root: string,
  cookie: { readonly host: string; readonly port: number }
): ChromeSourceFixture => {
  const userData = join(root, 'chrome-source')
  const profile = join(userData, 'Default')
  const downloads = join(root, 'downloads')
  mkdirSync(profile, { recursive: true })
  mkdirSync(downloads, { recursive: true })
  writeFileSync(
    join(userData, 'Local State'),
    JSON.stringify({
      profile: { last_used: 'Default', info_cache: { Default: { name: 'Fixture' } } },
    })
  )
  writeFileSync(
    join(profile, 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } })
  )
  const cookiesPath = join(profile, 'Cookies')
  const writeCookies = (token: string) => {
    rmSync(cookiesPath, { force: true })
    const db = new DatabaseSync(cookiesPath)
    for (const statement of COOKIE_SCHEMA) db.exec(statement)
    const now = BigInt(Date.now()) * 1000n + 11_644_473_600_000_000n
    db.prepare(
      'INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, 1, 1, -1, 1, ?, ?, 0, 0)'
    ).run(
      now,
      cookie.host,
      '',
      'session',
      token,
      new Uint8Array(0),
      '/',
      CHROME_UTC_2100,
      now,
      cookie.port,
      now
    )
    db.close()
  }
  return { userData, cookiesPath, downloads, writeCookies }
}
export const chromeRunningOn = (userDataDir: string): number =>
  execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.includes(`--user-data-dir=${userDataDir}`)).length

export const assertCopyReleased = async (
  profile: BrowserProfileOptions,
  phase: string
): Promise<void> => {
  assert.equal(
    chromeRunningOn(join(profile.dataHome, 'browser', 'user-data')),
    0,
    `no Chrome remains on the dev copy ${phase}`
  )
  assert.equal(
    (await Effect.runPromise(makeBrowserProfileOwner(profile).status)).inUse,
    false,
    `the profile copy is released ${phase}`
  )
}
