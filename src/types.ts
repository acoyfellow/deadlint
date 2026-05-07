// Shared finding types across all checks.

export type DeadRpcFinding = {
  kind: "dead-rpc";
  className: string;
  methodName: string;
  baseClass: string;
  file: string;
  line: number;
};

export type CloneFinding = {
  kind: "clone";
  engine: "similarity" | "inline";
  score: number; // 0..1
  a: { file: string; line: number; symbol: string };
  b: { file: string; line: number; symbol: string };
  lines: number; // approx body size
};

export type Finding = DeadRpcFinding | CloneFinding;

/** Top-level options parsed from argv. */
export type CliOptions = Omit<RunOptions, "tsconfigPath"> & {
  /** One or more tsconfig.json files to scan. */
  tsconfigPaths: string[];
};

/** Options for a single per-tsconfig run. */
export type RunOptions = {
  rootPath: string;
  tsconfigPath: string;
  bases: Set<string>;
  checks: Set<"dead-rpc" | "clones">;
  clonesEngine: "similarity" | "inline" | "both";
  cloneThreshold: number;
  cloneMinLines: number;
  /**
   * Directory names that should be excluded from all scans.
   *
   * The inline clone engine and the dead-rpc check honor `tsconfig.json`'s
   * `exclude` field, so they typically don't need this. But the similarity
   * engine shells out to similarity-ts (a Rust binary that does its own
   * filesystem walk and ignores tsconfig), and the companion-file scanner
   * for the dead-rpc check walks the filesystem directly.
   *
   * Common defaults: `dist`, `build`, `coverage`, `.svelte-kit`, `.next`,
   * `.nuxt`, `.alchemy`, `.wrangler`, `.turbo`. Override with `--exclude`.
   */
  excludeDirs: string[];
  json: boolean;
};
