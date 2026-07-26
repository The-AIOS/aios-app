#!/bin/bash
# AIOS newcomer test — run at each checkpoint to record PROGRESS, so the observer can
# see what changed without reading your home directory.
# written by the TEST USER, so it must be a dir they own — /Users/Shared is 1777
SHARED=/Users/Shared/aios-out
# 1777 (sticky, like /Users/Shared): both accounts must be able to add files here.
# 755 let whoever ran first lock the other one out, silently.
mkdir -p "$SHARED" 2>/dev/null; chmod 1777 "$SHARED" 2>/dev/null
OUT="$SHARED/checkpoint-$(date +%H%M%S).txt"
{
  echo "=== CHECKPOINT $(date +%H:%M:%S) ==="
  for c in claude git gh; do
    printf "  %-6s on PATH        " "$c"; command -v "$c" >/dev/null 2>&1 && echo "yes ($(command -v $c))" || echo "no"
  done
  # An installer can succeed while `command -v` still says no: claude installs under ~/.local
  # and its PATH line only takes effect in a NEW login shell. So look on disk too, or a
  # working install reads as a failure.
  echo "  --- claude on disk (independent of PATH) ---"
  for p in "$HOME/.local/bin/claude" "$HOME/.local/share/claude" "$HOME/.claude/local/claude"; do
    printf "  %-34s " "${p/#$HOME/~}"; [ -e "$p" ] && echo "exists" || echo "absent"
  done
  printf "  %-34s " "PATH line in a shell rc"
  grep -lsE '\.local/bin|\.local/share/claude' "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.profile" 2>/dev/null | tr '\n' ' ' | grep -q . && echo "yes" || echo "no"
  printf "  %-34s " "a LOGIN shell finds claude"
  /bin/sh -lc 'command -v claude' >/dev/null 2>&1 && echo "yes" || echo "no"
  for p in "$HOME/aios" "$HOME/aios/vault" "$HOME/.claude/settings.json" "$HOME/.claude.json" "$HOME/.aios/spawn-inbox"; do
    printf "  %-32s " "${p/#$HOME/~}"; [ -e "$p" ] && echo "exists" || echo "absent"
  done
  if [ -f "$HOME/.claude.json" ]; then
    printf "  signed in as                     "
    python3 -c "import json;print(json.load(open('$HOME/.claude.json')).get('oauthAccount',{}).get('emailAddress','(not signed in)'))" 2>/dev/null || echo "(unreadable)"
  fi
  [ -d "$HOME/aios" ] && { printf "  framework files                  "; ls "$HOME/aios" | wc -l | tr -d ' '; }
} > "$OUT" 2>&1
cat "$OUT"
echo
echo "Wrote $OUT — tell the observer: CHECKPOINT"
