// CLI entry point. Parses args, dispatches to checks, prints report.
import { existsSync, statSync } from "node:fs";
import { resolve, join, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { findDeadRpcMethods } from "./dead-rpc.ts";
import { findClonesSimilarity } from "./clones-similarity.ts";
import { findClonesInline } from "./clones-inline.ts";
import { renderReport } from "./report.ts";
import type { Finding, RunOptions } from "./types.ts";

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

function parseArgs(argv: string[]): RunOptions {
  const args = argv.slice(2);
  let rootPath: string | undefined;
  let tsconfigPath: string | undefined;
  let bases = new Set(DEFAULT_BASES);
  let checks = new Set<"dead-rpc" | "clones">(["dead-rpc", "clones"]);
  let clonesEngine: RunOptions["clonesEngine"] = "similarity";
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
        clonesEngine = args[++i] as RunOptions["clonesEngine"];
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

  const resolvedTsconfig = tsconfigPath
    ? isAbsolute(tsconfigPath)
      ? tsconfigPath
      : resolve(process.cwd(), tsconfigPath)
    : findTsconfig(absRoot);

  if (!resolvedTsconfig || !existsSync(resolvedTsconfig)) {
    console.error(
      `deadlint: no tsconfig.json found at any of:\n` +
        `  ${absRoot}/tsconfig.json\n` +
        `  ${absRoot}/apps/worker/tsconfig.json\n` +
        `  ${absRoot}/tsconfig.base.json\n` +
        `Pass --tsconfig <path> to point at one explicitly.`,
    );
    process.exit(2);
  }

  return {
    rootPath: absRoot,
    tsconfigPath: resolvedTsconfig,
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
  // Try common monorepo spots.
  const candidates = [
    join(root, "tsconfig.json"),
    join(root, "apps", "worker", "tsconfig.json"),
    join(root, "tsconfig.base.json"),
  ];
  return candidates.find(existsSync);
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
  const opts = parseArgs(process.argv);
  const findings: Finding[] = [];

  if (opts.checks.has("dead-rpc")) {
    if (!opts.json) console.error("→ dead-rpc check…");
    findings.push(...(await findDeadRpcMethods(opts)));
  }

  if (opts.checks.has("clones")) {
    if (opts.clonesEngine === "similarity" || opts.clonesEngine === "both") {
      if (!opts.json) console.error("→ clones (similarity-ts)…");
      findings.push(...(await findClonesSimilarity(opts)));
    }
    if (opts.clonesEngine === "inline" || opts.clonesEngine === "both") {
      if (!opts.json) console.error("→ clones (inline ts-morph)…");
      findings.push(...(await findClonesInline(opts)));
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ findings }, null, 2) + "\n");
  } else {
    process.stdout.write(renderReport(findings, opts) + "\n");
  }

  process.exit(findings.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
