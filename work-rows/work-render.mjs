// Prototype renderers for dev's `work` rows and `dev/work-outcome` messages, written against
// Pi's public renderer API so the shape can carry over to the global extension.
import { Container, Text } from '/Users/taekwondodev/Developer/dev/node_modules/@earendil-works/pi-tui/dist/index.js'

const SPIN = '⠹'
export const shortModel = (m) => (m ?? 'model pending').slice((m ?? '').indexOf('/') + 1)
export const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)
export const duration = (ms) => `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`
const human = (key) => key.replace(/-/g, ' ')
const role = (a) => a.skill ?? (a.coordinate ? 'coordinator' : a.access === 'read-only' ? 'reader' : 'writer')

// One child: header, meta, and a └ line. `child` merges the call args with known facts.
export function childLines(theme, child, state) {
  const glyph = { launched: ['↗', 'dim'], running: [SPIN, 'accent'], completed: ['✓', 'success'], failed: ['✗', 'error'] }[state]
  const header = theme.fg('dim', '▸ ') + theme.bold(theme.fg('accent', role(child))) + '  ' + theme.fg('muted', human(child.taskId))
  const meta = [shortModel(child.model), `thinking: ${child.effort}`]
  if (state === 'launched') meta.push(child.access, 'avviato')
  else meta.push(`↻${child.turns}`, `${child.toolUses} tool uses`, `${tokens(child.tokens)} token`, duration(child.elapsedMs))
  const lines = [header, theme.fg(glyph[1], glyph[0]) + ' ' + theme.fg('dim', meta.join(' · '))]
  if (child.tail !== undefined) lines.push(theme.fg('dim', '  └ ') + (state === 'failed' ? theme.fg('error', child.tail) : theme.fg('muted', child.tail)))
  return lines
}

// Collapsed result line: a workflow result contract shows format, status and list sizes.
export function resultSummary(answer) {
  const json = answer.match(/^```json\n([\s\S]*?)\n```/)
  if (json) {
    try {
      const value = JSON.parse(json[1])
      if (value.format && value.status) {
        const lists = Object.entries(value).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${v.length} ${k}`)
        return [value.format, value.status, ...lists].join(' · ')
      }
    } catch {}
  }
  return answer.split('\n').find((l) => l.trim()) ?? ''
}

export const textBlock = (lines) => new Text(lines.join('\n'), 0, 0)
export { Container, Text }
