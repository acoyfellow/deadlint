# deadlint

Find what `knip` and `oxlint` can't:

1. **Dead cross-boundary methods** — public methods on Workers
   `DurableObject` / `WorkerEntrypoint` / `RpcTarget` / `Agent` /
   `WorkflowEntrypoint` subclasses that nothing in the repo calls. Standard
   linters can't see across the JSRPC stub boundary, so they leave these alone
   forever. deadlint walks the call graph plus a targeted token scan and tells
   you which ones are actually unreachable.

2. **Structural clones** — function bodies that are near-duplicates of each
   other, even when identifiers have been renamed. Two pluggable engines so
   you can compare results.

```
$ npx deadlint ./my-worker
deadlint report — ./my-worker

Dead RPC methods (1)
───────────────────────────
  GitServer.streamingUploadPack  (extends DurableObject)
    src/git-server.ts:299

Clones — engine: inline (3)
───────────────────────────
  1.00  27L  readBlob ≈ readTree
    src/capabilities/repo.ts:135
    src/capabilities/repo.ts:167
  ...
```

> **Stability.** Pinned to `0.0.1` permanently. See
> [_Stability_](#stability) below for what that means.

> **Want the whole picture in 7 minutes?** Read [CONCEPT.md](./CONCEPT.md).

---

## Tutorial — your first scan in 60 seconds

```bash
# 1. Install (no global install — npx works fine)
npx deadlint --help

# 2. Point it at a TypeScript repo with a tsconfig.json
npx deadlint /path/to/your/worker

# 3. Optional: install similarity-ts for the precise clone engine
cargo install similarity-ts
npx deadlint /path/to/your/worker --clones-engine both
```

If you see `Dead RPC methods (N)` or `Clones — engine: ...` in the output,
each line is a `file:line` you can click in most terminals to jump straight
to the source. Exit code is `1` when findings are present, `0` when clean.

That's the entire learning curve.

---

## How-to recipes

### Run only the dead-RPC check

```bash
deadlint ./repo --check dead-rpc
```

### Run only structural clones, both engines

```bash
deadlint ./repo --check clones --clones-engine both
```

### Pipe findings to JSON for a CI job

```bash
deadlint ./repo --json > deadlint.json
jq '.findings[] | select(.kind == "dead-rpc")' deadlint.json
```

### Check a non-default boundary class list

By default deadlint considers `DurableObject`, `WorkerEntrypoint`,
`WorkflowEntrypoint`, `RpcTarget`, and `Agent` as boundary classes. If you
have your own:

```bash
deadlint ./repo --bases MyServiceBase,LegacyRpcEndpoint
```

### Override tsconfig discovery

If your repo's tsconfig isn't at the root or in `apps/worker/`:

```bash
deadlint ./repo --tsconfig ./packages/api/tsconfig.json
```

### Loosen or tighten the clone threshold

```bash
deadlint ./repo --clone-threshold 0.75 --clone-min-lines 10
```

Lower `--clone-threshold` = more matches (more false positives). Higher
`--clone-min-lines` = only flag substantial clones.

---

## Reference

### CLI

```
deadlint <path> [options]
```

| Flag                      | Default                | Description                                                                       |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `--tsconfig <path>`       | auto-detect            | Path to `tsconfig.json` to use as project root                                    |
| `--bases <A,B,C>`         | see below              | Comma list of class names to treat as boundary classes for the dead-RPC check     |
| `--check <list>`          | `dead-rpc,clones`      | Comma list of: `dead-rpc`, `clones`                                               |
| `--clones-engine <name>`  | `similarity`           | `similarity` (shells to `similarity-ts`), `inline` (built-in), or `both`          |
| `--clone-threshold <n>`   | `0.85`                 | Similarity threshold, `0.0`–`1.0`                                                 |
| `--clone-min-lines <n>`   | `6`                    | Minimum function body line count to be eligible for clone comparison              |
| `--json`                  | off                    | Emit a JSON object `{ findings: [...] }` instead of human text                    |
| `-h`, `--help`            | —                      | Show CLI help                                                                     |

Default `--bases`: `DurableObject`, `WorkerEntrypoint`, `WorkflowEntrypoint`,
`RpcTarget`, `Agent`.

### Exit codes

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | No findings                                              |
| 1    | Findings present                                         |
| 2    | Misconfiguration (missing path, no tsconfig, bad flag)   |

### JSON output schema

```ts
type Finding = DeadRpcFinding | CloneFinding;

type DeadRpcFinding = {
  kind: "dead-rpc";
  className: string;
  methodName: string;
  baseClass: string;
  file: string;
  line: number;
};

type CloneFinding = {
  kind: "clone";
  engine: "similarity" | "inline";
  score: number; // 0..1
  a: { file: string; line: number; symbol: string };
  b: { file: string; line: number; symbol: string };
  lines: number; // approx body size in lines
};
```

The CLI emits `{ "findings": Finding[] }` to stdout when `--json` is set.

### Always-live method names

deadlint never flags these as dead, even with zero in-repo callers, because
the Workers / Agents runtime invokes them automatically:

`fetch`, `scheduled`, `queue`, `tail`, `trace`, `email`, `test`, `alarm`,
`webSocketMessage`, `webSocketClose`, `webSocketError`, `run`, `constructor`,
`onStart`, `onConnect`, `onMessage`, `onClose`, `onError`, `onRequest`,
`onChatMessage`, `onStateUpdate`.

Methods starting with `_` or `#` are also skipped (private convention).

---

## Explanation

### Why does this need to exist?

Standard TypeScript linters stop at the class boundary. They see
`export class GitServer extends DurableObject { foo() {} }` and treat `foo`
as part of the public surface — because in principle anyone who has a
`DurableObjectStub<GitServer>` could call `.foo()`. They can't tell whether
`.foo()` is _actually_ called anywhere.

In a Workers / Agents codebase, that means the dozens of methods on every DO
or Agent are invisible to dead-code detection. Real example from a real
codebase: a wrapper method `streamingUploadPack` that delegated to
`streamingUploadPackWithEventType`. Every caller — internal and external —
went directly to the latter. The wrapper was dead for months. `knip` couldn't
see it.

### How the dead-RPC check works

A method is reported dead **only when both** of these signals turn up zero
in-repo references outside the declaration itself:

1. **TypeScript language-service references** via `ts-morph`'s
   `findReferencesAsNodes()`. This is precise but blind to JSRPC stubs:
   calls against `DurableObjectStub<T>` or an `Agent` stub don't resolve back
   to the implementation method, because the stub type is synthesized from
   the class shape and the proxy method has no declaration link. Used alone,
   this signal would flag _every_ DO method as dead.

2. **A scoped token scan** for `.methodName(`, `.methodName<`, and
   `["methodName"](`. This is how RPC calls actually look at the call site,
   regardless of TypeScript's resolution. It's intentionally a heuristic —
   we'd rather miss flagging a real dead method than wrongly flag a live one.

For a small set of method names that are too common across all JS/TS
codebases (`map`, `then`, `set`, `get`, etc. — see `TOKEN_GREP_BLOCKLIST` in
`src/dead-rpc.ts`), the token scan is suppressed and only the language-service
signal is used. Otherwise `array.map(...)` would mask any method named `map`
on any class.

This design biases toward **false negatives** (methods that look alive but
aren't) over **false positives** (methods incorrectly flagged dead). The
output is meant to be human-reviewed.

### How clone detection works

Two engines, run independently, results merged:

**`similarity`** — shells to [`similarity-ts`](https://github.com/mizchi/similarity).
This is the production-grade tool: oxc-parser based AST extraction, TSED tree
edit distance with a size penalty. Higher precision, finds semantic near-matches
even with renamed identifiers. Filters out small / coincidence-shaped helpers
by design.

**`inline`** — built into deadlint, ~150 lines of `ts-morph`. For each
function/method body it produces:

- A normalized "shape" string of `SyntaxKind` tokens with all identifiers and
  literals erased. Renamed copies of the same logic produce identical shapes.
- A set of 5-gram shingles over that shape.

Findings are emitted when two shapes are exactly identical (score `1.00`) or
when their shingle sets have Jaccard similarity above `--clone-threshold`.
Anonymous arrow/function expressions are excluded (in test files they create
massive false-positive clusters from `expect(() => ...)` patterns).

The two engines are **complementary, not redundant**. On real codebases they
find largely non-overlapping clone pairs. Use `--clones-engine both` if you
want maximum coverage.

### What this won't catch

- **Dynamically-named RPC calls**: `stub[methodFromConfig]()` where the
  method name is computed at runtime. Both signals miss this.
- **Cross-repo dead code**: if your worker's only callers live in a different
  repository, deadlint can't see them. Treat findings as "no callers in
  *this* tree" — not "no callers anywhere in the universe."
- **Behavioral clones with different control flow**: the inline engine is
  shape-based. Two functions that compute the same thing differently won't
  match. The similarity engine handles this slightly better but still has
  limits.
- **HTTP route handlers**: if your worker dispatches by URL path rather than
  by method name, dispatch-target methods are invisible to deadlint. Add the
  router/dispatcher class names to `--bases` if appropriate, or annotate
  call sites.

### Stability

This project is **pinned to `0.0.1` permanently**. That means:

- It works for what it does today, with tests on a synthetic fixture and
  validated on real codebases.
- The semver number is a deliberate signal: don't expect a stability
  guarantee. Behavior may change between commits if a heuristic is wrong.
- New checks may be added, default thresholds may move, output format may
  change. Pin to a commit SHA in CI rather than to a version range.
- It's not abandoned. It's just honest about its scope.

If you want a sound, blessed, breaking-change-tracked version, write it.
This one stays small.

---

## Develop

```bash
git clone https://github.com/acoyfellow/deadlint
cd deadlint
pnpm install
pnpm test         # black-box CLI tests against test/fixtures/sample
pnpm typecheck    # tsc --noEmit
```

Source is ~6 files in `src/`:

| File                    | Role                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `cli.ts`                | Argument parsing, dispatch, exit code                                  |
| `dead-rpc.ts`           | Boundary-class walk + token-grep + ts-morph reference union            |
| `clones-similarity.ts`  | `similarity-ts` runner + text-output parser                            |
| `clones-inline.ts`      | Built-in shape-hash + Jaccard clone detector                           |
| `report.ts`             | Human-readable output                                                  |
| `types.ts`              | Shared `Finding` types                                                 |

## License

[MIT](./LICENSE)
