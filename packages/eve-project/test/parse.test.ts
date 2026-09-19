import { describe, expect, it } from "vitest";
import { generateProject, getCanvasGraph, parseProject, validateProject } from "../src/index";
import { loadFixture } from "./fixtures";

describe("parseProject", () => {
  it("reads the nested layout and the name from package.json", () => {
    const { project } = parseProject(loadFixture("basic-agent"));
    expect(project.root).toBe("agent");
    expect(project.agent.name).toBe("support-triage");
    expect(project.agent.hasConfig).toBe(true);
    expect(project.agent.model).toEqual({ id: "openai/gpt-5.6-luna-fast" });
    expect(project.agent.instructions).toContain("Never promise a refund.");
  });

  it("keeps defineAgent options it has no control for, verbatim", () => {
    const { project } = parseProject(loadFixture("full-agent"));
    expect(project.agent.reasoning).toBe("high");
    expect(project.agent.raw.compaction).toBe("{\n    thresholdPercent: 0.95,\n  }");
  });

  it("reads tools, telling authored tools from built-ins", () => {
    const { project } = parseProject(loadFixture("full-agent"));
    expect(project.tools.map((tool) => [tool.id, tool.kind])).toEqual([
      ["search_docs", "tool"],
      ["web_search", "provided"],
    ]);
    expect(project.tools[0]?.description).toBe("Search the product docs index.");
  });

  it("reads markdown and packaged skills", () => {
    const { project } = parseProject(loadFixture("full-agent"));
    const [forecast, research] = project.skills;
    expect(forecast).toMatchObject({ id: "forecast", format: "markdown" });
    expect(forecast?.description).toBe("Use when the user asks about a forecast or temperature.");
    expect(research).toMatchObject({ id: "research", format: "package" });
    expect(research?.files.map((file) => file.path)).toEqual(["references/checklist.md"]);
  });

  it("describes a markdown skill without frontmatter by its first line, as Eve does", () => {
    const files = [...loadFixture("basic-agent"), { path: "agent/skills/tone.md", content: "\n# Keep it short\n\nBody.\n" }];
    expect(parseProject(files).project.skills[0]?.description).toBe("Keep it short");
  });

  it("reads a subagent directory with its own tools and skills", () => {
    const { project } = parseProject(loadFixture("full-agent"));
    const [researcher] = project.subagents;
    expect(researcher).toMatchObject({
      id: "researcher",
      kind: "local",
      description: "Investigate ambiguous questions before the parent agent responds.",
      model: { id: "anthropic/claude-opus-5" },
      hasInstructions: true,
    });
    expect(researcher?.tools.map((tool) => tool.id)).toEqual(["browse"]);
    expect(researcher?.skills.map((skill) => skill.id)).toEqual(["cite"]);
  });

  it("reads MCP and OpenAPI connections, including Vercel Connect auth and filters", () => {
    const { project } = parseProject(loadFixture("full-agent"));
    const [linear, petstore] = project.connections;
    expect(linear).toMatchObject({
      id: "linear",
      kind: "mcp",
      url: "https://mcp.linear.app/mcp",
      auth: "connect",
      connector: "mcp.linear.app/linear",
      filter: { mode: "allow", names: ["search_issues", "get_issue"] },
    });
    expect(petstore).toMatchObject({ id: "petstore", kind: "openapi", auth: "token" });
    expect(petstore?.spec).toBe("https://petstore3.swagger.io/api/v3/openapi.json");
  });

  it("reads channels and both schedule forms", () => {
    const { project } = parseProject(loadFixture("full-agent"));
    expect(project.channels.map((channel) => [channel.id, channel.kind])).toEqual([
      ["eve", "eve"],
      ["slack", "slack"],
    ]);
    expect(project.schedules).toMatchObject([
      { id: "cleanup", format: "markdown", cron: "0 0 * * 0", prompt: "Sweep stale research notes.", handler: false },
      { id: "digest", format: "module", cron: "0 9 * * 1-5", prompt: "Summarize new sources added yesterday." },
    ]);
  });

  it("reads the flat layout and a model set in code", () => {
    const { project } = parseProject(loadFixture("flat-agent"));
    expect(project.root).toBe("");
    expect(project.agent.model).toEqual({ id: "", expression: 'anthropic("claude-opus-5")' });
    expect(project.tools.map((tool) => tool.id)).toEqual(["get_weather"]);
  });

  it("warns instead of throwing on an agent.ts it cannot read", () => {
    const { project, warnings } = parseProject([
      { path: "agent/agent.ts", content: "const agent = 1;\n" },
      { path: "agent/instructions.md", content: "Hi.\n" },
    ]);
    expect(warnings[0]?.path).toBe("agent/agent.ts");
    expect(project.agent.hasConfig).toBe(true);
    expect(project.agent.model).toBeUndefined();
  });
});

describe("validateProject", () => {
  it("rejects a subagent without a description, as Eve's compiler does", () => {
    const files = loadFixture("full-agent").map((file) =>
      file.path === "agent/subagents/researcher/agent.ts"
        ? { ...file, content: 'import { defineAgent } from "eve";\n\nexport default defineAgent({\n  model: "anthropic/claude-opus-5",\n});\n' }
        : file,
    );
    const issues = validateProject(parseProject(files).project);
    expect(issues).toContainEqual(expect.objectContaining({ level: "error", at: "subagents.researcher.description" }));
  });

  it("rejects a schedule without a five-field cron", () => {
    const files = [...loadFixture("basic-agent"), { path: "agent/schedules/bad.md", content: "---\ncron: daily\n---\n\nRun.\n" }];
    const issues = validateProject(parseProject(files).project);
    expect(issues).toContainEqual(expect.objectContaining({ level: "error", at: "schedules.bad.cron" }));
  });

  it("rejects a project without root instructions", () => {
    const { project } = parseProject([{ path: "agent/agent.ts", content: 'import { defineAgent } from "eve";\n\nexport default defineAgent({\n  model: "a/b",\n});\n' }]);
    expect(validateProject(project)).toContainEqual(expect.objectContaining({ level: "error", at: "agent.instructions" }));
  });

  it("rejects traversing file paths", () => {
    const { project } = parseProject(loadFixture("basic-agent"));
    project.files.push({ path: "../outside.ts", content: "" });
    expect(validateProject(project).some((issue) => issue.level === "error")).toBe(true);
  });
});

describe("getCanvasGraph", () => {
  it("hangs a subagent's own capabilities off that subagent", () => {
    const { project } = parseProject(loadFixture("full-agent"));
    const graph = getCanvasGraph(project);
    expect(graph.nodes.map((node) => node.id)).toContain("tool:researcher/browse");
    expect(graph.edges).toContainEqual({ source: "subagent:researcher", target: "tool:researcher/browse", relation: "has tool" });
    expect(graph.edges).toContainEqual({ source: "agent", target: "connection:linear", relation: "connects to" });
    expect(graph.edges).not.toContainEqual(expect.objectContaining({ source: "agent", target: "tool:researcher/browse" }));
  });

  it("points every node at a file that exists", () => {
    const { project } = parseProject(loadFixture("full-agent"));
    const paths = new Set(project.files.map((file) => file.path));
    for (const node of getCanvasGraph(project).nodes) expect(paths.has(node.filePath)).toBe(true);
  });
});

/** The layout of vercel-labs/eve-sre-agent-template: instructions in a directory, an extension, memory and a sandbox. */
describe("eve template layouts", () => {
  const sre = [
    { path: "package.json", content: JSON.stringify({ name: "sre" }) },
    { path: "agent/agent.ts", content: 'import { defineAgent } from "eve";\n\nexport default defineAgent({\n  model: "openai/gpt-5.6-terra",\n});\n' },
    { path: "agent/instructions/date-and-time.ts", content: 'import { defineDynamic } from "eve/instructions";\n\nexport default defineDynamic({ events: {} });\n' },
    { path: "agent/instructions/instructions.md", content: "# Identity\n\nYou are sre.\n" },
    {
      path: "agent/extensions/github.ts",
      content: 'import githubExtension from "@github-tools/eve-extension";\nimport { GITHUB_CONNECTOR } from "#lib/constants.ts";\n\nexport default githubExtension({ connector: GITHUB_CONNECTOR });\n',
    },
    { path: "agent/memory/profile.ts", content: 'import { defineMemory } from "eve/memory";\n\nexport default defineMemory({\n  description: "Remember stable facts about the caller.",\n});\n' },
    { path: "agent/sandbox.ts", content: 'import { defineSandbox } from "eve/sandbox";\n\nexport default defineSandbox({});\n' },
  ];

  it("edits the markdown inside an instructions directory when there is no root file", () => {
    const { project } = parseProject(sre);
    expect(project.root).toBe("agent");
    expect(project.agent.instructionsPath).toBe("agent/instructions/instructions.md");
    expect(project.agent.instructions).toContain("You are sre.");
    expect(project.agent.instructionSources).toEqual(["agent/instructions/date-and-time.ts"]);
  });

  it("writes edited instructions back to the same file, never a new root file", () => {
    const { project } = parseProject(sre);
    project.agent.instructions = "# Identity\n\nYou are sre, on call.\n";
    const files = generateProject(project);
    const paths = files.map((file) => file.path);
    expect(paths).not.toContain("agent/instructions.md");
    expect(files.find((file) => file.path === "agent/instructions/instructions.md")?.content).toContain("on call");
    expect(paths).toContain("agent/instructions/date-and-time.ts");
  });

  it("never adds instructions.md beside instructions.ts, which Eve rejects", () => {
    const files = [
      { path: "package.json", content: JSON.stringify({ name: "factory" }) },
      { path: "agent/agent.ts", content: 'import { defineAgent } from "eve";\n\nexport default defineAgent({\n  model: "openai/gpt-5.6-terra",\n});\n' },
      { path: "agent/instructions.ts", content: 'import { defineInstructions } from "eve/instructions";\n\nexport default defineInstructions({ content: "x" });\n' },
    ];
    const { project } = parseProject(files);
    expect(project.agent.instructionSources).toEqual(["agent/instructions.ts"]);
    project.agent.instructions = "typed by mistake";
    expect(generateProject(project).map((file) => file.path)).not.toContain("agent/instructions.md");
  });

  it("reads extensions, memory and the sandbox, and passes their files through", () => {
    const { project } = parseProject(sre);
    expect(project.extensions).toEqual([
      expect.objectContaining({ id: "github", file: "agent/extensions/github.ts", package: "@github-tools/eve-extension" }),
    ]);
    expect(project.memory).toEqual([expect.objectContaining({ id: "profile", description: "Remember stable facts about the caller." })]);
    expect(project.sandbox).toBe("agent/sandbox.ts");
    const out = new Map(generateProject(project).map((file) => [file.path, file.content]));
    for (const file of sre) expect(out.get(file.path)).toBe(file.content);
  });
});

describe("schedules", () => {
  const base = [
    { path: "package.json", content: `{"name":"a","type":"module"}\n` },
    { path: "agent/instructions.md", content: "# A\n" },
  ];
  const schedule = (body: string) => [
    ...base,
    { path: "agent/schedules/digest.ts", content: `import { defineSchedule } from "eve/schedules";\n\nexport default defineSchedule({\n  cron: "0 9 * * 1",\n${body}});\n` },
  ];

  it("keeps a composed markdown prompt as an expression", () => {
    const { project } = parseProject(schedule(`  markdown: ["one", "two"].join("\\n\\n"),\n`));
    const [entry] = project.schedules;
    expect(entry?.prompt).toBe("");
    expect(entry?.promptExpression).toBe(`["one", "two"].join("\\n\\n")`);
    expect(validateProject(project).some((issue) => issue.at === "schedules.digest.prompt")).toBe(false);
  });

  it("reads a literal markdown prompt as text", () => {
    const { project } = parseProject(schedule(`  markdown: "Send the digest.",\n`));
    const [entry] = project.schedules;
    expect(entry?.prompt).toBe("Send the digest.");
    expect(entry?.promptExpression).toBeUndefined();
  });

  it("still warns when a module has neither a prompt nor a handler", () => {
    const { project } = parseProject(schedule(""));
    expect(validateProject(project)).toContainEqual(
      expect.objectContaining({ level: "warning", at: "schedules.digest.prompt" }),
    );
  });
});
