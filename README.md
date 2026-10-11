# agent-count

A Claude Code mod that counts the session's background work and keeps one line
for the status line:

```
⚙ main:thinking (1m05s) │ agents:6 (sub:4 sh:1 mon:1) │ pending:0 running:4 waiting:1 idle:1
```

- `main`: the main loop: `thinking` while its turn runs, `tool:<name>` while
  one of its tool calls runs, `idle` once the turn ended; while it works, the
  time spent on the current prompt follows in green, e.g. `(1m05s)`; once idle,
  the last prompt's time stays, e.g. `(ltt:2m10s)` (last task time; the time
  in white).
- `agents`: everything in flight; `sub` subagents and teammates, `sh` background
  shell commands, `mon` monitors; non-zero values in their own color (light
  green, sky blue, pale turquoise, light coral), the `sub`/`sh`/`mon` keys too.
- `pending` / `running` / `waiting` / `idle`: the same tasks by state (finished,
  failed and killed ones are not counted); non-zero values are colored.

Agents come from `$.agent.list()` (polled every 1 s). Shells and monitors are
tracked from their `Bash` / `Monitor` calls and dropped on their task
notification, `TaskStop`, or the `Stop` hook's `background_tasks` snapshot.

## Install

```
/plugin install agent-count --marketplace 0exp/claude-agent-count
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in
every session).

## Show it in the status line

The mod writes the line to `~/.claude/agent-count/<session_id>`. Print it from
your `statusLine` command where you want the row, e.g. in `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "input=$(cat); echo \"$input\" | jq -r '.model.display_name'; printf '%s' \"$input\" | sh ~/.claude/agent-count.sh",
  "refreshInterval": 1
}
```

`statusline/agent-count.sh` is that snippet as a script (copy it anywhere);
inline, it is:

```sh
af="$HOME/.claude/agent-count/$(echo "$input" | jq -r '.session_id // empty')"; [ -f "$af" ] && cat "$af"
```

Requires `jq`. A `refreshInterval` of 1 keeps the counters close to live.

## Develop

The plugin ships the `daiver-agent-count` skill (`skills/daiver-agent-count/`):
it tells Claude how to check, change, reload, wire up and release the mod. Ask
Claude to check or change agent-count and it loads the skill by itself.

```
claude --plugin-dir .          # run a session with the mod loaded from this folder
claude plugin validate .       # manifest, marketplace and hooks module
```
