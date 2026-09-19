import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { linkPiDeclarations } from '../src/pi-runtime.ts'

NodeRuntime.runMain(linkPiDeclarations.pipe(Effect.provide(NodeServices.layer)))
