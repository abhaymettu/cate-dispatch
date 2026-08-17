// Worktree per task + terminal spawn: the load-bearing sequence.

import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { promisify } from 'util'
import {
  DISPATCH_DIR,
  call,
  createTerminalPanel,
  ensureFirstParty,
  typeCommand,
  waitForPrompt,
} from './cate'
import { DEFAULT_EFFORT, DEFAULT_MODEL, profiles, resolveEffort, resolveModel, tabTitle } from './pipeline'
import { STATUS_DIR, type Task } from './tasks'

const execFileP = promisify(execFile)

const SPEC_DIR = path.join(DISPATCH_DIR, 'specs')
const SETTINGS_DIR = path.join(DISPATCH_DIR, 'settings')
const WORKTREES_DIR = path.join(DISPATCH_DIR, 'worktrees')

/** POSIX single-quote escaping - the only quoting used in typed commands. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export async function gitToplevel(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export interface Workdir {
  cwd: string
  worktree: string | null
  branch: string | null
}

/**
 * Git target → worktree at ~/.dispatch/worktrees/<name>, branch dispatch/<name>,
 * cwd preserving the target's path relative to the repo toplevel (a profile
 * target may be a subdir of a repo - `phd` is). Plain dir → target as-is.
 */
export async function prepareWorkdir(target: string, name: string): Promise<Workdir> {
  const toplevel = await gitToplevel(target)
  if (!toplevel) return { cwd: target, worktree: null, branch: null }
  const worktree = path.join(WORKTREES_DIR, name)
  const branch = `dispatch/${name}`
  await fs.mkdir(WORKTREES_DIR, { recursive: true })
  await execFileP('git', ['-C', toplevel, 'worktree', 'add', '-b', branch, worktree])
  return { cwd: path.join(worktree, path.relative(toplevel, target)), worktree, branch }
}

/** Per-task Claude Code settings: status hooks (see hook.ts). */
function settingsFor(name: string, hookJs: string): unknown {
  const hook = (event: string) => [
    { hooks: [{ type: 'command', command: `node ${shq(hookJs)} ${event} ${shq(name)}` }] },
  ]
  return {
    hooks: {
      UserPromptSubmit: hook('prompt'),
      Notification: hook('notification'),
      Stop: hook('stop'),
      SessionEnd: hook('end'),
    },
  }
}

export function claudeCommand(
  cwd: string,
  specFile: string,
  settingsFile: string,
  addDirs: string[] = [],
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
): string {
  const dirs = addDirs.map((d) => `--add-dir ${shq(d)} `).join('')
  // Subshell on purpose: the PANEL's root zsh must stay in the workspace root.
  // Cate session-save records the root shell's cwd and a restore respawns the
  // terminal there - a cwd outside the open workspace root is rejected
  // ("outside allowed directories") and the whole panel fails to restore.
  return (
    `( cd ${shq(cwd)} && claude --model ${shq(model)} --effort ${shq(effort)} ` +
    `${dirs}--settings ${shq(settingsFile)} "$(cat ${shq(specFile)})" )`
  )
}

export interface SpawnResult { task: Task }

export async function spawnAgent(opts: {
  name: string
  thought: string
  target: string
  spec: string
  workspaceRoot: string
  /** What the thought asked to run with, if anything. */
  model?: string | null
  effort?: string | null
}): Promise<SpawnResult> {
  const { name, thought, target, spec, workspaceRoot } = opts

  await fs.mkdir(SPEC_DIR, { recursive: true })
  await fs.mkdir(SETTINGS_DIR, { recursive: true })
  await fs.mkdir(STATUS_DIR, { recursive: true })

  const specFile = path.join(SPEC_DIR, `${name}.md`)
  await fs.writeFile(specFile, `${spec}\n`)

  const hookJs = path.join(__dirname, 'hook.js')
  const settingsFile = path.join(SETTINGS_DIR, `${name}.json`)
  await fs.writeFile(settingsFile, JSON.stringify(settingsFor(name, hookJs), null, 2))

  const { cwd, worktree, branch } = await prepareWorkdir(target, name)

  // First-party creds (bootstrap creates a terminal we then reuse).
  const fp = await ensureFirstParty(workspaceRoot)
  const panelId = fp.bootstrapPanelId ?? (await createTerminalPanel(fp.creds))

  await waitForPrompt(fp.creds, panelId)
  // Every profile root the agent might need (brain, career-ops, …), minus ones
  // that don't exist or already contain the cwd.
  const addDirs: string[] = []
  for (const root of Object.values(await profiles())) {
    const exists = await fs.stat(root).then((s) => s.isDirectory()).catch(() => false)
    if (exists && !cwd.startsWith(root)) addDirs.push(root)
  }
  const cmd = claudeCommand(
    cwd, specFile, settingsFile, addDirs,
    resolveModel(opts.model), resolveEffort(opts.effort),
  )
  // The tail of the typed command wraps unpredictably on screen; the spec
  // filename is short and always visible on the first line.
  await typeCommand(fp.creds, panelId, cmd, `${name}.md`)

  await call(fp.creds, 'cate.panel.setTitle', { panelId, title: tabTitle(target, name) }).catch(() => {})

  // Seed status so the board shows the task before the first hook fires.
  const statusTmp = path.join(STATUS_DIR, `${name}.json.tmp`)
  await fs.writeFile(statusTmp, JSON.stringify({ state: 'working', detail: 'spawned', at: Date.now() }))
  await fs.rename(statusTmp, path.join(STATUS_DIR, `${name}.json`))

  const task: Task = {
    id: name,
    thought,
    target,
    cwd,
    worktree,
    branch,
    specFile,
    terminalPanelId: panelId,
    createdAt: Date.now(),
  }
  return { task }
}

/** Milestone-1 proof: terminal panel + cd + `echo hi`, full discipline. */
export async function selftestSpawn(workspaceRoot: string): Promise<{ panelId: string }> {
  const fp = await ensureFirstParty(workspaceRoot)
  const panelId = fp.bootstrapPanelId ?? (await createTerminalPanel(fp.creds))
  await waitForPrompt(fp.creds, panelId)
  const stamp = new Date().toTimeString().slice(0, 8)
  await typeCommand(fp.creds, panelId, `cd ${shq(workspaceRoot)} && echo dispatch ok at ${stamp}`, 'dispatch ok at')
  return { panelId }
}
