import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionEntry } from "../src/omp.js";
import type { SkillRoots } from "../src/provenance.js";

/** The home directory the harvested session fixtures were recorded under. */
const RECORDED_HOME = "/home/user";

/** The marketplace plugin the fixture home installs, with its skill `ce-code-review`. */
export const CE_PLUGIN = "compound-engineering@compound-engineering-plugin";

export function writeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture skill.\n---\n\nBody.\n`);
}

/** Copies the entry file `skillFile` into `dir` with `extra` appended, as a project can keep a copy of an installed skill; returns the copy's path. */
export function copySkillEntry(skillFile: string, dir: string, extra = ""): string {
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, "SKILL.md");
  writeFileSync(copy, readFileSync(skillFile, "utf8") + extra);
  return copy;
}

type Registry = { version: number; plugins: Record<string, Array<Record<string, unknown>>> };

const readRegistry = (roots: SkillRoots): Registry => JSON.parse(readFileSync(roots.pluginsRegistry, "utf8"));

/**
 * Installs marketplace plugin `id` at `version` as OMP does: its skills under a
 * versioned cache folder, registered in the user-scope registry. An earlier
 * version's folder is removed, as OMP removes it on upgrade.
 */
export function installPlugin(roots: SkillRoots, id: string, version: string, skills: readonly string[]): string {
  uninstallPlugin(roots, id);
  const [plugin, marketplace] = id.split("@");
  const installPath = join(dirname(roots.pluginsRegistry), "cache/plugins", `${marketplace}___${plugin}___${version}`);
  for (const name of skills) writeSkill(join(installPath, "skills", name), name);
  const registry = readRegistry(roots);
  const at = "2026-09-30T10:15:00.464Z";
  registry.plugins[id] = [{ scope: "user", installPath, version, installedAt: at, lastUpdated: at }];
  writeFileSync(roots.pluginsRegistry, JSON.stringify(registry));
  return installPath;
}

/** Removes plugin `id` from the registry and deletes its install folder, as OMP's uninstall does. */
export function uninstallPlugin(roots: SkillRoots, id: string): void {
  const registry = readRegistry(roots);
  for (const entry of registry.plugins[id] ?? []) rmSync(String(entry.installPath), { recursive: true, force: true });
  delete registry.plugins[id];
  writeFileSync(roots.pluginsRegistry, JSON.stringify(registry));
}

/**
 * A temp home laid out like the real one: upstream skills tracked in a copy of
 * the fixture lock, a local skill with no lock entry, managed skills, and a
 * marketplace plugin with one skill.
 */
export function makeSkillHome() {
  const home = mkdtempSync(join(tmpdir(), "skill-observer-"));
  const roots: SkillRoots = {
    skillsDir: join(home, ".agents/skills"),
    lockFile: join(home, ".agents/.skill-lock.json"),
    managedDir: join(home, ".omp/agent/managed-skills"),
    pluginsRegistry: join(home, ".omp/plugins/installed_plugins.json"),
    home,
    cwd: join(home, "project"),
  };
  for (const name of ["tdd", "domain-modeling", "grill-with-docs", "ce-commit-jj"]) {
    writeSkill(join(roots.skillsDir, name), name);
  }
  copyFileSync(new URL("./fixtures/skill-lock.json", import.meta.url), roots.lockFile);
  for (const name of ["implement-spec", "worktree-add"]) {
    writeSkill(join(roots.managedDir, name), name);
  }
  mkdirSync(dirname(roots.pluginsRegistry), { recursive: true });
  writeFileSync(roots.pluginsRegistry, JSON.stringify({ version: 2, plugins: {} }));
  installPlugin(roots, CE_PLUGIN, "3.30.1", ["ce-code-review"]);

  return {
    home,
    roots,
    /** Rewrites fixture paths recorded under the real home into this one. */
    relocate: (entries: readonly SessionEntry[]): SessionEntry[] =>
      JSON.parse(JSON.stringify(entries).replaceAll(RECORDED_HOME, home)),
  };
}
