/** The theme a window paints: the operator's pick, else the OS's. Pure, so it is testable. */
export type ThemePref = 'system' | 'light' | 'dark';
export function resolvedTheme(pref: string, osDark: boolean): 'light' | 'dark' {
  return pref === 'light' || pref === 'dark' ? pref : osDark ? 'dark' : 'light';
}
/** The two body backgrounds, matching `--bg` in renderer/theme.css (`:root` and `body.light`). */
export const WINDOW_BG = { dark: '#0b0b0d', light: '#f4f4f2' } as const;
