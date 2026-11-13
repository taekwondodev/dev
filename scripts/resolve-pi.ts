import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import { linkPiDeclarations } from '../src/pi-runtime.ts'

NodeRuntime.runMain(linkPiDeclarations.pipe(Effect.provide(NodeServices.layer)))
