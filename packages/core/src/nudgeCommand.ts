/**
 * The command a panel nudge names (its "Run /…" label). Today's daily note suggests a ritual on a 💡 line, e.g.
 * `/aios:agent explainer`. The label used to keep only the first word after the slash, so that became "Run /agent"
 * followed by the explainer's description, which read as nonsense (operator-reported, 0.16.0). The label keeps the
 * command and ONE plain-name argument (an agent, a skill, a session); a URL or free text is left out, so the label stays
 * short. The full command still runs on click.
 */
export function nudgeShort(command: string): string {
  const words = String(command || '').trim().replace(/^\/(?:aios:|vault-commands:)?/, '').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const [cmd, arg] = words;
  return arg && /^[a-z0-9][a-z0-9-]{0,39}$/i.test(arg) ? `${cmd} ${arg}` : cmd;
}
