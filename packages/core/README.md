# @the-aios/core

What the AIOS App and AIOS Glass both decide, in one place.

The two surfaces answer the same questions about the same machine: what a request on the spawn
inbox means, who may claim it, which session a name refers to, what is waiting on the operator.
They fulfil the same requests and race for them, so they have to give the same answer. Each used
to keep its own copy of this code, with a test that compared digests across the two repositories.
Now there is one version, published to npm, and each surface depends on an exact version of it.

It is pure TypeScript with no dependencies: no Electron, no editor API, nothing that reads the
disk on its own. Each surface keeps the code that touches its own windows, terminals and files.

## Using it

```jsonc
// package.json — an exact version, never a range
"dependencies": { "@the-aios/core": "0.1.0" }
```

```ts
import { decideSend, TIMINGS } from '@the-aios/core/sendQueue';
import { normalizeVerb } from '@the-aios/core/busVerbs';
```

One import path per module, and no index that re-exports them all. The modules are the files in
[`src/`](./src).

The framework's cases files ship in the tarball and are read as files:

```ts
const cases = require.resolve('@the-aios/core/cases/inbox-contract-4.conformance.json');
```

## Working on it

The package is a workspace of the `aios-app` repository. From the repository root:

| Command | What it does |
|---|---|
| `npm run build -w @the-aios/core` | compile `src/` to `dist/` |
| `npm test -w @the-aios/core` | compile and run `test/` |
| `npm run cases:check -w @the-aios/core` | compare `cases/` with the framework at the locked commit |
| `npm run pack:check -w @the-aios/core` | build the tarball and load every module from it |

The App's own `npm run compile` builds the package first, and its `npm test` runs both suites.

Nothing in this folder imports from outside it, and it does not inherit the repository's
`tsconfig.json`. It can move to a repository of its own with its history
(`git subtree split -P packages/core`); what stays behind is the publishing workflow and three
lines of the App's `package.json`.

### Tests

A test that needs only this package lives in [`test/`](./test). A test that also needs a
surface's own code (its dispatcher, its panel, its settings) stays in that surface's repository
and imports the module from the package.

### The cases files are never edited by hand

[`cases/`](./cases) holds files the framework ([The-AIOS/aios](https://github.com/The-AIOS/aios))
owns. They are written only by `npm run cases:sync`, from the commit and the sha256 values in
[`cases.lock.json`](./cases.lock.json), and CI fetches them again and fails on any difference. To
take a newer version of a file, change the lock, run `cases:sync`, and bump the version.

## Changing it

A change here changes both surfaces, and a surface gets it when it moves to the new version.

1. Make the change and its test here.
2. Bump `version` in [`package.json`](./package.json), and the App's dependency on it, in the same
   pull request.
3. After the merge, a maintainer pushes the tag `core-v<version>`; CI publishes it.
4. Glass moves to the new version in its own pull request.

A change to how a request on the bus is decided is a protocol change: both surfaces have to be
running the new version before the spawn-inbox README describes it.

### Until Glass depends on this package

The App runs the package today. Glass still runs its own copies of these 26 modules, and its
tests still pin seven of them by digest against the copies the App used to keep. Until Glass
depends on a published version, **the modules in `src/` are not edited**: a change here would
reach the App and not Glass, and no test in either repository would say so. Fix what is urgent in
Glass's copy and here in the same breath, or wait for the adoption. Delete this section when Glass
has adopted the package.

## Licence

GPL-2.0-or-later, the licence of the App, of Glass and of the framework.
