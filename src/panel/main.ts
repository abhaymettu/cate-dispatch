// Dispatch board panel. Vanilla, no modules; talks to the extension server via
// relative fetches (Cate's proxy injects the bearer token).
//
// Shape: the board is the page, the composer is one pinned card, and the flow
// (thought -> questions -> review) morphs inside that card without moving
// anything else. See ../../DECISIONS.md for why the server exists at all.
//
// The board is reconciled by task id rather than rebuilt. That is not an
// optimisation: the poll runs every 2.5s, and re-creating the rows would restart
// every entry animation and make each state change a repaint instead of the
// crossfade the CSS is written for.

interface CateHost {
  panel: { id: string }
  theme: { get(): Promise<{ id: string; type: 'dark' | 'light'; app: Record<string, string> }> }
}
declare const cate: CateHost | undefined

interface Question { q: string; default: string }
interface Plan {
  profile: string
  repo: string | null
  slug: string
  questions: Question[]
  assumptions: string[]
  /** Set only when the thought named one; null means the server's default. */
  model: string | null
  effort: string | null
}

/** Mirrors the server's TaskView (src/tasks.ts) — all of it, not just the bits
    the old panel happened to render. */
interface TaskView {
  id: string
  thought: string
  target: string
  cwd: string
  worktree: string | null
  branch: string | null
  specFile: string
  terminalPanelId: string
  createdAt: number
  archived?: boolean
  state: 'working' | 'waiting' | 'done' | 'unknown'
  detail: string | null
  stateAt: number | null
}

/** The server fuses two very different situations into `waiting`: a permission
    prompt (blocked on you) and a finished turn (has a transcript TLDR). They
    need different affordances, so split them back out here. */
type RowState = 'working' | 'permission' | 'replied' | 'done' | 'unknown'

type Stage = 'thought' | 'questions' | 'review'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const frame = $('frame')
const thoughtEl = $<HTMLTextAreaElement>('thought')
const targetEl = $<HTMLInputElement>('target')
const specEl = $<HTMLTextAreaElement>('spec')
const statusEl = $('status')
const primary = $<HTMLButtonElement>('primary')
const primaryWide = $<HTMLButtonElement>('primary-wide')
const backBtn = $<HTMLButtonElement>('back')
const orbEl = $('orb')
const cardsEl = $<HTMLUListElement>('cards')

let stage: Stage = 'thought'
let draftId = ''
let plan: Plan | null = null
let busySince = 0
let busyTimer = 0
const expanded = new Set<string>() // board rows the user has expanded

async function api<T>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(`api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

/** One sprite reference. The sprite is drawn on a 24 grid, AIcss's icon size. */
function svg(icon: string, cls = ''): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  s.setAttribute('viewBox', '0 0 24 24')
  if (cls) s.setAttribute('class', cls)
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#${icon}`)
  s.appendChild(use)
  return s
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

// --- status ------------------------------------------------------------------

/** kind: 'work' shimmers (thinking-state), 'flat' is a plain note, 'bad' is an
    error. */
function setStatus(text: string, kind: 'work' | 'flat' | 'bad' = 'work'): void {
  statusEl.textContent = text
  // the line is one ellipsised row; a long server error is unreadable without this
  statusEl.title = text
  statusEl.classList.toggle('shimmer', kind === 'work' && text !== '')
  statusEl.classList.toggle('bad', kind === 'bad')
}

/** The router and spec calls are single-shot blocking `claude -p` runs (240s
    timeout, no streaming), so after a few seconds show elapsed time — an
    indicator that just cycles for a minute reads as hung. */
function setBusy(on: boolean, label = ''): void {
  clearInterval(busyTimer)
  orbEl.hidden = !on
  primary.hidden = on || stage !== 'thought'
  primaryWide.hidden = on || stage === 'thought'
  if (!on) {
    frame.removeAttribute('data-busy')
    busySince = 0
    return
  }
  frame.setAttribute('data-busy', '')
  busySince = Date.now()
  setStatus(label)
  busyTimer = setInterval(() => {
    const s = Math.floor((Date.now() - busySince) / 1000)
    setStatus(s < 5 ? label : `${label} ${s}s`)
  }, 1000) as unknown as number
}

function fail(err: unknown): void {
  setBusy(false)
  setStatus(err instanceof Error ? err.message : String(err), 'bad')
}

// --- theme -------------------------------------------------------------------

let themeId = ''

/** Cate fires no theme-change event, so this rides the board poll. All 43 app
    tokens are always present (the host merges over a base). */
async function applyTheme(): Promise<void> {
  try {
    if (typeof cate === 'undefined') return
    const theme = await cate.theme.get()
    if (theme.id === themeId) return
    themeId = theme.id
    document.documentElement.dataset.theme = theme.type
    for (const [k, v] of Object.entries(theme.app ?? {})) {
      document.documentElement.style.setProperty(`--cate-${k}`, v)
    }
  } catch {
    /* fallbacks in style.css hold */
  }
}

// --- the stage machine -------------------------------------------------------

const STAGES: Stage[] = ['thought', 'questions', 'review']

const PRIMARY_LABEL: Record<Stage, string> = {
  thought: 'Dispatch',
  questions: 'Write spec',
  review: 'Approve & spawn',
}

function pillLabel(btn: HTMLButtonElement, text: string): void {
  const span = btn.querySelector('.pillLabel')
  if (span) span.textContent = text
}

/** Which step the rail lights. Usually the live stage, but not always: while the
    spec is being written the stage is still `questions` and the rail should
    already be on `review`, because writing the spec is what is happening. */
function setRail(step: Stage): void {
  const at = STAGES.indexOf(step)
  document.querySelectorAll<HTMLElement>('.railStep').forEach((el) => {
    const i = STAGES.indexOf(el.dataset.step as Stage)
    el.classList.toggle('on', i === at)
    el.classList.toggle('done', i < at)
  })
}

function setStage(next: Stage): void {
  stage = next
  frame.dataset.stage = next

  for (const id of STAGES) {
    const section = $(`stage-${id}`)
    const on = id === next
    section.classList.toggle('on', on)
    // keep collapsed stages out of the tab order without killing the transition
    if (on) section.removeAttribute('inert')
    else section.setAttribute('inert', '')
  }

  setRail(next)

  // stage 1 sends with the round arrow; later stages need a verb
  primary.hidden = next !== 'thought'
  primaryWide.hidden = next === 'thought'
  pillLabel(primaryWide, PRIMARY_LABEL[next])
  primaryWide.disabled = false
  backBtn.hidden = next === 'thought'
  pillLabel(backBtn, next === 'review' ? 'Back' : 'Abort')

  syncPrimary()
  const focusEl = next === 'questions'
    ? document.querySelector<HTMLInputElement>('#qlist input')
    : next === 'review' ? specEl : null
  focusEl?.focus()
  // focusing a freshly-filled textarea lands the caret at the end, which scrolls
  // the spec to its last line — start at the top instead
  if (next === 'review') {
    specEl.setSelectionRange(0, 0)
    specEl.scrollTop = 0
  }
}

/** Stage 1's send button fills in (ai-agent-input's sendActive) once there is
    something to send. */
function syncPrimary(): void {
  const has = thoughtEl.value.trim().length > 0
  primary.disabled = !has
  primary.classList.toggle('sendActive', has)
}

/** ai-agent-input anchors its action row at both ends (attach left, send right).
    The left end here is the status line, which is empty at rest — so at rest it
    carries the shortcut instead of nothing. */
const REST_HINT = '⌘⏎ to dispatch'

function resetFlow(): void {
  draftId = ''
  plan = null
  setBusy(false)
  setStatus(REST_HINT, 'flat')
  setStage('thought')
}

// --- flow --------------------------------------------------------------------

async function startDispatch(): Promise<void> {
  const thought = thoughtEl.value.trim()
  if (!thought || busySince) return
  primary.disabled = true
  setBusy(true, 'Routing')
  try {
    const r = await api<{ draftId: string; target: string; targetExists: boolean; plan: Plan }>(
      'dispatch',
      { thought },
    )
    draftId = r.draftId
    plan = r.plan
    setBusy(false)
    setStatus('Answer or accept the defaults', 'flat')
    targetEl.value = r.target
    targetEl.title = r.target
    // an input clips its head, and the tail of a path is the part that identifies
    // it. `direction: rtl` would show the tail but bidi-scrambles the leading `/`,
    // so scroll instead.
    targetEl.scrollLeft = targetEl.scrollWidth
    $('specName').textContent = `${r.plan.slug || 'spec'}.md`
    $('specName').title = `${r.plan.slug || 'spec'}.md`

    // the routed profile is the most useful feedback and the old panel dropped it
    const pill = $('profile')
    pill.hidden = !r.plan.profile
    pill.textContent = r.plan.profile

    // if the thought asked to run with something, say so before it spawns
    const runWith = $('runWith')
    const parts = [r.plan.model, r.plan.effort].filter(Boolean)
    runWith.hidden = parts.length === 0
    runWith.textContent = parts.join(' · ')

    const assumptions = $('assumptions')
    assumptions.replaceChildren()
    for (const a of r.plan.assumptions) assumptions.appendChild(el('li', '', a))
    if (!r.targetExists) {
      assumptions.appendChild(el('li', 'warn', 'target does not exist — fix the path above'))
    }

    const qlist = $('qlist')
    qlist.replaceChildren()
    r.plan.questions.forEach((q, i) => {
      const row = el('div', 'qrow')
      const label = el('label', '', q.q)
      const input = el('input')
      input.value = q.default
      input.dataset.index = String(i)
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        const nextInput = qlist.querySelector<HTMLInputElement>(`input[data-index="${i + 1}"]`)
        if (nextInput) nextInput.focus()
        else void writeSpec()
      })
      row.append(label, input)
      qlist.appendChild(row)
    })
    setStage('questions')
  } catch (err) {
    fail(err)
    syncPrimary()
  }
}

async function writeSpec(): Promise<void> {
  if (!draftId || busySince) return
  primaryWide.disabled = true
  setRail('review')
  setBusy(true, 'Writing spec')
  try {
    const answers = Array.from($('qlist').querySelectorAll<HTMLInputElement>('input')).map((i) => i.value)
    const r = await api<{ spec: string }>('spec', { draftId, answers, target: targetEl.value })
    setBusy(false)
    setStatus('Edit before spawning if you need to', 'flat')
    specEl.value = r.spec
    setStage('review')
  } catch (err) {
    fail(err)
    setRail('questions')
    primaryWide.disabled = false
  }
}

async function approve(): Promise<void> {
  if (!draftId || busySince) return
  primaryWide.disabled = true
  setBusy(true, 'Spawning terminal')
  try {
    const r = await api<{ task: { id: string } }>('approve', { draftId, spec: specEl.value })
    thoughtEl.value = ''
    thoughtEl.style.height = 'auto'
    resetFlow()
    setStatus(`Spawned ${r.task.id}`, 'flat')
    setTimeout(() => { if (stage === 'thought' && !busySince) setStatus(REST_HINT, 'flat') }, 4000)
    void refreshBoard()
  } catch (err) {
    fail(err)
    primaryWide.disabled = false
  }
}

function runPrimary(): void {
  if (stage === 'thought') void startDispatch()
  else if (stage === 'questions') void writeSpec()
  else void approve()
}

// --- board -------------------------------------------------------------------

function age(ms: number): string {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000))
  if (m < 1) return 'just now'
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`
}

/** A finished turn carries a transcript TLDR; a permission prompt carries the
    Claude Code notification text. Both arrive as `waiting`. */
function rowState(t: TaskView): RowState {
  if (t.state !== 'waiting') return t.state
  const d = (t.detail ?? '').toLowerCase()
  const isPrompt = d.includes('permission') || d.includes('needs your') || d.includes('waiting for your')
  return isPrompt ? 'permission' : 'replied'
}

const ROW_STATES: RowState[] = ['working', 'permission', 'replied', 'done', 'unknown']

const ROW_ICON: Record<RowState, string> = {
  working: 'i-circle-arrow',
  permission: 'i-circle-alert',
  replied: 'i-circle-reply',
  done: 'i-circle-check',
  unknown: 'i-circle-dashed',
}

/** Board order. The server returns creation order, which buries the agents that
    are blocked on you under every agent that has already finished. Rank by what
    the row wants from you, newest activity first inside each rank. */
const ROW_RANK: Record<RowState, number> = {
  permission: 0,
  replied: 1,
  working: 2,
  unknown: 3,
  done: 4,
}

function byUrgency(a: TaskView, b: TaskView): number {
  const rank = ROW_RANK[rowState(a)] - ROW_RANK[rowState(b)]
  return rank !== 0 ? rank : (b.stateAt ?? b.createdAt) - (a.stateAt ?? a.createdAt)
}

const ROW_META: Record<RowState, string> = {
  working: '',
  permission: 'permission',
  replied: 'replied',
  done: '',
  unknown: '',
}

/** Everything a live row needs updating, resolved once at build time. */
interface Row {
  li: HTMLLIElement
  name: HTMLElement
  meta: HTMLElement
  caret: HTMLButtonElement
  archive: HTMLButtonElement
  tldr: HTMLElement
  branch: HTMLElement
  branchText: HTMLElement
  since: HTMLElement
  state: RowState | ''
}

const rows = new Map<string, Row>()

function buildRow(id: string): Row {
  const li = el('li', 'row')

  const main = el('button', 'rowMain')
  main.type = 'button'
  main.title = 'Focus this agent’s terminal'

  const iconWrap = el('span', 'rowIconWrap')
  for (const st of ROW_STATES) iconWrap.appendChild(svg(ROW_ICON[st], `rowIcon i-${st}`))
  main.appendChild(iconWrap)

  const name = el('span', 'rowName')
  main.appendChild(name)

  const meta = el('span', 'rowMeta')
  main.appendChild(meta)
  li.appendChild(main)

  const actions = el('span', 'rowActions')
  const caret = el('button', 'rowBtn caret')
  caret.type = 'button'
  caret.title = 'Details'
  caret.setAttribute('aria-label', 'Details')
  caret.appendChild(svg('i-chevron'))
  const archive = el('button', 'rowBtn')
  archive.type = 'button'
  archive.title = 'Archive'
  archive.setAttribute('aria-label', 'Archive')
  archive.appendChild(svg('i-x'))
  actions.append(caret, archive)
  li.appendChild(actions)

  const detail = el('div', 'rowDetail')
  const inner = el('div', 'rowDetailInner')
  const pad = el('div', 'rowDetailPad')
  const tldr = el('div', 'rowTldr')
  const facts = el('div', 'rowFacts')
  const branch = el('span', 'rowFact')
  branch.appendChild(svg('i-branch'))
  const branchText = el('span', 'mono')
  branch.appendChild(branchText)
  const since = el('span', 'rowFact')
  facts.append(branch, since)
  pad.append(tldr, facts)
  inner.appendChild(pad)
  detail.appendChild(inner)
  li.appendChild(detail)

  // focus moves the *other* panel, which may be off-screen or on another tab, so
  // the click needs to say something happened here too
  main.addEventListener('click', () => {
    api(`task/${encodeURIComponent(id)}/focus`)
      .then(() => {
        setStatus(`Focused ${id}`, 'flat')
        setTimeout(() => { if (stage === 'thought' && !busySince) setStatus(REST_HINT, 'flat') }, 2500)
      })
      .catch(fail)
  })
  caret.addEventListener('click', () => {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    li.classList.toggle('open', expanded.has(id))
    caret.setAttribute('aria-expanded', String(expanded.has(id)))
  })
  archive.addEventListener('click', () => {
    expanded.delete(id)
    void api(`task/${encodeURIComponent(id)}/archive`).then(refreshBoard).catch(fail)
  })

  return { li, name, meta, caret, archive, tldr, branch, branchText, since, state: '' }
}

function updateRow(row: Row, t: TaskView, i: number): void {
  const st = rowState(t)
  if (row.state !== st) {
    row.state = st
    row.li.className = `row ${st}${expanded.has(t.id) ? ' open' : ''}`
    // the glyphs are stacked; lighting one and dimming the rest crossfades them
    for (const other of ROW_STATES) {
      row.li.querySelector(`.i-${other}`)?.classList.toggle('on', other === st)
    }
    row.archive.hidden = st === 'working' || st === 'unknown'
  }
  row.li.style.setProperty('--i', String(i))

  if (row.name.textContent !== t.id) {
    row.name.textContent = t.id
    row.name.dataset.label = t.id // the shimmer overlay reads this
    row.name.title = t.id // long ids ellipsise in a narrow panel
  }
  const meta = ROW_META[st] || age(t.stateAt ?? t.createdAt)
  if (row.meta.textContent !== meta) row.meta.textContent = meta

  // target !== cwd is the signal that this task runs in a worktree
  const branch = t.branch && t.cwd !== t.target ? t.branch : ''
  row.branch.hidden = !branch
  if (branch) row.branchText.textContent = branch

  const tldr = t.detail ?? ''
  row.tldr.hidden = !tldr
  if (tldr && row.tldr.textContent !== tldr) row.tldr.textContent = tldr
  row.since.textContent = `started ${age(t.createdAt)} ago`

  const hasDetail = Boolean(tldr) || Boolean(branch)
  row.caret.hidden = !hasDetail
  if (!hasDetail && expanded.has(t.id)) {
    expanded.delete(t.id)
    row.li.classList.remove('open')
  }
}

/** task-list's rolling counter. Each character slot keeps its own glyph, so
    `2/5` -> `3/5` rolls only the digit that changed. */
function setCount(host: HTMLElement, value: string): void {
  if (host.dataset.value === value) return
  const prev = host.dataset.value ?? ''
  host.dataset.value = value
  if (prev.length !== value.length) {
    host.replaceChildren()
    host.className = 'headCount rollCount'
    for (const ch of value) {
      const slot = el('span', 'rollDigit', ch)
      host.appendChild(slot)
    }
    return
  }
  const slots = Array.from(host.children) as HTMLElement[]
  value.split('').forEach((ch, i) => {
    const slot = slots[i]
    if (!slot || slot.textContent === ch || slot.dataset.to === ch) return
    slot.dataset.to = ch
    const track = el('span', 'rollInner')
    track.append(el('span', '', prev[i] ?? ''), el('span', '', ch))
    slot.replaceChildren(track)
    requestAnimationFrame(() => requestAnimationFrame(() => track.classList.add('on')))
    setTimeout(() => {
      slot.textContent = ch
      delete slot.dataset.to
    }, 380)
  })
}

async function refreshBoard(): Promise<void> {
  try {
    const panelParam = typeof cate !== 'undefined' ? `?panel=${encodeURIComponent(cate.panel.id)}` : ''
    const r = (await (await fetch(`api/state${panelParam}`)).json()) as {
      tasks: TaskView[]
      workspaceRoot: string
    }

    // a head-truncated absolute path reads worse than the last two segments
    const seg = r.workspaceRoot.split('/').filter(Boolean)
    $('workspace').textContent = seg.length > 2 ? `…/${seg.slice(-2).join('/')}` : r.workspaceRoot
    $('workspace').title = r.workspaceRoot

    // reconcile by id: rows persist, so state changes crossfade in place
    const seen = new Set<string>()
    const ordered = r.tasks.slice().sort(byUrgency)
    ordered.forEach((t, i) => {
      seen.add(t.id)
      let row = rows.get(t.id)
      if (!row) {
        row = buildRow(t.id)
        rows.set(t.id, row)
      }
      updateRow(row, t, i)
      if (cardsEl.children[i] !== row.li) cardsEl.insertBefore(row.li, cardsEl.children[i] ?? null)
    })
    for (const [id, row] of rows) {
      if (seen.has(id)) continue
      row.li.remove()
      rows.delete(id)
      expanded.delete(id)
    }

    const total = r.tasks.length
    const done = r.tasks.filter((t) => t.state === 'done').length
    $('empty').hidden = total > 0
    $('board-head').hidden = total === 0
    if (total) setCount($('board-count'), `${done}/${total}`)
    $('head-list').classList.toggle('on', done < total)
    $('head-check').classList.toggle('on', total > 0 && done === total)
  } catch {
    /* server briefly away (remount) - next poll wins */
  }
}

// --- wiring ------------------------------------------------------------------

primary.addEventListener('click', runPrimary)
primaryWide.addEventListener('click', runPrimary)
backBtn.addEventListener('click', () => {
  if (stage === 'review') setStage('questions')
  else resetFlow()
})

$('copySpec').addEventListener('click', () => {
  void navigator.clipboard.writeText(specEl.value)
  const btn = $('copySpec')
  const label = btn.querySelector('span')
  const glyph = btn.querySelector('use')
  if (label) label.textContent = 'Copied'
  glyph?.setAttribute('href', '#i-copied')
  setTimeout(() => {
    if (label) label.textContent = 'Copy'
    glyph?.setAttribute('href', '#i-copy')
  }, 1200)
})

thoughtEl.addEventListener('input', () => {
  syncPrimary()
  thoughtEl.style.height = 'auto'
  thoughtEl.style.height = `${thoughtEl.scrollHeight}px`
})
for (const field of [thoughtEl, specEl]) {
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runPrimary()
  })
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stage !== 'thought') resetFlow()
})

$('selftest').addEventListener('click', () => {
  setStatus('Spawning test terminal')
  api<{ panelId: string }>('selftest')
    .then((r) => setStatus(`Echo sent to terminal ${r.panelId.slice(0, 8)}`, 'flat'))
    .catch(fail)
})

setStage('thought')
setStatus(REST_HINT, 'flat')
void applyTheme()
if (typeof cate !== 'undefined') {
  void api('join', { panelId: cate.panel.id }).catch(() => {})
}
void refreshBoard()
setInterval(() => {
  void refreshBoard()
  void applyTheme()
}, 2500)
