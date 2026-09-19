import { describe, expect, it } from "vitest";
import { generateProject, parseProject, validateProject, workspaceMembers } from "../src/index";

const AGENT = `import { defineAgent } from "eve";\n\nexport default defineAgent({\n  model: "openai/gpt-5.6-luna-fast",\n});\n`;

const workspace = [
  { path: "package.json", content: `{"name":"operations","type":"module"}\n` },
  { path: "agents/support/agent/agent.ts", content: AGENT },
  { path: "agents/support/agent/instructions.md", content: "# Support\n" },
  { path: "agents/research/agent/agent.ts", content: AGENT },
  { path: "agents/research/agent/instructions.md", content: "# Research\n" },
];

describe("workspaceMembers", () => {
  it("names the members of an agents/ workspace", () => {
    expect(workspaceMembers(workspace.map((file) => file.path))).toEqual(["research", "support"]);
  });

  it("ignores a directory that carries its own package.json", () => {
    const paths = [...workspace.map((file) => file.path), "agents/site/package.json", "agents/site/agent/agent.ts"];
    expect(workspaceMembers(paths)).toEqual(["research", "support"]);
  });

  it("is empty when a root agent/ directory takes precedence", () => {
    expect(workspaceMembers([...workspace.map((file) => file.path), "agent/instructions.md"])).toEqual([]);
  });
});

describe("a workspace project", () => {
  it("keeps every file and never writes a root agent/ that would hide the members", () => {
    const { project } = parseProject(workspace);
    const generated = generateProject(project);
    expect(generated.map((file) => file.path).sort()).toEqual(workspace.map((file) => file.path).sort());
  });

  it("is reported as a workspace rather than an agent missing instructions", () => {
    const issues = validateProject(parseProject(workspace).project);
    expect(issues).toContainEqual(expect.objectContaining({ level: "error", at: "agent" }));
    expect(issues.some((issue) => issue.at === "agent.instructions")).toBe(false);
  });
});
