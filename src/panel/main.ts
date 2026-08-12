// Dispatch board panel. Vanilla, no modules; talks to the extension server via
// relative fetches (Cate's proxy injects the bearer token).

interface CateHost {
  panel: { id: string }
  theme: { get(): Promise<{ type: string; app: Record<string, string> }> }
}
declare const cate: CateHost | undefined

interface Question { q: string; default: string }
interface Plan { profile: string; repo: string | null; slug: string; questions: Question[]; assumptions: string[] }
interface TaskView {
  id: string
  target: string
  cwd: string
  state: 'working' | 'waiting' | 'done' | 'unknown'
  detail: string | null
  createdAt: number
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const thoughtEl = $<HTMLTextAreaElement>('thought')
const composeStatus = $('compose-status')
const questionsEl = $('questions')
const reviewEl = $('review')
const specEl = $<HTMLTextAreaElement>('spec')
const reviewStatus = $('review-status')
const footStatus = $('foot-status')

let draftId = ''
let plan: Plan | null = null

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

// --- theme -------------------------------------------------------------------

async function applyTheme(): Promise<void> {
  try {
    if (typeof cate === 'undefined') return
    const theme = await cate.theme.get()
    for (const [k, v] of Object.entries(theme.app ?? {})) {
      document.documentElement.style.setProperty(`--cate-${k}`, v)
    }
  } catch {
    /* fallbacks in style.css hold */
  }
}

// --- flow --------------------------------------------------------------------

function resetFlow(): void {
  draftId = ''
  plan = null
  questionsEl.hidden = true
  reviewEl.hidden = true
  composeStatus.textContent = ''
  composeStatus.classList.remove('error')
}

function fail(el: HTMLElement, err: unknown): void {
  el.textContent = err instanceof Error ? err.message : String(err)
  el.classList.add('error')
}

async function startDispatch(): Promise<void> {
  const thought = thoughtEl.value.trim()
  if (!thought) return
  resetFlow()
  $<HTMLButtonElement>('go').disabled = true
  composeStatus.textContent = 'routing…'
  try {
    const r = await api<{ draftId: string; target: string; targetExists: boolean; plan: Plan }>(
      'dispatch',
      { thought },
    )
    draftId = r.draftId
    plan = r.plan
    composeStatus.textContent = ''
    $<HTMLInputElement>('target').value = r.target
    const assumptions = $('assumptions')
    assumptions.innerHTML = ''
    for (const a of r.plan.assumptions) {
      const li = document.createElement('li')
      li.textContent = `assuming: ${a}`
      assumptions.appendChild(li)
    }
    if (!r.targetExists) {
      const li = document.createElement('li')
      li.textContent = 'target does not exist - fix the path above'
      li.classList.add('error')
      assumptions.appendChild(li)
    }
    const qlist = $('qlist')
    qlist.innerHTML = ''
    r.plan.questions.forEach((q, i) => {
      const div = document.createElement('div')
      div.className = 'question'
      const label = document.createElement('label')
      label.textContent = `${i + 1}. ${q.q}`
      const input = document.createElement('input')
      input.value = q.default
      input.dataset.index = String(i)
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        const next = qlist.querySelector<HTMLInputElement>(`input[data-index="${i + 1}"]`)
        if (next) next.focus()
        else void writeSpec()
      })
      div.append(label, input)
      qlist.appendChild(div)
    })
    questionsEl.hidden = false
    const first = qlist.querySelector<HTMLInputElement>('input')
    if (first) first.focus()
  } catch (err) {
    fail(composeStatus, err)
  } finally {
    $<HTMLButtonElement>('go').disabled = false
  }
}

async function writeSpec(): Promise<void> {
  if (!draftId) return
  $<HTMLButtonElement>('continue').disabled = true
  composeStatus.textContent = 'writing spec…'
  try {
    const answers = Array.from($('qlist').querySelectorAll<HTMLInputElement>('input')).map(
      (i) => i.value,
    )
    const r = await api<{ spec: string }>('spec', {
      draftId,
      answers,
      target: $<HTMLInputElement>('target').value,
    })
    composeStatus.textContent = ''
    questionsEl.hidden = true
    specEl.value = r.spec
    reviewEl.hidden = false
    reviewStatus.textContent = ''
    reviewStatus.classList.remove('error')
  } catch (err) {
    fail(composeStatus, err)
  } finally {
    $<HTMLButtonElement>('continue').disabled = false
  }
}

async function approve(): Promise<void> {
  if (!draftId) return
  $<HTMLButtonElement>('approve').disabled = true
  reviewStatus.textContent = 'spawning terminal…'
  reviewStatus.classList.remove('error')
  try {
    const r = await api<{ task: { id: string } }>('approve', { draftId, spec: specEl.value })
    thoughtEl.value = ''
    resetFlow()
    footStatus.textContent = `spawned ${r.task.id} ✓`
    void refreshBoard()
  } catch (err) {
    fail(reviewStatus, err)
  } finally {
    $<HTMLButtonElement>('approve').disabled = false
  }
}

// --- board -------------------------------------------------------------------

function age(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`
}

const STATE_LABEL: Record<TaskView['state'], string> = {
  working: 'working',
  waiting: 'needs you',
  done: 'done',
  unknown: '-',
}

async function refreshBoard(): Promise<void> {
  try {
    const panelParam = typeof cate !== 'undefined' ? `?panel=${encodeURIComponent(cate.panel.id)}` : ''
    const r = await (await fetch(`api/state${panelParam}`)).json() as { tasks: TaskView[]; workspaceRoot: string }
    $('workspace').textContent = r.workspaceRoot
    const cards = $('cards')
    cards.innerHTML = ''
    $('empty').hidden = r.tasks.length > 0
    for (const t of r.tasks) {
      const card = document.createElement('div')
      card.className = 'card'
      card.title = t.detail ?? ''
      const dot = document.createElement('span')
      dot.className = `dot ${t.state}`
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = t.id
      const meta = document.createElement('span')
      meta.className = 'meta'
      const base = t.target.split('/').pop() ?? t.target
      meta.textContent = `${base} · ${STATE_LABEL[t.state]} · ${age(t.createdAt)}`
      card.append(dot, name, meta)
      if (t.state === 'done' || t.state === 'waiting') {
        const close = document.createElement('button')
        close.className = 'close'
        close.textContent = '✕'
        close.title = 'archive'
        close.addEventListener('click', (e) => {
          e.stopPropagation()
          void api(`task/${encodeURIComponent(t.id)}/archive`).then(refreshBoard)
        })
        card.appendChild(close)
      }
      card.addEventListener('click', () => {
        void api(`task/${encodeURIComponent(t.id)}/focus`).catch((err) => fail(footStatus, err))
      })
      cards.appendChild(card)
    }
  } catch {
    /* server briefly away (remount) - next poll wins */
  }
}

// --- wiring ------------------------------------------------------------------

$('go').addEventListener('click', () => void startDispatch())
thoughtEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void startDispatch()
})
$('continue').addEventListener('click', () => void writeSpec())
$('approve').addEventListener('click', () => void approve())
$('q-abort').addEventListener('click', resetFlow)
$('r-abort').addEventListener('click', resetFlow)
$('selftest').addEventListener('click', (e) => {
  e.preventDefault()
  footStatus.textContent = 'spawning test terminal…'
  footStatus.classList.remove('error')
  api<{ panelId: string }>('selftest')
    .then((r) => { footStatus.textContent = `echo hi sent to terminal ${r.panelId.slice(0, 8)} ✓` })
    .catch((err) => fail(footStatus, err))
})

void applyTheme()
if (typeof cate !== 'undefined') {
  void api('join', { panelId: cate.panel.id }).catch(() => {})
}
void refreshBoard()
setInterval(() => void refreshBoard(), 2500)
