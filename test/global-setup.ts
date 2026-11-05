import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEAK_PREFIX = "skill-observer-";
const RUN_PREFIX = "skill-observer-run-";

/**
 * Points every worker's `tmpdir()` at one run folder and deletes it afterwards,
 * so fixture homes and agent dirs never outlive the run. Teardown fails the run
 * when a test still wrote a `skill-observer-*` folder straight into the system temp dir.
 */
export default function setup() {
  const systemTmp = tmpdir();
  const existing = new Set(readdirSync(systemTmp));
  const runRoot = mkdtempSync(join(systemTmp, RUN_PREFIX));
  process.env.TMPDIR = runRoot;

  return () => {
    rmSync(runRoot, { recursive: true, force: true });
    const leaked = readdirSync(systemTmp).filter(
      (name) => name.startsWith(LEAK_PREFIX) && !name.startsWith(RUN_PREFIX) && !existing.has(name),
    );
    if (leaked.length > 0) {
      throw new Error(`Tests left temp folders outside the run root ${runRoot}: ${leaked.join(", ")}`);
    }
  };
}
