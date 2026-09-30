import { Effect, Schema } from 'effect'

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Share = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))

const CacheUsage = Schema.Struct({
  requests: Count,
  input: Amount,
  cacheRead: Amount,
  cacheWrite: Amount,
  hitRate: Schema.NullOr(Share),
})
export type CacheUsage = typeof CacheUsage.Type

const ToolSizes = Schema.Struct({
  name: Schema.String,
  count: Count,
  bytes: Count,
  meanBytes: Amount,
  medianBytes: Count,
  p90Bytes: Count,
  share: Share,
})
export type ToolSizes = typeof ToolSizes.Type

const ToolResults = Schema.Struct({
  count: Count,
  bytes: Count,
  meanBytes: Schema.NullOr(Amount),
  tools: Schema.Array(ToolSizes),
})
export type ToolResults = typeof ToolResults.Type

const TimeSplit = Schema.Struct({
  modelMs: Schema.Finite,
  toolMs: Schema.Finite,
  userMs: Schema.Finite,
})
export type TimeSplit = typeof TimeSplit.Type

const Baseline = Schema.Struct({
  sample: Schema.Struct({
    leadSessions: Count,
    emptyLeadSessions: Count,
    childSessions: Count,
    undecodableLines: Count,
    firstDate: IsoDate,
    lastDate: IsoDate,
  }),
  cache: Schema.Struct({ lead: CacheUsage, child: CacheUsage }),
  toolCallsPerSession: Schema.Struct({ median: Count, minimum: Count, maximum: Count }),
  children: Schema.Struct({
    agentAttempts: Count,
    processAttempts: Count,
    meanPerSession: Amount,
    sessionShare: Share,
  }),
  latency: Schema.Struct({ requests: Count, p50Ms: Schema.Finite, p90Ms: Schema.Finite }),
  timeSplit: TimeSplit,
  toolResults: Schema.Struct({ lead: ToolResults, child: ToolResults }),
})
export type Baseline = typeof Baseline.Type

interface Charts {
  readonly usage: string
  readonly tools: string
}

const decodeBaseline = Schema.decodeUnknownEffect(Schema.fromJsonString(Baseline))

export const percent = (share: number): string =>
  share > 0 && share < 0.0005 ? '<0.1%' : `${(share * 100).toFixed(1)}%`

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

export const size = (bytes: number): string => {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export const orUnavailable = <A>(value: A | null, format: (value: A) => string): string =>
  value === null ? 'n/a' : format(value)

const isXmlCharacter = (character: string): boolean =>
  character === '\t' ||
  character === '\n' ||
  character === '\r' ||
  (character >= ' ' && character < '\uFFFE')

const escape = (text: string): string =>
  [...text]
    .filter(isXmlCharacter)
    .join('')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const DISPLAY = 'SF Pro Display, Helvetica Neue, sans-serif'
const TEXT = 'SF Pro Text, Helvetica Neue, sans-serif'
const PRIMARY = '#F5F5F5'
const SECONDARY = '#8E8E93'

const text = (
  x: number,
  y: number,
  content: string,
  options: {
    readonly fill: string
    readonly size: number
    readonly font?: string
    readonly anchor?: 'start' | 'middle' | 'end'
  }
): string =>
  `  <text x="${x}" y="${y}" text-anchor="${options.anchor ?? 'middle'}" fill="${options.fill}" font-family="${options.font ?? TEXT}" font-size="${options.size}">${escape(content)}</text>\n`

const dateRange = ({ sample: { firstDate, lastDate } }: Baseline): string =>
  firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`

const frame = (width: number, height: number, title: string, subtitle: string): string =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">\n`,
    `  <title>${escape(`${title}: ${subtitle}`)}</title>\n`,
    `  <rect width="${width}" height="${height}" rx="28" fill="#111111"/>\n`,
    text(width / 2, 48, title, { fill: PRIMARY, size: 20, font: DISPLAY }),
    text(width / 2, 74, subtitle, { fill: SECONDARY, size: 13 }),
  ].join('')

interface Tile {
  readonly label: string
  readonly value: string
  readonly caption: string
  readonly color: string
}

const TILE_WIDTH = 180
const TILE_GAP = 24
const TILE_MARGIN = 42
const BODY_TOP = 100

const renderUsage = (baseline: Baseline): string => {
  const tiles: readonly Tile[] = [
    {
      label: 'Cache hit rate',
      value: orUnavailable(baseline.cache.lead.hitRate, percent),
      caption: 'lead input tokens',
      color: '#7DFFB3',
    },
    {
      label: 'Tool calls',
      value: String(baseline.toolCallsPerSession.median),
      caption: 'median per lead session',
      color: '#64D2FF',
    },
    {
      label: 'Children',
      value: baseline.children.meanPerSession.toFixed(2),
      caption: 'mean per lead session',
      color: '#FFD60A',
    },
    {
      label: 'Model latency',
      value: seconds(baseline.latency.p50Ms),
      caption: 'p50 per lead request',
      color: '#FF9F0A',
    },
    {
      label: 'Tool result size',
      value: orUnavailable(baseline.toolResults.lead.meanBytes, size),
      caption: 'mean per lead result',
      color: '#BF5AF2',
    },
  ]
  const width = TILE_MARGIN * 2 + tiles.length * TILE_WIDTH + (tiles.length - 1) * TILE_GAP
  const body = tiles
    .map((tile, index) => {
      const x = TILE_MARGIN + index * (TILE_WIDTH + TILE_GAP)
      const center = x + TILE_WIDTH / 2
      return [
        `  <rect x="${x}" y="${BODY_TOP}" width="${TILE_WIDTH}" height="160" rx="20" fill="#1C1C1E"/>\n`,
        text(center, BODY_TOP + 44, tile.label, { fill: SECONDARY, size: 13 }),
        text(center, BODY_TOP + 92, tile.value, { fill: tile.color, size: 28, font: DISPLAY }),
        text(center, BODY_TOP + 122, tile.caption, { fill: SECONDARY, size: 12 }),
      ].join('')
    })
    .join('')
  return `${frame(
    width,
    BODY_TOP + 200,
    'dev in real use',
    `${baseline.sample.leadSessions} lead and ${baseline.sample.childSessions} child sessions, ${dateRange(baseline)}`
  )}${body}</svg>\n`
}

const TOOLS_WIDTH = 720
const NAME_END = 164
const BAR_START = 180
const BAR_SPAN = 444
const ROW_HEIGHT = 32
const BAR_HEIGHT = 20

const bar = (y: number, width: number): string => {
  if (width <= 4)
    return `  <rect x="${BAR_START}" y="${y}" width="${width}" height="${BAR_HEIGHT}" fill="#64D2FF"/>\n`
  const straight = Math.round((width - 4) * 10) / 10
  return `  <path d="M${BAR_START} ${y}h${straight}a4 4 0 0 1 4 4v${BAR_HEIGHT - 8}a4 4 0 0 1 -4 4h-${straight}z" fill="#64D2FF"/>\n`
}

const renderTools = (baseline: Baseline): string => {
  const { lead } = baseline.toolResults
  const rows = lead.tools.length === 0 ? 1 : lead.tools.length
  const height = BODY_TOP + rows * ROW_HEIGHT + 36
  const subtitle = `${lead.count} results from ${baseline.sample.leadSessions} lead sessions, ${dateRange(baseline)}`
  const body =
    lead.tools.length === 0
      ? text(TOOLS_WIDTH / 2, BODY_TOP + 20, 'No tool results', { fill: SECONDARY, size: 13 })
      : lead.tools
          .map((tool, index) => {
            const top = BODY_TOP + index * ROW_HEIGHT
            const width = Math.round(tool.share * BAR_SPAN * 10) / 10
            return [
              text(NAME_END, top + 15, tool.name, { fill: SECONDARY, size: 13, anchor: 'end' }),
              bar(top + 1, width),
              text(BAR_START + width + 8, top + 15, percent(tool.share), {
                fill: PRIMARY,
                size: 13,
                anchor: 'start',
              }),
            ].join('')
          })
          .join('')
  return `${frame(TOOLS_WIDTH, height, 'Share of tool result bytes, lead sessions', subtitle)}${body}</svg>\n`
}

export const renderCharts = (baselineJson: string): Effect.Effect<Charts, Schema.SchemaError> =>
  decodeBaseline(baselineJson, { onExcessProperty: 'error' }).pipe(
    Effect.map(baseline => ({ usage: renderUsage(baseline), tools: renderTools(baseline) }))
  )
