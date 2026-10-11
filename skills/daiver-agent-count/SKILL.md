---
name: daiver-agent-count
description: Manage the agent-count Claude Code mod (status-line counters of the main loop state and background agents, shells and monitors by state). Use when the user asks to check, enable, disable, update, change, debug, release, publish or uninstall the agent-count mod/plugin, its counters line or its statusLine wiring.
---

# agent-count mod

Shows one status-line row under the model name:

```
⚙ main:thinking (1m05s) │ agents:6 (sub:4 sh:1 mon:1) │ pending:0 running:4 waiting:1 idle:1
```

- `main`: main loop state: `thinking` (turn running), `tool:<name>` (a main-loop tool call in flight), `waiting` (turn ended, background work still pending/running/waiting), `idle` (white; turn ended, nothing in flight). While working, the time spent on the current prompt follows in green, `(1m05s)`; once idle, the last prompt's time stays as `(ltt:2m10s)` (gray `ltt:`, white time).
- `agents`: all background work (main not included); `sub` subagents/teammates, `sh` background shells, `mon` monitors. With no background work and main `thinking`/`tool:*`, the value is `main` (in the `agents` value color) instead of `0`.
- `pending`/`running`/`waiting`/`idle`: the same work by state; ended agents (completed/failed/killed) are not counted.

## Where things are

| What | Path |
| --- | --- |
| Source repo (also the marketplace) | `~/Projects/claude-agent-count/` (dev checkout of `github.com/0exp/claude-agent-count`; the status script reads `$AGENT_COUNT_REPO` when it lives elsewhere) |
| Hooks module | `~/Projects/claude-agent-count/hooks/register.ts` |
| Manifest / marketplace | `~/Projects/claude-agent-count/.claude-plugin/{plugin,marketplace}.json` |
| Installed as | `agent-count@agent-count`, user scope; for development the marketplace `agent-count` is a `directory` source pointing at the repo, for users a GitHub source (`0exp/claude-agent-count`) read from the plugin cache |
| This skill | `skills/daiver-agent-count/` in the repo (ships with the plugin) |
| Counters line, per session | `~/.claude/agent-count/<session_id>` (ANSI-colored, one line) |
| Status-line wiring | printed right after the model line by the agent-prompt-view script (`~/.claude/agent-prompt-view/statusline.sh`, run by `statusLine.command`), or inline in `statusLine.command` without that mod; `refreshInterval: 1` |
| Status-line snippet | `~/Projects/claude-agent-count/statusline/agent-count.sh` |

With a `directory` marketplace the installed plugin is read from the repo folder: never move or delete it without reinstalling.

## How it works (keep these invariants when changing it)

- Main time: `turn.start` stores `$.clock.now()` only when main was `idle` (continuations keep the timer); `turn.complete` of the main loop saves the run time for `ltt` and clears the start; `session.start` (and so every reload) clears both.
- Agents: `$.agent.list()` polled every 1 s (`$.clock.every` from `session.start`); live statuses `pending|running|waiting|idle`.
- Shells/monitors have no listing API: added from `tool.call` results (`Bash` `result.backgroundTaskId`, `Monitor` `result.taskId`); removed on a `prompt.submit` with `origin.kind === 'task-notification'` (parses `<task-id>`), on `TaskStop`, and reconciled from `classic.Stop`'s `background_tasks` snapshot.
- Main state: `turn.start` -> `thinking`; untargeted `tool.call` with no `agentId` pushes/pops the tool name; `turn.complete` with no `agentId` -> `idle`, shown as `waiting` by `refresh()` while any background work is pending/running/waiting.
- `refresh($)` is a top-level function (the validator requires `$` to be passed only to top-level functions) and writes the file only when the line changed.
- Every gating hook has `.catch(($, e, next) => next(e))`: a mod failure must never block a tool call or a prompt.
- Tracked state lives in module variables: a reload or restart forgets shells/monitors until the next `Stop` snapshot.

## Tasks

**Status / health check**: run `sh <this skill's base directory>/scripts/status.sh` and report: install state and version, repo version and uncommitted changes, statusLine wiring, newest counters lines.

**Enable / disable / uninstall**
```sh
claude plugin enable  agent-count@agent-count
claude plugin disable agent-count@agent-count
claude plugin uninstall agent-count@agent-count && claude plugin marketplace remove agent-count
```
Uninstalling does not touch the statusLine: the row just disappears once no file is written. Offer to remove the `af=...; [ -f "$af" ] && cat "$af";` fragment from `statusLine.command` too (back up `settings.json` first), and to delete `~/.claude/agent-count/`; ask before deleting.

**Change the mod**
1. Edit `hooks/register.ts` in the repo, matching its style (no semicolons, single quotes, 2 spaces).
2. Check: `claude plugin validate ~/Projects/claude-agent-count` (must end with `✔ Validation passed`; no warnings expected; README installs from `0exp/claude-agent-count`). Type-check: load the `plugin-authoring` skill (it writes this build's `claude-code.d.ts` and names its path), put a tsconfig in the scratchpad with `strict`, `target: es2023`, `module: esnext`, `moduleResolution: bundler`, `lib: [es2023]`, `noEmit`, `types: []` and `include` = that d.ts + the repo's `hooks/`, then `npx -y -p typescript@5.6.3 tsc -p <scratchpad>`.
3. Bump `version` in `.claude-plugin/plugin.json` (semver: patch for fixes, minor for new fields/counters) and update `README.md` when the line format changes.
4. Reload: the marketplace is a `directory` source with `"source": "./"`, so the plugin is read from the repo folder itself (no reinstall, no `plugin update`). A running session picks up the edit when the user types `/reload-plugins` at the prompt (Claude cannot run slash commands; ask the user to); new sessions load it by themselves. The version bump is for bookkeeping and for GitHub installs.
5. Live-test quickly: start a background `sleep 20` and read the counters file (expect `sh:1 running:1`, then zeros after the task notification).

**Change the line format / colors**: everything is built in `refresh()`; colors are 24-bit ANSI constants (`GRAY`, `COLOR`, `MAIN_COLOR`) matching the user's status line palette. Show the user a plain-text preview (strip ANSI with `sed $'s/\e\\[[0-9;]*m//g'`) before and after.

**Re-wire the status line**: with the agent-prompt-view mod the fragment lives in its script (`statusline/prompt-view.sh`, printed after the first line) and `statusLine.command` only runs `~/.claude/agent-prompt-view/statusline.sh`: change it there. Without that mod the fragment goes right after `printf '%s\n' "$model";` in `statusLine.command`:
```sh
af="$HOME/.claude/agent-count/$(echo "$input" | jq -r '.session_id // empty')"; [ -f "$af" ] && cat "$af";
```
Edit `settings.json` with a JSON-aware tool (python `json`/`jq`), never with sed on the escaped string; back it up first (`settings.json.bak-agent-count`).

**Clean stale state files**: files in `~/.claude/agent-count/` are one per session and never removed by the mod. Offer to delete ones older than N days (`find ~/.claude/agent-count -type f -mtime +7`), list them first and ask.

**Release / publish**: the repo's remote is `origin` = `https://github.com/0exp/claude-agent-count`, branch `main`. Commit and push only when the user asks (pushing is outward-facing: confirm first unless the request says to push); bump `version` before a release so GitHub installs see the update. Others install with `/plugin install agent-count --marketplace 0exp/claude-agent-count` and update with `claude plugin marketplace update agent-count`. Never commit `.claude-plugin/types/` or a local `tsconfig.json` (both in `.gitignore`).

## Debugging

- Counters all zero while work runs: run the status script; if the file's mtime is old, the plugin is not loaded (`claude plugin list`), or the session predates the install. While only the main loop works, `agents:main` and zeros elsewhere are correct; `main` shows `thinking`/`tool:*`.
- Line missing from the status line: statusLine not wired, `jq` missing, or no file for this session id yet.
- Hook errors: the transcript shows `agent-count: <event> ...` lines only in hot-reloading sessions; otherwise run `claude --debug` and grep the debug log for `agent-count:`.
- A shell/monitor stuck in the count: its completion notification has not been delivered yet; it is dropped at the end of the next turn via the `Stop` snapshot.
