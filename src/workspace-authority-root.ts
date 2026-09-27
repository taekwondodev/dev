import { userInfo } from 'node:os'
import { join } from 'node:path'

// ADR 0003 fixes this location per OS account.
export const defaultAuthorityRoot = (): string =>
  join(userInfo().homedir, 'Library', 'Application Support', 'dev', 'workspace-authority')

export interface AuthorityPaths {
  readonly root: string
  readonly protocol: string
  readonly catalog: string
  readonly repos: string
  readonly gates: string
  readonly worktrees: string
}
export const authorityPaths = (root: string): AuthorityPaths => ({
  root,
  protocol: join(root, 'protocol.sqlite'),
  catalog: join(root, 'catalog.sqlite'),
  repos: join(root, 'repos'),
  gates: join(root, 'gates'),
  worktrees: join(root, 'worktrees'),
})
