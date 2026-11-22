import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import * as ledger from "../src/ledger.js";
import { projectRootScope } from "../src/project-scope.js";

it("publishes only owned extension sources without widening ordinary project drafts", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-observer-scope-")));
  const cwd = join(root, "current");
  const agentDir = join(root, "profile");
  const foreign = join(root, "other");
  const source = join(cwd, "extensions/queue-helper");
  const foreignSource = join(foreign, "extensions/queue-helper");
  const profileSource = join(agentDir, "extensions/queue-helper");
  const nativeSource = join(cwd, ".omp/extensions/local-helper");
  const unrelated = join(cwd, "unrelated");
  const installed = join(cwd, "node_modules/queue-helper");
  const target = (source: string, checkout?: string) => ({ scope: "harness", root: "extension", source, mechanism: "queue cleanup", ...(checkout !== undefined && { checkout }) } as const);
  const record = (target: ledger.HarnessTarget): ledger.HarnessLedgerRecord => ({
    kind: "harness", target, fingerprint: ledger.harnessFingerprint(target), outcome: "later", gist: "queue cleanup",
    timestamp: "2026-11-22T00:00:00Z", sessionId: "scope-test",
  });
  try {
    for (const dir of [source, foreignSource, profileSource, installed]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ omp: { extensions: ["./index.ts"] } }));
      writeFileSync(join(dir, "index.ts"), "export default () => {};\n");
    }
    mkdirSync(nativeSource, { recursive: true });
    writeFileSync(join(nativeSource, "index.js"), "export default () => {};\n");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "index.ts"), "export default () => {};\n");
    const alias = join(dirname(source), "alias");
    symlinkSync(foreignSource, alias);

    const currentTarget = ledger.canonicalHarnessTarget(cwd, agentDir, target(source));
    expect(currentTarget).toEqual(target(source, cwd));
    expect(ledger.canonicalHarnessTarget(cwd, agentDir, target(nativeSource))).toEqual(target(nativeSource, cwd));
    expect(ledger.hookFileKey(currentTarget, ledger.harnessFingerprint(currentTarget))).toBeUndefined();
    expect(() => ledger.canonicalHarnessTarget(cwd, agentDir, target(join(foreign, "missing"), foreign), projectRootScope(cwd))).toThrow(/user's project scope/);
    const named = projectRootScope(cwd, { roots: [foreign], worktrees: [] });
    const foreignTarget = ledger.canonicalHarnessTarget(cwd, agentDir, target(foreignSource, foreign), named);
    expect(ledger.harnessDestinationRoot(foreignTarget, cwd, agentDir)).toBe(foreignSource);
    expect(ledger.ledgerDecisionInProject(record(currentTarget), foreign)).toBe(false);
    expect(ledger.ledgerDecisionInProject(record(foreignTarget), foreign)).toBe(true);
    const profileTarget = ledger.canonicalHarnessTarget(cwd, agentDir, target(profileSource));
    expect(profileTarget).toEqual(target(profileSource));
    expect(ledger.ledgerDecisionInProject(record(profileTarget), cwd)).toBe(false);
    expect(() => ledger.harnessDestinationRoot(profileTarget, cwd, join(root, "other-profile"))).toThrow();
    for (const invalid of [unrelated, installed, alias, foreignSource]) {
      expect(() => ledger.canonicalHarnessTarget(cwd, agentDir, target(invalid))).toThrow();
    }

    const projectTarget = (path: string) => ledger.canonicalProjectTarget(cwd, { scope: "project", root: cwd, path, mechanism: "queue cleanup" });
    const historical = projectTarget("extensions/queue-helper/src/future.ts");
    for (const path of [historical.path, "extensions/queue-helper/package.json", ".omp/extensions/future.ts"]) {
      expect(() => ledger.requireCheckedExecutableTarget(projectTarget(path))).toThrow(/checked/);
    }
    expect(() => ledger.requireCheckedExecutableTarget(projectTarget("unrelated/index.ts"))).not.toThrow();
    expect(() => ledger.requireCheckedExecutableTarget(projectTarget("extensions/queue-helper/README.md"))).not.toThrow();
    expect(ledger.ledgerDecisionInProject({
      kind: "project", target: historical, fingerprint: ledger.projectFingerprint(historical),
      outcome: "later", gist: "queue cleanup", timestamp: "2026-11-22T00:00:00Z", sessionId: "scope-test",
    }, cwd)).toBe(true);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/queue-helper/index.ts"] } }));
    expect(ledger.canonicalHarnessTarget(cwd, agentDir, target(cwd))).toEqual(target(cwd, cwd));
    expect(() => ledger.requireCheckedExecutableTarget(projectTarget("package.json"))).toThrow(/checked/);
    rmSync(join(source, "package.json"));
    expect(ledger.harnessDestinationRoot(currentTarget, cwd, agentDir)).toBe(source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
