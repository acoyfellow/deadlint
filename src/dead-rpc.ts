// Dead RPC method finder.
//
// For every class extending one of the configured base classes (DurableObject,
// WorkerEntrypoint, RpcTarget, Agent, WorkflowEntrypoint), enumerate public
// async methods and report any whose only references are the declaration itself.
//
// Why this matters: knip / oxlint / eslint all stop at the class boundary —
// they can't tell whether a public method is "really" reachable, because in
// principle anyone with a binding could call it.
//
// What we do — a UNION of two reachability signals:
//
//   1. TypeScript language-service references via ts-morph's
//      findReferencesAsNodes(). This is precise but BLIND TO RPC: calls
//      against `DurableObjectStub<T>` / `Service<T>` / Agent stubs don't
//      resolve back to the implementation method, because the stub type is
//      synthesized from the class shape and the proxy method has no
//      declaration link. Without a fallback we'd report ~every DO method
//      as dead.
//
//   2. A repo-wide token scan for `.methodName(` and `["methodName"](`. Crude
//      but it's how RPC calls actually look at the call site. False
//      positives (e.g. an unrelated class with the same method name calling
//      `.foo()`) are accepted in exchange for not flagging real RPC entry
//      points.
//
// A method is reported DEAD only if BOTH signals turn up zero in-repo
// references outside the declaration itself.

import { Node, Project, SyntaxKind, type ClassDeclaration, type MethodDeclaration } from "ts-morph";
import { dirname, join, resolve, relative } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { DeadRpcFinding, RunOptions } from "./types.ts";

// Extensions of companion files that may contain calls to TypeScript class
// methods but aren't compiled as TypeScript. Scanned as plain text for the
// token-grep pass only (Pattern A and Pattern B). We don't try to parse them.
const COMPANION_EXTENSIONS = [".svelte", ".vue", ".astro", ".tsx", ".jsx", ".mts", ".cts"];

// Always-skip dirs the user can't override — these are filesystem hazards
// (.git internals, node_modules) where descending wastes time and produces
// nothing useful. The user-configurable exclude list is layered on top.
const ALWAYS_SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * Recursively collect companion (non-TS) source files under root that may
 * reference TypeScript-defined methods via string-key dispatch.
 *
 * @param root absolute path to start walking
 * @param userExcludeDirs additional directory names to skip (build outputs,
 *   framework caches). Combined with ALWAYS_SKIP_DIRS.
 */
function collectCompanionFiles(root: string, userExcludeDirs: string[]): string[] {
  const skip = new Set([...ALWAYS_SKIP_DIRS, ...userExcludeDirs]);
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        visit(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (COMPANION_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(join(dir, entry.name));
      }
    }
  };
  visit(root);
  return out;
}

const SKIP_METHOD_PREFIXES = ["_", "#"]; // private convention + private fields

// Methods we never flag as dead, even if no callers found in-repo. These are
// either Workers/Agents runtime entry points (called by the platform, not by
// in-repo code) or constructor-like hooks where absence of explicit calls is
// the norm.
const ALWAYS_LIVE_METHODS = new Set([
  // Workers entrypoints
  "fetch",
  "scheduled",
  "queue",
  "tail",
  "trace",
  "email",
  "test",
  // Durable Object lifecycle
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
  // WorkflowEntrypoint
  "run",
  // Agents SDK lifecycle hooks
  "constructor",
  "onStart",
  "onConnect",
  "onMessage",
  "onClose",
  "onError",
  "onRequest",
  "onChatMessage",
  "onStateUpdate",
]);

// Names so common in JS/TS that any token-grep for `.name(` will hit somewhere.
// We REFUSE to use the token-grep signal for these — only the ts-morph
// language-service signal counts. This prevents `array.map()`, `arr.forEach()`,
// `promise.then()` etc. from masking truly-dead methods of the same name.
//
// If your DO has a method literally named `map`/`then`/`forEach`/etc., the
// language-service reference search still finds real callers; we just don't
// trust grep for these names.
const TOKEN_GREP_BLOCKLIST = new Set([
  // Array methods
  "map",
  "filter",
  "reduce",
  "forEach",
  "find",
  "some",
  "every",
  "flat",
  "flatMap",
  "includes",
  "indexOf",
  "join",
  "slice",
  "sort",
  "concat",
  "push",
  "pop",
  "shift",
  "unshift",
  "reverse",
  "fill",
  "splice",
  "at",
  // Promise methods
  "then",
  "catch",
  "finally",
  // String methods
  "split",
  "replace",
  "replaceAll",
  "trim",
  "toLowerCase",
  "toUpperCase",
  "match",
  "matchAll",
  "startsWith",
  "endsWith",
  "padStart",
  "padEnd",
  "repeat",
  "substring",
  "charAt",
  "charCodeAt",
  // Map/Set methods
  "set",
  "get",
  "has",
  "delete",
  "clear",
  "keys",
  "values",
  "entries",
  "size",
  // Object methods
  "toString",
  "valueOf",
  "hasOwnProperty",
  // Generic
  "length",
  "name",
  "constructor",
]);

function getBaseClassName(cls: ClassDeclaration): string | undefined {
  const ext = cls.getExtends();
  if (!ext) return undefined;
  const expr = ext.getExpression();
  // Could be `DurableObject` or `DurableObject<Env>` or `Foo.Bar` — get the
  // rightmost identifier text.
  const text = expr.getText();
  const lastDot = text.lastIndexOf(".");
  const head = lastDot >= 0 ? text.slice(lastDot + 1) : text;
  // Strip generics: `DurableObject<Env>` → `DurableObject`
  const lt = head.indexOf("<");
  return (lt >= 0 ? head.slice(0, lt) : head).trim();
}

function isInteresting(method: MethodDeclaration): boolean {
  // Skip overloads, getters/setters, static, private, protected, prefixed.
  if (method.isStatic()) return false;
  const scope = method.getScope();
  if (scope === "private" || scope === "protected") return false;
  const name = method.getName();
  if (!name) return false;
  if (SKIP_METHOD_PREFIXES.some((p) => name.startsWith(p))) return false;
  if (ALWAYS_LIVE_METHODS.has(name)) return false;
  return true;
}

export async function findDeadRpcMethods(opts: RunOptions): Promise<DeadRpcFinding[]> {
  // Trust the tsconfig: ts-morph loads exactly the files the project
  // declares. We deliberately do NOT re-glob the filesystem — that would
  // pull in directories the tsconfig has explicitly excluded (legacy
  // trees, generated artifacts, etc.) and inflate findings with noise.
  const project = new Project({
    tsConfigFilePath: opts.tsconfigPath,
    skipAddingFilesFromTsConfig: false,
  });

  // ── Pass 1: collect every candidate method from boundary classes ──────────
  type Candidate = {
    cls: ClassDeclaration;
    method: MethodDeclaration;
    base: string;
    name: string;
  };
  const candidates: Candidate[] = [];

  // Build-output directories (dist/, .svelte-kit/, etc.) frequently get
  // pulled into a tsconfig project even when they shouldn't be — usually
  // because a path mapping or `composite` reference reaches them. We
  // filter using the same exclude list we forward to similarity-ts so the
  // three engines stay consistent.
  const isExcluded = (file: string): boolean =>
    opts.excludeDirs.some((dir) => file.includes(`/${dir}/`));

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (!filePath.startsWith(opts.rootPath)) continue;
    if (filePath.endsWith(".d.ts")) continue;
    if (isExcluded(filePath)) continue;

    for (const cls of sourceFile.getClasses()) {
      const base = getBaseClassName(cls);
      if (!base || !opts.bases.has(base)) continue;

      for (const method of cls.getMethods()) {
        if (!isInteresting(method)) continue;
        const nameNode = method.getNameNode();
        if (!Node.isIdentifier(nameNode) && !Node.isPrivateIdentifier(nameNode)) continue;
        candidates.push({ cls, method, base, name: method.getName() });
      }
    }
  }

  // ── Pass 2: token-grep the corpus ONCE for every candidate name ───────────
  // We build regexes that OR all candidate names, then walk every source
  // file's text and count hits per name. This is O(files + names) rather
  // than O(files * names).
  //
  // Two patterns are matched:
  //
  //   A) Direct dispatch:   .foo(   .foo<   ["foo"](   ['foo'](
  //      Standard JS call syntax.
  //
  //   B) String-key dispatch via `.call("name", ...)` — the Agents SDK
  //      pattern (frontend code uses `client.call("methodName", args)` to
  //      reach a Durable Object's @callable() methods through the WebSocket
  //      proxy). Without this, every method on every Agent looks dead from
  //      inside the worker repo.
  //
  // Names in TOKEN_GREP_BLOCKLIST are excluded from BOTH patterns, since
  // `.map(`, `.then(`, etc. would otherwise create universal false-keep-
  // alives. For those names we trust only the ts-morph language-service
  // signal in pass 3.
  const nameSet = new Set(
    candidates.map((c) => c.name).filter((n) => !TOKEN_GREP_BLOCKLIST.has(n)),
  );
  const callCounts = new Map<string, number>(); // name -> non-declaration call sites
  for (const name of nameSet) callCounts.set(name, 0);

  if (nameSet.size > 0) {
    const escaped = [...nameSet].map(escapeRegExp).join("|");

    // Pattern A: `.foo(`, `.foo<`, `["foo"](`. Declarations (bare
    // `name(`) are not matched because there's no leading `.` or `[`.
    const directRx = new RegExp(
      `(?:\\.|\\[[\"'])(${escaped})(?:[\"'\\]]?\\s*[(<])`,
      "g",
    );

    // Pattern B: `.call("foo"`, `.call<T>("foo"`, `.call('foo'`. Tolerates
    // whitespace so multi-line call expressions match, and an optional
    // generic argument list (`<...>`) so TypeScript-generic call sites
    // like `client.call<ReturnType>("method", ...)` are recognized.
    const stringDispatchRx = new RegExp(
      `\\.call(?:\\s*<[^>]*>)?\\s*\\(\\s*[\"'](${escaped})[\"']`,
      "g",
    );

    const scanText = (text: string) => {
      let m: RegExpExecArray | null;
      directRx.lastIndex = 0;
      while ((m = directRx.exec(text)) !== null) {
        const hitName = m[1]!;
        callCounts.set(hitName, (callCounts.get(hitName) ?? 0) + 1);
      }
      stringDispatchRx.lastIndex = 0;
      while ((m = stringDispatchRx.exec(text)) !== null) {
        const hitName = m[1]!;
        callCounts.set(hitName, (callCounts.get(hitName) ?? 0) + 1);
      }
    };

    // Pass 2a: TS source files loaded via tsconfig.
    for (const sf of project.getSourceFiles()) {
      const file = sf.getFilePath();
      if (!file.startsWith(opts.rootPath)) continue;
      if (file.endsWith(".d.ts")) continue;
      if (isExcluded(file)) continue;
      scanText(sf.getFullText());
    }

    // Pass 2b: companion non-TS source files (.svelte, .vue, .tsx, ...).
    // Frontend code commonly invokes Workers RPC methods from these files
    // via `client.call("methodName", args)` — we'd flag every such method
    // as dead without this. Read as text only; we do not try to parse them.
    for (const file of collectCompanionFiles(opts.rootPath, opts.excludeDirs)) {
      try {
        scanText(readFileSync(file, "utf8"));
      } catch {
        // Unreadable files (perms, race) just contribute zero hits.
      }
    }
  }

  // ── Pass 3: per-candidate, also try TypeScript references (precise) ──────
  // A method is dead iff BOTH signals turn up zero. This means a single hit
  // from either pass keeps it alive — false-negative-leaning by design.

  const findings: DeadRpcFinding[] = [];

  for (const c of candidates) {
    const tokenHits = callCounts.get(c.name) ?? 0;

    let tsHits = 0;
    try {
      const nameNode = c.method.getNameNode();
      const refs = (nameNode as Node & { findReferencesAsNodes: () => Node[] })
        .findReferencesAsNodes();
      for (const ref of refs) {
        if (ref === nameNode) continue;
        const refFile = ref.getSourceFile().getFilePath();
        if (refFile.endsWith(".d.ts")) continue;
        if (!refFile.startsWith(opts.rootPath)) continue;
        tsHits++;
      }
    } catch (err) {
      console.error(
        `WARN: reference lookup failed for ${c.cls.getName()}.${c.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (tokenHits === 0 && tsHits === 0) {
      findings.push({
        kind: "dead-rpc",
        className: c.cls.getName() ?? "<anonymous>",
        methodName: c.name,
        baseClass: c.base,
        file: c.cls.getSourceFile().getFilePath(),
        line: c.method.getStartLineNumber(),
      });
    }
  }

  return findings;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Re-export internals for tests.
export const __internals = {
  getBaseClassName,
  isInteresting,
  ALWAYS_LIVE_METHODS,
  TOKEN_GREP_BLOCKLIST,
};
// dirname/SyntaxKind imported above are currently unused; keep imports to
// anchor types if tests grow.
void dirname;
void SyntaxKind;
