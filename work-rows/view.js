// Scenes are real Pi renders (rose-pine-moon) precomputed per state; this only switches them.
let moment = 3, expanded = 0
const NOTES = { 1: 'appena lanciati: il lead ha finito il turno', 2: 'i figli lavorano; tu chiedi altro e il transcript scorre', 3: 'esiti consegnati, il lead verifica e continua' }
const render = () => {
  const q = window.QKEY, v = document.documentElement.dataset.variant || window.QDEFAULT
  const m = q === 'shape' ? moment : 3
  const t = document.getElementById('term')
  t.innerHTML = window.SCENES[`${q}|${v}|${m}|${expanded}`] || ''
  if (m === 3 && q !== 'shape') t.scrollTop = t.scrollHeight * 0.45
  document.querySelectorAll('[data-m]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.m === moment)))
  const e = document.getElementById('exp'); if (e) e.setAttribute('aria-pressed', String(!!expanded))
  const n = document.getElementById('note'); if (n) n.textContent = q === 'shape' ? NOTES[moment] : ''
}
document.addEventListener('lavagna:option', render)
document.addEventListener('click', (ev) => {
  const d = ev.target.dataset || {}
  if (d.m) moment = +d.m
  if (ev.target.id === 'exp') expanded = expanded ? 0 : 1
  if (d.m || ev.target.id === 'exp') render()
})
render()
