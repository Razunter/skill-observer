import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

// Bun fixes os.homedir() at process startup; each fake host supplies HOME at runtime.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<{ homedir(): string }>();
  return { ...os, homedir: () => process.env.HOME ?? os.homedir() };
});

// Loading the extension migrates the agent dir's rules, so every test and every spawned `omp` gets a throwaway agent dir.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "skill-observer-agent-"));
