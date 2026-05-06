// Clone detection via mizchi's similarity-ts.
//
// We shell out to `similarity-ts` (Rust binary, AST-based, TSED algorithm).
//
// Install: `cargo install similarity-ts`. There is NO npm package — the
// project only ships via crates.io. If the binary isn't on PATH we skip
// this engine with a warning, leaving the inline engine as the fallback.
//
// similarity-ts emits a VSCode-compatible text format like:
//   Duplicates in apps/worker/src/foo.ts:
//   ────────────────────────────────────────
//     apps/worker/src/foo.ts:10 | L10-15 similar-function: doThing
//     apps/worker/src/bar.ts:20 | L20-25 similar-function: doOtherThing
//     Similarity: 92.50%, Priority: 8.5 (lines: 10)
//
// We parse that block format. There is no machine-readable mode in v0.5.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { CloneFinding, RunOptions } from "./types.ts";

type SimilarityHit = {
  similarity: number;
  // similarity-ts uses different field names across versions; we tolerate
  // a few variants below.
  file1?: string;
  file2?: string;
  function1?: string;
  function2?: string;
  startLine1?: number;
  startLine2?: number;
  endLine1?: number;
  endLine2?: number;
  // newer schema
  a?: { file: string; name: string; startLine: number; endLine: number };
  b?: { file: string; name: string; startLine: number; endLine: number };
};

function tryRun(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string; code: number } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

function locateBinary(): string | undefined {
  const which = spawnSync("which", ["similarity-ts"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim() && existsSync(which.stdout.trim())) {
    return "similarity-ts";
  }
  return undefined;
}

export async function findClonesSimilarity(opts: RunOptions): Promise<CloneFinding[]> {
  const bin = locateBinary();
  if (!bin) {
    console.error(
      "WARN: similarity-ts not found on PATH. Install with `cargo install similarity-ts` or pass `--clones-engine inline`.",
    );
    return [];
  }

  // We deliberately keep similarity-ts's default size-penalty enabled.
  // Disabling it (--no-size-penalty) causes a runaway: any large function
  // matches dozens of unrelated smaller ones at "high" similarity because
  // the small one is a near-subgraph of the large one. The size penalty
  // is what makes similarity-ts's output actionable on real codebases.
  const args = [
    opts.rootPath,
    "--threshold",
    String(opts.cloneThreshold),
    "--min-lines",
    String(opts.cloneMinLines),
  ];

  const result = tryRun(bin, args);
  if (!result.ok && !result.stdout) {
    console.error(`WARN: similarity-ts failed (exit ${result.code}): ${result.stderr.trim()}`);
    return [];
  }

  return parseTextOutput(result.stdout);
}

function normalizeHit(h: SimilarityHit): CloneFinding | undefined {
  const a = h.a ?? {
    file: h.file1 ?? "",
    name: h.function1 ?? "?",
    startLine: h.startLine1 ?? 0,
    endLine: h.endLine1 ?? 0,
  };
  const b = h.b ?? {
    file: h.file2 ?? "",
    name: h.function2 ?? "?",
    startLine: h.startLine2 ?? 0,
    endLine: h.endLine2 ?? 0,
  };
  if (!a.file || !b.file) return undefined;

  return {
    kind: "clone",
    engine: "similarity",
    score: h.similarity ?? 0,
    a: { file: a.file, line: a.startLine, symbol: a.name },
    b: { file: b.file, line: b.startLine, symbol: b.name },
    lines: Math.max((a.endLine ?? 0) - (a.startLine ?? 0), (b.endLine ?? 0) - (b.startLine ?? 0)),
  };
}

// Parser for similarity-ts v0.5 text output. Two block shapes:
//
// Function clones:
//   Similarity: 87.33%, Score: 31.9 points (lines 31~42, avg: 36.5)
//     path/to/a.ts:59-100 repoComparator
//     path/to/b.ts:42-72 deriveAction
//
// Type clones (we currently ignore — not actionable code clones):
//   Similarity: 100.00% (structural: 100.00%, naming: 100.00%)
//     path/to/a.ts:79 | L79-79 similar-type: GitIdentity (type)
//     path/to/b.ts:61 | L61-64 similar-type: GitIdentity (interface)
//
// We only emit findings for the function-clone shape.
function parseTextOutput(out: string): CloneFinding[] {
  const findings: CloneFinding[] = [];
  const lines = out.split("\n");

  // Track whether we're in the Function Similarity section. We stop parsing
  // function clones once we hit "=== Type Similarity ===" or EOF.
  let inFunctionSection = false;

  const headerRx = /^Similarity:\s*([0-9.]+)%/;
  const fnRefRx = /^\s+(.+):(\d+)-(\d+)\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes("=== Function Similarity ===")) {
      inFunctionSection = true;
      continue;
    }
    if (line.includes("=== Type Similarity ===")) {
      inFunctionSection = false;
      continue;
    }
    if (!inFunctionSection) continue;

    const headerMatch = line.match(headerRx);
    if (!headerMatch) continue;

    // Look ahead for two file refs in the next non-empty lines.
    const a = (lines[i + 1] ?? "").match(fnRefRx);
    const b = (lines[i + 2] ?? "").match(fnRefRx);
    if (!a || !b) continue;

    const scorePct = Number(headerMatch[1]);
    const aStart = Number(a[2]);
    const aEnd = Number(a[3]);
    const bStart = Number(b[2]);
    const bEnd = Number(b[3]);

    findings.push({
      kind: "clone",
      engine: "similarity",
      score: scorePct / 100,
      a: { file: a[1]!, line: aStart, symbol: a[4]!.trim() },
      b: { file: b[1]!, line: bStart, symbol: b[4]!.trim() },
      lines: Math.max(aEnd - aStart, bEnd - bStart) + 1,
    });
    i += 2;
  }

  return findings;
}
