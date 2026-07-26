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
safe to hand to a fresh user. This is the honest input to the `AI-27`
virgin-account test (an *unsigned* build would fail the test on a wall that
isn't our product's fault).

## Path B — CI release (durable; the version that ships publicly)

Store the same credentials as **repository secrets** (Settings → Secrets →
Actions):

| Secret | What |
|---|---|
| `MAC_CSC_LINK` | base64 of the Developer ID Application `.p12` — **`openssl base64 -A -in cert.p12`**. Not plain `base64`: on macOS it wraps at 76 columns, and a wrapped secret fails *silently* in CI (electron-builder reports `not a file`, which reads as a missing secret rather than a malformed one) |
| `MAC_CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | the Developer Team ID that owns the certificate (`Pulsar Labs`) |

Then cut a release by pushing a version tag:

```bash
npm version patch     # bumps package.json + creates the vX.Y.Z tag
git push --follow-tags
```

`.github/workflows/release.yml` then, on `macos-14`:
**build → Apple codesign + notarize → `verify-signing.mjs` → assert
`latest-mac.yml` exists → publish** the `.dmg` + `.blockmap` + `latest-mac.yml`
to the GitHub Release → confirm the assets landed. Verify runs *before* publish,
so a broken signature never reaches a user.

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
notarized arm64 `.dmg` from any branch**, verifies it, and uploads it as a
**7-day Actions artifact** — no tag, no Release, no updater feed. Use it to hand
a non-technical tester a Gatekeeper-clean build to try without touching the version or
the auto-update channel.

## If signing or launch fails — entitlements

`build/entitlements.mac.plist` grants only `com.apple.security.cs.allow-jit`
(V8 needs it). Because the app bundles a **native** module (`node-pty`,
`asarUnpack`'d) and spawns child processes (`claude` in PTYs), a signed/notarized
build *may* need one or more of the candidates documented in that file
(`allow-unsigned-executable-memory`, `disable-library-validation`, …). **Add on
evidence** — a real sign or launch failure — never preemptively; each one weakens
the hardened runtime.

## Supply-chain hygiene (the release path ships to non-technical users)

`persist-credentials: false` on checkout keeps no token in `.git`. Adopt further
Buzz hardening proportionally as the App goes public: SHA-pin actions, hash-check
downloaded tools, disable the dependency cache in the signing job. Once the repo
is public, replace the release's asset-presence check with a true HTTP
reachability probe on each `browser_download_url`.
