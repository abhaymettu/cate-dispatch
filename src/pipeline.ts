// The dispatch.py pipeline, plumbing in TypeScript, prompts verbatim.

import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export const DEFAULT_MODEL = process.env.DISPATCH_MODEL || 'claude-opus-5'
export const DEFAULT_EFFORT = process.env.DISPATCH_EFFORT || 'medium'

export interface Question { q: string; default: string }
export interface Plan {
  profile: string
  repo: string | null
  slug: string
  questions: Question[]
  assumptions: string[]
}

export function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

export async function profiles(): Promise<Record<string, string>> {
  const cfg = path.join(os.homedir(), '.dispatch', 'profiles.json')
  const raw = JSON.parse(await fs.readFile(cfg, 'utf-8')) as Record<string, string>
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, expandTilde(v)]))
}

/** dispatch.py parse_json: first {...} blob in possibly-noisy output. */
export function parseJson(text: string): Record<string, unknown> {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) throw new Error(text)
  return JSON.parse(m[0]) as Record<string, unknown>
}

export async function claudeP(prompt: string): Promise<string> {
  // stdin ignored: claude -p reads stdin if given one (dispatch.py comment).
  const { stdout } = await execFileP(
    'claude',
    ['-p', '--model', DEFAULT_MODEL, '--effort', DEFAULT_EFFORT, prompt],
    { timeout: 240_000, maxBuffer: 4 * 1024 * 1024 },
  )
  return stdout
}

async function subdirListing(profs: Record<string, string>): Promise<string> {
  const parts: string[] = []
  for (const [k, root] of Object.entries(profs)) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
      parts.push(`${k}: ${dirs.join(', ')}`)
    } catch {
      /* not a dir - matches dispatch.py's is_dir() filter */
    }
  }
  return parts.join('\n')
}

// Prompt ported verbatim from dispatch.py expand1().
export async function expand1(thought: string, profs: Record<string, string>): Promise<Plan> {
  const listing = await subdirListing(profs)
  let prompt = `You route tasks for the user. Profiles (working roots):
${Object.entries(profs).map(([k, v]) => `${k}: ${v}`).join('\n')}
Repos (subdirectories) inside each profile root:
${listing}
Task: ${thought}
Pick the working directory. Ask clarifying questions (max 4) ONLY about genuine forks
in the work where guessing wrong would waste the run. If the task is unambiguous,
ask nothing and state your assumptions instead. Each question needs a sensible
default. Reply with ONLY JSON:
{"profile": "...", "repo": "<subdir name, or null>",
 "slug": "<2-3 word kebab-case name for the task itself, e.g. fix-tab-titles>",
 "questions": [{"q": "...", "default": "..."}], "assumptions": ["..."]}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = parseJson(await claudeP(prompt))
      return {
        profile: String(raw.profile ?? ''),
        repo: raw.repo == null ? null : String(raw.repo),
        slug: String(raw.slug ?? ''),
        questions: Array.isArray(raw.questions)
          ? raw.questions.map((q) => ({
              q: String((q as Question).q ?? ''),
              default: String((q as Question).default ?? ''),
            }))
          : [],
        assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.map(String) : [],
      }
    } catch (err) {
      if (attempt) throw new Error(`expansion returned non-JSON:\n${err instanceof Error ? err.message : err}`)
      prompt += '\nJSON only. No prose.'
    }
  }
  throw new Error('unreachable')
}

/** Abhay's cross-project context + real toolbox, injected into the spec prompt
 *  so specs name tools that actually exist (a spec once invented a "numen
 *  channel"; the real Telegram tool is `tg`). */
export async function userContext(profs: Record<string, string>): Promise<string> {
  const parts: string[] = []
  try {
    parts.push(await fs.readFile(path.join(os.homedir(), '.claude', 'CONTEXT.md'), 'utf-8'))
  } catch {
    /* absent */
  }
  try {
    const bins = (await fs.readdir(path.join(os.homedir(), '.local', 'bin'))).sort()
    parts.push(`Personal CLI tools on PATH (~/.local/bin): ${bins.join(', ')}. ` +
      'Only name a tool the agent should use if it appears in this list or the context above.')
  } catch {
    /* absent */
  }
  if (Object.keys(profs).length > 0) {
    parts.push('Other working roots the agent can read/write (also passed as --add-dir):\n' +
      Object.entries(profs).map(([k, v]) => `${k}: ${v}`).join('\n'))
  }
  return parts.join('\n\n')
}

// Prompt ported verbatim from dispatch.py expand2(); the context block now also
// carries the user context above.
export async function expand2(
  thought: string,
  answers: string,
  target: string,
  profs: Record<string, string> = {},
): Promise<string> {
  let context = ''
  try {
    const cm = await fs.readFile(path.join(target, 'CLAUDE.md'), 'utf-8')
    context = cm.split('\n').slice(0, 40).join('\n')
  } catch {
    /* no CLAUDE.md */
  }
  const out = await claudeP(`Write a task spec for a coding agent working in ${target}.
Original thought: ${thought}
Clarifications:
${answers}
Repo notes:
${context}
User context (who the user is, conventions, real tools - trust this over guesses):
${await userContext(profs)}
150-400 words, imperative, concrete file paths where possible, end with a "Verify by:"
line. Output the spec only, no preamble.`)
  return out.trim()
}

/** dispatch.py session_name: unique kebab name from slug or dir stem. */
export function taskName(targetDir: string, existing: string[], slug?: string | null): string {
  let stem = (slug ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/^-+|-+$/g, '')
  stem = stem || path.basename(targetDir).split('-')[0].slice(0, 12) || 'task'
  let n = 1
  while (existing.includes(`${stem}-${n}`)) n += 1
  return `${stem}-${n}`
}

export function tabTitle(targetDir: string, name: string): string {
  return `${path.basename(targetDir)} · ${name}`
}
