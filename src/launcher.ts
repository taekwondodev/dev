#!/usr/bin/env node
import { enableCompileCache } from 'node:module'

enableCompileCache()
process.env.DEV_CODING_AGENT = 'true'

const { main } = await import('./launcher-runtime.ts')
main()
