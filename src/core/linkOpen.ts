/**
 * #176: a link that asks for a new window opens in the operator's default browser.
 *
 * Electron's default for a `target="_blank"` link or `window.open` is a new App window, which has
 * none of the operator's browser sessions, so a claude.ai artifact or a Google Doc opened there was
 * signed out and useless. The App never opens windows of its own that way, so every such request is
 * either handed to the default browser (web and mail links) or refused (anything else: file:, data:,
 * javascript:, custom schemes). Pure, so the scheme rule is tested on its own.
 */
export type LinkAction = 'external' | 'deny';

export function windowOpenAction(url: string): LinkAction {
  return /^(https?:\/\/|mailto:)/i.test(String(url || '').trim()) ? 'external' : 'deny';
}
