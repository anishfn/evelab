import { parseFrontmatter } from "./frontmatter";
import {
  readAgentSource,
  readConnectorValue,
  readDefinitionCallee,
  readFilterValue,
  readImports,
  readStringProperty,
  readStringValue,
} from "./agent-source";
import { detectAgentRoot, hashImportBase, resolveRelative } from "./layout";
import {
  eveProjectSchema,
  reasoningSchema,
  scheduleIdSchema,
  slugSchema,
  type Channel,
  type ChannelKind,
  type Connection,
  type ConnectionAuth,
  type ConnectionKind,
  type EveProject,
  type Extension,
  type MemorySlot,
  type ModelConfig,
  type ProjectFile,
  type Reasoning,
  type Schedule,
  type Skill,
  type Subagent,
  type Tool,
  type ToolKind,
} from "./types";

export interface ParseWarning {
  path: string;
  message: string;
}

export interface ParseResult {
  project: EveProject;
  warnings: ParseWarning[];
}

export interface ParseOptions {
  /** The agent name when package.json has none, usually the project directory name. */
  fallbackName?: string;
}

const MODULE = /\.(?:ts|mts|js|mjs)$/;
const NOT_A_DEFINITION = /\.(?:test|spec|d)\.(?:ts|mts|js|mjs)$/;

interface Context {
  contents: Map<string, string>;
  paths: string[];
  claimed: Set<string>;
  warnings: ParseWarning[];
  /** The agent root, such as "agent/", which `lib/` sits under. */
  agentBase: string;
  /** Where `#` imports resolve, or undefined without an imports map. */
  hashBase?: string;
}

interface Settings {
  model?: ModelConfig;
  reasoning?: Reasoning;
  description?: string;
  raw: Record<string, string>;
}

/** Turns the files of a real Eve project into the evelab project model. */
export function parseProject(files: ProjectFile[], options: ParseOptions = {}): ParseResult {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const paths = [...contents.keys()];
  const root = detectAgentRoot(paths);
  const base = root ? `${root}/` : "";
  const context: Context = {
    contents,
    paths,
    claimed: new Set(),
    warnings: [],
    agentBase: base,
    hashBase: hashImportBase(contents.get("package.json")),
  };

  const configPath = `${base}agent.ts`;
  const configSource = contents.get(configPath);
  if (configSource !== undefined) context.claimed.add(configPath);
  const settings = readSettings(configSource, configPath, context.warnings);

  // Eve reads instructions.md (or .ts) at the agent root, then the entries of instructions/ in filename order.
  // evelab edits one markdown file: the root one, or the first markdown entry when only the directory exists.
  const instructionsDir = `${base}instructions/`;
  const instructionEntries = paths
    .filter((path) => path.startsWith(instructionsDir) && !path.slice(instructionsDir.length).includes("/"))
    .sort((a, b) => a.localeCompare(b));
  const rootInstructions = `${base}instructions.md`;
  const instructionsPath = contents.has(rootInstructions)
    ? rootInstructions
    : (instructionEntries.find((path) => path.endsWith(".md")) ?? rootInstructions);
  const instructions = contents.get(instructionsPath);
  if (instructions !== undefined) context.claimed.add(instructionsPath);

  const project = eveProjectSchema.parse({
    root,
    agent: {
      name: packageName(contents) ?? options.fallbackName ?? "agent",
      hasConfig: configSource !== undefined,
      ...settings,
      source: configSource ?? "",
      instructions: instructions ?? "",
      instructionsPath,
      instructionSources: paths
        .filter((path) => (path === `${base}instructions.ts` || path.startsWith(instructionsDir)) && path !== instructionsPath)
        .sort(),
    },
    tools: readTools(context, base),
    skills: readSkills(context, base),
    subagents: readSubagents(context, base),
    connections: readConnections(context, base),
    channels: readChannels(context, base),
    schedules: readSchedules(context, base),
    extensions: readExtensions(context, base),
    memory: readMemory(context, base),
    sandbox: [`${base}sandbox.ts`, `${base}sandbox/sandbox.ts`].find((path) => contents.has(path)),
    library: readLibrary(context, base),
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    generatedPaths: [...context.claimed].sort(),
  });

  linkShared(project, project, base, context.warnings);
  return { project, warnings: context.warnings };
}

function packageName(contents: Map<string, string>): string | undefined {
  const text = contents.get("package.json");
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const name = typeof parsed === "object" && parsed !== null ? (parsed as { name?: unknown }).name : undefined;
    return typeof name === "string" && name.trim() ? name : undefined;
  } catch {
    return undefined;
  }
}

function readSettings(source: string | undefined, path: string, warnings: ParseWarning[]): Settings {
  if (source === undefined) return { raw: {} };
  const config = readAgentSource(source);
  if (!config) {
    warnings.push({ path, message: "No defineAgent config object was found, so its settings are read-only here." });
    return { raw: {} };
  }

  const settings: Settings = { raw: {} };
  for (const [name, property] of config.properties) {
    const literal = readStringValue(property.text);
    if (name === "model") {
      settings.model = literal !== undefined ? { id: literal } : { id: "", expression: property.text };
    } else if (name === "reasoning" && literal !== undefined && reasoningSchema.safeParse(literal).success) {
      settings.reasoning = literal as Reasoning;
    } else if (name === "description" && literal !== undefined) {
      settings.description = literal;
    } else {
      settings.raw[name] = property.text;
    }
  }
  return settings;
}

/** Direct files of a directory, and the names of its subdirectories. */
function listDirectory(paths: string[], dir: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(dir)) continue;
    const rest = path.slice(dir.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.push(path);
    else dirs.add(rest.slice(0, slash));
  }
  return { files: files.sort(), dirs: [...dirs].sort() };
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stem(path: string): string {
  return fileName(path).replace(/\.[^.]+$/, "");
}

function isDefinitionModule(path: string): boolean {
  return MODULE.test(path) && !NOT_A_DEFINITION.test(path);
}

function isSlug(value: string): boolean {
  return slugSchema.safeParse(value).success;
}

const REEXPORT = /^export\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']\s*;?$/;

/**
 * The shared definition a slot file re-exports, when the whole file is
 * `export { default } from "<lib path>"`. Accepts the `#` import map and
 * relative paths, and only paths that land in `lib/<kind>/`.
 */
function sharedName(context: Context, filePath: string, source: string, kind: "tools" | "skills" | "connections"): string | undefined {
  const code = source.replace(/^\s*(?:\/\/[^\n]*\n\s*)*/, "").trim();
  const specifier = REEXPORT.exec(code)?.[1];
  if (!specifier) return undefined;
  const bare = specifier.replace(/\.(?:ts|mts|js|mjs)$/, "");
  let target: string | undefined;
  if (bare.startsWith("#") && context.hashBase !== undefined) target = `${context.hashBase}${bare.slice(1)}`;
  else if (bare.startsWith(".")) target = resolveRelative(filePath.slice(0, filePath.lastIndexOf("/")), bare);
  const prefix = `${context.agentBase}lib/${kind}/`;
  if (!target?.startsWith(prefix)) return undefined;
  const name = target.slice(prefix.length);
  return isSlug(name) ? name : undefined;
}

const PROVIDED_TOOL_MODULE = /^eve\/tools\/(?!approval$)[a-z_]+$/;

function toolKind(source: string): ToolKind {
  switch (readDefinitionCallee(source)) {
    case "defineTool":
      return "tool";
    case "defineWorkflowTool":
      return "workflow";
    case "disableTool":
      return "disabled";
    case "defineDynamic":
      return "dynamic";
    default:
      return readImports(source).some((specifier) => PROVIDED_TOOL_MODULE.test(specifier)) ? "provided" : "other";
  }
}

function readTools(context: Context, base: string): Tool[] {
  const tools: Tool[] = [];
  for (const path of listDirectory(context.paths, `${base}tools/`).files) {
    if (!isDefinitionModule(path)) continue;
    const id = stem(path);
    if (!isSlug(id)) {
      context.warnings.push({ path, message: "Tool file names use letters, digits, - and _; this file is left as is." });
      continue;
    }
    const source = context.contents.get(path) ?? "";
    context.claimed.add(path);
    const shared = sharedName(context, path, source, "tools");
    tools.push({
      id,
      file: fileName(path),
      description: shared ? "" : (readStringProperty(source, "description") ?? ""),
      kind: shared ? "tool" : toolKind(source),
      source,
      shared,
    });
  }
  return tools;
}

/**
 * A flat markdown skill without `description` frontmatter advertises its first
 * non-empty, non-fence body line with any leading `#`, `>`, `*` or `-` removed.
 */
export function markdownSkillDescription(markdown: string): string {
  const { data, body } = parseFrontmatter(markdown);
  if (typeof data.description === "string" && data.description) return data.description;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("```")) continue;
    return trimmed.replace(/^[#>*-]+\s*/, "");
  }
  return "";
}

function readSkills(context: Context, base: string): Skill[] {
  const dir = `${base}skills/`;
  const { files, dirs } = listDirectory(context.paths, dir);
  const skills: Skill[] = [];

  for (const path of files) {
    const id = stem(path);
    const content = context.contents.get(path) ?? "";
    const format = path.endsWith(".md") ? "markdown" : isDefinitionModule(path) ? "module" : undefined;
    if (!format) continue;
    if (!isSlug(id)) {
      context.warnings.push({ path, message: "Skill names use letters, digits, - and _; this file is left as is." });
      continue;
    }
    context.claimed.add(path);
    const shared = format === "module" ? sharedName(context, path, content, "skills") : undefined;
    skills.push({
      id,
      format,
      description: shared
        ? ""
        : format === "markdown"
          ? markdownSkillDescription(content)
          : (readStringProperty(content, "description") ?? ""),
      content,
      files: [],
      shared,
    });
  }

  for (const id of dirs) {
    const prefix = `${dir}${id}/`;
    const skillPath = `${prefix}SKILL.md`;
    const markdown = context.contents.get(skillPath);
    if (markdown === undefined || !isSlug(id)) {
      context.warnings.push({ path: prefix, message: "A packaged skill needs a SKILL.md; these files are left as is." });
      continue;
    }
    const siblings = context.paths.filter((path) => path.startsWith(prefix) && path !== skillPath).sort();
    for (const path of [skillPath, ...siblings]) context.claimed.add(path);
    const { data } = parseFrontmatter(markdown);
    skills.push({
      id,
      format: "package",
      description: typeof data.description === "string" ? data.description : "",
      content: markdown,
      files: siblings.map((path) => ({ path: path.slice(prefix.length), content: context.contents.get(path) ?? "" })),
    });
  }

  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function connectionKind(source: string): ConnectionKind {
  switch (readDefinitionCallee(source)) {
    case "defineMcpClientConnection":
      return "mcp";
    case "defineOpenAPIConnection":
      return "openapi";
    case "defineDynamic":
      return "dynamic";
    default:
      return "other";
  }
}

function readConnections(context: Context, base: string): Connection[] {
  const connections: Connection[] = [];
  for (const path of listDirectory(context.paths, `${base}connections/`).files) {
    if (!isDefinitionModule(path)) continue;
    const id = stem(path);
    if (!isSlug(id)) continue;
    const source = context.contents.get(path) ?? "";
    context.claimed.add(path);
    const shared = sharedName(context, path, source, "connections");
    if (shared) {
      connections.push({ id, file: fileName(path), kind: "other", description: "", auth: "none", source, shared });
      continue;
    }
    connections.push(connectionFromSource(id, fileName(path), source));
  }
  return connections;
}

function connectionFromSource(id: string, file: string, source: string): Connection {
  {
    const kind = connectionKind(source);
    const config = readAgentSource(source);
    const authText = config?.properties.get("auth")?.text;
    const auth: ConnectionAuth =
      authText === undefined
        ? config?.properties.has("headers")
          ? "custom"
          : "none"
        : /^connect\s*\(/.test(authText)
          ? "connect"
          : /getToken/.test(authText)
            ? "token"
            : "custom";
    const filterText = config?.properties.get(kind === "openapi" ? "operations" : "tools")?.text;

    return {
      id,
      file,
      kind,
      description: readStringProperty(source, "description") ?? "",
      url: readStringProperty(source, "url"),
      spec: readStringProperty(source, "spec"),
      auth,
      connector: auth === "connect" && authText ? readConnectorValue(authText) : undefined,
      filter: filterText ? readFilterValue(filterText) : undefined,
      source,
    };
  }
}

const LIBRARY_TOOL_CALLEES = new Set(["defineTool", "defineWorkflowTool", "defineDynamic"]);
const LIBRARY_CONNECTION_CALLEES = new Set(["defineMcpClientConnection", "defineOpenAPIConnection", "defineDynamic"]);

/**
 * Shared definitions under `lib/tools/`, `lib/skills/` and `lib/connections/`.
 * Only modules that define a tool, skill or connection are read; any other
 * helper in those folders stays an ordinary file.
 */
function readLibrary(context: Context, base: string): { tools: Tool[]; skills: Skill[]; connections: Connection[] } {
  const library = { tools: [] as Tool[], skills: [] as Skill[], connections: [] as Connection[] };
  const modules = (kind: string) =>
    listDirectory(context.paths, `${base}lib/${kind}/`).files.filter((path) => isDefinitionModule(path) && isSlug(stem(path)));

  for (const path of modules("tools")) {
    const source = context.contents.get(path) ?? "";
    if (!LIBRARY_TOOL_CALLEES.has(readDefinitionCallee(source) ?? "")) continue;
    context.claimed.add(path);
    library.tools.push({ id: stem(path), file: fileName(path), description: readStringProperty(source, "description") ?? "", kind: toolKind(source), source });
  }
  for (const path of modules("skills")) {
    const source = context.contents.get(path) ?? "";
    if (readDefinitionCallee(source) !== "defineSkill" || !path.endsWith(".ts")) continue;
    context.claimed.add(path);
    library.skills.push({ id: stem(path), format: "module", description: readStringProperty(source, "description") ?? "", content: source, files: [] });
  }
  for (const path of modules("connections")) {
    const source = context.contents.get(path) ?? "";
    if (!LIBRARY_CONNECTION_CALLEES.has(readDefinitionCallee(source) ?? "")) continue;
    context.claimed.add(path);
    library.connections.push(connectionFromSource(stem(path), fileName(path), source));
  }
  return library;
}

interface SharedOwner {
  tools: Tool[];
  skills: Skill[];
  connections: Connection[];
  subagents: Subagent[];
}

/** Fills each re-export with what its shared definition says, and warns about ones that point nowhere. */
function linkShared(
  project: { library: { tools: Tool[]; skills: Skill[]; connections: Connection[] } },
  owner: SharedOwner,
  base: string,
  warnings: ParseWarning[],
): void {
  const missing = (kind: string, name: string) =>
    warnings.push({ path: `${base}lib/${kind}/${name}`, message: `Something re-exports a shared ${kind.slice(0, -1)} "${name}" that does not exist.` });
  for (const tool of owner.tools) {
    if (!tool.shared) continue;
    const definition = project.library.tools.find((entry) => entry.id === tool.shared);
    if (definition) Object.assign(tool, { description: definition.description, kind: definition.kind });
    else missing("tools", tool.shared);
  }
  for (const skill of owner.skills) {
    if (!skill.shared) continue;
    const definition = project.library.skills.find((entry) => entry.id === skill.shared);
    if (definition) skill.description = definition.description;
    else missing("skills", skill.shared);
  }
  for (const connection of owner.connections) {
    if (!connection.shared) continue;
    const definition = project.library.connections.find((entry) => entry.id === connection.shared);
    if (definition) {
      const { kind, description, url, spec, auth, connector, filter } = definition;
      Object.assign(connection, { kind, description, url, spec, auth, connector, filter });
    } else {
      missing("connections", connection.shared);
    }
  }
  for (const subagent of owner.subagents) if (subagent.kind === "local") linkShared(project, subagent, base, warnings);
}

function readSubagents(context: Context, base: string): Subagent[] {
  const dir = `${base}subagents/`;
  const { files, dirs } = listDirectory(context.paths, dir);
  const subagents: Subagent[] = [];

  for (const id of dirs) {
    const nodeBase = `${dir}${id}/`;
    const configPath = `${nodeBase}agent.ts`;
    const source = context.contents.get(configPath);
    if (source === undefined || !isSlug(id)) {
      context.warnings.push({ path: nodeBase, message: "A subagent directory needs an agent.ts; these files are left as is." });
      continue;
    }
    context.claimed.add(configPath);
    const settings = readSettings(source, configPath, context.warnings);
    const instructionsPath = `${nodeBase}instructions.md`;
    const instructions = context.contents.get(instructionsPath);
    if (instructions !== undefined) context.claimed.add(instructionsPath);

    subagents.push({
      id,
      kind: "local",
      description: settings.description ?? "",
      model: settings.model,
      reasoning: settings.reasoning,
      raw: settings.raw,
      source,
      instructions: instructions ?? "",
      hasInstructions: instructions !== undefined,
      tools: readTools(context, nodeBase),
      skills: readSkills(context, nodeBase),
      connections: readConnections(context, nodeBase),
      subagents: readSubagents(context, nodeBase),
    });
  }

  for (const path of files) {
    if (!isDefinitionModule(path)) continue;
    const id = stem(path);
    if (!isSlug(id)) continue;
    const source = context.contents.get(path) ?? "";
    context.claimed.add(path);
    subagents.push({
      id,
      kind: "remote",
      description: readStringProperty(source, "description") ?? "",
      raw: {},
      source,
      instructions: "",
      hasInstructions: false,
      tools: [],
      skills: [],
      connections: [],
      subagents: [],
    });
  }

  return subagents.sort((a, b) => a.id.localeCompare(b.id));
}

const PLATFORM_CHANNELS: ReadonlySet<string> = new Set([
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
]);

function channelKind(source: string): ChannelKind {
  const callee = readDefinitionCallee(source);
  if (callee === "disableRoute") return "disabled";
  if (callee === "defineChannel") return "custom";
  for (const specifier of readImports(source)) {
    const platform = /^eve\/channels\/([a-z-]+)$/.exec(specifier)?.[1];
    if (platform && PLATFORM_CHANNELS.has(platform)) return platform as ChannelKind;
  }
  return "other";
}

/** Channels are root-only in Eve. */
function readChannels(context: Context, base: string): Channel[] {
  const channels: Channel[] = [];
  for (const path of listDirectory(context.paths, `${base}channels/`).files) {
    if (!isDefinitionModule(path)) continue;
    const id = stem(path);
    if (!isSlug(id)) continue;
    const source = context.contents.get(path) ?? "";
    context.claimed.add(path);
    channels.push({ id, file: fileName(path), kind: channelKind(source), source });
  }
  return channels;
}

/** Schedules are root-only and may be nested; the path under `schedules/` is the name. */
function readSchedules(context: Context, base: string): Schedule[] {
  const dir = `${base}schedules/`;
  const schedules: Schedule[] = [];
  for (const path of context.paths) {
    if (!path.startsWith(dir)) continue;
    const file = path.slice(dir.length);
    const isMarkdown = file.endsWith(".md");
    if (!isMarkdown && !isDefinitionModule(file)) continue;
    const id = file.replace(/\.[^.]+$/, "");
    if (!scheduleIdSchema.safeParse(id).success) continue;
    const source = context.contents.get(path) ?? "";
    context.claimed.add(path);

    if (isMarkdown) {
      const { data, body } = parseFrontmatter(source);
      schedules.push({ id, file, format: "markdown", cron: typeof data.cron === "string" ? data.cron : "", prompt: body.trim(), handler: false, source });
    } else {
      const config = readAgentSource(source);
      const markdown = config?.properties.get("markdown")?.text;
      const prompt = markdown === undefined ? undefined : readStringValue(markdown);
      schedules.push({
        id,
        file,
        format: "module",
        cron: readStringProperty(source, "cron") ?? "",
        prompt: prompt ?? "",
        promptExpression: markdown !== undefined && prompt === undefined ? markdown : undefined,
        handler: config?.properties.has("run") ?? false,
        source,
      });
    }
  }
  return schedules.sort((a, b) => a.id.localeCompare(b.id));
}

/** Mounted extensions. Their files are not claimed, so generation passes them through untouched. */
function readExtensions(context: Context, base: string): Extension[] {
  const extensions: Extension[] = [];
  for (const path of listDirectory(context.paths, `${base}extensions/`).files) {
    if (!isDefinitionModule(path)) continue;
    const id = stem(path);
    if (!isSlug(id)) continue;
    const source = context.contents.get(path) ?? "";
    const packageName = readImports(source).find((specifier) => !/^[.#/]/.test(specifier) && !/^eve(\/|$)/.test(specifier));
    extensions.push({ id, file: path, package: packageName, source });
  }
  return extensions;
}

/** Memory slots, read only like extensions. */
function readMemory(context: Context, base: string): MemorySlot[] {
  const slots: MemorySlot[] = [];
  for (const path of listDirectory(context.paths, `${base}memory/`).files) {
    if (!isDefinitionModule(path)) continue;
    const id = stem(path);
    if (!isSlug(id)) continue;
    const source = context.contents.get(path) ?? "";
    slots.push({ id, file: path, description: readStringProperty(source, "description") ?? "", source });
  }
  return slots;
}
