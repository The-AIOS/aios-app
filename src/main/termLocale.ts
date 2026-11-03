/**
 * A UTF-8 locale for every terminal the App starts.
 *
 * The App launched from the Dock has no LANG/LC_* at all (measured on a live install), and its
 * PTYs inherited that. Sessions were UTF-8 only by accident: the login zsh reads /etc/zprofile,
 * which sets LANG=C.UTF-8 when none is set. That rescue does not happen for an operator whose
 * login shell is bash, or for any non-login child. With no UTF-8 locale, `pbcopy` decodes its
 * input as Mac Roman, so an agent that copies "a→b — á" puts "a‚Üíb ‚Äî √°" on the clipboard,
 * and only the person it was pasted to sees it.
 *
 * A DEFAULT, NOT A HARDCODE: set only when the operator has set none of LANG, LC_ALL or LC_CTYPE.
 * C.UTF-8 is the value /etc/zprofile itself uses on macOS and is present on modern Linux,
 * where en_US.UTF-8 may not be generated. Windows has no POSIX locale variables; untouched.
 */
export const DEFAULT_TERM_LANG = 'C.UTF-8';

export function withDefaultLocale(env: Record<string, string>, platform: NodeJS.Platform): Record<string, string> {
  if (platform === 'win32') return env;
  if (env.LANG || env.LC_ALL || env.LC_CTYPE) return env;
  return { ...env, LANG: DEFAULT_TERM_LANG };
}
