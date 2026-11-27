# RELEASING.md — how AIOS ships

How the AIOS App is signed, notarized, distributed, and auto-updated. The lane
and its discipline are modelled on Block's **Buzz** — the closest precedent
(a local AI-agent desktop app in exactly our category), which ships a notarized
`.dmg` via GitHub Releases, **not** the Mac App Store. Reference: Block's Buzz
(github.com/block/buzz).

## Why GitHub Releases, not the Mac App Store

The App spawns real `claude` CLI processes in PTYs, reads `~/aios`, and runs
installers. The Mac App Store requires **App Sandbox**, which forbids all of
that. So — like Buzz — we distribute directly: a **Developer-ID-signed +
notarized `.dmg`** served from **The-AIOS org GitHub Releases**, with in-app
auto-update. Not the App Store isn't a shortcut around Apple; it's the lane
where *we* own the signing instead of Apple doing it at submission.

## The two guarantees (keep them distinct)

1. **Distribution trust — Apple codesign + notarize.** A Developer-ID
   Application signature + Apple notarization is what lets **Gatekeeper admit
   the app** on a stranger's Mac. Without it, a downloaded `.dmg` hits the
   *"AIOS is damaged / from an unidentified developer"* wall — the exact
   terminal dead-end the App exists to eliminate for non-technical operators.
2. **Update integrity — the code signature, reused.** On macOS `electron-updater`
   verifies every downloaded update **via the code signature itself** — no
   second (minisign-style) key needed. The corollary is load-bearing: **the
   updater is only as trustworthy as the Developer-ID signature it rides on.**
   Get signing + notarization solid and *verified* first; wire nothing on top
   of a signature that isn't real.

## What only the operator can do (credentials — never an automation author)

Signing needs an **organisation** Apple Developer account — a company is the
deliberate signing identity here, not an individual (`AI-5`). The scripts and CI
**consume** these; they are entered by the operator and never committed or seen by
any build author:

- **Developer ID Application certificate** — as a `.p12` (with an export password).
  Note that only the **Account Holder** may create one; an Admin sees both Developer
  ID rows greyed out. The way through, if you are an Admin: generate the CSR on your
  own machine, have the Account Holder issue the certificate against it, and import
  the result. The private key never leaves your Mac, so you need them exactly once.
- **A notarization credential**, one of:
  - Apple ID + **app-specific password** + Team ID, or
  - an **App Store Connect API key** (Issuer ID + Key ID + `.p8`).

## Path A — local signed build (fastest; for handing a fresh user a build today)

On this Mac, once the Developer-ID cert is in the login keychain:

```bash
# one-time: store a notarytool profile in the keychain (operator runs this)
xcrun notarytool store-credentials AIOS_NOTARY \
  --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-pw>"

# then, per build:
export APPLE_ID="<apple-id>"
export APPLE_APP_SPECIFIC_PASSWORD="<app-specific-pw>"
export APPLE_TEAM_ID="<team-id>"
npm run dist                 # compile + electron-builder --mac dmg (signs + notarizes)
node scripts/verify-signing.mjs   # codesign --verify · hardened runtime · spctl --assess
```

`verify-signing.mjs` green ⇒ the `.dmg` under `dist/` is Gatekeeper-clean and
safe to hand to a fresh user. This is the honest input to the
virgin-account test (an *unsigned* build would fail the test on a wall that
isn't our product's fault).

## Path B — CI release (durable; the version that ships publicly)

Store the credentials as secrets of the **`release` environment** (Settings →
Environments → `release` → Environment secrets), never as repository secrets:

| Secret | What |
|---|---|
| `MAC_CSC_LINK` | base64 of the Developer ID Application `.p12` — **`openssl base64 -A -in cert.p12`**. Not plain `base64`: on macOS it wraps at 76 columns, and a wrapped secret fails *silently* in CI (electron-builder reports `not a file`, which reads as a missing secret rather than a malformed one) |
| `MAC_CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | the Developer Team ID that owns the certificate (`Pulsar Labs`) |
| `ES_USERNAME`, `ES_PASSWORD`, `ES_CREDENTIAL_ID`, `ES_TOTP_SECRET` | SSL.com eSigner, for the Windows signature (`release-windows.yml`) |

**Why an environment.** Anyone with write access can push a branch, and a workflow on
that branch can read every repository secret. An environment secret is handed only to
a job that names the environment, and the `release` environment admits a job only when
it runs from `main` or a `v*` tag, after the owner approves it. The four jobs that name
it: `release.yml`, `release-linux.yml`, `release-windows.yml` and `canary.yml`.

**Who can release.** Only the owner can create a `v*` tag (a tag ruleset), and only the
owner can approve the `release` environment. Cut a release by pushing the annotated tag
on the merge commit:

```bash
git tag -a vX.Y.Z -m "AIOS App X.Y.Z" <merge-commit>
git push origin vX.Y.Z
```

The tag starts three runs (macOS, Linux, Windows), and each waits for approval: open
each run and choose *Review deployments* → `release` → *Approve and deploy*. Approve the
three together. Linux and Windows wait 30 minutes for the macOS manifest, so a macOS run
approved much later than the others makes them time out. Before approving a run you did
not start yourself, read its branch and inputs on the run page: the Linux and Windows
lanes take a `ref` input that builds any commit.

A secret missing from the environment never ships a worse build: macOS stops at its
credentials preflight and Windows at its unsigned check, both before anything is
attached, so the release stays a draft, which no updater reads. Enter the secret and
re-run that lane for the tag.

`.github/workflows/release.yml` then, on `macos-14`:
**build → Apple codesign + notarize → `verify-signing.mjs` → assert
`latest-mac.yml` exists → publish** the `.dmg` + `.blockmap` + `latest-mac.yml`
to the GitHub Release → confirm the assets landed. Verify runs *before* publish,
so a broken signature never reaches a user.

## Before you tag — What's New, seen in the App (operator rule, 0.11.0)

The LAST step before any version tag. What's New is written when a release is scoped, and the release
keeps changing under it: 0.11.0 was tagged describing features its own test rounds had removed or
renamed, and was caught only because the release gate held the draft.

Preferred: the operator opens What's New in the dev window they are already testing in (menu → What's
New), at the exact commit about to be tagged. A live view beats screenshots (operator, 0.12.0). When
there is no test window, or the copy needs reviewing away from the Mac:

```bash
npm run whatsnew:shot     # renders What's New in the real App (isolated) → ~/Downloads/AIOS-<v>-whats-new-<n>.png (one per scroll page) + .txt
```

Either way, re-read it against every test round of the release, and tag only after the operator's yes. Rank the copy by what someone notices in their first ten minutes after updating; plumbing
belongs in the GitHub notes, not What's New.

## After the release ships — close its branches

Every branch is work in flight. Once the release PR is merged and the release is published, nothing on its branches is
in flight any more, so they go, the same day:

- the release branch (`release/<version>`) and every branch merged into it (each fix's own branch, any contributed PR
  head pushed to this repo);
- any other branch fully contained in `main`: `git merge-base --is-ancestor origin/<branch> origin/main` succeeds.

Branches merged by PR are already deleted by GitHub (the repo setting "Automatically delete head branches" is on). The
ones it never sees are the ones merged locally into a release branch, which is how most fixes land. Left alone they pile
up: 0.15.0 left fifteen behind. A branch that is NOT contained in `main` stays until its owner decides; it is
unfinished work, not clutter.

The open branches should read as the list of what is in flight: `main`, the next release branch while one is being cut,
and one branch per open PR.

## How auto-update works (electron-updater, not Tauri)

- The `publish` block in `package.json` (`provider: github`, `The-AIOS/aios-app`)
  makes electron-builder write **`latest-mac.yml`** to each versioned Release.
- The app checks on boot + every 6h (`src/main/updater.ts`, **packaged builds
  only**), downloads in the background, raises a **native OS notification** when
  staged, and installs on the next quit. Zero in-app UI required for the happy
  path; a "restart to update" affordance folds into the Needs-you inbox card
  later (batch G).
- **One Release per version is the feed** — electron-updater polls the newest
  Release and reads its `latest-mac.yml`. We deliberately do **not** copy Buzz's
  separate rolling `-latest` release: that is a Tauri-updater idiom; the
  electron-native shape is simpler and correct.

## Canary — a signed build without cutting a version

`.github/workflows/canary.yml` (manual `workflow_dispatch`) builds a **signed +
notarized arm64 `.dmg` from `main`**, verifies it, and uploads it as a
**7-day Actions artifact** — no tag, no Release, no updater feed. Use it to hand
a non-technical tester a Gatekeeper-clean build to try without touching the version or
the auto-update channel. It reads the signing secrets, so it runs in the `release`
environment: from `main` only (other branches are refused) and after the owner
approves the run. A branch build for a tester is a local signed build (Path A).

## If signing or launch fails — entitlements

`build/entitlements.mac.plist` grants only `com.apple.security.cs.allow-jit`
(V8 needs it). Because the app bundles a **native** module (`node-pty`,
`asarUnpack`'d) and spawns child processes (`claude` in PTYs), a signed/notarized
build *may* need one or more of the candidates documented in that file
(`allow-unsigned-executable-memory`, `disable-library-validation`, …). **Add on
evidence** — a real sign or launch failure — never preemptively; each one weakens
the hardened runtime.

## Publishing @the-aios/core (the package the App and Glass share)

`packages/core` is published to the public npm registry as `@the-aios/core`. It has its own
version and its own tag series: **`core-v<version>`**. An App release (`v*`) does not publish it,
and a `core-v*` tag starts none of the App's release workflows. The App resolves the package from
this repository, so an App release never waits on npm; Glass installs it from npm, so Glass can
move to a version only after it is published.

**Per release:**

```bash
# packages/core/package.json already says 0.1.0, merged to main
git tag -a core-v0.1.0 -m "@the-aios/core 0.1.0" && git push origin core-v0.1.0
```

`.github/workflows/publish-core.yml` checks that the tag names the version, runs the package's
tests, the cases check and the tarball check, and publishes. Re-running it for a version that is
already on npm does nothing. Run it by hand (Actions → Publish @the-aios/core) for a dry run that
builds and packs and publishes nothing; started by hand from anything but a `core-v` tag it can
only rehearse.

**Once, before the first publish (maintainers only):**

1. Create the npm organisation `the-aios`, which owns the `@the-aios` scope.
2. Let the `release` environment admit the new tags: Settings → Environments → `release` →
   Deployment branches and tags → add `core-v*`. Without it the job is refused before it starts.
3. Publish without a stored token, by npm trusted publishing: npmjs.com → Packages →
   `@the-aios/core` → Settings → Trusted publishing → GitHub Actions, with organisation
   `The-AIOS`, repository `aios-app`, workflow file `publish-core.yml` and environment `release`.
   The workflow already asks for the `id-token` permission and runs on Node 24, which carries an
   npm new enough for it.

**The first version.** npm's documentation places that setting inside the package's own settings
page and does not say how it is reached for a package that has never been published. If npm does
not offer it before the package exists, make the first publish with a token and switch afterwards:

- store a granular npm token allowed to publish `@the-aios/core` as `NPM_TOKEN` in the `release`
  environment (never as a repository secret), push `core-v0.1.0`, and let the workflow publish
  with it; or publish that one version from a maintainer's machine with
  `npm publish -w @the-aios/core --access public`;
- then add the trusted publisher as in step 3 and delete the token. The workflow uses a stored
  token only when one exists, so removing it needs no change here.

npm's documentation says a newly created trusted publisher has to complete its first publish
within two days or it expires and has to be created again, so set it up when a version is ready
to tag.

## Supply-chain hygiene (the release path ships to non-technical users)

`persist-credentials: false` on checkout keeps no token in `.git`. Adopt further
Buzz hardening proportionally as the App goes public: SHA-pin actions, hash-check
downloaded tools, disable the dependency cache in the signing job. Once the repo
is public, replace the release's asset-presence check with a true HTTP
reachability probe on each `browser_download_url`.
