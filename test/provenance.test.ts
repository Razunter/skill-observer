import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProvenanceResolver } from "../src/provenance.js";
import { CE_PLUGIN, copySkillEntry, installPlugin, makeSkillHome, writeSkill } from "./skill-home.js";

describe("skill provenance", () => {
  it("labels a skill in the lock as upstream, with its folder hash and installed folder", () => {
    const { roots } = makeSkillHome();
    expect(createProvenanceResolver(roots).byName("tdd")).toEqual({
      kind: "upstream",
      name: "tdd",
      folder: "tdd",
      path: join(roots.skillsDir, "tdd/SKILL.md"),
      skillFolderHash: "79288be15c67b849f22b6572056601090fd20913",
    });
  });

  it("labels a skill in the skills directory without a lock entry as local", () => {
    const { roots } = makeSkillHome();
    expect(createProvenanceResolver(roots).byName("ce-commit-jj")).toEqual({
      kind: "local",
      name: "ce-commit-jj",
      folder: "ce-commit-jj",
      path: join(roots.skillsDir, "ce-commit-jj/SKILL.md"),
    });
  });

  it("labels a skill in the managed-skills directory as managed", () => {
    const { roots } = makeSkillHome();
    expect(createProvenanceResolver(roots).byName("implement-spec")).toEqual({
      kind: "managed",
      name: "implement-spec",
      folder: "implement-spec",
      path: join(roots.managedDir, "implement-spec/SKILL.md"),
    });
  });

  it("labels a skill found nowhere as unknown", () => {
    const { roots } = makeSkillHome();
    expect(createProvenanceResolver(roots).byName("no-such-skill")).toEqual({
      kind: "unknown",
      name: "no-such-skill",
    });
  });

  it("labels a skill under a registered plugin's install path as a plugin skill, with the plugin's id and version", () => {
    const { roots } = makeSkillHome();
    const installPath = installPlugin(roots, "impeccable@impeccable", "4.4.0", ["impeccable"]);
    const expected = {
      kind: "plugin",
      name: "impeccable",
      folder: "impeccable",
      path: join(installPath, "skills/impeccable/SKILL.md"),
      plugin: "impeccable@impeccable",
      version: "4.4.0",
    };
    const provenance = createProvenanceResolver(roots);
    expect(provenance.byName("impeccable")).toEqual(expected);
    expect(provenance.byPath(join(installPath, "skills/impeccable/SKILL.md"))).toEqual(expected);
  });

  it("resolves each skill by the file it is given when a plugin skill and a skill in the lock share a name", () => {
    const { roots } = makeSkillHome();
    const installPath = installPlugin(roots, CE_PLUGIN, "3.30.1", ["ce-code-review", "tdd"]);
    const provenance = createProvenanceResolver(roots);
    expect(provenance.byPath(join(roots.skillsDir, "tdd/SKILL.md"))).toMatchObject({ kind: "upstream", name: "tdd" });
    expect(provenance.byPath(join(installPath, "skills/tdd/SKILL.md"))).toMatchObject({ kind: "plugin", plugin: CE_PLUGIN });
    // OMP loads the plugin skill when both exist, so a name resolves to it.
    expect(provenance.byName("tdd")).toMatchObject({ kind: "plugin" });
  });

  it("leaves out a plugin the registry marks disabled, as OMP does", () => {
    const { roots } = makeSkillHome();
    const registry = JSON.parse(readFileSync(roots.pluginsRegistry, "utf8"));
    registry.plugins[CE_PLUGIN][0].enabled = false;
    writeFileSync(roots.pluginsRegistry, JSON.stringify(registry));
    expect(createProvenanceResolver(roots).byName("ce-code-review")).toEqual({ kind: "unknown", name: "ce-code-review" });
  });

  it("finds no plugin skills when the registry is missing", () => {
    const { roots } = makeSkillHome();
    rmSync(roots.pluginsRegistry);
    expect(createProvenanceResolver(roots).byName("ce-code-review")).toMatchObject({ kind: "unknown" });
  });

  it("gives a same-named skill in the skills directory precedence over a managed one", () => {
    const { roots } = makeSkillHome();
    writeSkill(join(roots.managedDir, "ce-commit-jj"), "ce-commit-jj");
    expect(createProvenanceResolver(roots).byName("ce-commit-jj")).toMatchObject({ kind: "local" });
  });

  it("finds an upstream skill by its frontmatter name when its folder is named differently", () => {
    const { roots } = makeSkillHome();
    writeSkill(join(roots.skillsDir, "grill-with-docs"), "grill-docs");
    expect(createProvenanceResolver(roots).byName("grill-docs")).toMatchObject({
      kind: "upstream",
      name: "grill-docs",
      folder: "grill-with-docs",
    });
  });

  it.each([
    ["an absolute", (home: string) => join(home, ".agents/skills/domain-modeling/SKILL.md")],
    ["a ~-relative", () => "~/.agents/skills/domain-modeling/SKILL.md"],
    ["a cwd-relative", () => "../.agents/skills/domain-modeling/SKILL.md"],
  ])("resolves %s SKILL.md path to the skill in that folder", (_label, pathIn) => {
    const { home, roots } = makeSkillHome();
    expect(createProvenanceResolver(roots).byPath(pathIn(home))).toMatchObject({
      kind: "upstream",
      name: "domain-modeling",
      folder: "domain-modeling",
    });
  });

  it("labels a SKILL.md outside the skills and managed directories as unknown, named by its folder", () => {
    const { roots } = makeSkillHome();
    expect(
      createProvenanceResolver(roots).byPath(".agents/skills/admin-browser-testing/SKILL.md"),
    ).toEqual({ kind: "unknown", name: "admin-browser-testing" });
  });

  it.each([
    ["a plugin", "ce-code-review", "plugin"],
    ["a local", "ce-commit-jj", "local"],
  ])("resolves a byte-identical copy of %s skill outside the skill roots to the installed skill", (_label, name, kind) => {
    const { roots } = makeSkillHome();
    const resolver = createProvenanceResolver(roots);
    const installed = resolver.byName(name);
    if (installed.kind === "unknown") throw new Error(`${name} is not installed`);
    const copy = copySkillEntry(installed.path, join(roots.cwd, ".agents/skills", name));

    expect(resolver.byPath(copy)).toEqual(installed);
    expect(installed.kind).toBe(kind);
  });

  it("labels a copy of an installed skill that differs by one byte as unknown", () => {
    const { roots } = makeSkillHome();
    const resolver = createProvenanceResolver(roots);
    const installed = resolver.byName("ce-code-review");
    if (installed.kind === "unknown") throw new Error("ce-code-review is not installed");
    const copy = copySkillEntry(installed.path, join(roots.cwd, ".agents/skills/ce-code-review"), " ");

    expect(resolver.byPath(copy)).toEqual({ kind: "unknown", name: "ce-code-review" });
  });
});
