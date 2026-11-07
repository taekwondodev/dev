// Renders transcript scenes with Pi's real components and the user's theme, then converts ANSI to HTML.
import fs from 'node:fs'
const P = '/Users/taekwondodev/Developer/dev/node_modules/@earendil-works/pi-coding-agent/dist'
const pi = await import(P + '/index.js')
const tui = await import('/Users/taekwondodev/Developer/dev/node_modules/@earendil-works/pi-tui/dist/index.js')
const { withBuiltInRenderers } = await import(P + '/core/tools/renderers/index.js')
const { theme } = await import(P + '/modes/interactive/theme/theme.js')
const R = await import('./work-render.mjs')
pi.initTheme('rose-pine-moon')
const W = 128
const ui = { requestRender() {} }
const CWD = '/Users/taekwondodev/Developer/dev'
const SESS = '/Users/taekwondodev/Developer/dev/.dev/child-sessions/'

// Real children from this session.
const child = (file, o) => {
  const entries = fs.readFileSync(SESS + file, 'utf8').trim().split('\n').map(JSON.parse)
  const turns = []
  let answer = ''
  for (const e of entries) {
    const m = e.message
    if (m?.role !== 'assistant') continue
    const calls = (m.content || []).filter((c) => c.type === 'toolCall').map((c) => {
      const a = c.arguments || {}
      const target = String(a.path || a.pattern || a.command || '').replace(CWD + '/', '').replace(/^.*node_modules\/@earendil-works\//, '').replace('/Users/taekwondodev/', '~/')
      return `${c.name} ${target}`.trim()
    })
    if (calls.length) turns.push(calls)
    const text = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    if (text) answer = text
  }
  return { ...o, turnsList: turns, answer }
}
const c1 = child('2026-11-07T08-26-21-843Z_01a1b51d-a713-7420-a07a-5299194b5356.jsonl', { id: 'f878935f-e5d3-4663-901c-1b2ce511c454', taskId: 'research-live-activity', skill: 'investigation', access: 'read-only', model: 'claude-bridge/claude-sonnet-5-5', effort: 'medium', turns: 11, toolUses: 42, tokens: 536310, elapsedMs: 94400 })
const c2 = child('2026-11-07T08-26-21-843Z_01a1b51d-a713-7147-8d23-c46b22c4dd86.jsonl', { id: '15b90b02-6559-4463-bf31-86e79f1d4757', taskId: 'research-pi-seams', skill: 'investigation', access: 'read-only', model: 'claude-bridge/claude-sonnet-5-5', effort: 'medium', turns: 25, toolUses: 70, tokens: 1485919, elapsedMs: 172439 })
const liveAt = (c, turn, toolUses, tokens, ms) => ({ ...c, turns: turn, toolUses, tokens, elapsedMs: ms, tail: c.turnsList[turn - 1].at(-1) })

// ANSI to HTML.
const toHtml = (lines) => lines.map((line) => {
  line = line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  let fg = null, bg = null, bold = false, dim = false, italic = false, out = '', open = false
  const style = () => [fg && `color:${fg}`, bg && `background:${bg}`, bold && 'font-weight:700', italic && 'font-style:italic', dim && 'opacity:.6'].filter(Boolean).join(';')
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/)
    if (m) {
      const c = (m[1] || '0').split(';').map(Number)
      for (let i = 0; i < c.length; i++) {
        const k = c[i]
        if (k === 0) { fg = bg = null; bold = dim = italic = false }
        else if (k === 1) bold = true
        else if (k === 2) dim = true
        else if (k === 3) italic = true
        else if (k === 22) bold = dim = false
        else if (k === 23) italic = false
        else if (k === 39) fg = null
        else if (k === 49) bg = null
        else if ((k === 38 || k === 48) && c[i + 1] === 2) { const v = `rgb(${c[i + 2]},${c[i + 3]},${c[i + 4]})`; if (k === 38) fg = v; else bg = v; i += 4 }
      }
      continue
    }
    if (!part) continue
    out += `<span style="${style()}">${part.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`
  }
  return `<div class="ln">${out}</div>`
}).join('')

// Components.
const user = (t) => new pi.UserMessageComponent(t)
const asst = (t, thinking = true) => new pi.AssistantMessageComponent({ role: 'assistant', content: [...(thinking ? [{ type: 'thinking', thinking: '.' }] : []), { type: 'text', text: t }], stopReason: 'toolUse', usage: {}, timestamp: 0 }, true)
// dev-final-reply-bg: a final reply gets a near-neutral background just above the user message background.
const finalBg = (() => { const { h, l } = tui.colorToOkhsl(theme.colors.userMessageBg); return tui.backgroundAnsi(tui.okhslColor(h, 0.08, l + 0.03), theme.getColorMode()) })()
const final = (t) => ({ render: (w) => asst(t, false).render(w).map((l) => { const pad = l + ' '.repeat(Math.max(0, w - tui.visibleWidth(l))); return finalBg + pad.replace(/\x1b\[(?:0|49)?m/g, (m) => m + finalBg) + '\x1b[49m' }) })
const tool = (name, args, def, result) => {
  const c = new pi.ToolExecutionComponent(name, 'id-' + Math.random(), args, {}, def, ui, CWD)
  c.markExecutionStarted?.(); c.setArgsComplete?.()
  if (result) c.updateResult({ content: [{ type: 'text', text: result.text }], details: result.details ?? {}, isError: false, durationMs: result.ms ?? 400 }, false)
  return c
}
const bash = (command, text, ms = 400) => tool('bash', { command }, withBuiltInRenderers('bash', undefined), { text, ms })
const read = (path, text) => tool('read', { path }, withBuiltInRenderers('read', undefined), { text })

// `work` rows.
const delegateArgs = (c) => ({ action: 'delegate', taskId: c.taskId, access: c.access, skill: c.skill, prompt: 'Answer the research ticket below for the repository at /Users/taekwondodev/Developer/dev…' })
const attemptResult = (c) => ({ kind: 'attempt', attempt: { id: c.id, taskId: c.taskId, kind: 'agent', status: 'running', access: c.access, cwd: CWD } })
const workDef = (render) => ({ name: 'work', ...render })
const workRow = (c, shape, moment) => {
  const lines = (theme) => {
    if (shape === 'live') {
      if (moment >= 3) return R.childLines(theme, { ...c, tail: R.resultSummary(c.answer) }, 'completed')
      return R.childLines(theme, moment === 1 ? liveAt(c, 1, 3, 24100, 9000) : liveAt(c, Math.min(6, c.turnsList.length), c === c1 ? 24 : 21, c === c1 ? 241000 : 388000, c === c1 ? 51000 : 66000), 'running')
    }
    return R.childLines(theme, c, 'launched')
  }
  const def = shape === 'outcome'
    ? workDef({ renderCall: () => new R.Text('', 0, 0), renderResult: () => new R.Text('', 0, 0) })
    : workDef({ renderCall: (args, theme) => R.textBlock(lines(theme).slice(0, 1)), renderResult: (result, o, theme) => R.textBlock(lines(theme).slice(1)) })
  return tool('work', delegateArgs(c), def, { text: JSON.stringify(attemptResult(c)), details: attemptResult(c) })
}
const answerLines = (c, max = 22) => {
  const ls = c.answer.split('\n')
  return [...ls.slice(0, max), ...(ls.length > max ? [`… ${ls.length - max} righe in più`] : [])]
}
const trailLines = (c) => c.turnsList.map((calls, i) => `↻${String(i + 1).padEnd(3)}${calls.join(' · ')}`)
const outcomeMsg = (cs, shape, expand, expanded) => {
  const content = 'Background work outcomes. These are producer observations, not verification; reconcile artifacts and honor dev-cycle checkpoints before proceeding. Report any recorded worktree and follow its cleanup guidance.\n' + JSON.stringify(cs.map((c) => ({ id: c.id, taskId: c.taskId, kind: 'agent', status: 'completed', access: c.access, model: c.model, invokedSkill: c.skill, logs: [{ stream: 'result', available: true, text: c.answer.slice(0, 1400), truncated: true }] })))
  const msg = { role: 'custom', customType: 'dev/work-outcome', content, display: true, details: {}, timestamp: 0 }
  const renderer = (m, opts, th) => {
    const box = new tui.Box(1, 1, (t) => th.bg('customMessageBg', t))
    if (shape === 'live') {
      box.addChild(new R.Text(th.fg('dim', '↳ esito consegnato al lead · ') + cs.map((c) => th.fg('success', '✓ ') + th.fg('muted', `${c.skill} ${c.taskId.replace(/-/g, ' ')}`)).join('   '), 0, 0))
      return box
    }
    cs.forEach((c, i) => {
      if (i) box.addChild(new tui.Spacer(1))
      const showAnswer = expand === 'full' || expanded
      box.addChild(R.textBlock(R.childLines(th, { ...c, tail: showAnswer ? undefined : R.resultSummary(c.answer) + th.fg('dim', '   ctrl+o per espandere') }, 'completed')))
      if (expanded && expand === 'trail') {
        box.addChild(new tui.Spacer(1))
        box.addChild(new R.Text(th.fg('muted', 'Lavoro del figlio'), 2, 0))
        box.addChild(new R.Text(trailLines(c).map((l) => th.fg('dim', l)).join('\n'), 2, 0))
        box.addChild(new tui.Spacer(1))
        box.addChild(new R.Text(th.fg('muted', 'Risposta'), 2, 0))
      }
      if (showAnswer) box.addChild(new R.Text(answerLines(c).map((l) => th.fg('text', l)).join('\n'), 2, 0))
    })
    return box
  }
  return new pi.CustomMessageComponent(msg, renderer)
}
const defaultOutcome = (cs) => new pi.CustomMessageComponent({ role: 'custom', customType: 'dev/work-outcome', content: 'Background work outcomes. These are producer observations, not verification; reconcile artifacts and honor dev-cycle checkpoints before proceeding.\n' + JSON.stringify(cs), display: true, details: {}, timestamp: 0 })

const inspectCall = (actions) => {
  const args = { action: 'inspect', id: c1.id, stream: 'result', offset: 0 }
  const result = { kind: 'log', log: { stream: 'result', available: true, text: c1.answer.slice(0, 900), truncated: true, nextOffset: 12000 } }
  const def = actions === 'compact'
    ? workDef({ renderCall: (a, th) => new R.Text(th.fg('toolTitle', th.bold('work inspect')) + '  ' + th.fg('accent', 'investigation') + ' ' + th.fg('muted', 'research live activity') + th.fg('dim', ' · result da 0'), 0, 0), renderResult: (r, o, th) => new R.Text(th.fg('dim', `12.0 KB letti · continua da 12000`) + (o.expanded ? '\n\n' + c1.answer.slice(0, 600) : th.fg('dim', '   ctrl+o per leggere')), 0, 0) })
    : workDef({})
  return tool('work', args, def, { text: JSON.stringify(result), details: result })
}
const processOutcome = (actions) => {
  const entry = { id: '9c1e2a40-…', taskId: 'work-check', kind: 'process', status: 'completed', exitCode: 0, cwd: CWD, logs: [{ stream: 'stdout', available: true, text: 'work:check  42 claims passed\nsmoke  ok', truncated: false }] }
  if (actions !== 'compact') return defaultOutcome([entry])
  return new pi.CustomMessageComponent({ role: 'custom', customType: 'dev/work-outcome', content: '', display: true, details: {}, timestamp: 0 }, (m, o, th) => {
    const box = new tui.Box(1, 1, (t) => th.bg('customMessageBg', t))
    box.addChild(new R.Text(th.fg('success', '✓ ') + th.fg('toolTitle', th.bold('$ npm run work:check')) + th.fg('dim', '  exit 0 · 38s · ctrl+o per l\'output'), 0, 0))
    return box
  })
}

const scene = ({ shape = 'split', moment = 3, expand = 'trail', expanded = false, actions = 'compact' }) => {
  const parts = [
    user('Confermo, traccia la mappa'),
    asst('Creo la mappa su GitHub e i ticket, poi lancio le due ricerche in parallelo.'),
    bash('gh-axi issue subissue add 274 275 276 277 278 279 280 281', '  added[7]: #275,#276,#277,#278,#279,#280,#281\nhelp[1]:\n  Run `gh-axi issue view 274` to see the parent with its sub-issues', 1900),
    workRow(c1, shape, moment),
    workRow(c2, shape, moment),
    final('Ho tracciato la mappa e lanciato le due ricerche: ti aggiorno quando arrivano gli esiti.'),
  ]
  if (moment >= 2) parts.push(
    user('Nel frattempo, cosa dice HANDOFF.md sul lavoro in pausa?'),
    read('HANDOFF.md', fs.readFileSync(CWD + '/HANDOFF.md', 'utf8').split('\n').slice(0, 14).join('\n')),
    final('Il lavoro in pausa è la migrazione nativa macOS: worktree `befd7fd6…`, implementazione interrotta prima dei test. Nessun commit autorizzato.'),
  )
  if (moment >= 3) parts.push(
    outcomeMsg([c1], shape, expand, expanded),
    asst('Verifico sul codice i punti decisivi della prima ricerca.'),
    bash('sed -n 66p src/pi-child.ts; sed -n 22,31p src/work-protocol.ts', fs.readFileSync(CWD + '/src/pi-child.ts', 'utf8').split('\n')[65] + '\n' + fs.readFileSync(CWD + '/src/work-protocol.ts', 'utf8').split('\n').slice(21, 31).join('\n'), 100),
    ...(actions ? [inspectCall(actions), processOutcome(actions)] : []),
    outcomeMsg([c2], shape, expand, expanded),
    final('Entrambe le ricerche sono chiuse e verificate; la mappa è aggiornata.'),
  )
  return toHtml(parts.flatMap((p) => p.render(W)))
}

const out = {}
for (const shape of ['split', 'live', 'outcome']) for (const moment of [1, 2, 3]) for (const ex of [0, 1]) out[`shape|${shape}|${moment}|${ex}`] = scene({ shape, moment, expanded: !!ex, actions: null })
for (const expand of ['summary', 'trail', 'full']) for (const ex of [0, 1]) out[`expand|${expand}|3|${ex}`] = scene({ expand, expanded: !!ex, actions: null })
for (const actions of ['compact', 'default']) for (const ex of [0, 1]) out[`actions|${actions}|3|${ex}`] = scene({ actions, expanded: !!ex })
fs.writeFileSync('/tmp/pi-render/scenes.json', JSON.stringify(out))
console.log(Object.keys(out).length, 'scenes', Math.round(JSON.stringify(out).length / 1024), 'KB')
