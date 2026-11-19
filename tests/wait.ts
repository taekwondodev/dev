import { setTimeout as sleep } from 'node:timers/promises'

export class TimedOut extends Error {}

export const within = <A>(promise: Promise<A>, ms: number, what: string): Promise<A> =>
  Promise.race([
    promise,
    sleep(ms, undefined, { ref: false }).then(() => {
      throw new TimedOut(`timed out: ${what}`)
    }),
  ])

export interface WaitTiming {
  readonly attempts?: number
  readonly intervalMs?: number
}

export const IN_MEMORY_POLL: WaitTiming = { attempts: 400, intervalMs: 50 }

export async function waitUntil<A, B extends A>(
  what: string,
  read: () => A | Promise<A>,
  done: (value: A) => value is B,
  timing?: WaitTiming
): Promise<B>
export async function waitUntil<A>(
  what: string,
  read: () => A | Promise<A>,
  done: (value: A) => boolean,
  timing?: WaitTiming
): Promise<A>
export async function waitUntil<A>(
  what: string,
  read: () => A | Promise<A>,
  done: (value: A) => boolean,
  { attempts = 80, intervalMs = 250 }: WaitTiming = {}
): Promise<A> {
  let last: A | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await read()
    if (done(last)) return last
    await sleep(intervalMs)
  }
  const shown = last === undefined ? '' : `; last read: ${JSON.stringify(last)}`
  throw new Error(`timed out: ${what}${shown}`)
}

export const waitFor = <A>(
  what: string,
  probe: () => A | undefined | Promise<A | undefined>,
  timing?: WaitTiming
): Promise<A> => waitUntil(what, probe, (value): value is A => value !== undefined, timing)

export const holdsFor = async (
  what: string,
  ms: number,
  holds: () => boolean | Promise<boolean>,
  everyMs = 10
): Promise<void> => {
  const until = performance.now() + ms
  for (;;) {
    if (!(await holds())) throw new Error(`stopped holding within ${ms} ms: ${what}`)
    if (performance.now() >= until) return
    await sleep(Math.min(everyMs, Math.max(0, until - performance.now())))
  }
}

export const clockAdvanced = async (): Promise<void> => {
  const start = Date.now()
  while (Date.now() === start) await sleep(1)
}
