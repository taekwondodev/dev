import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { CoordinationOptions } from './runtime-coordination.ts'

const entry = fileURLToPath(new URL('./cleanup-runtime.ts', import.meta.url))

export const requestCleanup = (
  dataHome: string,
  trigger: 'startup' | 'graceful-exit',
  coordination?: CoordinationOptions
): void => {
  try {
    const child = spawn(
      process.execPath,
      [entry, JSON.stringify({ dataHome, trigger, coordination })],
      {
        detached: true,
        stdio: 'ignore',
        cwd: '/',
      }
    )
    child.on('error', () => {})
    child.unref()
  } catch {}
}
