// Persistent task registry (~/.dispatch/tasks.json) merged with the status
// files hook.js writes (~/.dispatch/status/<id>.json). File-based on purpose:
// the extension server dies ~30s after the last panel closes, agents don't.

import { promises as fs } from 'fs'
import path from 'path'
import { DISPATCH_DIR } from './cate'

const TASKS_FILE = path.join(DISPATCH_DIR, 'tasks.json')
export const STATUS_DIR = path.join(DISPATCH_DIR, 'status')

export interface Task {
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
}

export type TaskState = 'working' | 'waiting' | 'done' | 'unknown'

export interface TaskView extends Task {
  state: TaskState
  detail: string | null
  stateAt: number | null
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

export async function allTasks(): Promise<Task[]> {
  return readJson<Task[]>(TASKS_FILE, [])
}

export async function addTask(task: Task): Promise<void> {
  const tasks = await allTasks()
  tasks.push(task)
  await fs.mkdir(DISPATCH_DIR, { recursive: true })
  const tmp = `${TASKS_FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(tasks, null, 2))
  await fs.rename(tmp, TASKS_FILE)
}

export async function archiveTask(id: string): Promise<void> {
  const tasks = await allTasks()
  const t = tasks.find((x) => x.id === id)
  if (t) t.archived = true
  const tmp = `${TASKS_FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(tasks, null, 2))
  await fs.rename(tmp, TASKS_FILE)
}

interface StatusFile { state?: unknown; detail?: unknown; at?: unknown }

/** hook.js event → board state mapping lives in hook.js; this just reads it. */
export async function taskViews(): Promise<TaskView[]> {
  const tasks = (await allTasks()).filter((t) => !t.archived)
  const views: TaskView[] = []
  for (const t of tasks) {
    const s = await readJson<StatusFile>(path.join(STATUS_DIR, `${t.id}.json`), {})
    const state = s.state === 'working' || s.state === 'waiting' || s.state === 'done'
      ? s.state
      : 'unknown'
    views.push({
      ...t,
      state,
      detail: typeof s.detail === 'string' ? s.detail : null,
      stateAt: typeof s.at === 'number' ? s.at : null,
    })
  }
  return views
}
