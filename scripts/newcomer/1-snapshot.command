#!/bin/bash
# AIOS newcomer test — step 1. Run this FIRST, before installing anything.
# It records what this user does and does not have, into the shared folder the
# observer can read. The ABSENCES are the point of the test.
# written by the TEST USER, so it must be a dir they own — /Users/Shared is 1777
SHARED=/Users/Shared/aios-out
# 1777 (sticky, like /Users/Shared): both accounts must be able to add files here.
# 755 let whoever ran first lock the other one out, silently.
mkdir -p "$SHARED" 2>/dev/null; chmod 1777 "$SHARED" 2>/dev/null
OUT="$SHARED/snapshot-$(whoami)-$(date +%H%M%S).txt"
{
  echo "=== WHO / WHEN ==="
  echo "user: $(whoami)   admin: $(id -Gn | grep -qw admin && echo yes || echo no)"
  date
  echo
  echo "=== TOOLS THIS USER HAS ==="
  for c in git node npm claude gh brew; do
    printf "  %-6s " "$c"
    if command -v "$c" >/dev/null 2>&1; then
      echo "$(command -v "$c")   [$("$c" --version 2>&1 | head -1)]"
    else
      echo "NOT INSTALLED"
    fi
  done
  echo
  echo "=== AIOS / CLAUDE STATE ==="
  for p in "$HOME/aios" "$HOME/.claude" "$HOME/.claude.json" "$HOME/.aios" "$HOME/Library/Keychains"; do
    printf "  %-30s " "${p/#$HOME/~}"
    [ -e "$p" ] && echo "exists" || echo "absent"
  done
  echo
  echo "=== PATH ==="
  echo "$PATH" | tr ':' '\n' | sed 's/^/    /'
} > "$OUT" 2>&1
echo "Wrote $OUT"
echo
echo "Now tell the observer: SNAPSHOT READY"
