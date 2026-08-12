# Decisions

Recorded as made, per the BUILD-SPEC's "resolve this before writing the spawn code"
items. Everything below was verified against `cate-src` at v1.6.0 (the running app).

## 1. The extension server cannot call `cate.terminal.*` - first-party creds via zshrc hook

The BUILD-SPEC hoped `CATE_API` direct calls would cover terminal control. They do not:

- The extension server's endpoint is created with `owner: 'extension'` and **no**
  `caller: 'first-party'` (`ExtensionServerManager.ts:396`), and `cate.terminal.*`
  hard-rejects non-first-party callers (`cateApiHandlers.ts:830`,
  `terminal-first-party-only`). No scope can change this.
- `cate.canvas.createPanel { type: 'terminal' }` **does** work for extension callers
  (the renderer responder accepts any registered panel type,
  `useCateHostActionResponder.ts:185`), but `initialInput` is not passed through, so
  a created terminal can never be given a command via extension scopes alone.
- The workspace's **first-party** `CATE_API`/`CATE_TOKEN` are injected into every
  Cate terminal PTY's env (`ipc/terminal.ts:264`). They cannot be scraped from
  process env (`ps -E` is dead on this macOS - verified), and they exist nowhere on
  disk.

**Resolution:** a sourced zshrc hook (`~/.dispatch/cate-creds-hook.zsh`) writes the
creds to `~/.dispatch/cate-cli/<encoded-pwd>.json` (0600) whenever a Cate terminal
starts. Bootstrap is self-serving: the server creates a terminal panel with its
extension token (`canvas` scope), that terminal's zsh deposits the creds, and the
server then drives that same terminal first-party (read/type/press). The bootstrap
terminal becomes the first agent's terminal - nothing is wasted.

Token lifetime: per workspace per app session. On 401 the server re-bootstraps.

## 2. Board status comes from our own Claude Code hooks, not Cate's

Cate's hook-bridge state (working / waiting / permission) lives only in the
renderer's `statusStore` - there is no `cate.*` method that exposes it to
extensions (verified: full surface in `cate-host-api.d.ts`, dispatch table in
`cateApiHandlers.ts`). "Read that state" is not possible for an extension.

**Resolution:** we launch `claude` with a per-task `--settings` file adding
UserPromptSubmit / Notification / Stop / SessionEnd hooks that run
`node dist/server/hook.js <event> <taskId>` - the same first-class hook mechanism
Cate itself injects, not output scraping. The hook writes
`~/.dispatch/status/<taskId>.json`; the server merges those files into the board.
Deliberately server-independent: the extension server is killed ~30s after the last
panel closes, while agents keep running in their PTYs, so status capture must not
depend on the server being alive. Cate's own status dot and native notifications
still work unchanged on top.

## 3. Notifications: Cate native + `tg` from the Stop/Notification hook

Cate already OS-notifies "Claude needs input / permission" on hook turn-end,
honoring `notifyOnlyWhenUnfocused`. Adding `cate.ui.notify` for the same edge would
double-notify, and the server may be dead at turn-end anyway (see #2). The hook
sends `tg` (with a transcript TLDR, ported from dispatch.py `cmd_stop`) only when
Cate is not the frontmost app; when Cate is frontmost, Cate's own notification is
the notification. `cate.ui.notify` is kept for server-side spawn failures only.

## 4. Scopes: `theme, ui, panel, canvas` - deviates from the BUILD-SPEC sketch

`canvas` added: `cate.canvas.createPanel` requires it and the whole bootstrap
depends on it. `storage` and `workspace.read` dropped: tasks persist in
`~/.dispatch/tasks.json` (the server owns a filesystem; `cate.storage` is
per-workspace-project, while tasks span profiles), and the workspace root arrives
as `WORKSPACE_ROOT` env. "Declare scopes minimally" wins over the sketch's list.

## 5. Worktrees: plain `git worktree add`, not Cate territories

Cate's colored worktree "territory" is the embedded Cate Agent's feature
(`cate.codingAgent.*`, caller-gated to `cate-agent`); there is no extension or CLI
surface for it. The BUILD-SPEC pre-approved plain worktrees as the fallback.
Worktrees live at `~/.dispatch/worktrees/<task>`, branch `dispatch/<task>`, created
from the repo toplevel (a profile target may be a subdir of a repo - `phd` is -
so the agent cwd is the worktree plus the target's path relative to toplevel).
Never deleted automatically (spec constraint).

## 6. Misc

- `claude -p` router/spec calls run from the server directly: the daemon inherits
  the user's login-shell env (`shellEnv.ts`, VS Code approach), so `claude`, `tg`,
  `git`, `node` all resolve. Verified: `whence -p claude` → `~/.local/bin/claude`.
- Model/effort: `DISPATCH_MODEL` / `DISPATCH_EFFORT` env, defaults
  `claude-opus-5` / `medium` - same as dispatch.py.
- `--dangerously-skip-permissions` dropped, per spec.
- Spawn discipline: after `createPanel`, poll `cate.terminal.read` until the screen
  is non-empty, stable across consecutive reads, and promptish; after `type`,
  re-read and require the command's marker substring on screen before `press enter`.
- Hotkey (M4): the server writes `~/.dispatch/server.json` `{port, secret, panelId}`;
  `~/.dispatch/bin/dispatch-focus` curls `/launcher/focus` and activates Cate - bind
  it from Raycast/skhd/Shortcuts. Cate has no globalShortcut anywhere (verified).

## 7. Specs get the user's global context; agents get every profile root (2026-08-11)

First real dispatch invented a "numen channel" tool - the spec-writer had no idea
what tools actually exist (the real Telegram sender is `tg`). PATH was ruled out:
Cate terminals resolve the identical PATH to a login shell (verified by diff).
Fix: `expand2` now injects `~/.claude/CONTEXT.md`, the `~/.local/bin` tool list,
and the profile map into the spec prompt's context block (prompt wording otherwise
unchanged), and spawned agents get `--add-dir` for every existing profile root so
cross-profile reads (brain, career-ops) don't hit permission walls.
