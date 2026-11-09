import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Clock, Effect, FileSystem, Option, Schema } from 'effect'
import type * as PiSettings from '../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js'
import type * as PiTheme from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js'
import type * as PiTui from '../node_modules/@earendil-works/pi-tui/dist/index.js'
import { errorText } from './error-text.ts'
import { globalPiAgentDir } from './preferences.ts'

export class RepositoryPickerError extends Schema.TaggedError<
  RepositoryPickerError,
  { readonly brand: unique symbol }
>()('RepositoryPickerError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Repository {
  readonly name: string
  readonly path: string
  readonly branch: string | undefined
  readonly lastUsed: number | undefined
}

const SessionHeader = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal('session'), cwd: Schema.String })
)
const HEADER_BYTES = 1024
const SESSION_READS = 16
const VISIBLE = 8
const CHROME_ROWS = 6
const DRAIN_MS = 1000
const BRANCH_REF = 'ref: refs/heads/'
const NAVIGATION = [
  'tui.select.up',
  'tui.select.down',
  'tui.select.pageUp',
  'tui.select.pageDown',
  'tui.select.confirm',
  'tui.select.cancel',
] as const
const ICON = { folder: '\u{f07b}', branch: '\u{f418}' }
const NOT_A_REPOSITORY = ' is not a Git repository.'
const INITIALIZE = 'initialize'

const control = (character: string): boolean =>
  character < ' ' || (character >= '\u007F' && character <= '\u009F')
const printable = (text: string): boolean => ![...text].some(control)
const dropControls = (text: string): string =>
  [...text].filter(character => !control(character)).join('')
const withoutControls = (text: string): string =>
  [...text].map(character => (control(character) ? '?' : character)).join('')

const sessionUse = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const head = yield* Effect.scoped(
    fs.open(path).pipe(Effect.flatMap(file => file.readAlloc(HEADER_BYTES)))
  )
  const text = new TextDecoder().decode(Option.getOrElse(head, () => new Uint8Array()))
  const header = yield* Schema.decodeEffect(SessionHeader)(text.split('\n', 1)[0] ?? '')
  const modified = (yield* fs.stat(path)).mtime
  return Option.map(modified, at => ({ cwd: header.cwd, at: at.getTime() }))
})

const sessionUses = Effect.fnUntraced(function* (sessionsPath: string) {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(sessionsPath).pipe(Effect.orElseSucceed(() => []))
  const uses = yield* Effect.forEach(
    names.filter(name => name.endsWith('.jsonl')),
    name => sessionUse(join(sessionsPath, name)).pipe(Effect.orElseSucceed(() => Option.none())),
    { concurrency: SESSION_READS }
  )
  return uses.flatMap(use => Option.toArray(use))
})

const branchOf = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(join(path, '.git', 'HEAD')).pipe(
    Effect.map(head => {
      const ref = head.trim()
      if (!ref.startsWith(BRANCH_REF)) return 'detached'
      const branch = ref.slice(BRANCH_REF.length)
      return printable(branch) ? branch : undefined
    }),
    Effect.orElseSucceed(() => undefined)
  )

const repositoryAt = Effect.fnUntraced(function* (directory: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  const path = join(directory, name)
  if (name.startsWith('.') || !printable(name)) return Option.none()
  const info = yield* fs.stat(path).pipe(Effect.option)
  if (Option.isNone(info) || info.value.type !== 'Directory') return Option.none()
  if (!(yield* fs.exists(join(path, '.git')).pipe(Effect.orElseSucceed(() => false))))
    return Option.none()
  return Option.some({ name, path, branch: yield* branchOf(fs, path) })
})

export const findRepositories = Effect.fnUntraced(function* (
  directory: string,
  sessionsPath: string
): Effect.fn.Return<readonly Repository[], never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))
  const [found, uses] = yield* Effect.all(
    [
      Effect.forEach(names, name => repositoryAt(directory, name), { concurrency: 'unbounded' }),
      sessionUses(sessionsPath),
    ],
    { concurrency: 2 }
  )
  return found
    .flatMap(repository => Option.toArray(repository))
    .map(repository => {
      const times = uses
        .filter(use => use.cwd === repository.path || use.cwd.startsWith(repository.path + sep))
        .map(use => use.at)
      return {
        name: repository.name,
        path: repository.path,
        branch: repository.branch,
        lastUsed: times.length === 0 ? undefined : Math.max(...times),
      }
    })
    .toSorted((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.name.localeCompare(b.name))
})

export const displayPath = (path: string): string => {
  const home = homedir()
  return withoutControls(
    path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
  )
}

const tailToWidth = (text: string, budget: number, width: (text: string) => number): string => {
  if (width(text) <= budget) return text
  const kept: string[] = []
  let used = width('…')
  for (const character of [...text].toReversed()) {
    used += width(character)
    if (used > budget) break
    kept.unshift(character)
  }
  return `…${kept.join('')}`
}

const ago = (now: number, at: number): string => {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

interface PickerModules {
  readonly tui: typeof PiTui
  readonly theme: typeof PiTheme
  readonly settings: typeof PiSettings
}

const loadModules = (packageRoot: string): Effect.Effect<PickerModules, RepositoryPickerError> =>
  Effect.tryPromise({
    try: async (): Promise<PickerModules> => {
      const [tui, theme, settings] = await Promise.all([
        import(pathToFileURL(join(packageRoot, '../pi-tui/dist/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/modes/interactive/theme/theme.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/core/settings-manager.js')).href),
      ])
      return { tui, theme, settings }
    },
    catch: cause =>
      new RepositoryPickerError({
        message: `Cannot load Pi's terminal interface: ${errorText(cause)}`,
        cause,
      }),
  })

interface Menu {
  readonly heading: string
  readonly items: readonly PiTui.SelectItem[]
  readonly filterable: boolean
  readonly hints: readonly (readonly [key: string, action: string])[]
}

const present = (
  { tui, theme: themes }: PickerModules,
  directory: string,
  menu: Menu
): Effect.Effect<string | undefined> =>
  Effect.callback<string | undefined>(resume => {
    const { theme } = themes
    const dim = (text: string) => theme.fg('dim', text)
    const muted = (text: string) => theme.fg('muted', text)
    const items = [...menu.items]
    const listTheme = { ...themes.getSelectListTheme(), description: (text: string) => text }
    const layout = {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: Math.max(...items.map(item => item.label.length)) + 3,
    }
    const header: PiTui.Component = {
      render: width => {
        const folder = `${ICON.folder} `
        const budget = width - tui.visibleWidth(folder) - tui.visibleWidth(menu.heading)
        const path = tailToWidth(displayPath(directory), budget, tui.visibleWidth)
        return [
          tui.truncateToWidth(
            `${theme.bold(theme.fg('syntaxType', `${folder}${path}`))}${muted(menu.heading)}`,
            width
          ),
        ]
      },
      invalidate: () => undefined,
    }
    const hints = new tui.TruncatedText(
      menu.hints.map(([key, action]) => dim(key) + muted(` ${action}`)).join('  '),
      0,
      0
    )
    const query = new tui.Input()
    const root = new tui.Container()
    const terminal = new tui.ProcessTerminal()
    const screen = new tui.TuiMainScreen(terminal)
    const visible = Math.max(1, Math.min(VISIBLE, terminal.rows - CHROME_ROWS))
    let settled = false
    let closed = false
    let list = new tui.SelectList(items, visible, listTheme, layout)
    const close = () => {
      if (closed) return
      closed = true
      const { hardwareCursorRow } = screen.captureRenderState()
      screen.stop({ preserveScreen: true })
      process.stdout.write(`${hardwareCursorRow > 0 ? `\x1b[${hardwareCursorRow}A` : ''}\r\x1b[J`)
    }
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      const handOver = () => {
        close()
        resume(Effect.succeed(value))
      }
      void terminal.drainInput(DRAIN_MS).then(handOver, handOver)
    }
    const rebuild = () => {
      const filter = query.getValue()
      const matches = tui.fuzzyFilter(items, filter, item => item.value)
      list = new tui.SelectList(matches, visible, listTheme, layout)
      list.onSelect = item => finish(item.value)
      list.onCancel = () => finish(undefined)
      root.children = [
        header,
        new tui.Spacer(1),
        matches.length === 0
          ? new tui.TruncatedText(muted('  No matching repositories'), 0, 0)
          : list,
        ...(filter.length === 0
          ? []
          : [new tui.TruncatedText(`${dim('filter')} ${theme.fg('text', filter)}`, 0, 0)]),
        new tui.Spacer(1),
        hints,
      ]
    }
    const picker: PiTui.Component = {
      render: width => root.render(width),
      invalidate: () => root.invalidate(),
      handleInput: data => {
        const keys = tui.getKeybindings()
        if (NAVIGATION.some(action => keys.matches(data, action))) list.handleInput(data)
        else if (menu.filterable) {
          const before = query.getValue()
          query.handleInput(data)
          const typed = query.getValue()
          if (!printable(typed)) query.setValue(dropControls(typed))
          if (query.getValue() !== before) rebuild()
        }
        screen.requestRender()
      },
    }
    rebuild()
    screen.addChild(picker)
    screen.setFocus(picker)
    screen.start()
    return Effect.sync(() => {
      settled = true
      close()
    })
  })

const prepare = Effect.fnUntraced(function* (
  packageRoot: string,
  directory: string
): Effect.fn.Return<PickerModules, RepositoryPickerError> {
  const modules = yield* loadModules(packageRoot)
  const name = yield* Effect.try({
    try: () =>
      modules.settings.SettingsManager.create(directory, globalPiAgentDir(), {
        projectTrusted: false,
      }).getTheme(),
    catch: cause =>
      new RepositoryPickerError({
        message: `Cannot read the Pi theme setting: ${errorText(cause)}`,
        cause,
      }),
  })
  modules.theme.initTheme(name)
  return modules
})

export const chooseRepository = Effect.fnUntraced(function* (
  packageRoot: string,
  directory: string,
  repositories: readonly Repository[]
): Effect.fn.Return<string | undefined, RepositoryPickerError> {
  const modules = yield* prepare(packageRoot, directory)
  const { theme } = modules.theme
  const muted = (text: string) => theme.fg('muted', text)
  const now = yield* Clock.currentTimeMillis
  const name = yield* present(modules, directory, {
    heading: `${NOT_A_REPOSITORY} Open dev in:`,
    items: repositories.map(repository => ({
      value: repository.name,
      label: repository.name,
      description: [
        repository.branch === undefined
          ? undefined
          : theme.fg('success', `${theme.bold(ICON.branch)} ${repository.branch}`),
        repository.lastUsed === undefined ? undefined : muted(ago(now, repository.lastUsed)),
      ]
        .filter(part => part !== undefined)
        .join(theme.fg('dim', ' • ')),
    })),
    filterable: true,
    hints: [
      ['↑↓', 'select'],
      ['type', 'filter'],
      ['enter', 'open'],
      ['esc', 'quit'],
    ],
  })
  return name === undefined ? undefined : join(directory, name)
})

export const confirmInitialization = Effect.fnUntraced(function* (
  packageRoot: string,
  directory: string
): Effect.fn.Return<boolean, RepositoryPickerError> {
  const modules = yield* prepare(packageRoot, directory)
  const choice = yield* present(modules, directory, {
    heading: NOT_A_REPOSITORY,
    items: [
      {
        value: INITIALIZE,
        label: 'Initialize a repository here',
        description: modules.theme.theme.fg('muted', 'git init'),
      },
    ],
    filterable: false,
    hints: [
      ['enter', 'initialize'],
      ['esc', 'quit'],
    ],
  })
  return choice === INITIALIZE
})
