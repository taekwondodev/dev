import { Effect, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import {
  CoordinationError,
  type ConversationClaim,
  type RuntimeLease,
} from './runtime-coordination.ts'

type SessionManager = Pick<Pi.SessionManager, 'getSessionFile' | 'getSessionId'>

class NavigationFailure extends Schema.TaggedError<NavigationFailure>()('NavigationFailure', {
  cause: Schema.Defect(),
}) {}

const conversationOf = (sessions: SessionManager): ConversationClaim => {
  const path = sessions.getSessionFile()
  if (path === undefined)
    throw new CoordinationError({ message: 'Dev requires a persisted conversation identity' })
  return { path, sessionId: sessions.getSessionId() }
}

export const createSessionGuard = (lease: RuntimeLease) => {
  const factory: Pi.ExtensionFactory = pi => {
    pi.on('session_before_switch', async (event, ctx) => {
      if (event.targetSessionFile === undefined) return
      try {
        await Effect.runPromise(lease.protect({ path: event.targetSessionFile }))
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (ctx.hasUI) ctx.ui.notify(message, 'error')
        else process.stderr.write(`${message}\n`)
        return { cancel: true }
      }
    })
  }
  return {
    factory,
    protect: (sessions: SessionManager) =>
      Effect.try({
        try: () => conversationOf(sessions),
        catch: cause =>
          cause instanceof CoordinationError
            ? cause
            : new CoordinationError({ message: 'Cannot identify the Pi conversation', cause }),
      }).pipe(Effect.flatMap(conversation => lease.protect(conversation))),
    bind: (runtime: Pi.AgentSessionRuntime): void => {
      const navigate = <A>(operation: () => Promise<A>): Promise<A> =>
        Effect.runPromise(
          lease.navigate(
            Effect.tryPromise({
              try: operation,
              catch: cause => new NavigationFailure({ cause }),
            }),
            () => conversationOf(runtime.session.sessionManager)
          )
        ).catch((cause: unknown) => {
          throw cause instanceof NavigationFailure ? cause.cause : cause
        })
      const switchSession = runtime.switchSession.bind(runtime)
      const newSession = runtime.newSession.bind(runtime)
      const fork = runtime.fork.bind(runtime)
      const importFromJsonl = runtime.importFromJsonl.bind(runtime)
      runtime.switchSession = (...args) => navigate(() => switchSession(...args))
      runtime.newSession = (...args) => navigate(() => newSession(...args))
      runtime.fork = (...args) => navigate(() => fork(...args))
      runtime.importFromJsonl = (...args) => navigate(() => importFromJsonl(...args))
    },
  }
}
