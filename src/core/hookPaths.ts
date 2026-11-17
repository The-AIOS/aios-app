/**
 * Where a framework hook lives (canonical v0.8.19 moved them into folders: aios#309). The App runs
 * some hooks by path and checks that others are wired, so it asks here: the new place first, then the
 * old one, so a vault not yet updated keeps working (canonical keeps forwarding files at the old paths
 * until v0.8.20, aios#330). Pure: the caller says which paths exist.
 */

/** Hook file → its folder under hooks/ since v0.8.19. */
export const HOOK_FOLDER: Readonly<Record<string, string>> = {
  'resolve-tier': 'pipeline',
  'install-settings.py': 'install',
  'issue-scrub.py': 'security',
  'aios-health.py': 'pipeline',
  'inject-datetime.sh': 'context',
  'inject-datetime.ps1': 'context',
  'provenance.py': 'context',
  'bus_log.py': 'context',
  'floor-at-start.py': 'context',
  'model-switch-log.py': 'pipeline',
  'suggest-agent-hint.py': 'agents',
};

/** The places a hook may be, relative to the framework root, best first. */
export function hookCandidates(file: string): string[] {
  const dir = HOOK_FOLDER[file];
  return dir ? [`hooks/${dir}/${file}`, `hooks/${file}`] : [`hooks/${file}`];
}

/** The first candidate that exists (relative to the root), or undefined. */
export function findHook(file: string, exists: (rel: string) => boolean): string | undefined {
  return hookCandidates(file).find(exists);
}
