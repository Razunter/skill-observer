import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loading the extension migrates the agent dir's rules, so every test and every spawned `omp` gets a throwaway agent dir.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "skill-observer-agent-"));
