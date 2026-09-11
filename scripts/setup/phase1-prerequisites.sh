#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# AIOS — Phase 1: make this Mac capable of running a Claude session.
#
# This is the ONLY thing the app installs. Everything after it (cloning the
# framework, MCP auth, the spawn wrappers, hooks, the cold-start interview) is
# conversational and belongs to a Claude session following SETUP.md — which is
# written FOR a Claude session, with judgment a script cannot carry: what to ask
# versus assume, what to defer, when to show a diff first.
#
# So Phase 1 stops at exactly the point where delegation becomes possible.
#
# Every step is CHECK-THEN-ACT and safe to re-run. Nothing is hidden: each step
# says what it is about to do, and the script ends by PROVING the result in the
# same login shell the app and its terminals use.
# ─────────────────────────────────────────────────────────────────────────────
set -u

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '  \033[90m•\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$*"; exit 1; }

say "AIOS setup — Phase 1 of 2: the tools a Claude session needs"
echo "  Phase 2 is the AIOS itself, and a Claude session does that part with you."
echo "  Everything here is safe to run again; steps already done are skipped."

# ── OS guard ─────────────────────────────────────────────────────────────────
# Everything below this line is macOS: Xcode Command Line Tools, then Homebrew,
# then five brew installs and a brew cask. None of it exists on Linux — yet we
# publish AIOS-amd64.deb and AIOS-x86_64.AppImage, so a Linux operator can install
# the app, press the one button it offers, and watch a script fail partway through
# with a Homebrew error. That is worse than no button: a broken promise reads as a
# broken product.
#
# So say the true thing instead. The APP itself runs fine on Linux — this one
# provisioning step is Mac-shaped — so a Linux operator who installs these by hand
# has a working AIOS. Listing them is the whole gap.
#
# Not exit 1: this is not a failure, it is a step that is not automated here yet,
# and a red error frames it wrongly for someone who did nothing wrong.
if [ "$(uname -s)" != "Darwin" ]; then
  say "Automatic setup is macOS and Windows only — for now"
  echo "  The AIOS App itself runs fine here. It is this one install step that is not"
  echo "  automated for Linux yet, so install these with your package manager:"
  echo
  echo "    git · node · gh · python3 · uv · Obsidian · Claude Code"
  echo
  if command -v apt-get >/dev/null 2>&1; then
    echo "    sudo apt-get update && sudo apt-get install -y git nodejs npm gh python3"
  elif command -v dnf >/dev/null 2>&1; then
    echo "    sudo dnf install -y git nodejs gh python3"
  elif command -v pacman >/dev/null 2>&1; then
    echo "    sudo pacman -S --noconfirm git nodejs npm github-cli python"
  else
    echo "    (use your distribution's package manager)"
  fi
  echo "    curl -LsSf https://astral.sh/uv/install.sh | sh     # uv"
  echo "    npm install -g @anthropic-ai/claude-code            # Claude Code"
  echo "    Obsidian: https://obsidian.md/download"
  echo
  echo "  Then re-open the app and press Re-check — every step verifies the same way"
  echo "  on every platform, so it will find them."
  exit 0
fi

# ── 0. Shell profile files ───────────────────────────────────────────────────
# A brand-new macOS account has NO ~/.zshrc and NO ~/.zprofile. Anything that
# appends a PATH line has to create the file first, or the append silently
# lands nowhere useful.
say "Shell profile"
ZPROFILE="$HOME/.zprofile"; ZSHRC="$HOME/.zshrc"
for f in "$ZPROFILE" "$ZSHRC"; do
  if [ -f "$f" ]; then skip "$(basename "$f") exists"; else touch "$f" && ok "created $(basename "$f")"; fi
done

# ── 1. Xcode Command Line Tools ──────────────────────────────────────────────
# Homebrew needs these, and the installer is a GUI dialog we cannot click.
say "Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then
  ok "already installed"
else
  warn "not installed — macOS will now show a dialog. Click Install and wait for it to finish."
  xcode-select --install 2>/dev/null || true
  echo "  Waiting for the tools to appear (this can take several minutes)…"
  until xcode-select -p >/dev/null 2>&1; do sleep 10; done
  ok "installed"
fi

# ── 2. Homebrew ──────────────────────────────────────────────────────────────
# The official installer asks for your password (it writes outside your home),
# and it does NOT put brew on your PATH — it only prints how. We do that part.
say "Homebrew"
BREW=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$candidate" ] && BREW="$candidate" && break
done
if [ -n "$BREW" ]; then
  ok "already installed ($BREW)"
else
  warn "not installed — the official installer will ask for your Mac password."
  # NOT fatal any more. This used to `die`, which ended Phase 1 on every Mac account without admin
  # rights — the installer needs one. Each tool below has other ways in (install-tool.sh), most of
  # them needing no admin at all, so a failed Homebrew is a skipped rung, not a stopped setup.
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || warn "Homebrew could not be installed (it needs an admin account) — continuing without it"
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$candidate" ] && BREW="$candidate" && break
  done
  [ -n "$BREW" ] && ok "installed ($BREW)"
fi
# on PATH for THIS script, and for every future login shell
if [ -n "$BREW" ]; then
  eval "$("$BREW" shellenv)"
  if grep -qs 'brew shellenv' "$ZPROFILE"; then
    skip "brew already on your PATH in .zprofile"
  else
    printf '\neval "$(%s shellenv)"\n' "$BREW" >> "$ZPROFILE" && ok "added brew to your PATH (.zprofile)"
  fi
fi

# ── 3. The toolchain ─────────────────────────────────────────────────────────
# Homebrew first when it can write; otherwise, or when a brew install fails (another account's
# Homebrew answers "Cellar is not writable"), the same tool goes through install-tool.sh, which
# tries every other way this Mac allows — ending in a checksum-verified download into ~/.local.
HERE="$(cd "$(dirname "$0")" && pwd)"
install_any() { # tool
  if [ -f "$HERE/install-tool.sh" ]; then bash "$HERE/install-tool.sh" "$1"
  else warn "$1: the fallback installer is missing from this build"; return 1; fi
}
say "Toolchain (node, git, gh, python, uv)"
for pkg in node git gh python uv; do
  if [ -n "$BREW" ] && "$BREW" list --formula "$pkg" >/dev/null 2>&1; then skip "$pkg already installed"
  elif [ -n "$BREW" ] && { printf '  installing %s…\n' "$pkg"; "$BREW" install "$pkg" >/dev/null 2>&1; }; then ok "$pkg"
  else install_any "$pkg" || warn "$pkg failed — continuing, the doctor will flag it"; fi
done
# install-tool.sh wrote these to .zprofile for NEW shells; this script is not one, and the Claude
# step below needs the node/npm it may have just put there.
export PATH="$HOME/.local/bin:$HOME/.local/opt/node/bin:$PATH"

# ── 4. Obsidian ──────────────────────────────────────────────────────────────
# Required on every path: it is how you read the vault, and it is what the
# bundled Obsidian MCP talks to.
say "Obsidian"
# ~/Applications counts: without admin rights /Applications is often not writable, and the
# fallback installer puts Obsidian in the operator's own Applications folder instead.
if [ -d "/Applications/Obsidian.app" ] || [ -d "$HOME/Applications/Obsidian.app" ]; then ok "already installed"
elif [ -n "$BREW" ] && "$BREW" list --cask obsidian >/dev/null 2>&1; then ok "already installed (brew)"
elif [ -n "$BREW" ] && { printf '  installing…\n'; "$BREW" install --cask obsidian >/dev/null 2>&1; }; then ok "installed"
else install_any obsidian || warn "install failed — get it from https://obsidian.md"; fi

# ── 5. Claude Code ───────────────────────────────────────────────────────────
# Deliberately via npm, not the curl installer. npm's global prefix is inside
# the Homebrew tree, which step 2 just put on PATH — so claude is reachable
# immediately. The curl installer drops it in ~/.local/bin and leaves the PATH
# to you, which is exactly the trap that cost a newcomer their whole setup.
say "Claude Code"
# Four states, tried in order — cheapest first, and each one leaves the machine in a
# state the next can build on. State 2 is not hypothetical: it is exactly where a
# newcomer lands when the official curl installer succeeds and leaves PATH alone.
claude_path_fix() {
  # DRIVEN BY WHETHER IT WORKS, NOT BY WHETHER THE TEXT IS THERE.
  #
  # The previous version asked `grep -qs '.local/bin' "$ZSHRC"` and skipped when it matched. On a
  # real operator's machine that grep hit something unrelated in 485 lines of accumulated config —
  # a comment, a different tool's PATH line, anything — so the script announced "PATH line already
  # present", appended nothing, and claude stayed unreachable. The message was true and the
  # conclusion was wrong: the presence of a substring says nothing about whether a NEW TERMINAL
  # can run claude, which is the only thing that matters.
  #
  # So: ask a fresh login+interactive shell — the same thing Terminal.app starts. If it can
  # already run claude, there is nothing to do. If it cannot, write the line, and prefer
  # .zprofile: every login shell reads it, it is short, and it is where Homebrew's own installer
  # writes, so it is far less likely to be tangled up in an operator's accumulated .zshrc.
  reachable() { zsh -ilc 'command -v claude' >/dev/null 2>&1; }

  if reachable; then skip "already reachable from a new terminal"; export PATH="$HOME/.local/bin:$PATH"; return; fi

  for f in "$ZPROFILE" "$ZSHRC"; do
    [ -n "$f" ] || continue
    if grep -qs 'export PATH=.*\.local/bin' "$f"; then skip "PATH export already in $(basename "$f")"
    else printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$f" && ok "added ~/.local/bin to $(basename "$f")"; fi
  done
  export PATH="$HOME/.local/bin:$PATH"

  # Prove it against a NEW shell, not against this one — this one was fixed by the export above
  # regardless of what landed in any file.
  if reachable; then ok "a new terminal can now run claude"
  else
    warn "a new terminal still cannot run claude"
    err=$(zsh -ilc true 2>&1 >/dev/null | grep -m1 -E '\.(zshrc|zprofile):[0-9]+' || true)
    [ -n "$err" ] && warn "your shell startup reports: $err"
    warn "the app's Setup will show this and offer the fix"
  fi
}

if command -v claude >/dev/null 2>&1; then
  ok "already installed ($(claude --version 2>/dev/null | head -1))"
elif [ -x "$HOME/.local/bin/claude" ] || [ -x "$HOME/.claude/local/claude" ]; then
  # 2. installed already, just unreachable — no download needed, only PATH
  warn "installed but not on your PATH — fixing that instead of reinstalling"
  claude_path_fix
  command -v claude >/dev/null 2>&1 && ok "now reachable ($(claude --version 2>/dev/null | head -1))" \
    || warn "still not reachable — the app's Setup will offer the fix"
else
  # 3. npm, preferred: its global prefix lives inside the Homebrew tree step 2 put on
  #    PATH, so claude is reachable immediately with no profile edit at all.
  printf '  installing via npm…\n'
  if npm install -g @anthropic-ai/claude-code >/tmp/aios-npm.log 2>&1; then
    hash -r 2>/dev/null || true
    ok "installed ($(claude --version 2>/dev/null | head -1))"
  else
    # 4. npm could not write — normal when node/Homebrew belong to ANOTHER user on a
    #    shared Mac, or a system-managed node. The official installer needs no such
    #    permission because it installs into your own home.
    warn "npm could not install globally (likely no write access to this machine's node)"
    printf '  falling back to the official installer…\n'
    curl -fsSL https://claude.ai/install.sh | bash || die "Claude Code install failed. See /tmp/aios-npm.log for the npm attempt."
    claude_path_fix
    command -v claude >/dev/null 2>&1 && ok "installed ($(claude --version 2>/dev/null | head -1))" \
      || die "Installed, but claude is still not on PATH. Open a NEW terminal and re-run this."
  fi
fi

# ── Prove it, the way the app will ───────────────────────────────────────────
# A login shell of the operator's own shell — the same thing the app probes with
# and the same thing its terminals launch. Anything that passes here is real.
say "Checking the way the AIOS App will"
LOGIN_SHELL="${SHELL:-/bin/zsh}"
FAIL=0
for tool in git node npm gh python3 uv claude; do
  if "$LOGIN_SHELL" -lc "command -v $tool" >/dev/null 2>&1; then ok "$tool"
  else warn "$tool NOT found by a login shell"; FAIL=1; fi
done
{ [ -d "/Applications/Obsidian.app" ] || [ -d "$HOME/Applications/Obsidian.app" ]; } && ok "Obsidian" || { warn "Obsidian not in /Applications or ~/Applications"; FAIL=1; }

say "Phase 1 complete"
if [ "$FAIL" -eq 0 ]; then
  echo "  Everything Phase 1 owns is in place."
  echo
  echo "  Next, in the AIOS App:"
  echo "    1. Sign in to Claude          (AIOS ▸ Sign In to Claude)"
  echo "    2. Set up my AIOS             — this hands over to a Claude session,"
  echo "       which clones the framework and walks you through the rest."
else
  echo "  Some tools are still missing above. Open a NEW terminal window and re-run this"
  echo "  script — PATH changes only reach shells started after them."
fi
echo
