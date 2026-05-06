# Changelog

## [0.0.1] — 2026-05-06

### Added

- `dead-rpc` check — finds public methods on `DurableObject`, `WorkerEntrypoint`,
  `WorkflowEntrypoint`, `RpcTarget`, and `Agent` subclasses with no in-repo
  callers.
- `clones` check with two engines:
  - `similarity` — shells to [similarity-ts](https://github.com/mizchi/similarity)
    (`cargo install` required).
  - `inline` — built-in `ts-morph` structural hash + Jaccard 5-gram similarity.
- Global git pre-push hook installer: `--install-hook`, `--uninstall-hook`,
  `--hook-status`.
- CLI flags: `--check`, `--bases`, `--tsconfig`, `--clones-engine`,
  `--clone-threshold`, `--clone-min-lines`, `--json`.

[0.0.1]: https://github.com/acoyfellow/deadlint/releases/tag/v0.0.1
