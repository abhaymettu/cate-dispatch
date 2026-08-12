Rough thought in, routed and spec'd Claude Code agent out, running in a Cate terminal panel.

# cate-dispatch

A server-backed [Cate](https://github.com/0-AI-UG) extension: type a rough thought,
it picks the right project, asks 2–4 clarifying questions, writes a spec you approve,
then spawns a real `claude` agent in a new Cate terminal panel - in a git worktree
when the target is a repo. Run as many agents as your machine can hold; a board shows
who's working, who needs you, and who's done, and you get a Telegram ping with a
transcript TLDR when an agent finishes while you're away.

Built against **Cate 1.6.0**. macOS, zsh, Node ≥ 20, and the
[Claude Code](https://claude.com/claude-code) CLI on PATH.

## Install

```sh
git clone https://github.com/abhaymettu/cate-dispatch
cd cate-dispatch
sh setup.sh
```

Then in Cate:

1. **Settings → CLI**: enable command-line control, including Terminal → Control.
2. **Settings → Extensions → Add local folder…** → this directory.
3. Open the **Dispatch** panel and click **prove spawn path** (footer). You should
   see a terminal open and echo back on its own.

Write your project roots to `~/.dispatch/profiles.json`:

```json
{
  "projects": "~/code",
  "notes":    "~/notes",
  "scratch":  "~/scratch"
}
```

Optional: bind `~/.dispatch/bin/dispatch-focus` to a global hotkey in
Raycast / skhd / macOS Shortcuts (Cate has no global-shortcut support of its own).

## What setup.sh does (read before running)

- Appends **one marked line** to your `~/.zshrc` sourcing
  `~/.dispatch/cate-creds-hook.zsh`. Cate's extension API deliberately blocks
  extensions from driving terminals; the workspace-scoped CLI credentials Cate
  injects into its own terminals are the only sanctioned path in, and this hook
  exports them (0600, `~/.dispatch/cate-cli/`) so the dispatch server can type
  into the terminals it creates. Full analysis in `DECISIONS.md`.
- Installs the `dispatch-focus` hotkey script.
- `npm install` (TypeScript only, dev-time) and builds `dist/`.

## Flow

1. Hotkey → panel. Type the thought, ⌘⏎.
2. Router call (`claude -p`) picks a profile + repo and asks only about genuine
   forks in the work - Enter accepts each default.
3. Spec (150–400 words, imperative, ends with "Verify by:") appears for review;
   edit in place, then **Approve & spawn**.
4. Git target → `git worktree add` under `~/.dispatch/worktrees/<task>`, branch
   `dispatch/<task>`; plain directories are used as-is.
5. A terminal panel opens, `cd`s there, and runs `claude` with the spec - with
   permission prompts ON (Cate surfaces and notifies on them).
6. The board tracks working / needs-you / done via per-task Claude Code hooks;
   click a card to focus that agent's terminal.

## Configuration

| Env / file | Meaning |
| --- | --- |
| `~/.dispatch/profiles.json` | Name → project root. The router chooses among these. |
| `DISPATCH_MODEL` | Model for router/spec calls and spawned agents (default `claude-opus-5`). |
| `DISPATCH_EFFORT` | Effort level (default `medium`). |
| `DISPATCH_NOTIFY` | Command to pipe away-from-keyboard notifications to (stdin). Default: first of `numen`, `tg` on PATH; silently skipped if neither exists. |

The spec-writer also reads `~/.claude/CONTEXT.md` (if you keep one) and your
`~/.local/bin` tool list, so specs reference tools that actually exist.

## Design notes

`DECISIONS.md` records the constraint map this is built on - why terminal control
needs harvested first-party credentials, why agent status comes from Claude Code
hooks rather than Cate's (extension-invisible) tracker, and why the extension
server must never be the thing that outlives an agent.

## Checks

```sh
npm test
```

MIT.
