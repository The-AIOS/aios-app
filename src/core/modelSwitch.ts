/**
 * "This session finished on a model nobody chose". Canonical's model-switch hook appends one
 * line per model switch to ~/.aios/model-switch.jsonl ($AIOS_MODEL_SWITCH_LOG overrides):
 *   {"at": ISO-8601 UTC, "session_id", "name", "from", "to", "reason"}   (unknown values = "")
 * An unattended worker can be moved to another model (a fallback, a flag) with nothing reporting
 * it; this reads the log so the session's row can say so. Pure: the caller reads the file.
 */
export interface ModelSwitch { at: number; from: string; to: string; reason: string }

/** Latest switch per session id, ignoring torn or foreign lines. */
export function latestSwitches(jsonl: string): Map<string, ModelSwitch> {
  const out = new Map<string, ModelSwitch>();
  for (const line of String(jsonl ?? '').split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    const sid = typeof e.session_id === 'string' ? e.session_id : '';
    const to = typeof e.to === 'string' ? e.to : '';
    const at = Date.parse(typeof e.at === 'string' ? e.at : '');
    if (!sid || !to || !Number.isFinite(at)) continue;
    const prev = out.get(sid);
    if (prev && prev.at > at) continue;
    out.set(sid, { at, to, from: typeof e.from === 'string' ? e.from : '', reason: typeof e.reason === 'string' ? e.reason : '' });
  }
  return out;
}

/** A model id as a person reads it: `claude-opus-4-8` → `Opus 4.8`; unknown shapes pass through. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/i.exec(String(id ?? '').trim());
  if (!m) return String(id ?? '');
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${fam} ${m[2]}${m[3] ? '.' + m[3] : ''}${m[4] ? ' (1M)' : ''}`;
}

/** The row's line: "finished on Opus 4.8 — flagged content". Only a switch inside this run counts. */
export function switchLine(s: ModelSwitch | undefined, startedAt: number): string {
  if (!s || (startedAt && s.at < startedAt)) return '';
  return `on ${modelName(s.to)}${s.reason ? ` — ${s.reason}` : ''}`;
}

/** Review nit: the same answer as data, so the renderer words it in the operator's language (main
 *  used to build the English "on …" itself). `reason` is Claude's own text and stays as written. */
/** A switch the operator CHOSE (the /model picker, a typed command) is not news — the line exists
 *  for the switch nobody picked (a fallback, flagged content). Operator test: "on Opus 5.5 — picker". */
export function operatorChose(reason: string): boolean {
  return /^(picker|user|model|\/model|command|slash|manual)\b/i.test(String(reason ?? '').trim());
}
export function switchParts(s: ModelSwitch | undefined, startedAt: number): { model: string; reason: string } | undefined {
  if (!s || (startedAt && s.at < startedAt) || operatorChose(s.reason)) return undefined;
  return { model: modelName(s.to), reason: s.reason };
}
