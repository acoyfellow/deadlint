// Inline (no-external-deps) clone detection using ts-morph.
//
// Approach: structural body hashing.
//   1. Walk every function/method body in the project.
//   2. Produce a normalized "shape" string: kind tokens only — no identifiers,
//      no literals, no comments. Just the AST skeleton.
//   3. Group bodies whose normalized shape is identical OR whose token shingles
//      overlap above the configured threshold (Jaccard on 5-grams).
//
// This is intentionally simple. It won't catch every clone similarity-ts does,
// but it has zero deps and is good enough for the "I copied this method and
// renamed two things" pattern that motivated this tool.

import {
  Project,
  Node,
  SyntaxKind,
  type FunctionDeclaration,
  type MethodDeclaration,
  type ArrowFunction,
  type FunctionExpression,
} from "ts-morph";
import type { CloneFinding, RunOptions } from "./types.ts";

type FnLike = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

type BodyEntry = {
  file: string;
  line: number;
  symbol: string;
  shape: string;
  shingles: Set<string>;
  bodyLines: number;
};

// Convert a node body to a normalized token sequence: SyntaxKind names only.
// This erases identifiers/literals so renamed copies still match.
function normalizeShape(node: Node): string {
  const tokens: string[] = [];
  const visit = (n: Node) => {
    tokens.push(SyntaxKind[n.getKind()] ?? String(n.getKind()));
    n.forEachChild(visit);
  };
  node.forEachChild(visit);
  return tokens.join(" ");
}

function shinglesOf(shape: string, k = 5): Set<string> {
  const tokens = shape.split(" ").filter(Boolean);
  if (tokens.length < k) return new Set([tokens.join(" ")]);
  const out = new Set<string>();
  for (let i = 0; i + k <= tokens.length; i++) {
    out.add(tokens.slice(i, i + k).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const small = a.size <= b.size ? a : b;
  const big = a.size <= b.size ? b : a;
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function symbolNameOf(fn: FnLike): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName() ?? "<anon>";
  }
  // Arrow / function expression — try the parent variable/property name
  const parent = fn.getParent();
  if (parent && "getName" in parent && typeof (parent as any).getName === "function") {
    try {
      return (parent as any).getName() ?? "<anon>";
    } catch {
      return "<anon>";
    }
  }
  return "<anon>";
}

function collectBodies(opts: RunOptions): BodyEntry[] {
  const project = new Project({
    tsConfigFilePath: opts.tsconfigPath,
    skipAddingFilesFromTsConfig: false,
  });
  project.addSourceFilesAtPaths([
    `${opts.rootPath}/**/*.ts`,
    `!${opts.rootPath}/**/node_modules/**`,
    `!${opts.rootPath}/**/dist/**`,
    `!${opts.rootPath}/**/.wrangler/**`,
    `!${opts.rootPath}/**/*.d.ts`,
  ]);

  const entries: BodyEntry[] = [];

  for (const sf of project.getSourceFiles()) {
    const file = sf.getFilePath();
    if (!file.startsWith(opts.rootPath)) continue;
    if (file.endsWith(".d.ts")) continue;

    sf.forEachDescendant((node) => {
      let body: Node | undefined;
      let fn: FnLike | undefined;

      if (Node.isFunctionDeclaration(node)) {
        fn = node;
        body = node.getBody();
      } else if (Node.isMethodDeclaration(node)) {
        fn = node;
        body = node.getBody();
      } else if (Node.isArrowFunction(node)) {
        fn = node;
        body = node.getBody();
      } else if (Node.isFunctionExpression(node)) {
        fn = node;
        body = node.getBody();
      }

      if (!fn || !body) return;
      const start = body.getStartLineNumber();
      const end = body.getEndLineNumber();
      const bodyLines = end - start + 1;
      if (bodyLines < opts.cloneMinLines) return;

      // Skip anonymous arrow/function expressions: in test files these are
      // overwhelmingly `expect(() => ...)` blocks and inline callbacks, which
      // share AST shape by accident, not by copy-paste. We only want named
      // functions/methods where a clone hint is actionable refactor signal.
      const sym = symbolNameOf(fn);
      if (sym === "<anon>") return;

      const shape = normalizeShape(body);
      const shingles = shinglesOf(shape);
      entries.push({
        file,
        line: fn.getStartLineNumber(),
        symbol: symbolNameOf(fn),
        shape,
        shingles,
        bodyLines,
      });
    });
  }

  return entries;
}

export async function findClonesInline(opts: RunOptions): Promise<CloneFinding[]> {
  const entries = collectBodies(opts);
  const findings: CloneFinding[] = [];

  // Bucket by exact shape first — O(n). Anything in the same bucket = exact
  // structural clone (score 1.0).
  const byShape = new Map<string, BodyEntry[]>();
  for (const e of entries) {
    const arr = byShape.get(e.shape) ?? [];
    arr.push(e);
    byShape.set(e.shape, arr);
  }
  const reported = new Set<string>();
  for (const arr of byShape.values()) {
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = pairKey(arr[i]!, arr[j]!);
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push(toFinding(arr[i]!, arr[j]!, 1.0));
      }
    }
  }

  // Then approximate match across all pairs whose Jaccard ≥ threshold.
  // This is O(n^2). Acceptable for now; we cap by skipping pairs already in `reported`
  // and by quick size-difference rejection.
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      // Quick reject: very different sizes can't hit threshold.
      const sizeRatio = Math.min(a.shingles.size, b.shingles.size) /
        Math.max(a.shingles.size, b.shingles.size);
      if (sizeRatio < opts.cloneThreshold) continue;
      const key = pairKey(a, b);
      if (reported.has(key)) continue;
      const score = jaccard(a.shingles, b.shingles);
      if (score >= opts.cloneThreshold) {
        reported.add(key);
        findings.push(toFinding(a, b, score));
      }
    }
  }

  return findings.sort((x, y) => y.score - x.score);
}

function pairKey(a: BodyEntry, b: BodyEntry): string {
  const ka = `${a.file}:${a.line}`;
  const kb = `${b.file}:${b.line}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function toFinding(a: BodyEntry, b: BodyEntry, score: number): CloneFinding {
  return {
    kind: "clone",
    engine: "inline",
    score,
    a: { file: a.file, line: a.line, symbol: a.symbol },
    b: { file: b.file, line: b.line, symbol: b.symbol },
    lines: Math.max(a.bodyLines, b.bodyLines),
  };
}
