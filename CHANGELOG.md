# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project pins to `0.0.1` permanently — see [README](./README.md#stability)
for why.

## [0.0.1] — 2026-05-06

### Added

- `dead-rpc` check: finds public methods on `DurableObject`, `WorkerEntrypoint`,
  `WorkflowEntrypoint`, `RpcTarget`, and `Agent` subclasses that have no
  in-repo callers.
- `clones` check with two engines:
  - `similarity` — shells to [similarity-ts](https://github.com/mizchi/similarity)
    (cargo install required). Higher precision.
  - `inline` — built-in `ts-morph` structural hash + Jaccard 5-gram similarity.
    Zero external dependencies. Higher recall.
- CLI: `deadlint <path>` with `--check`, `--bases`, `--tsconfig`,
  `--clones-engine`, `--clone-threshold`, `--clone-min-lines`, `--json`.
- Fixture-based black-box tests (`pnpm test`).
- Always-live method allowlist (Workers/Agents lifecycle hooks).
- Token-grep blocklist for stdlib method names (`map`, `then`, `set`, etc.) to
  prevent false-negatives where a class method shares a name with a built-in.

[0.0.1]: https://github.com/acoyfellow/deadlint/releases/tag/v0.0.1
