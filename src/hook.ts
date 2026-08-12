// Claude Code hook target: `node dist/server/hook.js <event> <taskId>`.
// Wired via the per-task --settings file. Deliberately independent of the
// extension server (which dies when the last panel closes): writes status
// files the server merely reads, and talks to `numen` (Telegram) directly.
//
// Events (see spawn.ts settingsFor):
//   prompt        (UserPromptSubmit) → working
//   notification  (Notification)     → waiting  + numen when Cate unfocused
//   stop          (Stop)             → waiting  + transcript TLDR, tg when Cate unfocused
//   end           (SessionEnd)       → done
//
// Ported from dispatch.py cmd_stop; must always exit 0.

import { execFile, spawn } from 'child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

const STATUS_DIR = path.join(os.homedir(), '.dispatch', 'status')

function writeStatus(taskId: string, state: string, detail?: string): void {
  mkdirSync(STATUS_DIR, { recursive: true })
  const file = path.join(STATUS_DIR, `${taskId}.json`)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ state, detail: detail ?? null, at: Date.now() }))
  renameSync(tmp, file)
}

/** Last assistant text message in the transcript (dispatch.py cmd_stop). */
export function tldrFromTranscript(jsonl: string): string {
  let tldr = ''
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as {
        type?: string
        message?: { content?: Array<{ type?: string; text?: string }> }
      }
      if (e.type === 'assistant') {
        const texts = (e.message?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
        if (texts.some((t) => t)) tldr = texts.join('\n').trim()
      }
    } catch {
      /* partial line */
    }
  }
  return tldr.length > 600 ? `${tldr.slice(0, 600)}…` : tldr
}

function cateFrontmost(cb: (front: boolean) => void): void {
  execFile('lsappinfo', ['front'], (err, asn) => {
    if (err || !asn.trim()) return cb(false)
    execFile('lsappinfo', ['info', '-only', 'name', asn.trim()], (err2, out) => {
      cb(!err2 && out.includes('"Cate"'))
    })
  })
}

/** Send `body` through the user's notify command: $DISPATCH_NOTIFY, else the
 *  first of `numen` / `tg` that exists. The command receives body on stdin.
 *  Missing commands fall through silently - a hook must never fail the turn. */
function sendNumen(body: string, candidates?: string[]): void {
  const [cmd, ...rest] = candidates ?? (
    process.env.DISPATCH_NOTIFY ? [process.env.DISPATCH_NOTIFY] : ['numen', 'tg']
  )
  if (!cmd) return
  try {
    const child = spawn(cmd, [], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => sendNumen(body, rest))
    child.stdin.end(body)
  } catch {
    sendNumen(body, rest)
  }
}

/**
 * Rename the task's terminal panel back to "<repo> · <task>". Only useful after
 * the agent EXITS: while it runs, Cate's 1 Hz agent telemetry force-labels the
 * panel "Claude Code" (updatePanelTitleFromAgent) and would clobber us.
 * Uses the harvested first-party creds; tries each workspace's creds file
 * (wrong-workspace calls fail panel-not-in-window and are skipped).
 */
function restoreTitle(taskId: string, cb: () => void): void {
  try {
    const home = os.homedir()
    const tasks = JSON.parse(
      readFileSync(path.join(home, '.dispatch', 'tasks.json'), 'utf-8'),
    ) as Array<{ id: string; target: string; terminalPanelId: string }>
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return cb()
    const title = `${path.basename(task.target)} · ${task.id}`
    const credsDir = path.join(home, '.dispatch', 'cate-cli')
    const files = readdirSync(credsDir).filter((f) => f.endsWith('.json'))
    let pending = files.length
    if (pending === 0) return cb()
    for (const f of files) {
      try {
        const { api, token } = JSON.parse(readFileSync(path.join(credsDir, f), 'utf-8')) as {
          api: string
          token: string
        }
        fetch(api, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'cate.panel.setTitle',
            args: { panelId: task.terminalPanelId, title },
          }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {}).finally(() => { if (--pending === 0) cb() })
      } catch {
        if (--pending === 0) cb()
      }
    }
  } catch {
    cb()
  }
}

function readStdin(cb: (data: string) => void): void {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { data += c })
  process.stdin.on('end', () => cb(data))
  // Hard cap so a wedged pipe never holds the CLI's hook slot open.
  setTimeout(() => { process.exit(0) }, 8000).unref()
}

function main(): void {
  const [, , event, taskId] = process.argv
  if (!event || !taskId) process.exit(0)

  readStdin((data) => {
    let payload: Record<string, unknown> = {}
    try { payload = JSON.parse(data) as Record<string, unknown> } catch { /* raw */ }

    try {
      if (event === 'prompt') {
        writeStatus(taskId, 'working')
      } else if (event === 'end') {
        writeStatus(taskId, 'done')
        restoreTitle(taskId, () => process.exit(0))
        return
      } else if (event === 'notification') {
        const msg = typeof payload.message === 'string' ? payload.message : 'needs your attention'
        writeStatus(taskId, 'waiting', msg)
        cateFrontmost((front) => {
          if (!front) sendNumen(`dispatch: ${taskId} - ${msg}`)
          process.exit(0)
        })
        return
      } else if (event === 'stop') {
        let tldr = ''
        try {
          const tp = typeof payload.transcript_path === 'string' ? payload.transcript_path : ''
          if (tp) tldr = tldrFromTranscript(readFileSync(tp, 'utf-8'))
        } catch {
          /* transcript unreadable */
        }
        writeStatus(taskId, 'waiting', tldr || 'turn finished')
        cateFrontmost((front) => {
          if (!front) {
            sendNumen(tldr
              ? `dispatch: ${taskId} done\n\n${tldr}`
              : `dispatch: ${taskId} done - no summary; check the terminal`)
          }
          process.exit(0)
        })
        return
      }
    } catch {
      /* hooks must never surface errors into the agent turn */
    }
    process.exit(0)
  })
}

if (require.main === module) main()
