// Cate API client + first-party credential bootstrap + terminal driving.
//
// Two credential sets (see DECISIONS.md #1):
//  - extension creds: env CATE_API/CATE_TOKEN, injected by Cate on server spawn.
//    Scopes: theme, ui, panel, canvas. Cannot call cate.terminal.*.
//  - first-party creds: harvested from a Cate terminal's env by the zshrc hook
//    into ~/.dispatch/cate-cli/<encoded-pwd>.json. Full terminal control.

import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

export const DISPATCH_DIR = path.join(os.homedir(), '.dispatch')
const CREDS_DIR = path.join(DISPATCH_DIR, 'cate-cli')

export interface Creds { api: string; token: string }

export class CateError extends Error {
  constructor(public readonly method: string, public readonly detail: string) {
    super(`${method}: ${detail}`)
  }
}

export async function call(
  creds: Creds,
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<unknown> {
  const res = await fetch(creds.api, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status === 401) throw new CateError(method, 'unauthorized')
  const body = (await res.json()) as { result?: unknown; error?: unknown }
  if (body && typeof body === 'object' && 'result' in body) {
    const r = body.result
    if (r && typeof r === 'object' && 'error' in (r as object)) {
      throw new CateError(method, String((r as { error: unknown }).error))
    }
    return r
  }
  throw new CateError(method, `malformed response (HTTP ${res.status})`)
}

export function extensionCreds(): Creds {
  const api = process.env.CATE_API
  const token = process.env.CATE_TOKEN
  if (!api || !token) throw new Error('CATE_API/CATE_TOKEN not set - not running under Cate?')
  return { api, token }
}

// --- first-party creds ------------------------------------------------------

/** Mirrors the zshrc hook's filename scheme: '/' → '%'. */
export function credsFileFor(workspaceRoot: string): string {
  return path.join(CREDS_DIR, `${workspaceRoot.replace(/\//g, '%')}.json`)
}

async function readCredsFile(workspaceRoot: string): Promise<Creds | null> {
  try {
    const raw = JSON.parse(await fs.readFile(credsFileFor(workspaceRoot), 'utf-8')) as {
      api?: unknown
      token?: unknown
    }
    if (typeof raw.api === 'string' && typeof raw.token === 'string') {
      return { api: raw.api, token: raw.token }
    }
  } catch {
    /* absent or malformed */
  }
  return null
}

async function credsValid(creds: Creds): Promise<boolean> {
  try {
    await call(creds, 'cate.panel.list', {}, 5000)
    return true
  } catch {
    return false
  }
}

export interface FirstParty {
  creds: Creds
  /** Terminal panel created during bootstrap, unused so far - reuse it for the
   *  next spawn instead of leaving a stray empty terminal. */
  bootstrapPanelId: string | null
}

let cached: Creds | null = null

/**
 * Get working first-party creds for this workspace. If the creds file is
 * missing or stale (app restarted → token rotated), create a terminal panel
 * with the EXTENSION creds; its zsh sources the creds hook and deposits fresh
 * creds, which we poll for.
 */
export async function ensureFirstParty(workspaceRoot: string): Promise<FirstParty> {
  if (cached && (await credsValid(cached))) return { creds: cached, bootstrapPanelId: null }
  cached = null

  const fromFile = await readCredsFile(workspaceRoot)
  if (fromFile && (await credsValid(fromFile))) {
    cached = fromFile
    return { creds: fromFile, bootstrapPanelId: null }
  }

  // Invalidate the stale file so the poll below only accepts a fresh write.
  await fs.rm(credsFileFor(workspaceRoot), { force: true })

  const created = (await call(extensionCreds(), 'cate.canvas.createPanel', {
    type: 'terminal',
  })) as { panelId?: unknown }
  const panelId = typeof created?.panelId === 'string' ? created.panelId : null
  if (!panelId) throw new Error('createPanel(terminal) returned no panelId')

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await sleep(400)
    const fresh = await readCredsFile(workspaceRoot)
    if (fresh && (await credsValid(fresh))) {
      cached = fresh
      return { creds: fresh, bootstrapPanelId: panelId }
    }
  }
  throw new Error(
    'No Cate CLI credentials appeared. Is the creds hook installed? Run setup.sh, ' +
      'then open a new Cate terminal once. (Also check Settings → CLI is enabled.)',
  )
}

// --- terminal driving -------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A screen whose last non-blank line ends like a shell prompt. */
export function looksLikePrompt(screen: string): boolean {
  const lines = screen.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return false
  // A zsh '%' prompt never directly follows a digit - that's a progress line
  // ("Receiving objects: 42%"), not a prompt.
  return /(?:[$#❯›>]|(?<![0-9])%)\s*$/.test(lines[lines.length - 1])
}

async function readScreen(creds: Creds, panelId: string): Promise<string> {
  const r = (await call(creds, 'cate.terminal.read', { panelId })) as { text?: unknown }
  return typeof r?.text === 'string' ? r.text : ''
}

/**
 * The load-bearing discipline: never type until the panel's screen is verified.
 * Ready = non-empty + unchanged across consecutive reads + promptish (or stable
 * for 4 straight reads as a fallback for exotic prompts).
 */
export async function waitForPrompt(
  creds: Creds,
  panelId: string,
  timeoutMs = 20_000,
  pollMs = 350,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let prev = ''
  let stable = 0
  while (Date.now() < deadline) {
    const screen = await readScreen(creds, panelId)
    if (screen.trim().length > 0 && screen === prev) {
      stable += 1
      if (looksLikePrompt(screen) || stable >= 4) return
    } else {
      stable = 0
    }
    prev = screen
    await sleep(pollMs)
  }
  throw new Error(`terminal ${panelId}: no shell prompt within ${timeoutMs}ms`)
}

/**
 * Type a command and press enter, verifying the command actually echoed on the
 * terminal screen before enter is sent (a blind type races the shell and
 * silently loses input). `marker` is a substring of `command` expected to be
 * visible; defaults to the last 24 chars.
 */
export async function typeCommand(
  creds: Creds,
  panelId: string,
  command: string,
  marker?: string,
): Promise<void> {
  const expect = marker ?? command.slice(-24)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await call(creds, 'cate.terminal.type', { panelId, text: command })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await sleep(250)
      // The screen hard-wraps at the terminal width, splitting the typed
      // command across lines - flatten before matching or the echo check
      // false-negatives and retypes (doubling the command).
      const screen = (await readScreen(creds, panelId)).replace(/\n/g, '')
      if (screen.includes(expect)) {
        await call(creds, 'cate.terminal.press', { panelId, key: 'enter' })
        return
      }
    }
  }
  throw new Error(`terminal ${panelId}: typed command never echoed on screen`)
}

export async function createTerminalPanel(creds: Creds): Promise<string> {
  const created = (await call(creds, 'cate.canvas.createPanel', { type: 'terminal' })) as {
    panelId?: unknown
  }
  if (typeof created?.panelId !== 'string') throw new Error('createPanel(terminal) failed')
  return created.panelId
}
