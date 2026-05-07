# Changelog

## [0.0.1] — 2026-05-06

### Added

- `dead-rpc` check — finds public methods on `DurableObject`, `WorkerEntrypoint`,
  `WorkflowEntrypoint`, `RpcTarget`, and `Agent` subclasses with no in-repo
  callers. Three signals: ts-morph references, direct dispatch token grep
  (`.method(` / `["method"](`), and string-key dispatch token grep
  (`.call("method", …)` — the Agents SDK pattern). All scans cover both
  `.ts` files and companion files (`.svelte`, `.vue`, `.astro`, `.tsx`,
  `.jsx`).
- `clones` check with two engines:
  - `similarity` — shells to [similarity-ts](https://github.com/mizchi/similarity)
    (`cargo install` required).
  - `inline` — built-in `ts-morph` structural hash + Jaccard 5-gram similarity.
- Both the dead-rpc check and the inline clone engine honor the
  `tsconfig.json` `exclude` field. Files outside the project are not scanned.
- Default-exclude list (`dist`, `build`, `out`, `coverage`, `.svelte-kit`,
  `.next`, `.nuxt`, `.turbo`, `.alchemy`, `.wrangler`, `.cache`, `.vercel`,
  `.astro`, `node_modules`) applied to all three signals — including
  pass-through to `similarity-ts` via repeated `--exclude` flags.
  Configurable with `--exclude` (replace) and `--also-exclude` (extend).
- Global git pre-push hook installer: `--install-hook`, `--uninstall-hook`,
  `--hook-status`.
- CLI flags: `--check`, `--bases`, `--tsconfig`, `--clones-engine`,
  `--clone-threshold`, `--clone-min-lines`, `--json`.

[0.0.1]: https://github.com/acoyfellow/deadlint/releases/tag/v0.0.1
