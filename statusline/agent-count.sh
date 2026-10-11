#!/bin/sh
# Prints the agent-count line for the session whose status line JSON is on stdin.
# Usage inside a statusLine command: printf '%s' "$input" | sh ~/.../agent-count.sh
sid=$(jq -r '.session_id // empty')
[ -n "$sid" ] && [ -f "$HOME/.claude/agent-count/$sid" ] && cat "$HOME/.claude/agent-count/$sid"
exit 0
