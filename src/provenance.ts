/**
 * Skill provenance: where a skill comes from decides how an approved change to
 * it is applied. Local skills are edited in place, managed skills go through
 * `manage_skill`, and upstream and plugin skills get amendment rules (ADR 0002).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface SkillRoots {
  /** The user's skills directory, `~/.agents/skills`. */
  skillsDir: string;
  /** The skills CLI lock, `~/.agents/.skill-lock.json`. */
  lockFile: string;
  /** OMP's managed-skills directory, `<agent dir>/managed-skills`. */
  managedDir: string;
  /** OMP's user-scope registry of marketplace plugins, `~/.omp/plugins/installed_plugins.json`. */
  pluginsRegistry: string;
  /** Expands `~` in read paths. */
  home: string;
  /** Resolves relative read paths. */
  cwd: string;
}

interface InstalledSkill {
  name: string;
  /** The installed folder's name: the lock key, or the folder under the managed-skills or plugin skills directory. */
  folder: string;
  /** Absolute path to the skill's `SKILL.md`. */
  path: string;
}

export type SkillProvenance =
  | (InstalledSkill & { kind: "local" })
  | (InstalledSkill & { kind: "upstream"; skillFolderHash: string })
  | (InstalledSkill & { kind: "managed" })
  /** Installed by an OMP marketplace plugin: `plugin` is its registry id, `<plugin>@<marketplace>`. */
  | (InstalledSkill & { kind: "plugin"; plugin: string; version: string })
  | { kind: "unknown"; name: string };

export interface ProvenanceResolver {
  /** Resolves a skill by the name `skill://` URLs and `/skill:` use. */
  byName(name: string): SkillProvenance;
  /** Resolves a skill by the path of its `SKILL.md`, as passed to `read`. */
  byPath(path: string): SkillProvenance;
}

/** OMP's agent dir: OMP exports its resolved value, profile overrides included, to this variable. */
export function ompAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp/agent");
}

/**
 * SHA-256 hex over the skill's folder: its regular files, recursively, sorted
 * by relative POSIX path, each hashed as `relpath\0bytes\0`. Symlinks and other
 * non-files are skipped. Pins amendment rules to the skill's content (ADR 0002).
 */
export function skillHash(skill: SkillProvenance): string {
  if (skill.kind !== "upstream" && skill.kind !== "plugin") return "";
  const root = dirname(skill.path);
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root, "");
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file).update("\0").update(readFileSync(join(root, file))).update("\0");
  }
  return hash.digest("hex");
}

export function defaultSkillRoots(cwd: string): SkillRoots {
  const home = homedir();
  return {
    skillsDir: join(home, ".agents/skills"),
    lockFile: join(home, ".agents/.skill-lock.json"),
    managedDir: join(ompAgentDir(), "managed-skills"),
    pluginsRegistry: join(home, ".omp/plugins/installed_plugins.json"),
    home,
    cwd,
  };
}

const FRONTMATTER_NAME = /^---\r?\n(?:[^\n]*\r?\n)*?name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*\r?\n/;

/** The skill's frontmatter `name`, or its folder name when it has none. */
function skillName(skillFile: string): string {
  try {
    const head = readFileSync(skillFile, "utf8").slice(0, 4096);
    return FRONTMATTER_NAME.exec(head)?.[1] ?? basename(dirname(skillFile));
  } catch {
    return basename(dirname(skillFile));
  }
}

function readLockHashes(lockFile: string): Map<string, string> {
  try {
    const lock = JSON.parse(readFileSync(lockFile, "utf8")) as {
      skills?: Record<string, { skillFolderHash?: string }>;
    };
    return new Map(
      Object.entries(lock.skills ?? {}).map(([folder, entry]) => [folder, entry.skillFolderHash ?? ""]),
    );
  } catch {
    return new Map();
  }
}

interface InstalledPlugin {
  id: string;
  version: string;
  installPath: string;
}

/** The enabled plugins in OMP's registry; none when it is missing or unreadable. */
function readPlugins(registryFile: string): InstalledPlugin[] {
  try {
    const registry = JSON.parse(readFileSync(registryFile, "utf8")) as {
      plugins?: Record<string, Array<{ installPath?: string; version?: string; enabled?: boolean }>>;
    };
    return Object.entries(registry.plugins ?? {}).flatMap(([id, entries]) =>
      entries
        // OMP skips a disabled entry, so its skills are not loaded.
        .filter((entry) => entry.enabled !== false && typeof entry.installPath === "string")
        .map((entry) => ({ id, version: entry.version || "unknown", installPath: resolve(entry.installPath as string) })),
    );
  } catch {
    return [];
  }
}

function listSkillFiles(root: string): string[] {
  try {
    return readdirSync(root)
      .map((folder) => join(root, folder, "SKILL.md"))
      .filter((file) => existsSync(file));
  } catch {
    return [];
  }
}

/**
 * Resolves skills against the user's skills directory, its lock, the
 * managed-skills directory and the plugins in OMP's registry. Directories are scanned on the first lookup, so a
 * resolver that is never asked costs nothing.
 */
export function createProvenanceResolver(roots: SkillRoots): ProvenanceResolver {
  let lockHashes: Map<string, string> | undefined;
  let byNameIndex: Map<string, SkillProvenance> | undefined;
  let plugins: InstalledPlugin[] | undefined;

  const installedPlugins = () => (plugins ??= readPlugins(roots.pluginsRegistry));
  const pluginSkill = (skillFile: string, plugin: InstalledPlugin): SkillProvenance => ({
    kind: "plugin",
    name: skillName(skillFile),
    folder: basename(dirname(skillFile)),
    path: skillFile,
    plugin: plugin.id,
    version: plugin.version,
  });

  const installed = (skillFile: string): SkillProvenance => {
    const skill: InstalledSkill = {
      name: skillName(skillFile),
      folder: basename(dirname(skillFile)),
      path: skillFile,
    };
    const root = dirname(dirname(skillFile));
    if (root === roots.managedDir) return { kind: "managed", ...skill };
    lockHashes ??= readLockHashes(roots.lockFile);
    const skillFolderHash = lockHashes.get(skill.folder);
    return skillFolderHash === undefined
      ? { kind: "local", ...skill }
      : { kind: "upstream", ...skill, skillFolderHash };
  };

  const index = (): Map<string, SkillProvenance> => {
    if (byNameIndex) return byNameIndex;
    const found = new Map<string, SkillProvenance>();
    const add = (provenance: SkillProvenance) => {
      if (!found.has(provenance.name)) found.set(provenance.name, provenance);
    };
    // First wins, in the precedence of OMP's loader: plugin skills, then local and upstream ones, then managed ones.
    for (const plugin of installedPlugins()) {
      for (const file of listSkillFiles(join(plugin.installPath, "skills"))) add(pluginSkill(file, plugin));
    }
    for (const root of [roots.skillsDir, roots.managedDir]) {
      for (const file of listSkillFiles(root)) add(installed(file));
    }
    byNameIndex = found;
    return found;
  };

  return {
    byName: (name) => index().get(name) ?? { kind: "unknown", name },
    byPath: (path) => {
      const expanded = path.startsWith("~/") ? join(roots.home, path.slice(2)) : path;
      const skillFile = resolve(roots.cwd, expanded);
      const plugin = installedPlugins().find((candidate) => skillFile.startsWith(candidate.installPath + sep));
      if (plugin && existsSync(skillFile)) return pluginSkill(skillFile, plugin);
      const root = dirname(dirname(skillFile));
      if ((root === roots.skillsDir || root === roots.managedDir) && existsSync(skillFile)) {
        return installed(skillFile);
      }
      const unknown = { kind: "unknown" as const, name: basename(dirname(skillFile)) };
      // A byte-identical copy of an installed skill's entry file loads the same instructions; a path that cannot be read is no copy.
      try {
        const copy = readFileSync(skillFile);
        const named = index().get(FRONTMATTER_NAME.exec(copy.toString("utf8", 0, 4096))?.[1] ?? unknown.name);
        return named && named.kind !== "unknown" && readFileSync(named.path).equals(copy) ? named : unknown;
      } catch {
        return unknown;
      }
    },
  };
}
