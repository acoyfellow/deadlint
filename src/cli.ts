// CLI entry point. Parses args, dispatches to checks, prints report.
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { resolve, join, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { findDeadRpcMethods } from "./dead-rpc.ts";
import { findClonesSimilarity } from "./clones-similarity.ts";
import { findClonesInline } from "./clones-inline.ts";
import { renderReport } from "./report.ts";
import type { CliOptions, Finding, RunOptions } from "./types.ts";

const DEFAULT_BASES = [
  "DurableObject",
  "WorkerEntrypoint",
  "WorkflowEntrypoint",
  "RpcTarget",
  "Agent",
];

// Directories typically containing build output or framework-generated
// artifacts. We exclude them by default from every scan because they
// produce ~100% clone matches against the source they were built from.
// Override with --exclude (replaces) or extend with --also-exclude (adds).
//
// Deliberately NOT in this list:
//   - `lib` — used for source code in SvelteKit (`src/lib/...`) and many
//     other frameworks. Way more common as source than as build output.
//     Projects that emit to `lib/` (e.g. alchemy-style outDir) can pass
//     `--also-exclude lib`.
//   - `target` — Cargo's, but rarely under a TS project root.
//   - `output` — too generic.
const DEFAULT_EXCLUDE_DIRS = [
  "dist",
  "build",
  "out",
  "coverage",
  ".svelte-kit",
  ".next",
  ".nuxt",
  ".turbo",
  ".alchemy",
  ".wrangler",
  ".cache",
  ".vercel",
  ".astro",
  "node_modules",
];

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  let rootPath: string | undefined;
  let tsconfigPath: string | undefined;
  let bases = new Set(DEFAULT_BASES);
  let checks = new Set<"dead-rpc" | "clones">(["dead-rpc", "clones"]);
  let clonesEngine: CliOptions["clonesEngine"] = "similarity";
  let cloneThreshold = 0.85;
  let cloneMinLines = 6;
  let excludeDirs = [...DEFAULT_EXCLUDE_DIRS];
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--tsconfig":
        tsconfigPath = args[++i];
        break;
      case "--bases":
        bases = new Set(args[++i]!.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      case "--check": {
        const list = args[++i]!.split(",").map((s) => s.trim());
        checks = new Set(list as ("dead-rpc" | "clones")[]);
        break;
      }
      case "--clones-engine":
        clonesEngine = args[++i] as CliOptions["clonesEngine"];
        break;
      case "--clone-threshold":
        cloneThreshold = Number(args[++i]);
        break;
      case "--clone-min-lines":
        cloneMinLines = Number(args[++i]);
        break;
      case "--exclude":
        excludeDirs = args[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--also-exclude": {
        const more = args[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
        excludeDirs.push(...more);
        break;
      }
      case "--json":
        json = true;
        break;
      case "--install-hook":
        process.exit(runInstallHook("install", args.slice(i + 1)));
      case "--uninstall-hook":
        process.exit(runInstallHook("uninstall", args.slice(i + 1)));
      case "--hook-status":
        process.exit(runInstallHook("status", []));
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith("--")) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
        rootPath ??= a;
    }
  }

  if (!rootPath) {
    printHelp();
    process.exit(2);
  }

  const absRoot = isAbsolute(rootPath) ? rootPath : resolve(process.cwd(), rootPath);
  if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) {
    console.error(`Not a directory: ${absRoot}`);
    process.exit(2);
  }

  // Resolve which tsconfig(s) to scan.
  //
  // - User-supplied --tsconfig: use it, exactly that one.
  // - Otherwise look for the canonical roots (./tsconfig.json,
  //   apps/worker/tsconfig.json, ./tsconfig.base.json). If found, use it.
  // - Otherwise discover all tsconfig.json files within the project (depth
  //   <= 3, skipping common build/cache dirs) and scan each. This covers
  //   monorepos and multi-app repos that don't have a usable root config.
  let tsconfigPaths: string[];
  if (tsconfigPath) {
    const resolved = isAbsolute(tsconfigPath)
      ? tsconfigPath
      : resolve(process.cwd(), tsconfigPath);
    if (!existsSync(resolved)) {
      console.error(`deadlint: --tsconfig file not found: ${resolved}`);
      process.exit(2);
    }
    tsconfigPaths = [resolved];
  } else {
    const direct = findTsconfig(absRoot);
    const all = findAllTsconfigs(absRoot);
    if (direct && all[0] === direct) {
      // Canonical root config found at depth 0/1; use only that one.
      tsconfigPaths = [direct];
    } else if (all.length > 0) {
      // Multi-tsconfig project (monorepo / multi-app). Scan each.
      tsconfigPaths = all;
    } else {
      console.error(
        `deadlint: no tsconfig.json found under ${absRoot}.\n` +
          `Pass --tsconfig <path> to point at one explicitly.`,
      );
      process.exit(2);
    }
  }

  return {
    rootPath: absRoot,
    tsconfigPaths,
    bases,
    checks,
    clonesEngine,
    cloneThreshold,
    cloneMinLines,
    excludeDirs: [...new Set(excludeDirs)],
    json,
  };
}

function findTsconfig(root: string): string | undefined {
  // Try common monorepo spots first.
  const direct = [
    join(root, "tsconfig.json"),
    join(root, "apps", "worker", "tsconfig.json"),
    join(root, "tsconfig.base.json"),
  ];
  const hit = direct.find(existsSync);
  if (hit) return hit;

  // Fall back: any tsconfig found by walking 2 levels deep, picking the
  // first one encountered. This handles monorepos with non-standard
  // layouts (web/, api/, packages/*/) when the user didn't pass --tsconfig
  // and didn't pin a root tsconfig. For multi-tsconfig repos, use
  // findAllTsconfigs() to discover them all.
  const all = findAllTsconfigs(root);
  return all[0];
}

/**
 * Walk `root` to a maximum depth of 3 directories, collecting every
 * tsconfig.json (excluding common build/cache dirs). Returns absolute paths,
 * sorted by directory depth (shallowest first) so well-named root configs
 * win when only one is needed.
 */
function findAllTsconfigs(root: string): string[] {
  const SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".svelte-kit",
    ".next",
    ".nuxt",
    ".turbo",
    ".alchemy",
    ".wrangler",
    ".cache",
    ".vercel",
    ".astro",
    "coverage",
    "out",
  ]);
  const found: { path: string; depth: number }[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name === "tsconfig.json") {
        found.push({ path: full, depth });
        continue;
      }
      if (entry.isDirectory() && !SKIP.has(entry.name)) {
        visit(full, depth + 1);
      }
    }
  };
  visit(root, 0);
  found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  return found.map((f) => f.path);
}

/**
 * Resolve the path to the bundled install-hook.sh script.
 * Works whether deadlint is run via `tsx src/cli.ts`, the `bin/deadlint.mjs`
 * shim, or installed via `npm i -g`.
 */
function findInstallHookScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli.ts -> ../scripts/install-hook.sh
  const candidate = resolve(here, "..", "scripts", "install-hook.sh");
  if (existsSync(candidate)) return candidate;
  // Fallback for unusual installs: search from the package root.
  const fallback = resolve(here, "scripts", "install-hook.sh");
  return fallback;
}

/**
 * Delegate to scripts/install-hook.sh. Returns the script's exit code.
 */
function runInstallHook(
  cmd: "install" | "uninstall" | "status",
  passthrough: string[],
): number {
  const script = findInstallHookScript();
  if (!existsSync(script)) {
    console.error(
      `deadlint: hook installer script missing.\n` +
        `Expected at: ${script}\n` +
        `This usually means a broken install — try reinstalling deadlint.`,
    );
    return 2;
  }
  // Strip --force-style flags off passthrough so we don't accidentally
  // forward unrelated deadlint flags. Only --force is meaningful for the
  // hook installer.
  const safeArgs = passthrough.filter((a) => a === "--force");
  const r = spawnSync("bash", [script, cmd, ...safeArgs], {
    stdio: "inherit",
    env: process.env,
  });
  return r.status ?? 1;
}

function printHelp(): void {
  console.log(`deadlint — find dead cross-boundary code and structural clones

USAGE
  deadlint <path> [options]

CHECKS
  dead-rpc   Public methods on DurableObject / WorkerEntrypoint / RpcTarget /
             Agent / WorkflowEntrypoint subclasses that have no in-repo callers.
             Catches what knip / oxlint / eslint can't, because they treat
             every exported class member as part of the public surface.

  clones     Near-duplicate function bodies across the codebase. Two engines:
               similarity  - shells to similarity-ts (cargo install required).
                             Higher precision, larger functions only.
               inline      - built-in ts-morph structural hash, zero external
                             deps. Higher recall, catches small/exact clones.

OPTIONS
  --tsconfig <path>           Path to tsconfig.json (default: auto-detect)
  --bases <A,B,C>             Override boundary class list
                              (default: DurableObject, WorkerEntrypoint,
                              WorkflowEntrypoint, RpcTarget, Agent)
  --check <list>              Comma list of: dead-rpc, clones
                              (default: both)
  --clones-engine <engine>    similarity | inline | both
                              (default: similarity)
  --clone-threshold <n>       0..1 threshold for clone match
                              (default: 0.85)
  --clone-min-lines <n>       Min function body lines to compare
                              (default: 6)
  --exclude <a,b,c>           Replace the default exclude-dirs list
                              (default: dist, build, out, coverage,
                              .svelte-kit, .next, .nuxt, .turbo, .alchemy,
                              .wrangler, .cache, .vercel, .astro,
                              node_modules)
  --also-exclude <a,b,c>      Add to the default exclude-dirs list
  --json                      Emit machine-readable JSON instead of text
  -h, --help                  This message

EXAMPLES
  deadlint ./my-worker
  deadlint ./my-worker --check dead-rpc
  deadlint ./my-worker --clones-engine both --clone-threshold 0.82
  deadlint ./my-worker --json > report.json

GIT HOOK
  --install-hook [--force]    Install a global pre-push hook that runs
                              deadlint on every push from any repo on
                              this machine. See README "Always-on" section.
  --uninstall-hook            Remove the deadlint-managed pre-push hook.
  --hook-status               Show whether the hook is currently installed.

EXIT CODES
  0   no findings
  1   findings present (use --json to consume)
  2   misconfiguration (missing path, missing tsconfig, bad flag)

DOCS
  https://github.com/acoyfellow/deadlint
`);
}

async function main() {
  const cli = parseArgs(process.argv);
  const allFindings: Finding[] = [];

  // Run each check once per discovered tsconfig. Same `RunOptions` shape
  // per project so the check functions don't need to know about multi-
  // project orchestration.
  for (const tsconfigPath of cli.tsconfigPaths) {
    const opts: RunOptions = { ...cli, tsconfigPath };
    if (!opts.json && cli.tsconfigPaths.length > 1) {
      console.error(`→ project: ${tsconfigPath}`);
    }

    if (opts.checks.has("dead-rpc")) {
      if (!opts.json) console.error("→ dead-rpc check…");
      allFindings.push(...(await findDeadRpcMethods(opts)));
    }

    if (opts.checks.has("clones")) {
      if (opts.clonesEngine === "similarity" || opts.clonesEngine === "both") {
        if (!opts.json) console.error("→ clones (similarity-ts)…");
        allFindings.push(...(await findClonesSimilarity(opts)));
      }
      if (opts.clonesEngine === "inline" || opts.clonesEngine === "both") {
        if (!opts.json) console.error("→ clones (inline ts-morph)…");
        allFindings.push(...(await findClonesInline(opts)));
      }
    }
  }

  // Deduplicate findings that the same multi-tsconfig run reported twice
  // (e.g. a clone pair where both files belong to two different sub-
  // projects, or a dead method whose class is included in both).
  const findings = dedupeFindings(allFindings);

  // Reporter wants something with rootPath and json — use the CLI shape.
  const reportOpts: RunOptions = {
    ...cli,
    tsconfigPath: cli.tsconfigPaths[0] ?? "",
  };
  if (cli.json) {
    process.stdout.write(JSON.stringify({ findings }, null, 2) + "\n");
  } else {
    process.stdout.write(renderReport(findings, reportOpts) + "\n");
  }

  process.exit(findings.length > 0 ? 1 : 0);
}

/**
 * Multi-tsconfig runs can report the same finding twice when files are
 * part of multiple project-references. Build a stable key per finding
 * and keep only the first occurrence.
 */
function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key =
      f.kind === "dead-rpc"
        ? `dead:${f.file}:${f.line}:${f.className}.${f.methodName}`
        : `clone:${f.engine}:` +
          [`${f.a.file}:${f.a.line}`, `${f.b.file}:${f.b.line}`].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
