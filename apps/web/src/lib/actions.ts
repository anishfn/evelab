"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAuth } from "@evelab/auth";
import {
  agentPath,
  applyOwnershipChange,
  attachResource,
  detachResource,
  OwnershipError,
  reasoningSchema,
  removeEntities,
  removeEntity,
  addPackageDependencies,
  CHAT_SDK_ADAPTERS,
  CHAT_SDK_STATES,
  chatSdkDependencies,
  renderChatSdkChannelModule,
  type ChatSdkAdapter,
  type ChatSdkState,
  renderChannelModule,
  renderConnectionModule,
  renderScheduleMarkdown,
  renderToolModule,
  type EveProject,
} from "@evelab/eve-project";
import { isSafeRepoPath, newRepositoryNameSchema, repositoryNameSchema } from "@evelab/github";
import {
  commitProject,
  connectRepository,
  disconnectRepository,
  discardChange,
  importRepository,
  previewImport,
  publishToNewRepository,
  publishToOwnRepository,
  pullProject,
  sourceControlMessage,
} from "@/lib/git";
import { deploySettingsSchema, saveDeploySettings, startDeployment } from "@/lib/deploy";
import { annotationSchema, LAYOUT_MODES, WIRE_STYLES } from "@/components/canvas/layout";
import { writeLayout } from "@/lib/layout";
import { discoverMcpTools, McpDiscoveryError, type DiscoveredTool } from "@/lib/mcp-discovery";
import { createConnection, createSchedule, createSubagent, createTool, ProjectOpError } from "@/lib/project-ops";
import { forgetProject, recordProject, requireProjectAccess, requireSignedIn } from "@/lib/session";
import {
  fetchSkillCandidate,
  isSafeRelativePath,
  SkillImportError,
  type SkillCandidate,
} from "@/lib/skill-import";
import {
  createProject,
  createProjectFile,
  createProjectFolder,
  deleteProject,
  deleteProjectPath,
  isIgnoredPath,
  ProjectPathError,
  readProject,
  readProjectFile,
  renameProjectPath,
  writeProject,
  writeProjectFile,
} from "@/lib/workspace";

/**
 * Every mutation validates its input, then checks the caller may touch the
 * project, before touching the project. Form data and imported metadata are
 * untrusted, and a server action can be called without the page that renders it.
 */

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** Eve derives names from file and directory names: letters, digits, - and _. */
const nameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "Use letters, digits, - and _");
const SEGMENT = "[A-Za-z0-9][A-Za-z0-9_-]*";
/** A resource on the canvas: "tool:search_docs", "skill:researcher/cite", or shared, "connection:#github". */
const resourceRefSchema = z.string().regex(new RegExp(`^(tool|skill|connection):(#${SEGMENT}|(${SEGMENT}/)*${SEGMENT})$`));
const agentRefSchema = z.string().regex(/^(agent|subagent:[A-Za-z0-9][A-Za-z0-9_\-/]*)$/);
const entityRefSchema = z.union([
  resourceRefSchema,
  z.string().regex(new RegExp(`^subagent:(${SEGMENT}/)*${SEGMENT}$`)),
  z.string().regex(new RegExp(`^channel:${SEGMENT}$`)),
]);

/** Parses a project id and refuses callers who may not open that project. */
async function projectFrom(value: unknown): Promise<string> {
  const id = idSchema.parse(value);
  await requireProjectAccess(id);
  return id;
}

async function save(id: string, project: EveProject): Promise<void> {
  await writeProject(id, project);
  revalidatePath(`/projects/${id}`, "layout");
}

/* Sign-in. Plain forms, so they work before any JavaScript loads. */

export async function signInAction() {
  const auth = getAuth();
  if (!auth) redirect("/projects");
  const result = await auth.api.signInSocial({
    body: { provider: "github", callbackURL: "/projects" },
    headers: await headers(),
  });
  if (!("url" in result) || !result.url) throw new Error("GitHub sign-in is not available.");
  redirect(result.url);
}

export async function signOutAction() {
  const auth = getAuth();
  if (auth) await auth.api.signOut({ headers: await headers() });
  // Signing out lands on the public front page rather than a bare sign-in form.
  redirect(auth ? "/" : "/projects");
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(280).optional(),
  modelId: z.string().trim().min(1, "Choose a model"),
  provider: z.enum(["ai-gateway-project", "ai-gateway-key", "chatgpt", "anthropic", "openai"]).default("ai-gateway-project"),
  reasoning: reasoningSchema.optional(),
});

export async function createProjectAction(formData: FormData) {
  const input = createSchema.parse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    modelId: formData.get("modelId"),
    provider: formData.get("provider") || undefined,
    reasoning: formData.get("reasoning") || undefined,
  });
  await requireSignedIn();
  const id = await createProject(input);
  await claimOrRemove(id, input.name);
  revalidatePath("/projects");
  redirect(`/projects/${id}/canvas`);
}

/** A directory nobody owns would be invisible to everyone, so an ownership failure removes it. */
async function claimOrRemove(id: string, name: string): Promise<void> {
  try {
    await recordProject(id, name);
  } catch (error) {
    await deleteProject(id);
    throw error;
  }
}

export async function deleteProjectAction(formData: FormData) {
  const id = await projectFrom(formData.get("id"));
  await deleteProject(id);
  await disconnectRepository(id);
  await forgetProject(id);
  revalidatePath("/projects");
  redirect("/projects");
}

/** The agent's name comes from package.json, so only the description is edited here. */
export async function updateAgentAction(formData: FormData) {
  const id = await projectFrom(formData.get("id"));
  const description = z.string().trim().max(280).optional().parse(formData.get("description") || undefined);

  const project = await readProject(id);
  project.agent.description = description;
  await save(id, project);
}

const modelSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  reasoning: z.union([reasoningSchema, z.literal("")]).default(""),
});

export async function updateModelAction(formData: FormData) {
  const id = await projectFrom(formData.get("id"));
  const input = modelSchema.parse({
    modelId: formData.get("modelId"),
    reasoning: formData.get("reasoning") ?? "",
  });

  const project = await readProject(id);
  if (project.agent.model?.expression) {
    throw new Error("This agent computes its model in code. Change it in agent.ts.");
  }
  project.agent.model = { id: input.modelId };
  project.agent.reasoning = input.reasoning || undefined;
  await save(id, project);
}

export async function saveInstructionsAction(projectId: string, content: string) {
  const id = await projectFrom(projectId);
  const project = await readProject(id);
  project.agent.instructions = z.string().max(500_000).parse(content);
  await save(id, project);
}

export async function readFileAction(projectId: string, path: string): Promise<string> {
  const id = await projectFrom(projectId);
  return readProjectFile(id, path);
}

export async function saveFileAction(projectId: string, path: string, content: string) {
  const id = await projectFrom(projectId);
  await writeProjectFile(id, path, z.string().max(2_000_000).parse(content));
  revalidatePath(`/projects/${id}`, "layout");
}

/** A path as someone types it in the explorer: inside the project, and not a dependency or build folder. */
const projectPathSchema = z
  .string()
  .trim()
  .min(1, "Give it a name.")
  .max(200, "That path is too long.")
  .refine((path) => !path.startsWith("/") && !path.includes("\\"), "Use a path inside the project.")
  .refine(
    (path) => path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Use a path inside the project.",
  )
  .refine((path) => /^[\w .@+()[\]/-]+$/.test(path), "Use letters, digits, spaces and . - _ in names.")
  .refine((path) => !isIgnoredPath(path), "That folder is managed outside the project.");

export type FileOperationResult = { ok: true } | { ok: false; message: string };

function parseProjectPath(value: unknown): { ok: true; path: string } | { ok: false; message: string } {
  const parsed = projectPathSchema.safeParse(value);
  return parsed.success
    ? { ok: true, path: parsed.data }
    : { ok: false, message: parsed.error.issues[0]?.message ?? "That path is not allowed." };
}

/** Runs a file operation, turning a refusal into a message and refreshing every view of the project, the canvas included. */
async function fileOperation(id: string, run: () => Promise<void>): Promise<FileOperationResult> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProjectPathError) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath(`/projects/${id}`, "layout");
  return { ok: true };
}

export async function createFileAction(projectId: string, path: string): Promise<FileOperationResult> {
  const id = await projectFrom(projectId);
  const target = parseProjectPath(path);
  if (!target.ok) return target;
  return fileOperation(id, () => createProjectFile(id, target.path));
}

export async function createFolderAction(projectId: string, path: string): Promise<FileOperationResult> {
  const id = await projectFrom(projectId);
  const target = parseProjectPath(path);
  if (!target.ok) return target;
  return fileOperation(id, () => createProjectFolder(id, target.path));
}

export async function renamePathAction(projectId: string, from: string, to: string): Promise<FileOperationResult> {
  const id = await projectFrom(projectId);
  const source = parseProjectPath(from);
  if (!source.ok) return source;
  const target = parseProjectPath(to);
  if (!target.ok) return target;
  if (target.path.startsWith(`${source.path}/`)) return { ok: false, message: "A folder cannot move inside itself." };
  return fileOperation(id, () => renameProjectPath(id, source.path, target.path));
}

export async function deletePathAction(projectId: string, path: string): Promise<FileOperationResult> {
  const id = await projectFrom(projectId);
  const target = parseProjectPath(path);
  if (!target.ok) return target;
  return fileOperation(id, () => deleteProjectPath(id, target.path));
}

export async function createToolAction(formData: FormData) {
  const projectId = await projectFrom(formData.get("projectId"));
  const { path } = await createTool(projectId, {
    name: String(formData.get("toolId") ?? ""),
    description: String(formData.get("description") ?? ""),
  });
  revalidatePath(`/projects/${projectId}`, "layout");
  // The canvas keeps the user in place; the Tools page sends them to the source.
  if (formData.get("openSource") === "true") {
    redirect(`/projects/${projectId}/files?path=${encodeURIComponent(path)}`);
  }
}

/** A subagent is a directory with its own agent.ts and instructions. It inherits nothing. */
export async function createSubagentAction(formData: FormData) {
  const projectId = await projectFrom(formData.get("projectId"));
  await createSubagent(projectId, {
    name: String(formData.get("subagentId") ?? ""),
    description: String(formData.get("description") ?? ""),
    model: String(formData.get("modelId") ?? "") || undefined,
  });
  revalidatePath(`/projects/${projectId}`, "layout");
}

/** Removes a tool, skill, connection or subagent by its canvas id, and only its files. */
export async function deleteEntityAction(formData: FormData) {
  const projectId = await projectFrom(formData.get("projectId"));
  const ref = entityRefSchema.parse(formData.get("ref"));
  const project = await readProject(projectId);
  await save(projectId, removeEntity(project, ref));
}

/** Canvas node positions. Presentation state, stored outside the project. */
export async function saveLayoutAction(
  projectId: string,
  positions: Record<string, { x: number; y: number }>,
  options: { mode?: string; collapsed?: string[]; annotations?: unknown[]; wireStyle?: string } = {},
) {
  const id = await projectFrom(projectId);
  const parsed = z
    .record(z.object({ x: z.number().finite(), y: z.number().finite() }))
    .parse(positions);
  const settings = z
    .object({
      mode: z.enum(LAYOUT_MODES).optional(),
      collapsed: z.array(z.string().max(200)).max(500).optional(),
      annotations: z.array(annotationSchema).max(500).optional(),
      wireStyle: z.enum(WIRE_STYLES).optional(),
    })
    .parse(options);
  await writeLayout(id, { positions: parsed, ...settings });
}

const ownershipSchema = z.object({
  projectId: idSchema,
  capability: resourceRefSchema,
  to: agentRefSchema,
});

const attachSchema = z.object({ projectId: idSchema, resource: resourceRefSchema, agent: agentRefSchema });

/**
 * Lets another agent use a tool, skill or connection without copying it. The
 * definition moves to `lib/` once, and each agent gets a one-line re-export.
 */
export async function attachResourceAction(
  input: z.input<typeof attachSchema>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { projectId, resource, agent } = attachSchema.parse(input);
  await requireProjectAccess(projectId);
  try {
    await writeProject(projectId, attachResource(await readProject(projectId), { resource, to: agent }));
  } catch (error) {
    if (error instanceof OwnershipError) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  return { ok: true };
}

/** Stops an agent using a resource. The definition stays in `lib/`, ready to attach again. */
export async function detachResourceAction(
  input: z.input<typeof attachSchema>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { projectId, resource, agent } = attachSchema.parse(input);
  await requireProjectAccess(projectId);
  try {
    await writeProject(projectId, detachResource(await readProject(projectId), { resource, from: agent }));
  } catch (error) {
    if (error instanceof OwnershipError) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  return { ok: true };
}

/** Removes a node from the canvas by its id, and only its files. Returns instead of throwing, for the canvas. */
export async function removeNodeAction(input: {
  projectId: string;
  ref: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const projectId = await projectFrom(input.projectId);
  const ref = entityRefSchema.parse(input.ref);
  try {
    await save(projectId, removeEntity(await readProject(projectId), ref));
  } catch (error) {
    if (error instanceof OwnershipError) return { ok: false, message: error.message };
    throw error;
  }
  return { ok: true };
}

/** Deletes a whole canvas selection in one write, so it lands or fails together. */
export async function removeNodesAction(input: {
  projectId: string;
  refs: string[];
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const projectId = await projectFrom(input.projectId);
  const refs = z.array(entityRefSchema).min(1).max(500).parse(input.refs);
  try {
    await save(projectId, removeEntities(await readProject(projectId), refs));
  } catch (error) {
    if (error instanceof OwnershipError) return { ok: false, message: error.message };
    throw error;
  }
  return { ok: true };
}

/**
 * Hands a tool, skill or connection to another agent: an edge dragged on the
 * canvas. In Eve that means moving its file into the new owner's directory.
 */
export async function changeOwnershipAction(
  input: z.input<typeof ownershipSchema>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { projectId, capability, to } = ownershipSchema.parse(input);
  await requireProjectAccess(projectId);
  const project = await readProject(projectId);
  try {
    await writeProject(projectId, applyOwnershipChange(project, { capability, to }));
  } catch (error) {
    if (error instanceof OwnershipError) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  return { ok: true };
}

/**
 * Writes `connections/<id>.ts`. Credentials never touch evelab: Vercel Connect
 * resolves them at run time, or the token comes from the deployment's environment.
 */
export async function createConnectionAction(input: {
  projectId: string;
  id: string;
  kind: "mcp" | "openapi";
  url: string;
  description?: string;
  auth: "none" | "connect" | "token";
  connector?: string;
  tokenEnv?: string;
  allow?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const projectId = await projectFrom(input.projectId);
  const allow = (input.allow ?? "")
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  try {
    await createConnection(projectId, {
      name: input.id,
      kind: input.kind,
      url: input.url,
      description: input.description,
      auth: input.auth,
      connector: input.connector,
      tokenEnv: input.tokenEnv,
      allow,
    });
  } catch (error) {
    if (error instanceof ProjectOpError) return { ok: false, message: error.message };
    if (error instanceof z.ZodError) return { ok: false, message: error.issues[0]?.message ?? "Check the form." };
    throw error;
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  return { ok: true };
}

/**
 * Lists an MCP server's tools so a connection's allow list can be picked
 * rather than typed. A token given here is used for this request only and is
 * never written anywhere.
 */
export async function discoverMcpToolsAction(input: {
  projectId: string;
  url: string;
  token?: string;
}): Promise<{ ok: true; tools: DiscoveredTool[] } | { ok: false; message: string }> {
  await projectFrom(input.projectId);
  const parsed = z
    .object({ url: z.string().trim().min(1).max(2000), token: z.string().trim().max(4000).optional() })
    .safeParse({ url: input.url, token: input.token });
  if (!parsed.success) return { ok: false, message: "Enter the server's URL." };
  try {
    return { ok: true, tools: await discoverMcpTools(parsed.data.url, parsed.data.token || undefined) };
  } catch (error) {
    if (error instanceof McpDiscoveryError) return { ok: false, message: error.message };
    return { ok: false, message: "Could not list tools from that server." };
  }
}

const channelSchema = z
  .object({
    kind: z.enum(["slack", "discord", "linear", "github", "linq", "photon", "teams", "telegram", "mcp", "twilio"]),
    connector: z.string().trim().max(200).optional(),
    botName: z.string().trim().max(100).optional(),
    botUsername: z.string().trim().max(100).optional(),
    allowFrom: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Use an E.164 number, such as +15551234567").optional(),
    fromNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Use an E.164 number, such as +15557654321").optional(),
  })
  .refine((input) => input.kind !== "github" || input.botName, { message: "Enter the GitHub App's bot name" })
  .refine((input) => input.kind !== "telegram" || input.botUsername, { message: "Enter the Telegram bot username" })
  .refine((input) => input.kind !== "twilio" || input.allowFrom, { message: "Enter the number allowed to reach the agent" });

/**
 * Writes `channels/<platform>.ts`. Where Vercel Connect can hold the platform
 * credentials the channel uses it, so no platform secret reaches the project.
 */
export async function createChannelAction(
  input: z.input<typeof channelSchema> & { projectId: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const projectId = await projectFrom(input.projectId);
  const parsed = channelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
  const value = parsed.data;

  const project = await readProject(projectId);
  if (project.channels.some((channel) => channel.id === value.kind)) {
    return { ok: false, message: `The ${value.kind} channel is already set up.` };
  }
  let source: string;
  try {
    source = renderChannelModule({ ...value, connector: value.connector || undefined });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not write that channel." };
  }
  project.channels.push({ id: value.kind, file: `${value.kind}.ts`, kind: value.kind, source });
  await save(projectId, project);
  return { ok: true };
}

/**
 * Writes a Chat SDK channel for a service eve has no first-class channel for,
 * and adds the packages it imports to the project's package.json.
 */
export async function createChatSdkChannelAction(input: {
  projectId: string;
  adapter: string;
  state: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const projectId = await projectFrom(input.projectId);
  if (!(input.adapter in CHAT_SDK_ADAPTERS) || !(input.state in CHAT_SDK_STATES)) {
    return { ok: false, message: "Choose a Chat SDK adapter and a state store." };
  }
  const adapter = input.adapter as ChatSdkAdapter;
  const state = input.state as ChatSdkState;

  const project = await readProject(projectId);
  if (project.channels.some((channel) => channel.id === adapter)) {
    return { ok: false, message: `A ${adapter} channel is already set up.` };
  }
  const packageFile = project.files.find((file) => file.path === "package.json");
  if (!packageFile) return { ok: false, message: "This project has no package.json to add the Chat SDK packages to." };
  try {
    packageFile.content = addPackageDependencies(packageFile.content, chatSdkDependencies(adapter, state));
  } catch {
    return { ok: false, message: "package.json is not valid JSON, so the Chat SDK packages could not be added." };
  }
  project.channels.push({
    id: adapter,
    file: `${adapter}.ts`,
    kind: "chat-sdk",
    source: renderChatSdkChannelModule({ adapter, state, userName: project.agent.name }),
  });
  await save(projectId, project);
  return { ok: true };
}

export async function deleteChannelAction(formData: FormData) {
  const projectId = await projectFrom(formData.get("projectId"));
  const channelId = nameSchema.parse(formData.get("channelId"));
  const project = await readProject(projectId);
  project.channels = project.channels.filter((channel) => channel.id !== channelId);
  await save(projectId, project);
}

/** Writes a markdown schedule: the cron in frontmatter and the prompt as the body. */
export async function createScheduleAction(formData: FormData) {
  const projectId = await projectFrom(formData.get("projectId"));
  await createSchedule(projectId, {
    name: String(formData.get("scheduleId") ?? ""),
    cron: String(formData.get("cron") ?? ""),
    prompt: String(formData.get("prompt") ?? ""),
  });
  revalidatePath(`/projects/${projectId}`, "layout");
}

export async function deleteScheduleAction(formData: FormData) {
  const projectId = await projectFrom(formData.get("projectId"));
  const scheduleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_\-/]*$/).parse(formData.get("scheduleId"));
  const project = await readProject(projectId);
  project.schedules = project.schedules.filter((schedule) => schedule.id !== scheduleId);
  await save(projectId, project);
}

/**
 * Reads a candidate skill so the user can see the source and every file before
 * anything is written. This does not install.
 */
export async function previewSkillAction(
  url: string,
): Promise<{ ok: true; candidate: SkillCandidate } | { ok: false; message: string }> {
  await requireSignedIn();
  try {
    const candidate = await fetchSkillCandidate(z.string().trim().min(1).max(500).parse(url));
    return { ok: true, candidate };
  } catch (error) {
    if (error instanceof SkillImportError) return { ok: false, message: error.message };
    if (error instanceof z.ZodError) return { ok: false, message: "Paste a link or a skills.sh name." };
    return { ok: false, message: "Could not read that skill." };
  }
}

const installSkillSchema = z.object({
  projectId: idSchema,
  id: nameSchema,
  description: z.string().trim().max(1000).default(""),
  files: z
    .array(
      z.object({
        // Nested paths are allowed (scripts/run.sh), traversal is not.
        path: z.string().min(1).max(200).refine(isSafeRelativePath, {
          message: "Unsafe skill file path",
        }),
        content: z.string().max(256 * 1024),
      }),
    )
    .min(1)
    .max(120),
});

/** Writes a reviewed skill package into `skills/<id>/`. Called only after confirmation. */
export async function installSkillAction(input: z.input<typeof installSkillSchema> & { name?: string; source?: string }) {
  const parsed = installSkillSchema.parse(input);
  const projectId = parsed.projectId;
  await requireProjectAccess(projectId);

  const markdown = parsed.files.find((file) => file.path === "SKILL.md");
  if (!markdown) throw new Error("A skill needs a SKILL.md.");

  const project = await readProject(projectId);
  if (project.skills.some((skill) => skill.id === parsed.id)) {
    throw new Error(`A skill named "${parsed.id}" is already installed.`);
  }

  project.skills.push({
    id: parsed.id,
    format: "package",
    description: parsed.description,
    content: markdown.content,
    files: parsed.files.filter((file) => file.path !== "SKILL.md"),
  });
  await save(projectId, project);
}

/*
 * Source control. These return a result instead of throwing, so a GitHub
 * failure reaches the user as a sentence rather than an error page. Access
 * failures still throw: they are not something to explain to the caller.
 */

type Failure = { ok: false; message: string };

async function sourceControl<T extends object>(run: () => Promise<T>): Promise<({ ok: true } & T) | Failure> {
  try {
    return { ok: true as const, ...(await run()) };
  } catch (error) {
    const message = sourceControlMessage(error);
    if (message) return { ok: false, message };
    throw error;
  }
}

const branchInput = z.string().trim().max(200).optional();

export async function previewImportAction(input: { repository: string; branch?: string }) {
  await requireSignedIn();
  return sourceControl(async () => {
    const parsed = z.object({ repository: repositoryNameSchema, branch: branchInput }).parse(input);
    return { preview: await previewImport(parsed.repository, parsed.branch) };
  });
}

export async function importRepositoryAction(input: { repository: string; branch: string; commit: string }) {
  await requireSignedIn();
  return sourceControl(async () => {
    const parsed = z
      .object({ repository: repositoryNameSchema, branch: z.string().trim().min(1).max(200), commit: z.string().regex(/^[0-9a-f]{40}$/) })
      .parse(input);
    const projectId = await importRepository(parsed.repository, parsed.branch, parsed.commit);
    try {
      await claimOrRemove(projectId, projectId);
    } catch (error) {
      await disconnectRepository(projectId);
      throw error;
    }
    revalidatePath("/projects");
    return { projectId };
  });
}

export async function connectRepositoryAction(input: { projectId: string; repository: string; branch?: string }) {
  const parsed = z.object({ projectId: idSchema, repository: repositoryNameSchema, branch: branchInput }).parse(input);
  await requireProjectAccess(parsed.projectId);
  return sourceControl(async () => {
    const result = await connectRepository(parsed.projectId, parsed.repository, parsed.branch);
    revalidatePath(`/projects/${parsed.projectId}`, "layout");
    return result;
  });
}

export async function createRepositoryAction(input: {
  projectId: string;
  name: string;
  isPrivate: boolean;
  message: string;
}) {
  const projectId = await projectFrom(input.projectId);
  return sourceControl(async () => {
    const parsed = z
      .object({
        name: newRepositoryNameSchema,
        isPrivate: z.boolean(),
        message: z.string().trim().min(1, "Write a commit message").max(5000),
      })
      .parse(input);
    const result = await publishToNewRepository(projectId, parsed.name, parsed.isPrivate, parsed.message);
    revalidatePath(`/projects/${projectId}`, "layout");
    return result;
  });
}

/** Publishes a project that came from someone else's repository to a new repository on the caller's account. */
export async function publishToOwnRepositoryAction(input: {
  projectId: string;
  name: string;
  isPrivate: boolean;
  message: string;
}) {
  const projectId = await projectFrom(input.projectId);
  return sourceControl(async () => {
    const parsed = z
      .object({
        name: newRepositoryNameSchema,
        isPrivate: z.boolean(),
        message: z.string().trim().min(1, "Write a commit message").max(5000),
      })
      .parse(input);
    const result = await publishToOwnRepository(projectId, parsed.name, parsed.isPrivate, parsed.message);
    revalidatePath(`/projects/${projectId}`, "layout");
    return result;
  });
}

/** Commits every local change. The commit is created on GitHub, so this is also the push. */
export async function commitAction(input: { projectId: string; message: string }) {
  const projectId = await projectFrom(input.projectId);
  return sourceControl(async () => {
    const { message } = z
      .object({ message: z.string().trim().min(1, "Write a commit message").max(5000) })
      .parse(input);
    const result = await commitProject(projectId, message);
    revalidatePath(`/projects/${projectId}`, "layout");
    return result;
  });
}

export async function pullAction(input: { projectId: string }) {
  const projectId = await projectFrom(input.projectId);
  return sourceControl(async () => {
    const result = await pullProject(projectId);
    revalidatePath(`/projects/${projectId}`, "layout");
    return { result };
  });
}

export async function discardChangeAction(input: { projectId: string; path: string }) {
  const projectId = await projectFrom(input.projectId);
  return sourceControl(async () => {
    const { path } = z.object({ path: z.string().refine(isSafeRepoPath, { message: "Unsafe path" }) }).parse(input);
    await discardChange(projectId, path);
    revalidatePath(`/projects/${projectId}`, "layout");
    return {};
  });
}

export async function disconnectRepositoryAction(formData: FormData) {
  const id = await projectFrom(formData.get("id") ?? formData.get("projectId"));
  await disconnectRepository(id);
  revalidatePath(`/projects/${id}`, "layout");
}

/*
 * Deployment. `eve deploy` runs on the server with the server's VERCEL_TOKEN;
 * the token never reaches the browser or the project.
 */

export async function saveDeploySettingsAction(formData: FormData) {
  const projectId = await projectFrom(formData.get("projectId"));
  const settings = deploySettingsSchema.parse({
    project: formData.get("project") || undefined,
    team: formData.get("team") || undefined,
  });
  await saveDeploySettings(projectId, settings);
  revalidatePath(`/projects/${projectId}/deployments`);
}

export async function deployAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const id = await projectFrom(projectId);
  try {
    await startDeployment(id);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The deployment did not start." };
  }
  revalidatePath(`/projects/${id}/deployments`);
  return { ok: true };
}
