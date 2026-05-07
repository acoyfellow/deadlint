<p align="center">
  <img src="./docs/img/banner.jpg" alt="three skulls and ritual ornaments, block-printed in oxblood ink on cream paper" width="100%">
</p>

<h1 align="center">deadlint</h1>

<p align="center"><em>Ruthlessly Eliminate the Dead.</em></p>

---

Find dead public methods on Cloudflare Workers `DurableObject` /
`WorkerEntrypoint` / `WorkflowEntrypoint` / `RpcTarget` / `Agent` subclasses,
and structural clones across your TypeScript codebase.

## The gap

| Tool                         | Stops at                | Result                                            |
| ---------------------------- | ----------------------- | ------------------------------------------------- |
| `tsc` (`noUnusedLocals`)     | function boundary       | unused vars only                                  |
| `oxlint` / `biome` / `eslint`| file/class boundary     | every `export` is treated as live                 |
| `knip` / `ts-prune`          | module-export boundary  | every public class member is treated as the API  |
| **deadlint**                 | RPC stub / clone        | this is the layer that was missing                |

In a Workers / Agents codebase, every public method on a DO is — to a static
analyzer — an entry point. Anyone with a stub could call it, so nothing dares
flag it. Real codebases accumulate dead RPC methods for years and no linter
will tell you.

deadlint walks the call graph plus a targeted token scan and tells you which
ones are actually unreachable.

## What it found, on real repos

```text
$ npx deadlint ./artifacts
deadlint report — ./artifacts

Dead RPC methods (1)
───────────────────────────
  GitServer.streamingUploadPack  (extends DurableObject)
    apps/worker/src/git-server.ts:299

Clones — engine: inline (3)
───────────────────────────
  1.00  27L  readBlob ≈ readTree
    src/capabilities/repo.ts:135
    src/capabilities/repo.ts:167
  1.00  27L  readBlob ≈ readCommit
    src/capabilities/repo.ts:135
    src/capabilities/repo.ts:199
  1.00  27L  readTree ≈ readCommit
    src/capabilities/repo.ts:167
    src/capabilities/repo.ts:199

4 findings
```

`streamingUploadPack` was a wrapper around `streamingUploadPackWithEventType`
that nothing called for months. `readBlob` / `readTree` / `readCommit` were
27-line copy-pastes of each other. No other linter saw any of it.

## Install and run

```bash
# one-off
npx deadlint /path/to/your/repo

# global
npm i -g deadlint
deadlint /path/to/your/repo
```

The path needs a `tsconfig.json`. That's the only requirement.

```bash
deadlint ./repo                              # full scan (default)
deadlint ./repo --check dead-rpc             # just the dead methods
deadlint ./repo --check clones               # just the clones
deadlint ./repo --clones-engine both         # similarity-ts + inline engine
deadlint ./repo --json > findings.json       # machine-readable
deadlint --help                              # all flags
```

Exit `0` = clean, `1` = findings, `2` = misconfig.

## What it actually checks

**Dead RPC methods.** For every public method on a class extending
`DurableObject`, `WorkerEntrypoint`, `WorkflowEntrypoint`, `RpcTarget`,
or `Agent`, deadlint looks for callers across three signals:

1. The TypeScript language service (precise — but blind to JSRPC stubs).
2. A token scan for `.method(` / `["method"](` direct dispatch.
3. A token scan for `.call("method", …)` string-key dispatch — the
   Agents SDK pattern frontend code uses to reach DO methods through
   the WebSocket proxy.

Patterns 2 and 3 are scanned across both TypeScript files and companion
files (`.svelte`, `.vue`, `.astro`, `.tsx`, `.jsx`) so frontend call
sites that aren't compiled by your tsconfig are still seen. A method is
flagged dead **only when all three signals turn up zero**. Common
stdlib names (`map`, `then`, `set`, …) are excluded from the token
scans to avoid coincidental keep-alives. Workers/Agents runtime hooks
(`fetch`, `alarm`, `onConnect`, …) are allow-listed.

Override the boundary class list with `--bases Foo,Bar`.

**Structural clones.** Two engines, run independently, results merged.

`similarity` (default) shells out to
[`similarity-ts`](https://github.com/mizchi/similarity) — a Rust binary
using oxc-parser and TSED. Higher precision, biased toward larger
functions. Install once: `cargo install similarity-ts`.

`inline` is built into deadlint, ~150 lines of `ts-morph`. Each function
body is normalized to a `SyntaxKind`-only token sequence (identifiers
and literals erased, so renamed copies match exactly). Findings are
emitted on identical shapes (`1.00`) or 5-gram Jaccard similarity above
`--clone-threshold` (default `0.85`). No external dependencies.

Use `--clones-engine both` to run them side by side. They find largely
non-overlapping pairs.

## Always on, every repo

```bash
deadlint --install-hook
```

Sets `git config --global core.hooksPath ~/.config/git/hooks` and writes
a `pre-push` script that runs `deadlint . --check dead-rpc` before every
push. Covers every repo on your machine — public, private, GitHub, GitLab.
The hook silently no-ops on non-TypeScript repos.

```bash
deadlint --hook-status      # is it installed?
deadlint --uninstall-hook   # remove it (only if we wrote it)
git push --no-verify        # bypass once
```

The installer refuses to clobber a pre-existing `pre-push` hook unless
you pass `--force`. The uninstaller refuses to remove anything that
isn't deadlint-managed. You can't accidentally lose work.

## What it won't catch

- Fully dynamic RPC: `stub[methodFromConfig]()` where the method name is
  computed at runtime. None of the signals can see it.
- Cross-repo dead code. If your callers live in a different repository,
  deadlint sees nothing.
- HTTP routes dispatched by URL path rather than method name. Add the
  router class to `--bases` if appropriate.
- Behavioral clones with different control flow. The inline engine is
  shape-based; the similarity engine helps but isn't magic.

Build-output directories (`dist`, `build`, `.svelte-kit`, `.next`, etc.)
are excluded by default — they generate ~100% clone matches against the
source they were built from. Pass `--exclude` to replace the list, or
`--also-exclude` to extend it. Note: `lib` is **not** in the default
list because SvelteKit and many other frameworks use `src/lib/` for
source code; pass `--also-exclude lib` if your project emits to it.

Findings are meant for human review. The tool biases toward false
negatives — it would rather miss a dead method than wrongly flag a live one.

## License

[MIT](./LICENSE)
