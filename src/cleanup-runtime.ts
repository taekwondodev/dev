import './compile-cache-adoption.ts'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { acquireCleanupRuntime, purgeConversationLocks } from './runtime-coordination.ts'
import { cleanConversations } from './conversation-cleanup.ts'
import { cleanPreferenceTemporaries } from './preferences.ts'
import { SessionId } from './work-domain.ts'
import { WorkStore } from './work-store.ts'

const CleanupRequest = Schema.Struct({
  dataHome: Schema.NonEmptyString,
  trigger: Schema.Literals(['startup', 'graceful-exit']),
  coordination: Schema.optional(
    Schema.Struct({
      installationPath: Schema.optional(Schema.NonEmptyString),
      namespacePath: Schema.optional(Schema.NonEmptyString),
    })
  ),
})
type CleanupRequest = typeof CleanupRequest.Type

const cleanup = Effect.fnUntraced(function* (request: CleanupRequest) {
  yield* purgeConversationLocks(request.coordination).pipe(Effect.ignore)
  yield* acquireCleanupRuntime(request.dataHome, request.coordination)
  yield* cleanPreferenceTemporaries(request.dataHome).pipe(Effect.ignore)
  yield* cleanConversations(request.dataHome, request.coordination?.namespacePath).pipe(
    Effect.provide(
      WorkStore.layer(request.dataHome, SessionId.make(randomUUID())).pipe(
        Layer.provide(NodeServices.layer)
      )
    )
  )
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  NodeRuntime.runMain(
    Schema.decodeEffect(Schema.fromJsonString(CleanupRequest))(process.argv[2]).pipe(
      Effect.flatMap(cleanup),
      Effect.scoped,
      Effect.provide(NodeServices.layer)
    ),
    { disableErrorReporting: true }
  )
}
