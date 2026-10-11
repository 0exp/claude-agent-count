#!/bin/sh
# Health check of the agent-count mod: install state, versions, statusLine wiring, state files.
REPO="${AGENT_COUNT_REPO:-$HOME/Projects/claude-agent-count}"
STATE="$HOME/.claude/agent-count"
SETTINGS="$HOME/.claude/settings.json"

echo "== plugin"
claude plugin list 2>/dev/null | grep -A4 'agent-count@' || echo "not installed"

echo "== repo ($REPO)"
if [ -d "$REPO" ]; then
  echo "manifest version: $(jq -r .version "$REPO/.claude-plugin/plugin.json")"
  git -C "$REPO" status --short 2>/dev/null | sed 's/^/  /'
else
  echo "missing: the installed plugin is read from this folder"
fi

echo "== statusLine"
if jq -e '.statusLine.command | contains(".claude/agent-count/")' "$SETTINGS" >/dev/null 2>&1; then
  echo "wired, refreshInterval: $(jq -r '.statusLine.refreshInterval // "default"' "$SETTINGS")"
elif jq -e '.statusLine.command | contains(".claude/agent-prompt-view/")' "$SETTINGS" >/dev/null 2>&1 &&
  grep -q '.claude/agent-count/' "$HOME/.claude/agent-prompt-view/statusline.sh" 2>/dev/null; then
  echo "wired through agent-prompt-view, refreshInterval: $(jq -r '.statusLine.refreshInterval // "default"' "$SETTINGS")"
else
  echo "not wired: the counters line is written but never printed"
fi

echo "== state files ($STATE)"
if [ -d "$STATE" ]; then
  ls -t "$STATE" | head -5 | while read -r f; do
    printf '%s  %s\n  ' "$(stat -f '%Sm' "$STATE/$f")" "$f"
    sed $'s/\e\\[[0-9;]*m//g' "$STATE/$f"
  done
  echo "total: $(ls "$STATE" | wc -l | tr -d ' ') file(s)"
else
  echo "none yet (written on the first session start with the plugin loaded)"
fi
