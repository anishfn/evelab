import { patchAgentSource, readAgentSource, readStringValue } from "./agent-source";
import { DEFAULT_AGENT_MODEL_ID, renderAgentConfig, renderSubagentConfig } from "./agent-template";
import { workspaceMembers } from "./layout";
import type { Connection, EveProject, ModelConfig, ProjectFile, Reasoning, Skill, Subagent, Tool } from "./types";

/**
 * Writes the project model back to real Eve files.
 *
 * Files the parser did not turn into entities (package.json, lib/, hooks/,
 * sandbox/, evals/, anything else) are passed through byte for byte. Entity
 * files are written from their verbatim source, and `agent.ts` configs are
 * patched in place, never regenerated.
 */
export function generateProject(project: EveProject): ProjectFile[] {
  const generated = new Set(project.generatedPaths);
  const output = new Map<string, string>();
  for (const file of project.files) {
    if (!generated.has(file.path)) output.set(file.path, file.content);
  }

  const base = project.root ? `${project.root}/` : "";
  const { agent } = project;

  if (agent.hasConfig) {
    output.set(`${base}agent.ts`, patchSettings(agent.source, agent));
  } else if (agent.model?.id) {
    // Choosing a model is what brings agent.ts into existence; until then Eve uses its default.
    output.set(`${base}agent.ts`, renderAgentConfig(agent.model.id, agent.reasoning));
  }

  const instructionsPath = agent.instructionsPath || `${base}instructions.md`;
  const hadInstructions = project.files.some((file) => file.path === instructionsPath);
  // Eve refuses instructions.md beside instructions.ts at the agent root, so code-authored instructions never get a markdown twin.
  const codeAuthored = !hadInstructions && project.files.some((file) => file.path === `${base}instructions.ts`) && instructionsPath === `${base}instructions.md`;
  // A workspace keeps its agents under agents/<name>/, and a root agent/ would hide every one of them from Eve.
  const isWorkspace = workspaceMembers(project.files.map((file) => file.path)).length > 0;
  if (!codeAuthored && !isWorkspace && (hadInstructions || agent.instructions.length > 0 || agent.instructionSources.length === 0)) {
    output.set(instructionsPath, agent.instructions);
  }

  // A new subagent without its own model runs on the root agent's, as eve init would configure it.
  writeCapabilities(output, base, project, agent.model?.id || DEFAULT_AGENT_MODEL_ID);
  for (const tool of project.library.tools) output.set(`${base}lib/tools/${tool.file}`, tool.source);
  for (const skill of project.library.skills) output.set(`${base}lib/skills/${skill.id}.ts`, skill.content);
  for (const connection of project.library.connections) output.set(`${base}lib/connections/${connection.file}`, connection.source);
  for (const channel of project.channels) output.set(`${base}channels/${channel.file}`, channel.source);
  for (const schedule of project.schedules) output.set(`${base}schedules/${schedule.file}`, schedule.source);

  return [...output.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

interface DesiredSettings {
  model?: ModelConfig;
  reasoning?: Reasoning;
  description?: string;
  raw: Record<string, string>;
}

/**
 * Brings a `defineAgent` module in line with the desired settings by patching
 * only the values that differ. Values the source computes (and so the parser
 * kept in `raw`) are never touched, and a module that cannot be read is
 * returned unchanged: it is the user's source of truth.
 */
export function patchSettings(source: string, desired: DesiredSettings): string {
  const config = readAgentSource(source);
  if (!config) return source;

  const patch: Record<string, string> = {};
  const remove: string[] = [];
  const literal = (name: string): string | undefined => {
    const text = config.properties.get(name)?.text;
    return text === undefined ? undefined : readStringValue(text);
  };

  if (desired.model && !desired.model.expression && desired.model.id && literal("model") !== desired.model.id) {
    patch.model = JSON.stringify(desired.model.id);
  }

  for (const key of ["reasoning", "description"] as const) {
    if (desired.raw[key] !== undefined) continue;
    const wanted = desired[key];
    const present = config.properties.has(key);
    if (wanted === undefined || wanted === "") {
      if (present) remove.push(key);
    } else if (literal(key) !== wanted) {
      patch[key] = JSON.stringify(wanted);
    }
  }

  if (Object.keys(patch).length === 0 && remove.length === 0) return source;
  try {
    return patchAgentSource(source, patch, remove);
  } catch {
    return source;
  }
}

interface CapabilityOwner {
  tools: Tool[];
  skills: Skill[];
  connections: Connection[];
  subagents: Subagent[];
}

/** The repository path of a skill's defining file. */
export function skillFilePath(base: string, skill: Skill): string {
  switch (skill.format) {
    case "markdown":
      return `${base}skills/${skill.id}.md`;
    case "module":
      return `${base}skills/${skill.id}.ts`;
    case "package":
      return `${base}skills/${skill.id}/SKILL.md`;
  }
}

function writeCapabilities(output: Map<string, string>, base: string, owner: CapabilityOwner, fallbackModel: string): void {
  for (const tool of owner.tools) output.set(`${base}tools/${tool.file}`, tool.source);

  for (const skill of owner.skills) {
    output.set(skillFilePath(base, skill), skill.content);
    if (skill.format === "package") {
      for (const file of skill.files) output.set(`${base}skills/${skill.id}/${file.path}`, file.content);
    }
  }

  for (const connection of owner.connections) output.set(`${base}connections/${connection.file}`, connection.source);

  for (const subagent of owner.subagents) {
    if (subagent.kind === "remote") {
      output.set(`${base}subagents/${subagent.id}.ts`, subagent.source);
      continue;
    }
    const dir = `${base}subagents/${subagent.id}/`;
    output.set(
      `${dir}agent.ts`,
      subagent.source
        ? patchSettings(subagent.source, subagent)
        : renderSubagentConfig(subagent.description, subagent.model?.id || fallbackModel, subagent.reasoning),
    );
    if (subagent.hasInstructions || subagent.instructions.length > 0) {
      output.set(`${dir}instructions.md`, subagent.instructions);
    }
    writeCapabilities(output, dir, subagent, fallbackModel);
  }
}
