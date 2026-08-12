// abhay.dispatch server. Binds HOST (127.0.0.1), honors PORT, requires
// CATE_TOKEN on every panel request (the Cate proxy injects it). /health is
// tokenless - it's the daemon's ready probe. /launcher/* is gated by a local
// secret written to ~/.dispatch/server.json for the hotkey script.

import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { promises as fs, readFileSync } from 'fs'
import http from 'http'
import path from 'path'
import { DISPATCH_DIR, call, extensionCreds } from './cate'
import { expand1, expand2, profiles, taskName, type Plan } from './pipeline'
import { selftestSpawn, spawnAgent } from './spawn'
import { addTask, allTasks, archiveTask, taskViews } from './tasks'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 0)
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd()
const PANEL_DIR = path.join(__dirname, '..', 'panel')
const SERVER_FILE = path.join(DISPATCH_DIR, 'server.json')

const launcherSecret = randomBytes(16).toString('hex')
let boardPanelId: string | null = null
// Survive server restarts: the panel only announces itself while it is open,
// so a fresh server would otherwise forget the board until the next poll.
try {
  const parsed = JSON.parse(readFileSync(SERVER_FILE, 'utf-8')) as { boardPanelId?: unknown }
  if (typeof parsed.boardPanelId === 'string') boardPanelId = parsed.boardPanelId
} catch { /* first boot */ }

interface Draft { thought: string; target: string; plan: Plan }
const drafts = new Map<string, Draft>()

async function writeServerFile(): Promise<void> {
  await fs.mkdir(DISPATCH_DIR, { recursive: true })
  await fs.writeFile(
    SERVER_FILE,
    JSON.stringify({ port: PORT, secret: launcherSecret, boardPanelId }, null, 2),
    { mode: 0o600 },
  )
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1024 * 1024) { reject(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

async function serveStatic(res: http.ServerResponse, rel: string): Promise<void> {
  const file = path.join(PANEL_DIR, rel)
  if (!file.startsWith(PANEL_DIR)) { res.writeHead(403).end(); return }
  try {
    const data = await fs.readFile(file)
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(data)
  } catch {
    res.writeHead(404).end('Not found')
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) })
  res.end(s)
}

/** dispatch.py: assumptions + Q/A block for expand2. */
export function answersBlock(plan: Plan, answers: string[]): string {
  const qa = plan.questions
    .map((q, i) => `Q: ${q.q}\nA: ${(answers[i] ?? '').trim() || q.default}`)
    .join('\n')
  const assumed = plan.assumptions.map((a) => `Assumed: ${a}`)
  return [...assumed, ...(qa ? [qa] : [])].join('\n')
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: string,
  url: URL,
): Promise<void> {
  if (req.method !== 'POST' && route !== 'state') { json(res, 405, { error: 'POST only' }); return }

  if (route === 'state') {
    // The poll doubles as a liveness beacon: the panel names itself on every
    // request, so a restarted server re-learns the board id within one poll.
    const fromPanel = url.searchParams.get('panel')
    if (fromPanel && fromPanel !== boardPanelId) {
      boardPanelId = fromPanel
      await writeServerFile()
    }
    json(res, 200, { tasks: await taskViews(), workspaceRoot: WORKSPACE_ROOT })
    return
  }

  const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>

  if (route === 'join') {
    if (typeof body.panelId === 'string') {
      boardPanelId = body.panelId
      await writeServerFile()
    }
    json(res, 200, { ok: true })
    return
  }

  if (route === 'dispatch') {
    const thought = String(body.thought ?? '').trim()
    if (!thought) { json(res, 400, { error: 'empty thought' }); return }
    const profs = await profiles()
    const plan = await expand1(thought, profs)
    let target = profs[plan.profile] ?? WORKSPACE_ROOT
    if (plan.repo) target = path.join(target, plan.repo)
    const draftId = randomBytes(8).toString('hex')
    drafts.set(draftId, { thought, target, plan })
    const targetExists = await fs.stat(target).then((s) => s.isDirectory()).catch(() => false)
    json(res, 200, { draftId, target, targetExists, plan })
    return
  }

  if (route === 'spec') {
    const draft = drafts.get(String(body.draftId ?? ''))
    if (!draft) { json(res, 400, { error: 'unknown draft (panel reloaded?) - start over' }); return }
    if (typeof body.target === 'string' && body.target.trim()) draft.target = body.target.trim()
    const answers = Array.isArray(body.answers) ? body.answers.map(String) : []
    const spec = await expand2(draft.thought, answersBlock(draft.plan, answers), draft.target, await profiles())
    json(res, 200, { spec })
    return
  }

  if (route === 'approve') {
    const draft = drafts.get(String(body.draftId ?? ''))
    if (!draft) { json(res, 400, { error: 'unknown draft (panel reloaded?) - start over' }); return }
    const spec = String(body.spec ?? '').trim()
    if (!spec) { json(res, 400, { error: 'empty spec' }); return }
    const existing = (await allTasks()).map((t) => t.id)
    const name = taskName(draft.target, existing, draft.plan.slug)
    const { task } = await spawnAgent({
      name,
      thought: draft.thought,
      target: draft.target,
      spec,
      workspaceRoot: WORKSPACE_ROOT,
    })
    await addTask(task)
    drafts.delete(String(body.draftId))
    json(res, 200, { task })
    return
  }

  if (route === 'selftest') {
    json(res, 200, await selftestSpawn(WORKSPACE_ROOT))
    return
  }

  const taskMatch = /^task\/([^/]+)\/(focus|archive)$/.exec(route)
  if (taskMatch) {
    const [, id, action] = taskMatch
    if (action === 'archive') {
      await archiveTask(id)
      json(res, 200, { ok: true })
      return
    }
    const task = (await allTasks()).find((t) => t.id === id)
    if (!task) { json(res, 404, { error: 'no such task' }); return }
    await call(extensionCreds(), 'cate.panel.focus', { panelId: task.terminalPanelId })
    json(res, 200, { ok: true })
    return
  }

  json(res, 404, { error: `no route: ${route}` })
}

/** Phone-initiated dispatch (numen): full pipeline with every clarifying
 *  question answered by its default, then spawn. Runs in the background - the
 *  two claude -p calls take minutes and the caller (numen's Telegram poller)
 *  must not block on them. The outcome is texted back through the notify
 *  command, and the board picks the task up on its next poll. */
function autoDispatch(thought: string): void {
  void (async () => {
    try {
      const profs = await profiles()
      const plan = await expand1(thought, profs)
      let target = profs[plan.profile] ?? WORKSPACE_ROOT
      if (plan.repo) target = path.join(target, plan.repo)
      const spec = await expand2(thought, answersBlock(plan, []), target, profs)
      const existing = (await allTasks()).map((t) => t.id)
      const name = taskName(target, existing, plan.slug)
      const { task } = await spawnAgent({ name, thought, target, spec, workspaceRoot: WORKSPACE_ROOT })
      await addTask(task)
      notify(`dispatch: ${name} is on the canvas, working in ${target.replace(/^\/Users\/[^/]+/, '~')}.\n\nSpec:\n${spec.slice(0, 500)}${spec.length > 500 ? '…' : ''}`)
    } catch (err) {
      notify(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

/** Pipe a message through the user's notify command (same chain as hook.ts). */
function notify(body: string, candidates?: string[]): void {
  const [cmd, ...rest] = candidates ?? (
    process.env.DISPATCH_NOTIFY ? [process.env.DISPATCH_NOTIFY] : ['numen', 'tg']
  )
  if (!cmd) return
  try {
    const child = spawn(cmd, [], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => notify(body, rest))
    child.stdin.end(body)
  } catch {
    notify(body, rest)
  }
}

async function focusBoard(): Promise<void> {
  const ext = extensionCreds()
  // Focus the remembered board; if it is gone, find ANY existing Dispatch
  // panel before creating one, so the hotkey never multiplies panels.
  const candidates: string[] = boardPanelId ? [boardPanelId] : []
  try {
    const listed = (await call(ext, 'cate.panel.list', {})) as Array<{
      panelId?: unknown
      type?: unknown
      title?: unknown
    }>
    for (const p of Array.isArray(listed) ? listed : []) {
      if (p.type === 'extension' && p.title === 'Dispatch' && typeof p.panelId === 'string') {
        candidates.push(p.panelId)
      }
    }
  } catch { /* list unavailable; fall through */ }
  for (const id of candidates) {
    try {
      await call(ext, 'cate.panel.focus', { panelId: id })
      if (id !== boardPanelId) {
        boardPanelId = id
        await writeServerFile()
      }
      return
    } catch { /* stale id; try the next */ }
  }
  boardPanelId = null
  const created = (await call(ext, 'cate.canvas.createPanel', {
    type: 'extension',
    extensionPanelId: 'board',
  })) as { panelId?: unknown }
  if (typeof created?.panelId === 'string') {
    await call(ext, 'cate.panel.focus', { panelId: created.panelId }).catch(() => {})
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/health') { res.writeHead(200).end('ok'); return }

    if (url.pathname === '/launcher/focus') {
      if (url.searchParams.get('secret') !== launcherSecret) { res.writeHead(401).end(); return }
      await focusBoard()
      res.writeHead(200).end('ok')
      return
    }

    if (url.pathname === '/launcher/dispatch' && req.method === 'POST') {
      if (url.searchParams.get('secret') !== launcherSecret) { res.writeHead(401).end(); return }
      const body = JSON.parse((await readBody(req)) || '{}') as { thought?: unknown }
      const thought = typeof body.thought === 'string' ? body.thought.trim() : ''
      if (!thought) { res.writeHead(400).end('empty thought'); return }
      autoDispatch(thought)
      res.writeHead(200).end(
        'On it. Routing and writing the spec now, then it goes on the Cate canvas. ' +
        "I'll text you the task name and spec in a few minutes.",
      )
      return
    }

    const auth = req.headers.authorization ?? ''
    if (!TOKEN || auth !== `Bearer ${TOKEN}`) { json(res, 401, { error: 'unauthorized' }); return }

    if (url.pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url.pathname.slice('/api/'.length), url)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        json(res, 500, { error: msg })
        call(extensionCreds(), 'cate.ui.notify', { message: `dispatch: ${msg}`, level: 'error' }).catch(() => {})
      }
      return
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    await serveStatic(res, rel)
  })().catch(() => { try { res.writeHead(500).end() } catch { /* sent */ } })
})

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    void writeServerFile()
    console.log(`dispatch server on ${HOST}:${PORT}, workspace ${WORKSPACE_ROOT}`)
  })
}
