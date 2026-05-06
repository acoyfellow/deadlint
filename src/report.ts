// Pretty-print a list of findings to stdout.

import { relative } from "node:path";
import type { Finding, RunOptions } from "./types.ts";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
};

function color(s: string, c: keyof typeof C, on = process.stdout.isTTY): string {
  return on ? `${C[c]}${s}${C.reset}` : s;
}

export function renderReport(findings: Finding[], opts: RunOptions): string {
  if (findings.length === 0) {
    return color("✓ no findings", "green");
  }

  const dead = findings.filter((f): f is Finding & { kind: "dead-rpc" } => f.kind === "dead-rpc");
  const clones = findings.filter((f): f is Finding & { kind: "clone" } => f.kind === "clone");

  const lines: string[] = [];
  lines.push(color(`deadlint report — ${opts.rootPath}`, "bold"));
  lines.push("");

  if (dead.length > 0) {
    lines.push(color(`Dead RPC methods (${dead.length})`, "yellow"));
    lines.push(color("───────────────────────────", "dim"));
    for (const f of dead) {
      const rel = relative(opts.rootPath, f.file);
      lines.push(
        `  ${color(`${f.className}.${f.methodName}`, "red")}  ` +
          color(`(extends ${f.baseClass})`, "dim") +
          `\n    ${color(`${rel}:${f.line}`, "cyan")}`,
      );
    }
    lines.push("");
  }

  if (clones.length > 0) {
    const byEngine = new Map<string, typeof clones>();
    for (const c of clones) {
      const arr = byEngine.get(c.engine) ?? [];
      arr.push(c);
      byEngine.set(c.engine, arr);
    }
    for (const [engine, list] of byEngine) {
      lines.push(color(`Clones — engine: ${engine} (${list.length})`, "magenta"));
      lines.push(color("───────────────────────────", "dim"));
      for (const c of list) {
        const ra = relative(opts.rootPath, c.a.file);
        const rb = relative(opts.rootPath, c.b.file);
        lines.push(
          `  ${color(c.score.toFixed(2), "yellow")}  ${color(`${c.lines}L`, "dim")}  ` +
            `${c.a.symbol} ≈ ${c.b.symbol}\n` +
            `    ${color(`${ra}:${c.a.line}`, "cyan")}\n` +
            `    ${color(`${rb}:${c.b.line}`, "cyan")}`,
        );
      }
      lines.push("");
    }
  }

  lines.push(color(`${findings.length} finding${findings.length === 1 ? "" : "s"}`, "bold"));
  return lines.join("\n");
}
