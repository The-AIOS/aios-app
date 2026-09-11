# -----------------------------------------------------------------------------
# AIOS - install ONE missing tool on Windows, trying every way this PC allows.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-tool.ps1 -Tool gh [-Then "<command>"]
#
# The Windows counterpart of install-tool.sh, for the same reason. Each tool had
# exactly one way in - winget - and a real first install still ended with gh
# installed by hand from CMD. winget can be missing (older Windows 10, LTSC,
# managed machines), broken (source errors, agreements it waits on), or it can
# SUCCEED into a PATH this terminal cannot see yet. So the tool is installed by
# trying each way in order until it RUNS:
#
#   1. winget, then Scoop, then Chocolatey (only when already present; Chocolatey
#      only in an elevated terminal, because it needs one)
#   2. the tool's official installer or download, checksum-verified, into
#      %LOCALAPPDATA%\Programs - no administrator rights needed
#   3. the download page, named plainly, when nothing above can succeed
#
# Success is decided by running the tool after re-reading PATH from the
# registry, never by an installer's exit code.
#
# -Then runs a command AFTER the tool works, in THIS process, whose PATH already
# includes what was just installed. The terminal that launched this script still
# has the old PATH; running the follow-up here removes the "open a new terminal"
# step. (The AIOS App itself keeps its launch-time PATH until it restarts - that
# is how Windows propagates environment changes, see AI-111 in aios.ts.)
#
# Testing parameters (not for operators): -Plan lists the ladder and touches
# nothing - -Only <rung> - -Dest <dir> installs downloads under <dir> -
# -NoPersist leaves the user PATH alone - -Force ignores an existing tool -
# -Arch x64|arm64 picks the download for another machine.
# -----------------------------------------------------------------------------
param(
  [Parameter(Mandatory = $true)][ValidateSet('gh', 'git', 'node', 'uv', 'python', 'obsidian')][string]$Tool,
  [string]$Then = '',
  [switch]$Plan,
  [string]$Only = '',
  [string]$Dest = '',
  [switch]$NoPersist,
  [switch]$Force,
  [string]$Arch = ''
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with the progress bar on 5.1
# Windows PowerShell 5.1 on older builds still defaults to TLS 1.0, which GitHub and nodejs.org refuse.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

function Say  { param($m) Write-Host ""; Write-Host $m -ForegroundColor White }
function Ok   { param($m) Write-Host "  [ok]   $m" -ForegroundColor Green }
function Skip { param($m) Write-Host "  [--]   $m" -ForegroundColor DarkGray }
function Warn { param($m) Write-Host "  [!]    $m" -ForegroundColor Yellow }

if (-not $Arch) {
  $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $Arch = if ($a -eq 'ARM64') { 'arm64' } else { 'x64' }
}
$Root = if ($Dest) { $Dest } else { Join-Path $env:LOCALAPPDATA 'Programs' }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$Root = (Resolve-Path $Root).Path
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("aios-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$script:SessionPaths = @()

$Pages = @{
  gh = 'https://cli.github.com/'; git = 'https://git-scm.com/download/win'; node = 'https://nodejs.org/en/download'
  uv = 'https://docs.astral.sh/uv/getting-started/installation/'; python = 'https://www.python.org/downloads/windows/'
  obsidian = 'https://obsidian.md/download'
}
$Cmd = @{ gh = 'gh'; git = 'git'; node = 'node'; uv = 'uv'; python = 'python'; obsidian = '' }

# -- is the tool REALLY here ---------------------------------------------------
# Same guard as phase1-prerequisites.ps1: %LOCALAPPDATA%\Microsoft\WindowsApps holds App Execution
# Alias stubs (python is the notorious one) that Get-Command reports as commands but that only open
# the Microsoft Store. A real tool answers --version with something version-shaped.
function Have {
  param([string]$n)
  $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $false }
  $out = ''
  try { $out = (& $n --version 2>$null | Out-String) } catch { }
  return [bool]($out -match '\d+\.\d+')
}
function Find-Obsidian {
  @(
    (Join-Path $env:LOCALAPPDATA 'Obsidian\Obsidian.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Obsidian\Obsidian.exe'),
    (Join-Path $env:ProgramFiles 'Obsidian\Obsidian.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
function Have-Tool {
  if ($Tool -eq 'obsidian') { return [bool](Find-Obsidian) }
  return (Have $Cmd[$Tool])
}

# A new terminal reads PATH from the registry; this process read it once, at start. Re-read it,
# keeping anything this run added, so "did the install work?" is asked of the PATH a new terminal
# would actually have.
function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($script:SessionPaths) + @($u, $m) | Where-Object { $_ }) -join ';'
}
# PREPENDED, not appended: an appended python lands behind the WindowsApps stub and loses to it.
function Add-UserPath {
  param([string]$dir)
  $script:SessionPaths = @($dir) + @($script:SessionPaths)
  if (-not $NoPersist) {
    $u = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $u) { $u = '' }
    if (-not (($u -split ';') -contains $dir)) {
      [Environment]::SetEnvironmentVariable('Path', (($dir + ';' + $u).Trim(';')), 'User')
    }
    Ok "$dir is on your PATH (now and in new terminals)"
  }
  Refresh-Path
}

function Is-Elevated {
  try { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { return $false }
}

function Fetch { param([string]$Url, [string]$Out) Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Out -Headers @{ 'User-Agent' = 'aios-app-setup' } }

# A download is used only if its SHA-256 matches the publisher's. No match, or nothing to compare
# against, and the rung fails: the next rung or the download page beats running an unverified binary.
function Verify {
  param([string]$File, [string]$Expected)
  $got = (Get-FileHash -Algorithm SHA256 -Path $File).Hash.ToLowerInvariant()
  if ($Expected -and $got -eq $Expected.ToLowerInvariant()) { Ok 'checksum verified'; return $true }
  Warn 'checksum mismatch or unavailable - not using this download'; return $false
}

# The newest non-prerelease GitHub release that HAS an asset matching the pattern. Newest-with-the-
# asset rather than "latest": a latest release can omit a platform (Obsidian has shipped one with
# only the Android package). GitHub records a sha256 digest per uploaded asset - that is the checksum.
function Get-GitHubAsset {
  param([string]$Repo, [string]$Pattern)
  $rels = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=15" -Headers @{ 'User-Agent' = 'aios-app-setup' }
  foreach ($r in $rels) {
    if ($r.prerelease -or $r.draft) { continue }
    foreach ($a in $r.assets) {
      if ($a.name -match $Pattern -and $a.digest) {
        return [pscustomobject]@{ Name = $a.name; Url = $a.browser_download_url; Sha = ($a.digest -replace '^sha256:', '') }
      }
    }
  }
  return $null
}

# Expand a zip and return the folder that actually holds its content (skipping a single top folder).
function Expand-Flat {
  param([string]$Zip, [string]$Target)
  $x = Join-Path $Tmp ('x-' + [Guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $Zip -DestinationPath $x -Force
  $inner = Get-ChildItem $x
  $src = if ($inner.Count -eq 1 -and $inner[0].PSIsContainer) { $inner[0].FullName } else { $x }
  if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
  New-Item -ItemType Directory -Force -Path (Split-Path $Target) | Out-Null
  Move-Item -Path $src -Destination $Target
}

# -- the rungs -----------------------------------------------------------------
$WingetId = @{ gh = 'GitHub.cli'; git = 'Git.Git'; node = 'OpenJS.NodeJS.LTS'; uv = 'astral-sh.uv'; python = 'Python.Python.3.12'; obsidian = 'Obsidian.Obsidian' }
$ScoopName = @{ gh = 'gh'; git = 'git'; node = 'nodejs-lts'; uv = 'uv'; python = 'python'; obsidian = 'extras/obsidian' }
$ChocoName = @{ gh = 'gh'; git = 'git'; node = 'nodejs-lts'; uv = 'uv'; python = 'python'; obsidian = 'obsidian' }

function Avail {
  param([string]$r)
  switch ($r) {
    'winget'   { return (Have 'winget') }
    'scoop'    { return [bool](Get-Command scoop -ErrorAction SilentlyContinue) }
    'choco'    { return ([bool](Get-Command choco -ErrorAction SilentlyContinue) -and (Is-Elevated)) }
    'official' { return $true }
    'uvpython' { return $true }
    'release'  { return $true }
  }
  return $false
}

function Describe {
  param([string]$r)
  switch ($r) {
    'winget'   { 'winget (Windows package manager)' }
    'scoop'    { 'Scoop, for your user only' }
    'choco'    { 'Chocolatey (needs an administrator terminal)' }
    'official' { 'the official installer, for your user only (no admin)' }
    'uvpython' { "uv's managed Python, for your user only (no admin)" }
    'release'  { 'the official download, checksum-verified, for your user only (no admin)' }
  }
}

function Run-Rung {
  param([string]$r)
  switch ($r) {
    'winget' {
      winget install --id $WingetId[$Tool] -e --source winget --accept-package-agreements --accept-source-agreements | Out-Host
      return $true
    }
    'scoop' {
      if ($Tool -eq 'obsidian') { scoop bucket add extras | Out-Null }
      scoop install $ScoopName[$Tool] | Out-Host
      return $true
    }
    'choco' { choco install $ChocoName[$Tool] -y | Out-Host; return $true }
    'official' {
      # uv's own installer: user-level, writes %USERPROFILE%\.local\bin and the user PATH itself
      powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex" | Out-Host
      Add-UserPath (Join-Path $HOME '.local\bin')
      return $true
    }
    'uvpython' {
      if (-not (Have 'uv')) {
        Say 'python needs uv first'
        $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Tool', 'uv')
        if ($NoPersist) { $args2 += '-NoPersist' }
        & powershell @args2 | Out-Host
        $script:SessionPaths = @((Join-Path $HOME '.local\bin')) + @($script:SessionPaths)
        Refresh-Path
        if (-not (Have 'uv')) { return $false }
      }
      uv python install --default | Out-Host
      Add-UserPath (Join-Path $HOME '.local\bin')
      return $true
    }
    'release' { return (Run-Release) }
  }
  return $false
}

function Run-Release {
  switch ($Tool) {
    'gh' {
      $ga = if ($Arch -eq 'arm64') { 'arm64' } else { 'amd64' }
      $a = Get-GitHubAsset 'cli/cli' "^gh_[0-9.]+_windows_$ga\.zip$"
      if (-not $a) { Warn 'could not find a GitHub CLI download for this PC'; return $false }
      $f = Join-Path $Tmp $a.Name; Fetch $a.Url $f
      if (-not (Verify $f $a.Sha)) { return $false }
      $target = Join-Path $Root 'gh'
      Expand-Archive -Path $f -DestinationPath $target -Force
      Add-UserPath (Join-Path $target 'bin')
      return $true
    }
    'git' {
      # PortableGit, not MinGit: Claude Code on Windows needs Git Bash, and only PortableGit carries bash.
      $pa = if ($Arch -eq 'arm64') { 'arm64' } else { '64-bit' }
      $a = Get-GitHubAsset 'git-for-windows/git' "^PortableGit-[0-9.]+-$pa\.7z\.exe$"
      if (-not $a) { Warn 'could not find a Git download for this PC'; return $false }
      $f = Join-Path $Tmp $a.Name; Fetch $a.Url $f
      if (-not (Verify $f $a.Sha)) { return $false }
      $target = Join-Path $Root 'Git'
      # a self-extracting 7-Zip archive: -y answers yes, -o<dir> (no space) is where it goes
      $p = Start-Process -FilePath $f -ArgumentList @('-y', "-o`"$target`"") -Wait -PassThru -WindowStyle Hidden
      if ($p.ExitCode -ne 0) { return $false }
      Add-UserPath (Join-Path $target 'cmd')
      $bash = Join-Path $target 'bin\bash.exe'
      if ((Test-Path $bash) -and -not $NoPersist) {
        # where Claude Code looks for Git Bash when git is not in a standard install location
        [Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', $bash, 'User')
        $env:CLAUDE_CODE_GIT_BASH_PATH = $bash
      }
      return $true
    }
    'node' {
      $na = if ($Arch -eq 'arm64') { 'arm64' } else { 'x64' }
      $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -Headers @{ 'User-Agent' = 'aios-app-setup' }
      $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
      if (-not $lts) { Warn 'could not read the current Node.js LTS version'; return $false }
      $ver = $lts.version; $name = "node-$ver-win-$na.zip"
      $sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$ver/SHASUMS256.txt").Content
      $sha = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($name))\s*$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
      $f = Join-Path $Tmp $name; Fetch "https://nodejs.org/dist/$ver/$name" $f
      if (-not (Verify $f $sha)) { return $false }
      $target = Join-Path $Root 'node'
      Expand-Flat $f $target
      Add-UserPath $target
      # where `npm install -g` puts commands (Claude Code, for one)
      Add-UserPath (Join-Path $env:APPDATA 'npm')
      return $true
    }
    'obsidian' {
      $a = Get-GitHubAsset 'obsidianmd/obsidian-releases' '^Obsidian-[0-9.]+\.exe$'
      if (-not $a) { Warn 'could not find an Obsidian download for this PC'; return $false }
      $f = Join-Path $Tmp $a.Name; Fetch $a.Url $f
      if (-not (Verify $f $a.Sha)) { return $false }
      # the per-user installer: /S is silent, and it installs under %LOCALAPPDATA% without elevation
      $p = Start-Process -FilePath $f -ArgumentList '/S' -Wait -PassThru
      return ($p.ExitCode -eq 0)
    }
  }
  return $false
}

# Ordered least invasive first; the download page is always last.
$Ladders = @{
  gh       = @('winget', 'scoop', 'choco', 'release')
  git      = @('winget', 'scoop', 'choco', 'release')
  node     = @('winget', 'scoop', 'choco', 'release')
  uv       = @('official', 'winget', 'scoop', 'choco')
  python   = @('winget', 'scoop', 'choco', 'uvpython')
  obsidian = @('winget', 'scoop', 'choco', 'release')
}
$Rungs = if ($Only) { @($Only) } else { $Ladders[$Tool] }

try {
  if ($Plan) {
    Write-Host "tool: $Tool - os: windows - arch: $Arch"
    $i = 0
    foreach ($r in $Rungs) {
      $i++
      $s = if (Avail $r) { 'available here' } else { 'not available here' }
      Write-Host ("  {0}. {1} - {2} ({3})" -f $i, $r, (Describe $r), $s)
    }
    Write-Host "  page: $($Pages[$Tool])"
    exit 0
  }

  Say "Installing $Tool"
  if ((-not $Force) -and (Have-Tool)) {
    Ok "$Tool is already installed"
  } else {
    $done = $false
    foreach ($r in $Rungs) {
      if (-not (Avail $r)) { Skip "$(Describe $r) - not available on this PC"; continue }
      Write-Host "  trying $(Describe $r)..."
      $ran = $false
      try { $ran = [bool](Run-Rung $r | Select-Object -Last 1) } catch { Warn "$r failed: $($_.Exception.Message)" }
      Refresh-Path
      if ($ran -and ($Force -or (Have-Tool))) { Ok "$Tool installed via $r"; $done = $true; break }
      Warn "$r did not produce a working $Tool - trying the next way"
    }
    if (-not $done) {
      Say "Could not install $Tool automatically on this PC"
      Write-Host "  Install it from $($Pages[$Tool])"
      Write-Host "  then close and reopen the AIOS App and press Re-check."
      exit 1
    }
  }

  if ($Then) {
    Say "Next: $Then"
    Refresh-Path
    Invoke-Expression $Then
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
  }
  exit 0
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
