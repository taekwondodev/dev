#!/usr/bin/env node
import { enableCompileCache } from 'node:module'

enableCompileCache()

const { main } = await import('./launcher-runtime.ts')
main()
