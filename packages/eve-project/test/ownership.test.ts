import { describe, expect, it } from "vitest";
import {
  applyOwnershipChange,
  generateProject,
  OwnershipError,
  parseProject,
  removeEntities,
  removeEntity,
  type ProjectFile,
} from "../src/index";
import { loadFixture } from "./fixtures";

function load() {
  const files = loadFixture("full-agent");
  return { files, project: parseProject(files).project };
}

function diff(before: ProjectFile[], after: ProjectFile[]): { added: string[]; removed: string[]; changed: string[] } {
  const original = new Map(before.map((file) => [file.path, file.content]));
  const next = new Map(after.map((file) => [file.path, file.content]));
  return {
    added: [...next.keys()].filter((path) => !original.has(path)).sort(),
    removed: [...original.keys()].filter((path) => !next.has(path)).sort(),
    changed: [...next.keys()].filter((path) => original.has(path) && original.get(path) !== next.get(path)).sort(),
  };
}

describe("ownership", () => {
  it("hands a tool to a subagent by moving its file into the subagent's directory", () => {
    const { files, project } = load();
    const next = applyOwnershipChange(project, { capability: "tool:search_docs", to: "subagent:researcher" });

    expect(next.tools.map((tool) => tool.id)).toEqual(["web_search"]);
    expect(next.subagents[0]?.tools.map((tool) => tool.id)).toEqual(["browse", "search_docs"]);
    expect(diff(files, generateProject(next))).toEqual({
      added: ["agent/subagents/researcher/tools/search_docs.ts"],
      removed: ["agent/tools/search_docs.ts"],
      changed: [],
    });
  });

  it("hands a subagent's skill back to the agent", () => {
    const { files, project } = load();
    const next = applyOwnershipChange(project, { capability: "skill:researcher/cite", to: "agent" });
    expect(diff(files, generateProject(next))).toEqual({
      added: ["agent/skills/cite.md"],
      removed: ["agent/subagents/researcher/skills/cite.md"],
      changed: [],
    });
  });

  it("moves a packaged skill with all of its files", () => {
    const { project } = load();
    const next = applyOwnershipChange(project, { capability: "skill:research", to: "subagent:researcher" });
    const paths = generateProject(next).map((file) => file.path);
    expect(paths).toContain("agent/subagents/researcher/skills/research/references/checklist.md");
    expect(paths.some((path) => path.startsWith("agent/skills/research/"))).toBe(false);
  });

  it("treats a move to the current owner as no change", () => {
    const { files, project } = load();
    const next = applyOwnershipChange(project, { capability: "tool:researcher/browse", to: "subagent:researcher" });
    expect(generateProject(next)).toEqual(files);
  });

  it("refuses a move that would collide with an existing name", () => {
    const { project } = load();
    const withBrowse = applyOwnershipChange(project, { capability: "tool:researcher/browse", to: "agent" });
    withBrowse.subagents[0]!.tools.push({ ...withBrowse.tools.find((tool) => tool.id === "browse")!, file: "browse.ts" });
    expect(() => applyOwnershipChange(withBrowse, { capability: "tool:browse", to: "subagent:researcher" })).toThrow(
      OwnershipError,
    );
  });

  it("refuses to move a file that imports others by relative path", () => {
    const files = loadFixture("full-agent").map((file) =>
      file.path === "agent/tools/search_docs.ts"
        ? { ...file, content: `import { cite } from "../lib/format";\n${file.content}` }
        : file,
    );
    const { project } = parseProject(files);
    expect(() => applyOwnershipChange(project, { capability: "tool:search_docs", to: "subagent:researcher" })).toThrow(
      /relative path/,
    );
  });

  it("does not mutate the project it is given", () => {
    const { project } = load();
    const before = structuredClone(project);
    applyOwnershipChange(project, { capability: "connection:linear", to: "subagent:researcher" });
    expect(project).toEqual(before);
  });

  it("removes an entity anywhere in the tree, with only its files", () => {
    const { files, project } = load();
    const next = removeEntity(removeEntity(project, "tool:researcher/browse"), "connection:linear");
    expect(diff(files, generateProject(next))).toEqual({
      added: [],
      removed: ["agent/connections/linear.ts", "agent/subagents/researcher/tools/browse.ts"],
      changed: [],
    });
    const paths = generateProject(removeEntity(project, "subagent:researcher")).map((file) => file.path);
    expect(paths.some((path) => path.startsWith("agent/subagents/researcher/"))).toBe(false);
    expect(() => removeEntity(project, "tool:ghost")).toThrow(OwnershipError);
  });

  it("removes a selection in one pass, skipping what a removed subagent already takes", () => {
    const { files, project } = load();
    const next = removeEntities(project, ["tool:researcher/browse", "subagent:researcher", "connection:linear", "connection:linear"]);
    const paths = generateProject(next).map((file) => file.path);
    expect(paths.some((path) => path.startsWith("agent/subagents/researcher/"))).toBe(false);
    expect(paths).not.toContain("agent/connections/linear.ts");
    expect(diff(files, generateProject(next)).added).toEqual([]);
    expect(() => removeEntities(project, ["tool:ghost"])).toThrow(OwnershipError);
  });

  it("rejects owners and capabilities that do not exist", () => {
    const { project } = load();
    expect(() => applyOwnershipChange(project, { capability: "tool:search_docs", to: "subagent:ghost" })).toThrow(OwnershipError);
    expect(() => applyOwnershipChange(project, { capability: "tool:nope", to: "agent" })).toThrow(OwnershipError);
    expect(() => applyOwnershipChange(project, { capability: "subagent:researcher", to: "agent" })).toThrow(OwnershipError);
  });
});
