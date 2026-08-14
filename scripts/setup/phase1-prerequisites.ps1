# -----------------------------------------------------------------------------
# AIOS - Phase 1: make this PC capable of running a Claude session.
#
# The Windows counterpart of phase1-prerequisites.sh, and it stops at exactly
# the same place: this is the ONLY thing the app installs. Everything after it
# (cloning the framework, MCP auth, the spawn wrappers, hooks, the cold-start
# interview) is conversational and belongs to a Claude session following
# SETUP.md - which is written FOR a Claude session, with judgment a script
# cannot carry.
#
# Every step is CHECK-THEN-ACT and safe to re-run. Nothing is hidden: each step
# says what it is about to do, and the script ends by PROVING the result the
# same way the app's own doctor will.
#
# winget is the package manager here (Homebrew's role in the .sh). It ships with
# Windows 11 and modern Windows 10 as "App Installer". Without it there is
# nothing this script can honestly install, so it says so and names the pages -
# an impossible instruction is worse than no instruction.
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Continue'

function Say  { param($m) Write-Host ""; Write-Host $m -ForegroundColor White }
function Ok   { param($m) Write-Host "  [ok]   $m" -ForegroundColor Green }
function Skip { param($m) Write-Host "  [--]   $m" -ForegroundColor DarkGray }
function Warn { param($m) Write-Host "  [!]    $m" -ForegroundColor Yellow }

# "Is this tool really here?" - and on Windows Get-Command alone cannot answer that.
#
# %LOCALAPPDATA%\Microsoft\WindowsApps holds App Execution Alias STUBS that exist on a clean
# machine even when the tool does not. `python` is the notorious one: the stub's only job is to
# open the Microsoft Store, but Get-Command reports it as a command, so a bare check declared
# python installed, skipped the winget install, and left the operator with a launcher that
# cannot run anything - a green Phase 1 on a machine with no Python.
#
# The guard tests BEHAVIOUR, not the folder: winget itself legitimately lives in WindowsApps, so
# blacklisting the path would break the package manager this whole script depends on. A real
# tool answers --version with something version-shaped; the stub prints its "not found" notice.
# Only tools resolving inside WindowsApps pay for the probe, so the common case stays free.
function Have {
  param([string]$n)
  $c = Get-Command $n -ErrorAction SilentlyContinue
  if (-not $c) { return $false }
  if (-not $env:LOCALAPPDATA) { return $true }
  $aliasDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
  $src = [string]$c.Source
  if (-not $src -or -not $src.StartsWith($aliasDir, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  $out = ''
  try { $out = (& $n --version 2>$null | Out-String) } catch { }
  return [bool]($out -match '\d+\.\d+')
}

Say "AIOS setup - Phase 1 of 2: the tools a Claude session needs"
Write-Host "  Phase 2 is the AIOS itself, and a Claude session does that part with you."
Write-Host "  Everything here is safe to run again; steps already done are skipped."

# -- 0. PowerShell profile ----------------------------------------------------
# A brand-new Windows account has NO profile file. Anything that appends to it
# (the spawn wrapper, a PATH line) has to create it first, or the append lands
# nowhere. Mirrors the .sh's .zprofile/.zshrc step.
Say "PowerShell profile"
if (Test-Path $PROFILE) {
  Skip "profile exists ($PROFILE)"
} else {
  New-Item -ItemType File -Path $PROFILE -Force | Out-Null
  Ok "created $PROFILE"
}

# -- 1. winget ----------------------------------------------------------------
Say "Package manager (winget)"
$winget = Have 'winget'
if ($winget) {
  Ok "winget is available"
} else {
  Warn "winget not found. It ships as 'App Installer' from the Microsoft Store."
  Warn "Install it from https://aka.ms/getwinget, then run this again."
  Warn "Everything below will be checked but cannot be installed without it."
}

# Install one winget package, but only if the command it provides is missing.
# Idempotent by CAPABILITY, not by package list: an operator who already has
# node from nodejs.org must not have a second copy installed over the top.
function Ensure {
  param([string]$Cmd, [string]$Id, [string]$Label)
  if (Have $Cmd) { Skip "$Label already installed"; return }
  if (-not $winget) { Warn "$Label missing - needs winget"; return }
  Write-Host "  installing $Label..."
  winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Null
  # winget puts new shims on the MACHINE/USER path, which this process cannot
  # see; re-read the persisted environment so the next check is honest.
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  if (Have $Cmd) { Ok $Label } else { Warn "$Label install did not take - continuing, the doctor will flag it" }
}

# -- 2. The toolchain ---------------------------------------------------------
# Same list as the .sh: node, git, gh, python, uv.
Say "Toolchain (node, git, gh, python, uv)"
Ensure -Cmd 'node'    -Id 'OpenJS.NodeJS.LTS' -Label 'node'
Ensure -Cmd 'git'     -Id 'Git.Git'           -Label 'git'
Ensure -Cmd 'gh'      -Id 'GitHub.cli'        -Label 'gh'
Ensure -Cmd 'python'  -Id 'Python.Python.3.12' -Label 'python'
Ensure -Cmd 'uv'      -Id 'astral-sh.uv'      -Label 'uv'

# -- 3. Obsidian --------------------------------------------------------------
# Required on every path: it is how you read the vault, and it is what the
# bundled Obsidian MCP talks to. It is a GUI app, so presence is a file check.
Say "Obsidian"
$obsidian = @(
  (Join-Path $env:LOCALAPPDATA 'Obsidian\Obsidian.exe'),
  (Join-Path $env:ProgramFiles 'Obsidian\Obsidian.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($obsidian) {
  Ok "already installed ($obsidian)"
} elseif ($winget) {
  Write-Host "  installing..."
  winget install --id Obsidian.Obsidian -e --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Null
  $obsidian = @(
    (Join-Path $env:LOCALAPPDATA 'Obsidian\Obsidian.exe'),
    (Join-Path $env:ProgramFiles 'Obsidian\Obsidian.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($obsidian) { Ok "installed" } else { Warn "install failed - get it from https://obsidian.md" }
} else {
  Warn "not installed - get it from https://obsidian.md"
}

# -- 4. Claude Code -----------------------------------------------------------
# Four states, cheapest first, each leaving the machine in a state the next can
# build on - the same ladder as the .sh. State 2 is not hypothetical: it is
# where you land when the official installer succeeds and leaves PATH alone.
Say "Claude Code"

function Claude-PathFix {
  # DRIVEN BY WHETHER IT WORKS, NOT BY WHETHER THE TEXT IS THERE - the same
  # correction the .sh carries. And "works" means a NEW terminal, which on
  # Windows is the persisted (User) environment block, not this process's copy.
  $dirs = @("$HOME\.local\bin", "$env:APPDATA\npm", "$HOME\.claude\local")
  $dir = $dirs | Where-Object {
    (Test-Path (Join-Path $_ 'claude.exe')) -or (Test-Path (Join-Path $_ 'claude.cmd')) -or (Test-Path (Join-Path $_ 'claude'))
  } | Select-Object -First 1
  if (-not $dir) { Warn "claude is not in any known location - nothing to add to PATH"; return }
  $u = [Environment]::GetEnvironmentVariable('Path','User'); if (-not $u) { $u = '' }
  if (($u -split ';') -contains $dir) {
    Skip "$dir is already on your PATH"
  } else {
    [Environment]::SetEnvironmentVariable('Path', (($u.TrimEnd(';') + ';' + $dir).Trim(';')), 'User')
    Ok "added $dir to your PATH"
  }
  $env:Path = "$env:Path;$dir"
  if (Have 'claude') { Ok "a new terminal can now run claude" }
  else { Warn "a new terminal still cannot run claude - the app's Setup will show this and offer the fix" }
}

$onDisk = @("$HOME\.local\bin\claude.exe", "$HOME\.local\bin\claude.cmd", "$env:APPDATA\npm\claude.cmd", "$HOME\.claude\local\claude.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1

if (Have 'claude') {
  Ok ("already installed (" + ((claude --version 2>$null | Select-Object -First 1)) + ")")
} elseif ($onDisk) {
  # 2. installed already, just unreachable - no download needed, only PATH
  Warn "installed but not on your PATH - fixing that instead of reinstalling"
  Claude-PathFix
} else {
  # 3. the official Windows installer, preferred: it needs neither node nor npm.
  Write-Host "  installing via the official installer..."
  try {
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  } catch {
    Warn "the official installer failed - falling back to npm"
    if (Have 'npm') { npm install -g @anthropic-ai/claude-code | Out-Null }
    else { Warn "npm is not available either - install Claude Code from https://claude.ai/download" }
  }
  Claude-PathFix
}

# -- Prove it, the way the app will -------------------------------------------
# The persisted environment, which is what a NEW terminal (and every pane this
# app opens) will read. Anything that passes here is real.
Say "Checking the way the AIOS App will"
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
$fail = $false
foreach ($tool in @('git','node','npm','gh','python','uv','claude')) {
  if (Have $tool) { Ok $tool } else { Warn "$tool NOT found by a new terminal"; $fail = $true }
}
$obsidian = @(
  (Join-Path $env:LOCALAPPDATA 'Obsidian\Obsidian.exe'),
  (Join-Path $env:ProgramFiles 'Obsidian\Obsidian.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($obsidian) { Ok "Obsidian" } else { Warn "Obsidian not installed"; $fail = $true }

$bar = '=' * 58
Write-Host ""
if (-not $fail) {
  Write-Host $bar -ForegroundColor Green
  Write-Host ""
  Write-Host "   Phase 1 complete - everything Phase 1 owns is in place." -ForegroundColor Green
  Write-Host ""
  Write-Host "   Next, in the AIOS App:" -ForegroundColor Green
  Write-Host "     1. Sign in to Claude          (AIOS > Sign In to Claude)" -ForegroundColor Green
  Write-Host "     2. Set up my AIOS             - this hands over to a Claude session," -ForegroundColor Green
  Write-Host "        which clones the framework and walks you through the rest." -ForegroundColor Green
  Write-Host $bar -ForegroundColor Green
} else {
  Write-Host $bar -ForegroundColor Yellow
  Write-Host ""
  Write-Host "   Phase 1 finished with gaps - some tools are still missing above." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "   Open a NEW terminal window and run this again: PATH changes only" -ForegroundColor Yellow
  Write-Host "   reach shells started after them." -ForegroundColor Yellow
  Write-Host $bar -ForegroundColor Yellow
}
Write-Host ""
