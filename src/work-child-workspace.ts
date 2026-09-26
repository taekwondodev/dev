import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Predicate, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { WorkspaceId, type WorkspaceGrant } from './workspace-domain.ts'

const Reply = Schema.Struct({
  type: Schema.Literal('workspace-checked'),
  requestId: WorkspaceId,
  useId: WorkspaceId,
  allowed: Schema.Boolean,
  reason: Schema.optional(Schema.String),
})
const decodeReply = Schema.decodeUnknownOption(Reply)
const FileInput = Schema.Struct({ path: Schema.NonEmptyString })
const readTools = new Set(['read', 'grep', 'find', 'ls'])

export const validateWorkspaceWritePath = async (
  grant: WorkspaceGrant,
  input: unknown
): Promise<string> => {
  const { path } = Schema.decodeUnknownSync(FileInput)(input)
  if (path.includes('\0')) throw new Error('Invalid write path')
  if (
    path.startsWith('@') ||
    path === '~' ||
    path.startsWith('~/') ||
    path.startsWith('file://') ||
    /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(path)
  )
    throw new Error(
      'Use a literal absolute or relative write path; Pi path shorthand is not an authority identity'
    )
  // `resolve` removes `..` lexically, before the filesystem resolves any symbolic link,
  // while the builtin tool hands this operand to the kernel, which resolves links first.
  // Through an in-workspace link the two name different files, so the ambiguous operand
  // is refused outright.
  //
  // This closes the ambiguity, not the race. A `tool_call` hook can only allow or block;
  // it cannot rewrite the tool's input or hand it a descriptor. Between this check and
  // the tool's own open(2) a component of the path can still be replaced by a symbolic
  // link, and the write then follows it. That residual window is a property of the hook
  // boundary and is accepted, not fixed here.
  if (path.split('/').includes('..'))
    throw new Error('Write path must not traverse parent directories')
  const absolute = resolve(grant.cwd, path)
  let ancestor = absolute
  const suffix: string[] = []
  for (;;) {
    try {
      await lstat(ancestor)
      break
    } catch (cause) {
      if (!Predicate.isObject(cause) || cause.code !== 'ENOENT') throw cause
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new Error('Cannot establish write-path identity', { cause })
      suffix.unshift(basename(ancestor))
      ancestor = parent
    }
  }
  const canonicalAncestor = await realpath(ancestor)
  const actual = join(canonicalAncestor, ...suffix)
  const inside = relative(grant.checkout, actual)
  if (inside === '') throw new Error('A workspace directory is not a file-write destination')
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
    throw new Error('Write path escapes the authorized workspace')
  if (inside.split('/').some(part => part.toLowerCase() === '.git'))
    throw new Error('Direct Git administrative writes require structural authority')
  const rootDevice = (await lstat(grant.checkout)).dev
  for (
    let directory = suffix.length > 0 ? canonicalAncestor : dirname(actual);
    directory !== grant.checkout;
    directory = dirname(directory)
  ) {
    if ((await lstat(directory)).dev !== rootDevice)
      throw new Error('Write destination crosses an unsupported mount boundary')
    let nested = false
    try {
      await lstat(join(directory, '.git'))
      nested = true
    } catch (cause) {
      if (!Predicate.isObject(cause) || cause.code !== 'ENOENT') throw cause
    }
    if (nested)
      throw new Error('Write destination belongs to a nested repository; select it explicitly')
  }
  if (suffix.length === 0) {
    const info = await lstat(absolute)
    if (!info.isFile() || info.nlink !== 1)
      throw new Error('Write destination must be a regular file without hard links')
  }
  return path
}

export const checkChildWorkspace = (
  grant: WorkspaceGrant,
  operation: 'read' | 'write'
): Promise<void> =>
  new Promise((accept, reject) => {
    if (!process.connected || process.send === undefined) {
      reject(new Error('Workspace controller IPC is unavailable'))
      return
    }
    const requestId = randomUUID()
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.removeListener('message', onMessage)
      process.removeListener('disconnect', onDisconnect)
    }
    const fail = (cause: Error): void => {
      cleanup()
      reject(cause)
    }
    const onDisconnect = (): void => fail(new Error('Workspace controller disconnected'))
    const onMessage = (raw: unknown): void => {
      const reply = decodeReply(raw)
      if (
        reply._tag !== 'Some' ||
        reply.value.requestId !== requestId ||
        reply.value.useId !== grant.useId
      )
        return
      cleanup()
      if (reply.value.allowed) accept()
      else reject(new Error(reply.value.reason ?? 'Workspace authorization rejected'))
    }
    const timeout = setTimeout(
      () => fail(new Error('Workspace authorization acknowledgment unavailable')),
      10000
    )
    process.on('message', onMessage)
    process.once('disconnect', onDisconnect)
    try {
      process.send({ type: 'workspace-check', requestId, useId: grant.useId, operation }, cause => {
        if (cause !== null) fail(cause)
      })
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })

export const childWorkspaceExtension =
  (grant: WorkspaceGrant): Pi.ExtensionFactory =>
  pi => {
    pi.on('tool_call', async event => {
      try {
        const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
        const builtin = tool?.sourceInfo.source === 'builtin'
        const reviewGit =
          grant.access === 'read' &&
          event.toolName === 'git_inspect' &&
          tool?.sourceInfo.source === 'sdk'
        const read = (builtin && readTools.has(event.toolName)) || reviewGit
        if (!read && grant.access !== 'write') throw new Error('Child workspace is read-only')
        const fileWrite = builtin && (event.toolName === 'write' || event.toolName === 'edit')
        if (fileWrite) await validateWorkspaceWritePath(grant, event.input)
        await checkChildWorkspace(grant, read ? 'read' : 'write')
      } catch (cause) {
        return { block: true, reason: cause instanceof Error ? cause.message : String(cause) }
      }
    })
  }
