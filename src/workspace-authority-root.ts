import { userInfo } from 'node:os'
import { join } from 'node:path'

// Every installation of this OS account must meet the same authority, so its location
// comes from the account, never from HOME, the data home or the installation.
export const defaultAuthorityRoot = (): string =>
  join(userInfo().homedir, 'Library', 'Application Support', 'dev', 'workspace-authority')
