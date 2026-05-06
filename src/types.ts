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

export type RunOptions = {
  rootPath: string;
  tsconfigPath: string;
  bases: Set<string>;
  checks: Set<"dead-rpc" | "clones">;
  clonesEngine: "similarity" | "inline" | "both";
  cloneThreshold: number;
  cloneMinLines: number;
  json: boolean;
};
