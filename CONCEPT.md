# deadlint in 7 minutes

A reading-only walkthrough. By the end you'll know what deadlint does,
what gap it fills, and the entire codebase well enough to extend it.

## Minute 1 — the gap

Take this Cloudflare Worker:

```ts
export class GitServer extends DurableObject {
  async readBlob(hash: string) { ... }
  async readTree(hash: string) { ... }
  async streamingUploadPack(body: ReadableStream) { ... }   // <- nobody calls this
  async streamingUploadPackWithEventType(body: ReadableStream) { ... }
}
```

Ask `knip`, `oxlint`, `eslint`, or `tsc` whether `streamingUploadPack` is
dead. They'll all say no. They're not lying — they can't tell. From _their_
point of view, `GitServer` is exported, and any holder of a
`DurableObjectStub<GitServer>` could call any of its public methods. They
stop at the class boundary.

In Workers / Agents codebases that means the dozens of public methods on
every DO are permanently invisible to dead-code detection. Real story: a
wrapper that nobody had called in months. `streamingUploadPack` delegated to
`streamingUploadPackWithEventType`. Every caller — internal and external —
went straight to the latter. The wrapper was dead the day after it shipped.

deadlint exists to tell you that.

## Minute 2 — the trick

There's no _sound_ static-analysis answer here. RPC stubs cross a runtime
boundary; the type system doesn't know which methods get reached. So
deadlint uses **two heuristic signals in conjunction**:

### Signal A: TypeScript language-service references (ts-morph)

For every public method on a boundary class, ask the TS language service:
who references this name? This is precise, but **blind to JSRPC stubs** —
the stub type is synthesized from the class shape and the proxy method has
no declaration link. So every DO method looks unreferenced.

Used alone: ~30 false positives on the artifacts repo.

### Signal B: a scoped token scan

Grep the corpus for `.methodName(`, `.methodName<`, and `["methodName"](`.
Crude. This is what RPC calls actually look like at the call site,
regardless of TypeScript's reasoning. False-positives keep alive things that
share a name with unrelated calls. False-negatives are rare — anyone calling
the method has to spell the name somewhere.

Used alone: too noisy.

### The union

A method is **dead only when both signals turn up zero** in-repo references.
On the artifacts repo this took us from 30 false positives → 1 real finding
(the `streamingUploadPack` dead wrapper).

For a small list of stdlib-ish names (`map`, `then`, `set`, `get`, `has`,
`forEach`...), Signal B is suppressed entirely — every codebase has
thousands of `.map(` calls. For those names, only Signal A counts.

## Minute 3 — what counts as a "boundary class"

The default list:

- `DurableObject` — Cloudflare DOs
- `WorkerEntrypoint` — JSRPC-callable Workers
- `WorkflowEntrypoint` — Cloudflare Workflows
- `RpcTarget` — first-class RPC targets
- `Agent` — Agents SDK base

Override with `--bases Foo,Bar`.

The dead-RPC check **only looks at methods on these classes**. If you have
your own framework with its own RPC base classes, list them. Methods on
plain classes are left to `knip`/`oxlint`.

## Minute 4 — the second check, "clones"

While we were already walking the AST, adding clone detection was cheap and
high-value. Two implementations, deliberately:

### `--clones-engine similarity` (default)

Shells out to [`similarity-ts`](https://github.com/mizchi/similarity), a
Rust binary by [@mizchi](https://github.com/mizchi). It uses oxc-parser and
TSED (Tree Structure Edit Distance) with a size-penalty. Production-grade,
high-precision, finds **semantic near-matches** even with renamed
identifiers. Filters out coincidence-shaped helpers.

Install: `cargo install similarity-ts`. If it's not on PATH, this engine
prints a warning and skips.

### `--clones-engine inline`

~150 lines of `ts-morph` built into deadlint. For every function/method
body it produces a normalized "shape" string of `SyntaxKind` tokens —
identifiers and literals erased. Renamed copies produce identical shapes.
We bucket on exact shape (score `1.00`), and approximate-match using
5-gram Jaccard similarity above `--clone-threshold`.

No external deps. Higher recall than similarity-ts on small clones.
Different style of finding. The two engines are complementary —
running both gives you a fuller picture.

## Minute 5 — the codebase

```
src/
├── cli.ts                  # arg parsing, dispatch, exit codes
├── types.ts                # Finding type definitions
├── dead-rpc.ts             # the dead-RPC check (Signal A ∪ Signal B)
├── clones-similarity.ts    # similarity-ts runner + text-output parser
├── clones-inline.ts        # built-in shape-hash + Jaccard
└── report.ts               # human-readable output
```

That's the whole tool. Six files, ~700 lines of TypeScript total.
Everything else is tests, fixtures, docs.

The interesting code paths are all in `dead-rpc.ts` and `clones-inline.ts`.
The CLI / report / types files are mechanical.

## Minute 6 — the contract

Output format is stable:

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
  score: number;        // 0..1
  a: { file: string; line: number; symbol: string };
  b: { file: string; line: number; symbol: string };
  lines: number;        // approx body size
};
```

Pass `--json` to consume it programmatically. Exit code is `0`/`1`/`2`
(clean / findings / misconfig). That's the whole API surface.

## Minute 7 — what won't work, and what you'd do next

deadlint **won't** catch:

- Dynamically-named RPC calls: `stub[name]()` where `name` is computed.
- Cross-repo dead code: if your worker's callers live in a different
  repo, deadlint sees nothing.
- Methods reached via HTTP route dispatch by URL path rather than
  method name. Add the router class to `--bases` or annotate call sites.
- Behavioral clones with different control flow. The inline engine is
  shape-based; the similarity engine helps but isn't magic.

The thing it _is_ good at — finding dead methods on Workers boundary
classes — it does in roughly the way you'd write it yourself if you sat
down for a week. That's the entire pitch. Pinned to `0.0.1` because
"version 1" implies a stability promise; this is honest, useful, and
small, and stays that way.

If you want to extend it, the obvious next checks (in order of leverage):

1. **Dead HTTP routes** — extend the boundary concept to Hono/itty/etc.
   route handlers. The pattern is the same: routes are entry points the
   linter doesn't see.
2. **Dead queue/scheduled handlers** — same idea, different decorator.
3. **Cross-package call graph** — for monorepos, walk all workspace
   packages and merge callers. Currently each invocation only sees the
   `tsconfig.json` it was pointed at.
4. **A `--diff` mode** — only report findings whose method or body was
   touched in `git diff <base>...HEAD`. Fast, MR-shaped output for CI.

Read `src/dead-rpc.ts` next. It's 200 lines and the comments explain the
reasoning more than the code does. Welcome.

---

## Bonus: making it always-on

If you want deadlint to fire on every `git push` from every repo on your
machine — public, private, GitHub, GitLab, doesn't matter — set git's
global `core.hooksPath` and drop a `pre-push` script there. See the
"Always-on" section in the README. ~10 lines of bash, one-time setup,
covers your whole career.
