import { userInfo } from 'node:os'
import { join } from 'node:path'

// ADR 0003 fixes this location per OS account.
export const defaultAuthorityRoot = (): string =>
  join(userInfo().homedir, 'Library', 'Application Support', 'dev', 'workspace-authority')
