import { z } from "zod";

/**
 * The evelab project model.
 *
 * This is NOT a replacement for Eve's own representation. It is a lossless view
 * of a real Eve project (https://eve.dev/docs/getting-started#project-layout),
 * used to translate between GUI state and files on disk. Every entity keeps the
 * verbatim source of the file that defines it, and anything evelab does not
 * model is carried through untouched, so a round trip never drops information.
 */

export const filePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
    message: "Project paths must be relative and must not traverse upwards",
  });

export const projectFileSchema = z.object({
  path: filePathSchema,
  content: z.string(),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

/**
 * Where the agent lives in the repository. Eve's recommended layout keeps it in
 * `agent/`; the flat layout puts the same slots at the package root.
 */
export const agentRootSchema = z.enum(["agent", ""]);
export type AgentRoot = z.infer<typeof agentRootSchema>;

/** Eve derives names from file paths, so ids are file or directory stems. */
export const slugSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use letters, digits, - and _");

export const reasoningSchema = z.enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"]);
export type Reasoning = z.infer<typeof reasoningSchema>;

export const modelConfigSchema = z.object({
  /** AI Gateway model id exactly as written, e.g. "anthropic/claude-sonnet-5". Empty when computed in code. */
  id: z.string().default(""),
  /**
   * Verbatim source of `model` when it is not a string literal: a provider model
   * such as `anthropic("...")`, `chatgpt()`, or `defineDynamic(...)`. Read-only in the GUI.
   */
  expression: z.string().optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const toolKindSchema = z.enum(["tool", "workflow", "provided", "disabled", "dynamic", "other"]);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const toolSchema = z.object({
  /** File stem under `tools/`, which is the name the model sees. */
  id: slugSchema,
  /** File name within `tools/`, extension included. */
  file: z.string(),
  description: z.string().default(""),
  kind: toolKindSchema,
  source: z.string(),
  /**
   * The shared definition this slot file re-exports, by name under `lib/tools/`.
   * Absent for a tool defined in place.
   */
  shared: z.string().optional(),
});
export type Tool = z.infer<typeof toolSchema>;

export const skillFormatSchema = z.enum(["markdown", "package", "module"]);
export type SkillFormat = z.infer<typeof skillFormatSchema>;

export const skillSchema = z.object({
  id: slugSchema,
  /** `skills/<id>.md`, `skills/<id>/SKILL.md` with siblings, or a `skills/<id>.ts` module. */
  format: skillFormatSchema,
  description: z.string().default(""),
  /** The markdown file, the package's SKILL.md, or the module source. */
  content: z.string(),
  /** Package siblings (references, assets, scripts), relative to the skill directory. */
  files: z.array(projectFileSchema).default([]),
  /** The shared definition this skill module re-exports, by name under `lib/skills/`. */
  shared: z.string().optional(),
});
export type Skill = z.infer<typeof skillSchema>;

export const connectionKindSchema = z.enum(["mcp", "openapi", "dynamic", "other"]);
export type ConnectionKind = z.infer<typeof connectionKindSchema>;

export const connectionAuthSchema = z.enum(["none", "connect", "token", "custom"]);
export type ConnectionAuth = z.infer<typeof connectionAuthSchema>;

export const connectionSchema = z.object({
  /** File stem under `connections/`; remote tools are called `<id>__<tool>`. */
  id: slugSchema,
  file: z.string(),
  kind: connectionKindSchema,
  description: z.string().default(""),
  /** MCP endpoint, when written as a string literal. */
  url: z.string().optional(),
  /** OpenAPI document URL, when written as a string literal. */
  spec: z.string().optional(),
  auth: connectionAuthSchema,
  /** Vercel Connect connector UID from `connect("...")`. */
  connector: z.string().optional(),
  filter: z.object({ mode: z.enum(["allow", "block"]), names: z.array(z.string()) }).optional(),
  source: z.string(),
  /** The shared definition this slot file re-exports, by name under `lib/connections/`. */
  shared: z.string().optional(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const channelKindSchema = z.enum([
  "eve",
  "slack",
  "discord",
  "teams",
  "telegram",
  "twilio",
  "github",
  "linear",
  "linq",
  "photon",
  "mcp",
  "chat-sdk",
  "custom",
  "disabled",
  "other",
]);
export type ChannelKind = z.infer<typeof channelKindSchema>;

export const channelSchema = z.object({
  /** File stem under `channels/`; the channel id. */
  id: slugSchema,
  file: z.string(),
  kind: channelKindSchema,
  source: z.string(),
});
export type Channel = z.infer<typeof channelSchema>;

export const scheduleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_\-/]*$/);

export const scheduleSchema = z.object({
  /** Path under `schedules/` without the extension; nested names keep their `/`. */
  id: scheduleIdSchema,
  /** Path under `schedules/`, extension included. */
  file: z.string(),
  format: z.enum(["markdown", "module"]),
  cron: z.string().default(""),
  /** The prompt of a markdown schedule or a `markdown:` module. Empty for a handler, or when the module composes it. */
  prompt: z.string().default(""),
  /** Verbatim source of `markdown` when it is not a string literal, such as a joined array. Read-only in the GUI. */
  promptExpression: z.string().optional(),
  /** A module schedule with a `run` handler instead of a prompt. */
  handler: z.boolean().default(false),
  source: z.string(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

export interface Subagent {
  /** Directory name under `subagents/`, or the file stem of a remote agent. */
  id: string;
  /** A declared local subagent directory, or a single-file remote or workspace agent. */
  kind: "local" | "remote";
  description: string;
  model?: ModelConfig;
  reasoning?: Reasoning;
  raw: Record<string, string>;
  /** agent.ts of a local subagent, or the remote agent module. Empty for one evelab has not written yet. */
  source: string;
  instructions: string;
  hasInstructions: boolean;
  tools: Tool[];
  skills: Skill[];
  connections: Connection[];
  subagents: Subagent[];
}

export const subagentSchema: z.ZodType<Subagent, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    id: slugSchema,
    kind: z.enum(["local", "remote"]),
    description: z.string().default(""),
    model: modelConfigSchema.optional(),
    reasoning: reasoningSchema.optional(),
    raw: z.record(z.string()).default({}),
    source: z.string().default(""),
    instructions: z.string().default(""),
    hasInstructions: z.boolean().default(false),
    tools: z.array(toolSchema).default([]),
    skills: z.array(skillSchema).default([]),
    connections: z.array(connectionSchema).default([]),
    subagents: z.array(subagentSchema).default([]),
  }),
);

/** A mounted extension: `agent/extensions/<id>.ts`, usually wrapping an npm package. */
export const extensionSchema = z.object({
  id: slugSchema,
  /** Repository path of the mount file. */
  file: z.string(),
  /** The package the mount imports, when it names one. */
  package: z.string().optional(),
  source: z.string(),
});
export type Extension = z.infer<typeof extensionSchema>;

/** A memory slot: `agent/memory/<id>.ts` declared with defineMemory. */
export const memorySlotSchema = z.object({
  id: slugSchema,
  file: z.string(),
  description: z.string().default(""),
  source: z.string(),
});
export type MemorySlot = z.infer<typeof memorySlotSchema>;

export const agentConfigSchema = z.object({
  /** The root agent's name: package.json `name`, or the directory name. Eve derives it; evelab only shows it. */
  name: z.string().min(1),
  /** Whether `agent.ts` exists. Without it Eve uses its default model. */
  hasConfig: z.boolean(),
  model: modelConfigSchema.optional(),
  reasoning: reasoningSchema.optional(),
  description: z.string().optional(),
  /** Config keys evelab has no control for, mapped to their verbatim source text. */
  raw: z.record(z.string()).default({}),
  /** Verbatim agent.ts, kept so edits patch it rather than regenerate it. */
  source: z.string().default(""),
  /** Contents of the markdown instructions evelab edits, at `instructionsPath`. */
  instructions: z.string().default(""),
  /**
   * Repository path of the markdown instructions evelab edits: the root instructions.md when there
   * is one, otherwise the first markdown entry of instructions/. Empty means the root instructions.md.
   */
  instructionsPath: z.string().default(""),
  /** Other instruction sources evelab shows but does not edit: instructions.ts and the other instructions/ entries. */
  instructionSources: z.array(z.string()).default([]),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/**
 * Canonical definitions that several agents use. Eve gives each declared
 * subagent only what lives in its own directory, and shares code through
 * `lib/`, so a shared resource is defined once under `lib/<kind>/` and every
 * agent that uses it gets a one-line re-export in its own slot.
 */
export const librarySchema = z.object({
  tools: z.array(toolSchema).default([]),
  skills: z.array(skillSchema).default([]),
  connections: z.array(connectionSchema).default([]),
});
export type Library = z.infer<typeof librarySchema>;

export const eveProjectSchema = z.object({
  root: agentRootSchema,
  agent: agentConfigSchema,
  tools: z.array(toolSchema).default([]),
  skills: z.array(skillSchema).default([]),
  subagents: z.array(subagentSchema).default([]),
  connections: z.array(connectionSchema).default([]),
  channels: z.array(channelSchema).default([]),
  schedules: z.array(scheduleSchema).default([]),
  /** Mounted extensions. Read only: their files pass through untouched. */
  extensions: z.array(extensionSchema).default([]),
  /** Memory slots. Read only. */
  memory: z.array(memorySlotSchema).default([]),
  /** Repository path of the sandbox definition, when the agent replaces the default sandbox. */
  sandbox: z.string().optional(),
  library: librarySchema.default({ tools: [], skills: [], connections: [] }),
  /**
   * Every file of the source project, including ones evelab does not interpret
   * (package.json, lib/, hooks/, sandbox/, evals/, lockfiles). Generation
   * re-emits these untouched, which keeps import, edit and export non-destructive.
   */
  files: z.array(projectFileSchema).default([]),
  /**
   * The source files the parser turned into model entities. Generation owns
   * exactly these plus whatever the model now holds, so a deleted tool's file
   * disappears and every other file passes through.
   */
  generatedPaths: z.array(z.string()).default([]),
});
export type EveProject = z.infer<typeof eveProjectSchema>;
