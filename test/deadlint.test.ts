// Black-box tests that assert deadlint produces the expected findings on the
// fixture project. We invoke the CLI in --json mode and check the structured
// output, so this exercises the same code path users hit.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const fixture = resolve(here, "fixtures", "sample");
const cli = resolve(repoRoot, "src", "cli.ts");
const tsx = resolve(repoRoot, "node_modules", ".bin", "tsx");

type DeadFinding = {
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
  score: number;
  a: { file: string; line: number; symbol: string };
  b: { file: string; line: number; symbol: string };
  lines: number;
};

type Finding = DeadFinding | CloneFinding;

function runDeadlint(args: string[]): { findings: Finding[]; exit: number; stderr: string } {
  const r = spawnSync(tsx, [cli, fixture, "--json", ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0 && r.status !== 1) {
    // 0 = clean, 1 = findings — anything else is a real failure.
    throw new Error(`deadlint failed (exit ${r.status}): ${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout) as { findings: Finding[] };
  return { findings: parsed.findings, exit: r.status ?? -1, stderr: r.stderr };
}

function pairKey(c: CloneFinding): string {
  const a = `${c.a.symbol}`;
  const b = `${c.b.symbol}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ── dead-rpc ──────────────────────────────────────────────────────────────

test("dead-rpc: identifies exactly the planted dead methods", () => {
  const { findings } = runDeadlint(["--check", "dead-rpc"]);
  const dead = findings.filter((f): f is DeadFinding => f.kind === "dead-rpc");

  const names = new Set(dead.map((d) => `${d.className}.${d.methodName}`));

  // Must flag these 3
  assert.ok(names.has("ServerDO.deprecatedFlush"), "deprecatedFlush should be dead");
  assert.ok(names.has("ServerDO.legacyReset"), "legacyReset should be dead");
  assert.ok(names.has("ServerDO.unusedHelperRpc"), "unusedHelperRpc should be dead");

  // Must NOT flag these
  assert.ok(!names.has("ServerDO.readObject"), "readObject is called via stub.readObject — should be live");
  assert.ok(!names.has("ServerDO.writeObject"), "writeObject is called by handleEvent — should be live");
  assert.ok(
    !names.has("ServerDO.handleEvent"),
    "handleEvent is called via [\"handleEvent\"]() — token-grep should keep it live",
  );
  assert.ok(!names.has("ServerDO.fetch"), "fetch is allow-listed");
  assert.ok(!names.has("ServerDO.alarm"), "alarm is allow-listed");

  // No surprises — exact size check
  assert.equal(dead.length, 3, `expected 3 dead findings, got ${dead.length}: ${[...names].join(", ")}`);
});

test("dead-rpc: each finding has correct file path and a plausible line number", () => {
  const { findings } = runDeadlint(["--check", "dead-rpc"]);
  const dead = findings.filter((f): f is DeadFinding => f.kind === "dead-rpc");
  for (const d of dead) {
    assert.ok(d.file.endsWith("server.ts"), `unexpected file: ${d.file}`);
    assert.ok(d.line > 0, "line should be 1-indexed");
    assert.equal(d.baseClass, "DurableObject");
  }
});

// ── clones (inline engine — guaranteed available, no external deps) ──────

test("clones (inline): finds cloneA ≈ cloneB", () => {
  const { findings } = runDeadlint([
    "--check",
    "clones",
    "--clones-engine",
    "inline",
    "--clone-min-lines",
    "5",
  ]);
  const clones = findings.filter((f): f is CloneFinding => f.kind === "clone");
  const inline = clones.filter((c) => c.engine === "inline");

  const keys = new Set(inline.map(pairKey));
  assert.ok(keys.has("cloneA|cloneB"), `expected cloneA|cloneB pair, got: ${[...keys].join(", ")}`);

  // Make sure the engine doesn't falsely pair the unique functions.
  assert.ok(!keys.has("uniqueA|uniqueB"), "uniqueA and uniqueB are structurally distinct");
});

test("clones (inline): score for cloneA ≈ cloneB is high", () => {
  const { findings } = runDeadlint([
    "--check",
    "clones",
    "--clones-engine",
    "inline",
    "--clone-min-lines",
    "5",
  ]);
  const clones = findings.filter((f): f is CloneFinding => f.kind === "clone");
  const hit = clones.find((c) => pairKey(c) === "cloneA|cloneB" && c.engine === "inline");
  assert.ok(hit, "cloneA|cloneB inline finding should exist");
  // Renamed-identifier copies of a non-trivial body land around 0.85-0.95
  // on Jaccard 5-gram similarity (some shingles drift due to identifier-
  // free shape never reaching exact equality on short token windows).
  assert.ok(hit.score >= 0.85, `score should be ≥0.85 for renamed copy, was ${hit.score}`);
});

// ── exit codes ────────────────────────────────────────────────────────────

test("exit code: nonzero when findings present", () => {
  const { exit, findings } = runDeadlint([]);
  assert.ok(findings.length > 0, "fixture should produce findings");
  assert.equal(exit, 1, "exit should be 1 when findings present");
});

// ── string-key dispatch (Agents SDK pattern) ──────────────────────────────

test("dead-rpc: keeps methods alive that are reached via client.call(\"name\", ...)", () => {
  const { findings } = runDeadlint(["--check", "dead-rpc"]);
  const dead = findings.filter((f): f is DeadFinding => f.kind === "dead-rpc");
  const names = new Set(dead.map((d) => `${d.className}.${d.methodName}`));
  assert.ok(
    !names.has("ServerDO.processViaCallApi"),
    "processViaCallApi is reached via client.call(\"processViaCallApi\", ...) and must not be flagged dead",
  );
});

test("dead-rpc: keeps methods alive that are reached only from .svelte companion files", () => {
  const { findings } = runDeadlint(["--check", "dead-rpc"]);
  const dead = findings.filter((f): f is DeadFinding => f.kind === "dead-rpc");
  const names = new Set(dead.map((d) => `${d.className}.${d.methodName}`));
  assert.ok(
    !names.has("ServerDO.frontendOnlyMethod"),
    "frontendOnlyMethod is reached from CallerComponent.svelte and must not be flagged dead",
  );
});

// ── tsconfig exclude is honored ───────────────────────────────────────────

test("clones (inline): does not scan files excluded by tsconfig", () => {
  const { findings } = runDeadlint([
    "--check",
    "clones",
    "--clones-engine",
    "inline",
    "--clone-min-lines",
    "5",
  ]);
  const clones = findings.filter((f): f is CloneFinding => f.kind === "clone");
  for (const c of clones) {
    assert.ok(
      !c.a.file.includes("/archive/") && !c.b.file.includes("/archive/"),
      `clone references archive/ file (excluded by tsconfig): ${c.a.file} / ${c.b.file}`,
    );
  }
});

test("dead-rpc: does not scan files excluded by tsconfig", () => {
  const { findings } = runDeadlint(["--check", "dead-rpc"]);
  const dead = findings.filter((f): f is DeadFinding => f.kind === "dead-rpc");
  for (const d of dead) {
    assert.ok(
      !d.file.includes("/archive/"),
      `dead-rpc finding in archive/ file (excluded by tsconfig): ${d.file}`,
    );
  }
});

// ── similarity engine (only if installed; otherwise just verify graceful skip) ──

test("clones (similarity): runs cleanly whether or not similarity-ts is installed", () => {
  // We deliberately do NOT assert that similarity-ts finds the synthetic
  // fixture pair. similarity-ts uses TSED with size-penalty by default, and
  // its scores on small/medium fixtures regularly land below the configurable
  // threshold even when bodies are near-identical. That's a feature on real
  // codebases (it kills coincidence-shaped helpers) but it means our fixture
  // alone isn't a reliable target for it. We only assert the engine doesn't
  // crash and produces well-formed output.
  const { findings, stderr, exit } = runDeadlint([
    "--check",
    "clones",
    "--clones-engine",
    "similarity",
    "--clone-min-lines",
    "5",
  ]);
  // exit 0 (clean) or 1 (findings) are both fine — we just don't want 2+ (crash).
  assert.ok(exit === 0 || exit === 1, `unexpected exit ${exit}: ${stderr}`);
  for (const f of findings) {
    if (f.kind === "clone" && f.engine === "similarity") {
      assert.ok(f.a.file && f.b.file, "similarity finding paths must be non-empty");
      assert.ok(f.score >= 0 && f.score <= 1, `score must be 0..1, got ${f.score}`);
      assert.ok(f.lines > 0, "lines must be > 0");
    }
  }
});
