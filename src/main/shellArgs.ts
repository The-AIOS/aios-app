/**
 * The interactive-shell argv for a terminal pane, per platform. Pure, so every platform's answer
 * can be tested on any machine.
 *
 * POSIX shells take `-l` (login shell: the pane inherits ~/.zprofile / ~/.bash_profile PATH).
 * Windows PowerShell has no -l and node-pty exits code 1 on an unknown argument, so it gets
 * `-NoLogo`; cmd.exe takes no such flag.
 *
 * `noProfile` (#44) is for the SETUP terminals only. On a company-managed laptop the user's
 * PowerShell profile is blocked by policy, and merely loading it printed a red "running scripts is
 * disabled" error before setup had done anything, which operators read as "the install failed".
 * Setup needs nothing from the profile (its scripts already run with -NoProfile, and the AIOS
 * `spawn` wrapper that lives there is something setup INSTALLS, not uses). Every other terminal
 * keeps loading the profile: that is where operators keep their own setup.
 */
export function shellArgs(shell: string, platform: NodeJS.Platform, noProfile = false): string[] {
  if (platform === 'win32') {
    if (!/powershell|pwsh/i.test(shell)) return [];
    return noProfile ? ['-NoLogo', '-NoProfile'] : ['-NoLogo'];
  }
  return ['-l'];
}
