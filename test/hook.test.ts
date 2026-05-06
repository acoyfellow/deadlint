// Tests for scripts/install-hook.sh.
//
// We always set DEADLINT_HOOKS_DIR to a freshly-mkdtemp'd directory so the
// installer never touches the real ~/.config/git/hooks/. We intentionally
// do NOT exercise the `git config --global core.hooksPath` mutation: that
// would mutate the user's actual git config. The script's behavior around
// core.hooksPath is covered by the manual install path in the README.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const script = resolve(repoRoot, "scripts", "install-hook.sh");

function runScript(
  cmd: string,
  hooksDir: string,
  extraArgs: string[] = [],
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [script, cmd, ...extraArgs], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEADLINT_HOOKS_DIR: hooksDir,
      // Prevent the script from touching the real global git config.
      // We can't actually stop `git config --global` from running, but we
      // can check that the script doesn't change anything we care about by
      // setting GIT_CONFIG_GLOBAL to a throwaway file (git respects this).
      GIT_CONFIG_GLOBAL: join(hooksDir, "fake-gitconfig"),
    },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function makeTmpHooksDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deadlint-hook-test-"));
  return dir;
}

test("install: writes the pre-push hook into a fresh hooks dir", () => {
  const dir = makeTmpHooksDir();
  try {
    const r = runScript("install", dir);
    assert.equal(r.code, 0, `install failed: ${r.stderr}`);
    const hookPath = join(dir, "pre-push");
    assert.ok(existsSync(hookPath), "pre-push hook should exist");
    const contents = readFileSync(hookPath, "utf8");
    assert.match(contents, /deadlint-managed/, "hook must include marker");
    assert.match(contents, /deadlint --check dead-rpc/, "hook must invoke deadlint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install: no-op when our hook is already present (no --force)", () => {
  const dir = makeTmpHooksDir();
  try {
    const first = runScript("install", dir);
    assert.equal(first.code, 0, "first install should succeed");

    const before = readFileSync(join(dir, "pre-push"), "utf8");
    const second = runScript("install", dir);
    assert.equal(second.code, 0, "second install should be a clean no-op");
    const after = readFileSync(join(dir, "pre-push"), "utf8");
    assert.equal(after, before, "second install should not mutate the hook");
    assert.match(second.stdout, /already installed/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install: refuses to clobber a foreign pre-push hook", () => {
  const dir = makeTmpHooksDir();
  try {
    writeFileSync(
      join(dir, "pre-push"),
      "#!/usr/bin/env bash\necho 'this is some other tool'\n",
      { mode: 0o755 },
    );
    const r = runScript("install", dir);
    assert.equal(r.code, 1, "should refuse with exit 1");
    assert.match(r.stderr, /refuses to overwrite/i);
    // Original file unchanged
    const after = readFileSync(join(dir, "pre-push"), "utf8");
    assert.match(after, /this is some other tool/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install --force: overwrites foreign hook when explicitly asked", () => {
  const dir = makeTmpHooksDir();
  try {
    writeFileSync(join(dir, "pre-push"), "#!/usr/bin/env bash\necho 'old'\n", {
      mode: 0o755,
    });
    const r = runScript("install", dir, ["--force"]);
    assert.equal(r.code, 0, `--force install failed: ${r.stderr}`);
    const after = readFileSync(join(dir, "pre-push"), "utf8");
    assert.match(after, /deadlint-managed/);
    assert.doesNotMatch(after, /echo 'old'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: removes hooks we installed", () => {
  const dir = makeTmpHooksDir();
  try {
    runScript("install", dir);
    assert.ok(existsSync(join(dir, "pre-push")));

    const r = runScript("uninstall", dir);
    assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
    assert.ok(!existsSync(join(dir, "pre-push")), "hook should be gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: refuses to remove a hook we didn't install", () => {
  const dir = makeTmpHooksDir();
  try {
    writeFileSync(join(dir, "pre-push"), "#!/usr/bin/env bash\necho 'foreign'\n", {
      mode: 0o755,
    });
    const r = runScript("uninstall", dir);
    assert.equal(r.code, 1, "should refuse");
    assert.match(r.stderr, /refuses to remove/i);
    assert.ok(existsSync(join(dir, "pre-push")), "foreign hook should remain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: no-op if no hook exists", () => {
  const dir = makeTmpHooksDir();
  try {
    const r = runScript("uninstall", dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Nothing to do/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: reports installed/not-installed correctly", () => {
  const dir = makeTmpHooksDir();
  try {
    let r = runScript("status", dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /not present/i);

    runScript("install", dir);
    r = runScript("status", dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /installed \(deadlint-managed\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
