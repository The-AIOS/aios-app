#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# AIOS — install ONE missing tool, trying every way this machine allows.
#
#   bash install-tool.sh <gh|git|node|uv|python|obsidian> [--then "<command>"]
#
# WHY A LADDER. Every tool used to have exactly one way in: Homebrew on a Mac.
# A Mac with no Homebrew, or with Homebrew owned by another account, or an
# account without admin rights, hit a dead end at the first missing tool — and
# a real first install did exactly that, on the GitHub step. The fix is not a
# better single method; it is trying the methods in order until one WORKS:
#
#   1. whatever package manager is already here and can write
#   2. a package manager this script can bootstrap (asks for a password)
#   3. the tool's official download, into your own home — no admin rights
#   4. the download page, named plainly, when nothing above can succeed
#
# Every rung is CHECK-THEN-ACT: a rung that is not usable here is skipped, a
# rung that runs but does not produce a working tool falls through to the next.
# Success is decided by running the tool, never by an installer's exit code.
#
# --then runs a command AFTER the tool works, in THIS process, whose PATH
# already includes what was just installed. The terminal that launched this
# script still has the old PATH; running the follow-up here is what removes
# the "now open a new terminal" step nobody tells a newcomer about.
#
# Testing flags (not for operators): --plan lists the ladder without touching
# anything · --only <rung> · --dest <dir> installs downloads under <dir> ·
# --no-persist leaves shell profiles alone · --force ignores an existing tool ·
# --os darwin|linux and --arch arm64|x64 pick the download for another machine.
# ─────────────────────────────────────────────────────────────────────────────
set -u

TOOL=""; THEN=""; PLAN=0; ONLY=""; DEST=""; NOPERSIST=0; FORCE=0; OS_ARG=""; ARCH_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --then) THEN="${2:-}"; shift 2 ;;
    --plan) PLAN=1; shift ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    --no-persist) NOPERSIST=1; shift ;;
    --force) FORCE=1; shift ;;
    --os) OS_ARG="${2:-}"; shift 2 ;;
    --arch) ARCH_ARG="${2:-}"; shift 2 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) TOOL="$1"; shift ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '  \033[90m•\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

case "$TOOL" in
  gh|git|node|uv|python|obsidian) ;;
  *) echo "usage: install-tool.sh <gh|git|node|uv|python|obsidian> [--then \"<command>\"]" >&2; exit 2 ;;
esac

# ── where am I ───────────────────────────────────────────────────────────────
if [ -n "$OS_ARG" ]; then OS="$OS_ARG"; else
  case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) OS=other ;; esac
fi
if [ -n "$ARCH_ARG" ]; then ARCH="$ARCH_ARG"; else
  case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
fi
ROOT="${DEST:-$HOME/.local}"
# absolute, so a symlink written below never points somewhere relative to itself
mkdir -p "$ROOT" && ROOT="$(cd "$ROOT" && pwd)"
BIN="$ROOT/bin"
OPT="$ROOT/opt"
TMP="$(mktemp -d 2>/dev/null || echo "/tmp/aios-install-$$")"; mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

# The page each tool falls back to — the last rung, always present.
page_for() {
  case "$TOOL" in
    gh) echo "https://cli.github.com/" ;;
    git) [ "$OS" = darwin ] && echo "https://git-scm.com/download/mac" || echo "https://git-scm.com/download/linux" ;;
    node) echo "https://nodejs.org/en/download" ;;
    uv) echo "https://docs.astral.sh/uv/getting-started/installation/" ;;
    python) echo "https://www.python.org/downloads/" ;;
    obsidian) echo "https://obsidian.md/download" ;;
  esac
}

# ── is the tool REALLY here ──────────────────────────────────────────────────
# On a Mac without the Command Line Tools, /usr/bin/git and /usr/bin/python3
# exist but are stubs: running one opens an install dialog instead of the tool.
# `command -v` calls that installed. So the stubs only count once CLT exists.
clt_ready() { xcode-select -p >/dev/null 2>&1; }
works() {
  local c; c="$(command -v "$1" 2>/dev/null)" || return 1
  if [ "$OS" = darwin ] && { [ "$c" = /usr/bin/git ] || [ "$c" = /usr/bin/python3 ]; } && ! clt_ready; then return 1; fi
  "$1" --version >/dev/null 2>&1
}
have_tool() {
  case "$TOOL" in
    python) works python3 ;;
    obsidian)
      if [ "$OS" = darwin ]; then [ -d /Applications/Obsidian.app ] || [ -d "$HOME/Applications/Obsidian.app" ]
      else command -v obsidian >/dev/null 2>&1 || [ -x "$BIN/obsidian" ] \
        || { command -v flatpak >/dev/null 2>&1 && flatpak info md.obsidian.Obsidian >/dev/null 2>&1; } \
        || { command -v snap >/dev/null 2>&1 && snap list obsidian >/dev/null 2>&1; }
      fi ;;
    *) works "$TOOL" ;;
  esac
}

# ── shared helpers ───────────────────────────────────────────────────────────
is_admin() {
  if [ "$OS" = darwin ]; then id -Gn 2>/dev/null | tr ' ' '\n' | grep -qx admin
  else [ "$(id -u)" = 0 ] || command -v sudo >/dev/null 2>&1; fi
}
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"

brew_bin() {
  local b
  for b in "$(command -v brew 2>/dev/null)" /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew "$HOME/.linuxbrew/bin/brew"; do
    [ -n "$b" ] && [ -x "$b" ] && { echo "$b"; return 0; }
  done
  return 1
}
# Homebrew that belongs to another account cannot write, and `brew install`
# then ends in a wall of chown instructions — so a brew counts only if it can.
brew_writable() {
  local b p; b="$(brew_bin)" || return 1
  p="$("$b" --prefix 2>/dev/null)" || return 1
  [ -w "$p/Cellar" ] || [ -w "$p" ]
}
pkg_mgr() {
  local m; for m in apt-get dnf pacman zypper apk; do command -v "$m" >/dev/null 2>&1 && { echo "$m"; return 0; }; done
  return 1
}
can_download() { command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; }
fetch() { # url out
  if command -v curl >/dev/null 2>&1; then curl -fL# --retry 2 --connect-timeout 20 -o "$2" "$1"
  else wget -q -O "$2" "$1"; fi
}
fetch_stdout() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 --connect-timeout 20 "$1"
  else wget -q -O - "$1"; fi
}
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else openssl dgst -sha256 "$1" | awk '{print $NF}'; fi
}
# A download is used only if its SHA-256 matches the publisher's. No match, or
# no published checksum to compare against, and the rung fails — the next rung
# or the download page is a better outcome than running an unverified binary.
verify() { # file expected-hex
  local got; got="$(sha256_of "$1" | tr 'A-F' 'a-f')"
  if [ -n "$2" ] && [ "$got" = "$(echo "$2" | tr 'A-F' 'a-f')" ]; then ok "checksum verified"; return 0; fi
  warn "checksum mismatch or unavailable — not using this download"; return 1
}
# The newest non-prerelease GitHub release that HAS an asset matching the
# pattern, as "name|sha256|url". Newest-with-the-asset, not "latest": a
# project's latest release can omit a platform — Obsidian has shipped one with
# only the Android package — and "latest" would then find nothing at all.
# GitHub records a sha256 digest for every uploaded asset; that is the checksum.
gh_asset() { # owner/repo ERE
  fetch_stdout "https://api.github.com/repos/$1/releases?per_page=15" 2>/dev/null \
    | awk -F'"' '
        /"prerelease":/ { pre = ($0 ~ /true/) }
        /"draft":/      { dr = ($0 ~ /true/) }
        /"name":/       { n = $4 }
        /"digest":/     { d = $4; sub(/^sha256:/, "", d) }
        /"browser_download_url":/ { if (!pre && !dr) print n "|" d "|" $4; d = "" }' \
    | grep -E "^($2)\|" | head -1
}
# "name|sha256|url" → $name $sum $url (set in the caller's scope)
split_asset() { name="${1%%|*}"; local rest="${1#*|}"; sum="${rest%%|*}"; url="${rest#*|}"; }

# Put a directory on PATH now, and for every login shell started later.
# Idempotent on the exact line; the file that matters is the one the shell
# actually reads (.zprofile for zsh on a Mac, .profile/.bashrc on Linux).
add_path() {
  export PATH="$1:$PATH"
  [ "$NOPERSIST" = 1 ] && return 0
  local line="export PATH=\"$1:\$PATH\"" f files
  if [ "$OS" = darwin ]; then files="$HOME/.zprofile"; else files="$HOME/.profile $HOME/.bashrc"; fi
  case "${SHELL:-}" in */zsh) files="$files $HOME/.zprofile" ;; */bash) [ "$OS" = darwin ] && files="$files $HOME/.bash_profile" ;; esac
  for f in $files; do
    [ -f "$f" ] || touch "$f"
    grep -qxF "$line" "$f" 2>/dev/null || printf '\n# added by AIOS setup\n%s\n' "$line" >> "$f"
  done
  ok "$1 is on your PATH (now and in new terminals)"
}

# ── the rungs ────────────────────────────────────────────────────────────────
# Each rung answers two questions: can it run HERE (avail_*), and run it (run_*).
brew_formula() { case "$TOOL" in python) echo python ;; *) echo "$TOOL" ;; esac; }

avail() {
  case "$1" in
    brew) brew_writable ;;
    homebrew) [ "$OS" = darwin ] && ! brew_bin >/dev/null && is_admin && can_download ;;
    clt) [ "$OS" = darwin ] && ! clt_ready ;;
    macports) [ "$OS" = darwin ] && command -v port >/dev/null 2>&1 && is_admin ;;
    pkg) [ "$OS" = linux ] && pkg_mgr >/dev/null && is_admin ;;
    flatpak) [ "$OS" = linux ] && command -v flatpak >/dev/null 2>&1 ;;
    snap) [ "$OS" = linux ] && command -v snap >/dev/null 2>&1 && is_admin ;;
    official) can_download ;;
    uvpython) works uv || can_download ;;
    release)
      can_download || return 1
      case "$TOOL" in
        obsidian) if [ "$OS" = darwin ]; then command -v hdiutil >/dev/null 2>&1; else true; fi ;;
        gh) if [ "$OS" = darwin ]; then command -v unzip >/dev/null 2>&1; else command -v tar >/dev/null 2>&1; fi ;;
        *) command -v tar >/dev/null 2>&1 ;;
      esac ;;
    *) return 1 ;;
  esac
}

run_brew() {
  local b; b="$(brew_bin)"
  if [ "$TOOL" = obsidian ]; then "$b" install --cask obsidian; else "$b" install "$(brew_formula)"; fi
  eval "$("$b" shellenv)"
}

run_homebrew() {
  warn "installing Homebrew first — the official installer will ask for your Mac password"
  /bin/bash -c "$(fetch_stdout https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || return 1
  local b; b="$(brew_bin)" || return 1
  eval "$("$b" shellenv)"
  if [ "$NOPERSIST" != 1 ] && ! grep -qs 'brew shellenv' "$HOME/.zprofile"; then
    printf '\neval "$(%s shellenv)"\n' "$b" >> "$HOME/.zprofile"
  fi
  run_brew
}

run_clt() {
  warn "macOS will show a dialog to install the Command Line Tools — click Install and wait"
  xcode-select --install 2>/dev/null || true
  local waited=0
  until clt_ready; do sleep 10; waited=$((waited + 10)); [ "$waited" -ge 1800 ] && return 1; done
}

run_macports() {
  local p; case "$TOOL" in node) p=nodejs22 ;; python) p=python312 ;; *) p="$TOOL" ;; esac
  $SUDO port install "$p"
}

run_pkg() {
  local m p; m="$(pkg_mgr)"
  case "$m:$TOOL" in
    pacman:gh|apk:gh) p=github-cli ;;
    apt-get:node|pacman:node|apk:node) p="nodejs npm" ;;
    *:node) p=nodejs ;;
    pacman:python) p=python ;;
    *:python) p=python3 ;;
    *:uv) p=uv ;;
    *) p="$TOOL" ;;
  esac
  case "$m" in
    apt-get) $SUDO apt-get update && $SUDO apt-get install -y $p ;;
    dnf) $SUDO dnf install -y $p ;;
    pacman) $SUDO pacman -S --noconfirm $p ;;
    zypper) $SUDO zypper --non-interactive install $p ;;
    apk) $SUDO apk add $p ;;
  esac
}

run_flatpak() {
  flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo \
    && flatpak install --user -y flathub md.obsidian.Obsidian
}

run_snap() { $SUDO snap install obsidian --classic; }

run_official() { # uv's own installer: user-level, no admin
  fetch_stdout https://astral.sh/uv/install.sh | sh || return 1
  export PATH="$HOME/.local/bin:$PATH"
}

run_uvpython() {
  if ! works uv; then
    say "python needs uv first"
    local np=""; [ "$NOPERSIST" = 1 ] && np="--no-persist"
    bash "$0" uv $np || return 1
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  fi
  uv python install --default || return 1
  add_path "$HOME/.local/bin"
}

run_release() {
  local a name sum url f
  case "$TOOL" in
    gh)
      local ga; [ "$ARCH" = arm64 ] && ga=arm64 || ga=amd64
      if [ "$OS" = darwin ]; then a="$(gh_asset cli/cli "gh_[0-9.]+_macOS_${ga}\.zip")"
      else a="$(gh_asset cli/cli "gh_[0-9.]+_linux_${ga}\.tar\.gz")"; fi
      [ -n "$a" ] || { warn "could not find a GitHub CLI download for this machine"; return 1; }
      split_asset "$a"
      f="$TMP/$name"; fetch "$url" "$f" && verify "$f" "$sum" || return 1
      rm -rf "$OPT/gh" && mkdir -p "$OPT/gh" "$BIN" || return 1
      if [ "$OS" = darwin ]; then unzip -q "$f" -d "$TMP/gh" || return 1
      else mkdir -p "$TMP/gh" && tar -xzf "$f" -C "$TMP/gh" || return 1; fi
      cp -R "$TMP/gh/"*/. "$OPT/gh/" || return 1
      chmod +x "$OPT/gh/bin/gh" && ln -sf "$OPT/gh/bin/gh" "$BIN/gh" || return 1
      add_path "$BIN" ;;
    node)
      local na ext; [ "$ARCH" = arm64 ] && na=arm64 || na=x64
      local ver; ver="$(fetch_stdout https://nodejs.org/dist/index.json | grep -m1 '"lts":"' | sed -E 's/.*"version":"(v[0-9.]+)".*/\1/')"
      [ -n "$ver" ] || { warn "could not read the current Node.js LTS version"; return 1; }
      name="node-$ver-$OS-$na.tar.gz"; f="$TMP/$name"
      sum="$(fetch_stdout "https://nodejs.org/dist/$ver/SHASUMS256.txt" | awk -v n="$name" '$2 == n {print $1}')"
      fetch "https://nodejs.org/dist/$ver/$name" "$f" && verify "$f" "$sum" || return 1
      rm -rf "$OPT/node" && mkdir -p "$OPT/node" || return 1
      tar -xzf "$f" -C "$OPT/node" --strip-components=1 || return 1
      # npm's global prefix lives inside this folder, so `npm install -g` works without sudo
      add_path "$OPT/node/bin" ;;
    obsidian)
      if [ "$OS" = darwin ]; then
        a="$(gh_asset obsidianmd/obsidian-releases 'Obsidian-[0-9.]+\.dmg')"
        [ -n "$a" ] || { warn "could not find an Obsidian download for this Mac"; return 1; }
        split_asset "$a"
        f="$TMP/$name"; fetch "$url" "$f" && verify "$f" "$sum" || return 1
        local mnt="$TMP/mnt" apps=/Applications
        mkdir -p "$mnt" && hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$f" || return 1
        # /Applications needs admin on many Macs; your own Applications folder never does
        [ -w /Applications ] || { apps="$HOME/Applications"; mkdir -p "$apps"; }
        cp -R "$mnt/Obsidian.app" "$apps/"; local rc=$?
        hdiutil detach -quiet "$mnt" || true
        [ $rc -eq 0 ] || return 1
        ok "installed to $apps"
      else
        local oa; [ "$ARCH" = arm64 ] && oa='-arm64' || oa=''
        a="$(gh_asset obsidianmd/obsidian-releases "Obsidian-[0-9.]+${oa}\.AppImage")"
        [ -n "$a" ] || { warn "could not find an Obsidian download for this machine"; return 1; }
        split_asset "$a"
        f="$TMP/$name"; fetch "$url" "$f" && verify "$f" "$sum" || return 1
        mkdir -p "$BIN" && cp "$f" "$BIN/obsidian" && chmod +x "$BIN/obsidian" || return 1
        add_path "$BIN"
      fi ;;
    *) return 1 ;;
  esac
}

# Ordered cheapest and least invasive first; the download page is always last.
ladder() {
  case "$OS:$TOOL" in
    darwin:gh)       echo "brew macports homebrew release" ;;
    darwin:git)      echo "clt brew macports homebrew" ;;
    darwin:node)     echo "brew macports homebrew release" ;;
    darwin:uv)       echo "official brew" ;;
    darwin:python)   echo "clt brew uvpython macports homebrew" ;;
    darwin:obsidian) echo "brew release homebrew" ;;
    linux:gh)        echo "brew pkg release" ;;
    linux:git)       echo "pkg brew" ;;
    linux:node)      echo "brew pkg release" ;;
    linux:uv)        echo "official brew pkg" ;;
    linux:python)    echo "pkg brew uvpython" ;;
    linux:obsidian)  echo "flatpak release snap" ;;
    *)               echo "" ;;
  esac
}

describe() {
  case "$1" in
    brew) echo "Homebrew (already installed and writable)" ;;
    homebrew) echo "install Homebrew, then use it (needs an admin account)" ;;
    clt) echo "Apple Command Line Tools" ;;
    macports) echo "MacPorts" ;;
    pkg) echo "this system's package manager" ;;
    flatpak) echo "Flatpak, for your user only" ;;
    snap) echo "Snap" ;;
    official) echo "the official installer, into your home folder (no admin)" ;;
    uvpython) echo "uv's managed Python, into your home folder (no admin)" ;;
    release) echo "the official download, checksum-verified, into your home folder (no admin)" ;;
  esac
}

RUNGS="$(ladder)"
[ -n "$ONLY" ] && RUNGS="$ONLY"

if [ "$PLAN" = 1 ]; then
  echo "tool: $TOOL · os: $OS · arch: $ARCH"
  i=0
  for r in $RUNGS; do
    i=$((i + 1))
    if avail "$r" >/dev/null 2>&1; then s="available here"; else s="not available here"; fi
    printf '  %d. %s — %s (%s)\n' "$i" "$r" "$(describe "$r")" "$s"
  done
  echo "  page: $(page_for)"
  exit 0
fi

say "Installing $TOOL"
if [ "$FORCE" != 1 ] && have_tool; then
  ok "$TOOL is already installed"
else
  done_ok=0
  for r in $RUNGS; do
    if ! avail "$r" >/dev/null 2>&1; then skip "$(describe "$r") — not available on this machine"; continue; fi
    printf '  trying %s…\n' "$(describe "$r")"
    if "run_$r"; then
      hash -r 2>/dev/null || true
      if [ "$FORCE" = 1 ] || have_tool; then ok "$TOOL installed via $r"; done_ok=1; break; fi
      warn "$r finished but $TOOL still does not run — trying the next way"
    else
      warn "$r did not work — trying the next way"
    fi
  done
  if [ "$done_ok" != 1 ]; then
    say "Could not install $TOOL automatically on this machine"
    echo "  Install it from $(page_for)"
    echo "  then come back to the AIOS App and press Re-check."
    exit 1
  fi
fi

if [ -n "$THEN" ]; then
  say "Next: $THEN"
  eval "$THEN"
  exit $?
fi
exit 0
