/**
 * The all-or-nothing release gate (operator's decision, 0.11.0).
 *
 * The old order: macOS created the Release PUBLIC, then Linux and Windows attached to it. A Mac
 * failure could never ship without Mac, but the reverse was open — Mac publishes, Linux or Windows
 * then fails, and the release is live with only Mac's feed, so every Windows/Linux updater fails
 * against the newest release until someone repairs it by hand.
 *
 * Now macOS creates it as a DRAFT (electron-updater ignores drafts, so nobody sees it), every lane
 * attaches to the draft, and each lane ends by asking this function whether the set is complete.
 * Whichever lane completes it publishes. A missing manifest is not a failure here — another lane
 * may still be running — it simply leaves the draft a draft. Pure.
 */
export const REQUIRED_MANIFESTS = ['latest-mac.yml', 'latest.yml', 'latest-linux.yml'] as const;

export type GateDecision =
  | { do: 'publish' }
  | { do: 'wait'; missing: string[] }
  | { do: 'already-public' };

export function gateDecision(release: { isDraft: boolean; assets: string[] }): GateDecision {
  if (!release.isDraft) return { do: 'already-public' };
  const have = new Set(release.assets);
  const missing = REQUIRED_MANIFESTS.filter((m) => !have.has(m));
  return missing.length ? { do: 'wait', missing } : { do: 'publish' };
}

/**
 * #194: two lanes can reach the gate in the same second. The one that loses the race reads the release while the other
 * is publishing it, gets "not found" or a failed feed check, and used to fail its run on a good release. So when a
 * lane's read or check fails, it reads again: a release that is now PUBLIC with every manifest attached was published
 * by the other lane, and that is success. Anything else is still a failure. Pure: the caller does the reading.
 */
export function publishedByAnotherLane(release: { isDraft: boolean; assets: string[] } | null): boolean {
  if (!release || release.isDraft) return false;
  const have = new Set(release.assets);
  return REQUIRED_MANIFESTS.every((m) => have.has(m));
}
