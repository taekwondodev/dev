import * as Effect from 'effect/Effect'
import { ownerBootstrap } from './chrome-fixture.ts'

const [, , dataHome] = process.argv
if (dataHome === undefined) throw new Error('the starter needs a data home')
await Effect.runPromise(ownerBootstrap(dataHome).ensure)
process.stdout.write('started\n')
