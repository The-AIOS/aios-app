#!/bin/bash
# AIOS newcomer test — step 0. Return THIS account to a never-seen-AIOS state.
#
# Everything below lives inside one user's home, which is what makes this safe to run on a
# shared Mac: the toolchain (Homebrew, node, npm, git, gh) is machine-wide and is deliberately
# NOT touched — removing it would break the other account on this machine, not just this one.
# Claude Code, by contrast, installs per-user (~/.local/share/claude), so it can go.
#
# The script refuses to run as anyone whose home holds a real AIOS unless you force it. That
# guard is the whole reason this is a script and not a paste-able rm -rf: the same command that
# resets a test account would silently erase a working vault.

set -u
ME="$(whoami)"

# ── HOME must be sane before any path is built from it ───────────────────────────
# Every target below is "$HOME/…". If HOME were empty, "$HOME/aios" becomes "/aios"; if HOME
# were "/", it becomes "/aios" again with the whole disk one typo away. `set -u` catches UNSET
# but not empty, and not wrong. So HOME is verified to be absolute, to exist, and to be THIS
# user's actual home according to the system — not merely whatever the environment claims.
case "${HOME:-}" in
  /*) : ;;
  *) echo "REFUSING: HOME is not an absolute path (got '${HOME:-}')."; exit 1 ;;
esac
[ -d "$HOME" ] || { echo "REFUSING: HOME ('$HOME') is not a directory."; exit 1; }
[ "$HOME" != "/" ] || { echo "REFUSING: HOME is '/'."; exit 1; }
REAL_HOME="$(eval echo "~$ME")"
if [ "$HOME" != "$REAL_HOME" ]; then
  echo "REFUSING: HOME ('$HOME') is not $ME's home ('$REAL_HOME')."
  echo "Running with a borrowed HOME would delete somebody else's files."
  exit 1
fi
HOME_RES="$(cd "$HOME" && pwd -P)"

# Is a path CONFINED to this user's home? Resolves the PARENT, never the path itself, so a
# symlink is judged by where it lives rather than where it points.
confined() {
  case "$1" in */*) : ;; *) return 1 ;; esac
  d=$(dirname "$1"); [ -d "$d" ] || return 0          # absent parent → nothing to delete
  dr=$(cd "$d" && pwd -P) || return 1
  case "$dr/" in "$HOME_RES/"*) return 0 ;; *) return 1 ;; esac
}

FORCE=0; DRY=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

# ── refuse to destroy anything IRRECOVERABLE ─────────────────────────────────────
# The first version of this guard asked "is the vault personalized?" — and got the answer
# exactly backwards on its first real use. A successful newcomer test ENDS with a personalized
# vault: that is the pass condition. So the guard blocked the very account it was written to
# protect the world from, while a genuinely precious vault that happened to still hold a
# template placeholder would have sailed through.
#
# The question that actually matters is not "is this someone's?" but "CAN THIS BE GOT BACK?".
# A vault pushed to the operator's own remote is recoverable — deleting the working copy costs
# a clone. A vault with uncommitted work, or unpushed commits, or no remote of its own, is
# irreplaceable, and no amount of it being "just a test" changes that.
VAULT="$HOME/aios"
RISK=""
if [ -d "$VAULT/.git" ] && git -C "$VAULT" rev-parse HEAD >/dev/null 2>&1; then
  COMMITS=$(git -C "$VAULT" rev-list --count HEAD 2>/dev/null || echo 0)
  DIRTY=$(git -C "$VAULT" status --porcelain 2>/dev/null | head -40)
  ORIGIN=$(git -C "$VAULT" remote get-url origin 2>/dev/null || true)
  BRANCH=$(git -C "$VAULT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)

  [ -n "$DIRTY" ] && RISK="$RISK
  • uncommitted changes ($(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ') paths) — these exist nowhere else"

  if [ -z "$ORIGIN" ]; then
    RISK="$RISK
  • no git remote — $COMMITS commits of history exist ONLY in this folder"
  elif printf '%s' "$ORIGIN" | grep -qiE '[/:]The-AIOS/aios(\.git)?$'; then
    # the framework repo is not a backup of a personal vault; nobody should be pushing there
    RISK="$RISK
  • the only remote is the FRAMEWORK repo ($ORIGIN) — personal content was never pushed anywhere"
  else
    LOCAL=$(git -C "$VAULT" rev-parse HEAD 2>/dev/null)
    REMOTE=$(git -C "$VAULT" ls-remote "$ORIGIN" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}')
    if [ -z "$REMOTE" ]; then
      RISK="$RISK
  • branch '$BRANCH' does not exist on $ORIGIN — its commits are only here"
    elif [ "$LOCAL" != "$REMOTE" ]; then
      AHEAD=$(git -C "$VAULT" rev-list --count "$REMOTE..HEAD" 2>/dev/null || echo '?')
      RISK="$RISK
  • $AHEAD commit(s) not pushed to $ORIGIN"
    else
      RECOVERABLE="$ORIGIN ($BRANCH @ $(printf '%s' "$LOCAL" | cut -c1-7))"
    fi
  fi
else
  COMMITS=0
fi

# A PUSHED VAULT IS NOT A BACKUP OF THIS ACCOUNT. ~/.claude holds things that exist in no
# remote anywhere: every session transcript, and the auto-memory an operator's sessions have
# accumulated. Judging safety by the vault alone would have let this delete 2.4 GB of
# irreplaceable history on a fully-pushed real account — caught by running it against one.
MEM=$(ls -d "$HOME"/.claude/projects/*/memory 2>/dev/null | head -1)
if [ -n "$MEM" ] && [ -f "$MEM/MEMORY.md" ]; then
  RISK="$RISK
  • auto-memory exists ($(basename "$(dirname "$MEM")")) — accumulated knowledge, in no remote"
fi
TR=$(ls "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
if [ "${TR:-0}" -gt 25 ]; then
  RISK="$RISK
  • $TR session transcripts under ~/.claude/projects — history that exists nowhere else"
fi

if [ -n "$RISK" ] && [ "$FORCE" != "1" ]; then
  echo "STOPPING. $VAULT holds work that cannot be recovered after this:"
  printf '%s\n' "$RISK"
  echo
  echo "Push it, or copy what matters out, then re-run. If it is genuinely disposable,"
  echo "re-run with --force. (You are '$ME'.)"
  exit 1
fi

# ── the plan, stated before anything happens ─────────────────────────────────────
TARGETS=(
  "$HOME/aios"                                  # the framework + vault clone
  "$HOME/.claude"                               # settings, skills symlinks, plugin cache
  "$HOME/.claude.json"                          # the account + per-project MCP registrations
  "$HOME/.aios"                                 # spawn-inbox / command bus
  "$HOME/.local/bin/claude"                     # per-user Claude launcher
  "$HOME/.local/share/claude"                   # per-user Claude versions
  "$HOME/Library/Application Support/AIOS"      # app state, spilled step scripts
  "$HOME/Library/Caches/ms-playwright"          # Chromium builds the old bulk MCP install pulled
  "$HOME/.config/gh"                            # GitHub CLI auth
)

echo "AIOS newcomer reset — account: $ME"
echo
if [ -n "${RECOVERABLE:-}" ]; then
  echo "The vault is fully pushed — recoverable from $RECOVERABLE"
  echo "(so this costs a clone, not the work)"
  echo
elif [ "$FORCE" = "1" ] && [ -n "$RISK" ]; then
  echo "--force: proceeding DESPITE unrecoverable work —$RISK"
  echo
fi
echo "WILL DELETE (all inside $HOME):"
for t in "${TARGETS[@]}"; do
  if [ -e "$t" ]; then
    SZ=$(du -sh "$t" 2>/dev/null | cut -f1)
    echo "  ✗ ${t/#$HOME/~}   ${SZ:-}"
  else
    echo "  – ${t/#$HOME/~}   (already absent)"
  fi
done
echo "  ✗ the ~/.local/bin PATH line from ~/.zshrc (if setup added it)"
echo "  ✗ the Claude Code keychain entry, so signing in is genuinely re-tested"
echo
echo "WILL NOT TOUCH — machine-wide, shared with the other account on this Mac:"
for b in brew node npm git gh; do
  P=$(command -v "$b" 2>/dev/null)
  [ -n "$P" ] && echo "  • $b  →  $P"
done
echo "  • /Applications/AIOS.app  (replace it from the .dmg instead)"
echo
echo "So the next run starts WITHOUT: a vault, Claude, a sign-in, a GitHub auth, any app state."
echo "It still starts WITH: Homebrew, node, npm, git, gh. Testing a machine that lacks those"
echo "needs a VM or a different Mac — this account cannot fake their absence."
echo

if [ "$DRY" = "1" ]; then echo "(--dry-run: nothing was changed)"; exit 0; fi

printf 'Type RESET to proceed: '
read -r ANSWER
[ "$ANSWER" = "RESET" ] || { echo "Aborted — nothing changed."; exit 1; }
echo

# ── do it ────────────────────────────────────────────────────────────────────────
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || [ -L "$t" ] || continue
  # belt and braces: every deletion must live inside THIS user's home, checked at the moment
  # of deletion rather than trusted from how the list was built
  if ! confined "$t"; then
    echo "  ! REFUSING ${t/#$HOME/~} — it resolves outside $HOME_RES"
    continue
  fi
  if [ -L "$t" ]; then
    # `rm -rf` on a symlink removes the LINK, which is what we want — but say so out loud,
    # because a reader assumes a vault was deleted and here it was only unlinked. And if it
    # points outside this home, the destination is somebody else's data: never follow it.
    DEST=$(readlink "$t")
    rm -f "$t" && echo "  unlinked ${t/#$HOME/~}  →  kept its target ($DEST)"
    continue
  fi
  rm -rf "$t" && echo "  removed ${t/#$HOME/~}" || echo "  ! could not remove ${t/#$HOME/~}"
done

# the PATH line, without disturbing the rest of the rc
ZSHRC="$HOME/.zshrc"
# Only the export line setup adds — not every line that happens to mention .local/bin. The
# broad filter would have silently dropped an operator's own unrelated PATH edits.
if [ -f "$ZSHRC" ] && grep -qE '^[[:space:]]*export PATH=.*\.local/bin' "$ZSHRC"; then
  cp "$ZSHRC" "$ZSHRC.pre-aios-reset"
  grep -vE '^[[:space:]]*export PATH=.*\.local/bin' "$ZSHRC" > "$ZSHRC.tmp" && mv "$ZSHRC.tmp" "$ZSHRC"
  echo "  removed the ~/.local/bin PATH export (previous rc kept as .zshrc.pre-aios-reset)"
else
  echo "  (no ~/.local/bin PATH export in .zshrc to remove)"
fi

# Log Claude out at the keychain level. The service name matters and I got it wrong first time:
# it is "Claude Code-credentials", not "Claude Code", so the delete silently matched nothing and
# the operator reset everything else and was still signed in. Verified against a real keychain.
# ("Claude Safe Storage" belongs to the Claude desktop app — deliberately left alone.)
CLEARED=0
for SVC in "Claude Code-credentials" "Claude Code"; do
  if security delete-generic-password -s "$SVC" >/dev/null 2>&1; then
    echo "  removed keychain entry: $SVC"; CLEARED=1
  fi
done
[ "$CLEARED" = "0" ] && echo "  (no Claude keychain entry found)"
# a stray token file would sign them back in just as effectively
for F in "$HOME/.claude/.credentials.json" "$HOME/.config/claude/credentials.json"; do
  [ -f "$F" ] && rm -f "$F" && echo "  removed ${F/#$HOME/~}"
done

echo
echo "=========================================================="
echo
echo "   RESET DONE — this account has never seen AIOS"
echo
echo "   Next, in order — DOUBLE-CLICK each one in Finder:"
echo "     1. Install the newest /Users/Shared/aios-newcomer/AIOS-*.dmg (Replace)"
echo "     2. 1-snapshot.command    — records the starting state"
echo "     3. 2-launch-app.command  — launches the app with its log captured"
echo
echo "   Double-clicking opens a fresh window each time, which is what you want:"
echo "   THIS window still holds the deleted PATH in its environment and would"
echo "   make claude look installed. Nothing to type here — you are done."
echo
echo "=========================================================="
echo
