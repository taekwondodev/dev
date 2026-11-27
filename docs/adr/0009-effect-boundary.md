# ADR 0009: Effect boundary

Coordination runs in Effect with typed failures and a shared retry policy. Promises remain at Pi calling points: extension handlers, runtime factory, session replacements and tool-operation adapters running Effect through the host context. The authority worker's synchronous SQLite engine is the other boundary. One style was chosen over a parallel Promise layer despite rewrite cost. Pi session/native-file errors cross back unchanged because Pi recognizes some by class and owns their recovery; workspace refusals remain typed domain failures.

[#16](https://github.com/taekwondodev/dev/issues/16) accepted the migration to Effect.

Deliberate departures from the Effect guide:

- Launcher and maintenance argument parsing stay manual to preserve pass-through, error output and startup cost.
- `runGit` in `src/pi-child.ts` and `readHead` in `src/workspace-tool.ts` use `node:child_process` because the Effect spawner hides the terminating signal, changing model-visible errors.
- Startup's `git rev-parse` in `src/preferences.ts` and `which pi` in `src/pi-runtime.ts` also stay there: they are short, uninterrupted commands for which the spawner added measurable startup time.
- The URL reader's `src/web-network.ts` issues requests through `node:http` and `node:https` directly, because its network policy pins each connection to a validated address through the request's `lookup` option and revalidates every redirect itself; a generic HTTP client would resolve names again. It takes both modules from `process.getBuiltinModule` at the first request, because an ES import of `node:http` also loads Node's bundled undici at every start. `src/web-browser.ts` spawns Chrome with `node:child_process` because the DevTools pipe needs file descriptors 3 and 4, which the Effect spawner does not expose.
- `src/native.ts` uses `node:child_process` and `node:fs` synchronously to prepare the native addon for the authority's synchronous identity and storage checks and its database publication.
- `allowedUnstableApis` admits only the modules needed from the pinned release, not all Effect APIs; no stable alternatives exist for the admitted integrations.
- The authority client is a lazily opened scoped Effect passed by argument, not a layer-provided service that would start the worker for help or diagnostics.
