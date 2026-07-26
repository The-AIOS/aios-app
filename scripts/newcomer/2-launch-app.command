#!/bin/bash
# AIOS newcomer test — step 2. Launches the app with its output CAPTURED, so the
# observer can read what the app reports instead of relying on descriptions.
# Launch it this way rather than from Finder for the whole test.
#
# v2: SELF-DIAGNOSING. v1 hardcoded /Applications and could only say "not there yet",
# which told us nothing about WHY. Every reason this can fail now names itself, and the
# reasons that are safe to fix are fixed.
# The drop box has to be writable by BOTH accounts — the test user writing logs and the
# observer reading them. v1 created it 755, so whoever ran first silently locked the other
# out and every log line vanished into "Permission denied". 1777 (sticky, like /Users/Shared
# itself) is the mode a shared drop box actually needs: anyone may add a file, only its owner
# may delete it. Chmod is attempted every run because only the DIRECTORY'S OWNER can set it,
# and that is whoever happened to create it.
SHARED=/Users/Shared/aios-out
mkdir -p "$SHARED" 2>/dev/null; chmod 1777 "$SHARED" 2>/dev/null
LOG="$SHARED/app-$(whoami)-$(date +%H%M%S).log"
if ! : > "$LOG" 2>/dev/null; then
  LOG="$HOME/Desktop/aios-app-$(date +%H%M%S).log"; : > "$LOG"
  echo "! $SHARED is not writable by $(whoami) — logging to the Desktop instead:"
  echo "    $LOG"
fi
chmod a+r "$LOG" 2>/dev/null

say() { echo "$@"; echo "$@" >> "$LOG"; }

# ── find the app, in every place a person could reasonably have put it ────────────
CAND=""
for d in /Applications ~/Applications /Volumes/AIOS* ~/Desktop ~/Downloads; do
  for a in "$d"/AIOS.app "$d"/The-AIOS.app; do
    [ -d "$a" ] && CAND="$CAND $a"
  done
done

if [ -z "$CAND" ]; then
  say "Could not find AIOS.app anywhere I looked."
  say ""
  say "  /Applications entries matching AIOS:"
  ls -d /Applications/*AIOS* 2>/dev/null | sed 's/^/    /' || say "    (none)"
  say "  ~/Applications entries matching AIOS:"
  ls -d ~/Applications/*AIOS* 2>/dev/null | sed 's/^/    /' || say "    (none)"
  say "  mounted volumes:"
  ls -d /Volumes/* 2>/dev/null | sed 's/^/    /'
  say ""
  say "Open the newest /Users/Shared/aios-newcomer/AIOS-*.dmg and drag AIOS across first."
  echo; echo "Diagnostics written to $LOG — send that to app-walker."
  exit 1
fi

# prefer /Applications, then ~/Applications, then whatever else turned up
APPDIR=$(echo $CAND | tr ' ' '\n' | grep -m1 '^/Applications/' \
      || echo $CAND | tr ' ' '\n' | grep -m1 "^$HOME/Applications/" \
      || echo $CAND | tr ' ' '\n' | head -1)

say "=== found: $APPDIR ==="
if [ $(echo $CAND | wc -w) -gt 1 ]; then
  say "! more than one copy exists — you may be launching a different one than you think:"
  echo $CAND | tr ' ' '\n' | sed 's/^/    /' | tee -a "$LOG"
fi

VER=$(defaults read "$APPDIR/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)
BUILT=$(stat -f "%Sm" "$APPDIR" 2>/dev/null)
BIN=$(defaults read "$APPDIR/Contents/Info.plist" CFBundleExecutable 2>/dev/null)
CFNAME=$(defaults read "$APPDIR/Contents/Info.plist" CFBundleName 2>/dev/null)
say "version: ${VER:-unknown}   bundle built: ${BUILT:-unknown}   executable: ${BIN:-unknown}"
EXPECT=$(ls -t /Users/Shared/aios-newcomer/AIOS-*.dmg 2>/dev/null | head -1 | sed -E 's/.*AIOS-([0-9.]+)-.*/\1/')
if [ -n "$EXPECT" ] && [ "$VER" != "$EXPECT" ]; then
  say "  ! the newest .dmg here is $EXPECT but the installed app is $VER — you are running a STALE build."
  say "    Replace it from AIOS-$EXPECT-arm64.dmg before continuing; anything you observe otherwise is noise."
else
  say "  ^ matches the newest .dmg on offer ($EXPECT)"
fi

EXE="$APPDIR/Contents/MacOS/${BIN:-AIOS}"
if [ ! -x "$EXE" ]; then
  say "The bundle is there but its executable is missing or not runnable: $EXE"
  ls -l "$APPDIR/Contents/MacOS/" 2>&1 | sed 's/^/    /' | tee -a "$LOG"
  exit 1
fi

# ── the three things that stop an UNSIGNED build from launching ──────────────────
Q=$(xattr -p com.apple.quarantine "$APPDIR" 2>/dev/null)
if [ -n "$Q" ]; then
  say "quarantine flag present ($Q) — this build is unsigned (AI-5), so macOS holds it."
  if xattr -dr com.apple.quarantine "$APPDIR" 2>/dev/null; then
    say "  ✓ cleared it for this copy. This is what code signing will make unnecessary."
  else
    say "  ! could not clear it (needs the owner of the app). Right-click the app → Open once,"
    say "    accept the warning, quit it, then run this script again."
  fi
fi
say "architecture: $(uname -m)   binary: $(file -b "$EXE" 2>/dev/null | head -c 60)"

# ── preflight the four helper apps ────────────────────────────────────────────────
# Electron aborts with a bare "FATAL: Unable to find helper app" if any of these is absent.
# It builds that path from CFBundleName — NOT from CFBundleExecutable, which is what this
# check first used and why it passed a bundle that could not start: executable "AIOS",
# CFBundleName "The-AIOS", helpers "AIOS Helper.app", so Electron hunted for a helper nobody
# ships. Checking the wrong key is worse than not checking, because it reports a green.
MISSING=0
for h in "" " (GPU)" " (Renderer)" " (Plugin)"; do
  NAME="${CFNAME:-${BIN:-AIOS}} Helper$h"
  [ -x "$APPDIR/Contents/Frameworks/$NAME.app/Contents/MacOS/$NAME" ] || { say "  MISSING helper: $NAME"; MISSING=1; }
done
if [ $MISSING -eq 1 ]; then
  say ""
  PREFIX=$(ls "$APPDIR/Contents/Frameworks" 2>/dev/null | grep -m1 'Helper.app$' | sed 's/ Helper.app$//')
  if [ -n "$PREFIX" ] && [ "$PREFIX" != "$CFNAME" ]; then
    say ""
    say "This is a BUILD defect, not something you did: the bundle declares CFBundleName"
    say "  \"$CFNAME\" but ships helpers named \"$PREFIX Helper.app\". Electron resolves its child"
    say "  processes through CFBundleName, so this build can never start. Tell app-walker."
    exit 1
  fi
  say "The bundle is INCOMPLETE. Almost always this means it was launched while Finder was"
  say "still copying it — 117 MB and 786 files do not arrive instantly. Wait for the copy to"
  say "finish (the Finder progress bar disappears), then run this script again."
  say "If it persists, delete the app and drag it across once more."
  exit 1
fi
say "helpers: all 4 present ✓ (CFBundleName \"${CFNAME}\")"

say "Logging to $LOG"
say "Keep this Terminal window open. Quitting the app stops the log."
echo
"$EXE" >> "$LOG" 2>&1
CODE=$?
say ""
say "=== app exited with code $CODE ==="
[ $CODE -ne 0 ] && say "Non-zero exit — the last lines of this log are what app-walker needs."
