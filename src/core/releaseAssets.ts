/**
 * Does the published Release actually carry a usable update feed — for THIS platform?
 *
 * v0.7.0 was signed, notarized, published and verified, and could not update anybody: the
 * manifest named a file that was never uploaded. v0.7.1's first cut repeated it. The gate that
 * was supposed to catch it asserted `test -f dist/latest-mac.yml` — presence, when the
 * requirement was usability.
 *
 * The fix that shipped was correct and macOS-shaped: it grepped `latest-mac.yml` and `\.dmg$`
 * inline in the workflow. The moment a second platform exists that check is a liability twice
 * over — it fails a correct Linux release, and it silently guards nothing on one. Each platform
 * uses a DIFFERENT electron-updater class with a DIFFERENT accepted format, and every one of
 * them is a fresh chance to repeat v0.7.0:
 *
 *   darwin  MacUpdater      findFile(files, 'zip', ['pkg', 'dmg'])  → the target must be a ZIP,
 *                           and the dmg is explicitly EXCLUDED. This is v0.7.0's bug exactly.
 *   linux   AppImageUpdater → the target must be the AppImage. There is NO deb updater in
 *                           electron-updater, so a .deb can ship as an install artifact but can
 *                           never be the update channel. Pointing the manifest at one produces
 *                           a release whose Linux users never update and are never told.
 *   win32   NsisUpdater     → the target must be the installer .exe.
 *
 * So the rule is not "a manifest exists" and not even "the manifest's file is attached". It is:
 * the manifest names a file that IS attached AND is a format this platform's updater will
 * accept. Presence, attachment, and format are three different failures; v0.7.0 passed the
 * first and failed the third.
 *
 * Pure on purpose — the IO wrapper (scripts/assert-release-assets.mjs) reads the manifest and
 * asks `gh` for the asset list; everything that can be wrong lives here, where it is testable.
 * A gate nobody can fail on demand is the thing this whole file exists to prevent.
 */

export type ReleasePlatform = 'darwin' | 'linux' | 'win32';

export interface PlatformFeed {
  /** The manifest electron-updater fetches for this platform. */
  manifest: string;
  /** Extensions the platform's updater will actually download, in preference order. */
  updatable: string[];
  /** Extensions that are legitimate INSTALL artifacts but cannot carry an update. */
  installOnly: string[];
  /** At least one of these must be attached, or first-time installers have nothing to click. */
  requireInstaller: string[];
  /** The updater class, named in errors so the reader can go read its source. */
  updater: string;
}

export const FEEDS: Record<ReleasePlatform, PlatformFeed> = {
  darwin: {
    manifest: 'latest-mac.yml',
    updatable: ['.zip'],
    installOnly: ['.dmg', '.pkg'],
    requireInstaller: ['.dmg'],
    updater: 'MacUpdater',
  },
  linux: {
    manifest: 'latest-linux.yml',
    updatable: ['.AppImage'],
    installOnly: ['.deb', '.rpm', '.snap'],
    requireInstaller: ['.AppImage', '.deb'],
    updater: 'AppImageUpdater',
  },
  win32: {
    manifest: 'latest.yml',
    updatable: ['.exe'],
    installOnly: ['.msi', '.appx'],
    requireInstaller: ['.exe'],
    updater: 'NsisUpdater',
  },
};

export interface ParsedManifest {
  version: string;
  /** The top-level `path:` — the file the updater will fetch. */
  path: string;
  /** Every `files[].url`. electron-builder percent-encodes spaces here; we decode. */
  urls: string[];
}

/**
 * The manifest is electron-builder's own small, flat YAML. Parsing only what we assert on keeps
 * this dependency-free — but note it is deliberately STRICT: a shape we do not recognise returns
 * empty rather than guessing, so the caller reports "could not read the manifest" instead of
 * quietly asserting against nothing. Silence is the failure mode we are here to remove.
 */
export function parseManifest(text: string): ParsedManifest {
  const line = (re: RegExp): string => {
    const m = re.exec(text);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
  };
  // `path:` and `version:` are top-level, so anchor to column 0 — `files[].url` is indented and
  // must not be mistaken for either.
  const version = line(/^version:[ \t]*(.+)$/m);
  const path = line(/^path:[ \t]*(.+)$/m);
  const urls = [...text.matchAll(/^[ \t]+-?[ \t]*url:[ \t]*(.+)$/gm)]
    .map((m) => decodeURIComponent(m[1].trim().replace(/^['"]|['"]$/g, '')));
  return { version, path: decodeURIComponent(path), urls };
}

export interface AssertInput {
  platform: ReleasePlatform;
  /** The git tag the release was cut from, e.g. "v0.8.1". */
  tag: string;
  /** package.json version at the built commit, e.g. "0.8.1". */
  pkgVersion: string;
  /** Raw text of the platform manifest produced in dist/. */
  manifestText: string;
  /** Asset filenames actually attached to the Release (or present in dist/, pre-publish). */
  assets: string[];
  /**
   * Where `assets` came from, used verbatim in messages. A pre-publish run reads dist/, and
   * telling someone a file is "not attached to the release" when no release exists yet sends
   * them to look in the wrong place — the diagnosis has to name the surface it measured.
   */
  where?: string;
}

export interface AssertResult {
  ok: boolean;
  errors: string[];
  /** Human-readable confirmations, for a log that shows what was measured rather than "OK". */
  checks: string[];
}

const ext = (name: string, list: string[]): boolean =>
  list.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));

export function assertReleaseAssets(input: AssertInput): AssertResult {
  const { platform, tag, pkgVersion, manifestText, assets } = input;
  const where = input.where ?? 'attached to the release';
  const feed = FEEDS[platform];
  const errors: string[] = [];
  const checks: string[] = [];

  if (!feed) {
    return { ok: false, errors: [`no feed definition for platform "${platform}" — refusing to report a pass it did not measure`], checks };
  }

  const m = parseManifest(manifestText);
  if (!m.version || !m.path) {
    errors.push(`${feed.manifest} did not parse (version="${m.version}" path="${m.path}") — cannot assert against a manifest we cannot read`);
    return { ok: false, errors, checks };
  }

  /* A tag that disagrees with the built version is its own silent failure: the release is
     labelled v0.8.2 while the manifest advertises 0.8.1, so every client compares itself
     against the OLD number and nobody updates. Nothing else in the pipeline notices, because
     each half is internally consistent. */
  const tagVersion = tag.replace(/^v/, '');
  if (tagVersion !== pkgVersion) {
    errors.push(`tag ${tag} does not match package.json version ${pkgVersion} — the release would advertise a version nobody is on`);
  } else {
    checks.push(`tag ${tag} matches package.json ${pkgVersion}`);
  }
  if (m.version !== pkgVersion) {
    errors.push(`${feed.manifest} says version ${m.version} but package.json says ${pkgVersion} — stale manifest in dist/`);
  } else {
    checks.push(`${feed.manifest} advertises ${m.version}`);
  }

  if (!assets.includes(feed.manifest)) {
    errors.push(`${feed.manifest} is not ${where} — ${feed.updater} has no feed to read`);
  } else {
    checks.push(`${feed.manifest} is ${where}`);
  }

  /* THE v0.7.0 CHECK. The manifest's own `path:` is the file the updater fetches. Asserting the
     manifest exists, or that SOME installer is attached, both passed on v0.7.1 while
     latest-mac.yml pointed at a zip that was never uploaded — a 404 for every updating client. */
  if (!assets.includes(m.path)) {
    errors.push(`${feed.manifest} points at "${m.path}" but it is NOT ${where} — every updating client gets a 404`);
  } else {
    checks.push(`the update target "${m.path}" is ${where}`);
  }

  /* THE FORMAT CHECK — the half v0.7.0 actually failed. The file can be present and still be
     one the updater refuses. */
  if (ext(m.path, feed.installOnly)) {
    errors.push(`${feed.manifest} points at "${m.path}", which ${feed.updater} will not download `
      + `(install-only format). It must be one of: ${feed.updatable.join(', ')}`);
  } else if (!ext(m.path, feed.updatable)) {
    errors.push(`${feed.manifest} points at "${m.path}", which is not a format ${feed.updater} accepts `
      + `(expected ${feed.updatable.join(' or ')})`);
  } else {
    checks.push(`"${m.path}" is a format ${feed.updater} accepts`);
  }

  /* Every file the manifest enumerates must be there, not just the primary target: electron-updater
     may fall back to another entry, and a 404 on a fallback is the same dead end. */
  for (const u of m.urls) {
    if (!assets.includes(u)) {
      errors.push(`${feed.manifest} enumerates "${u}" in files[] but it is not ${where}`);
    }
  }
  if (m.urls.length && m.urls.every((u) => assets.includes(u))) {
    checks.push(`all ${m.urls.length} files[] entries are ${where}`);
  }

  /* A release with a working updater and nothing a NEW user can install is half a release — and
     it fails quietly, because everyone testing it already has the app. */
  const installer = assets.find((a) => ext(a, feed.requireInstaller));
  if (!installer) {
    errors.push(`no first-install artifact ${where} (expected one of ${feed.requireInstaller.join(', ')}) — `
      + `existing users could update but nobody new could install`);
  } else {
    checks.push(`first-install artifact present: ${installer}`);
  }

  return { ok: errors.length === 0, errors, checks };
}
