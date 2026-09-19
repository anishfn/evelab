import { hasRelativeImports } from "./agent-source";
import { renderSharedReexport, renderSkillModule } from "./agent-template";
import { parseFrontmatter } from "./frontmatter";
import { hashImportBase, relativeSpecifier } from "./layout";
import { markdownSkillDescription } from "./parse";
import type { Connection, EveProject, Skill, Subagent, Tool } from "./types";

/**
 * Who can use a tool, skill or connection, as the canvas draws it.
 *
 * In Eve a declared subagent inherits nothing from its parent: it has only what
 * lives in its own `subagents/<id>/` directory. A resource one agent uses lives
 * in that agent's slot. A resource several agents use is defined once under
 * `lib/<kind>/`, and each agent that uses it gets a one-line re-export in its
 * own slot, which is Eve's way to share code between agents.
 */

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipError";
  }
}

export interface OwnershipMove {
  /** Canvas id of the capability: "tool:search_docs", "skill:researcher/cite". */
  capability: string;
  /** Canvas id of the new owner: "agent" or "subagent:researcher". */
  to: string;
}

export type CapabilityKind = "tool" | "skill" | "connection";

interface CapabilityOwner {
  tools: Tool[];
  skills: Skill[];
  connections: Connection[];
  subagents: Subagent[];
}

export interface CapabilityRef {
  kind: CapabilityKind;
  /** Owner of a resource defined in place: "" for the root, "researcher" for a subagent. */
  ownerKey: string;
  id: string;
  /** True for a shared definition under `lib/`, written "tool:#search_docs". */
  shared: boolean;
}

export function parseCapabilityRef(ref: string): CapabilityRef | undefined {
  const shared = /^(tool|skill|connection):#([^/]+)$/.exec(ref);
  if (shared) return { kind: shared[1] as CapabilityKind, ownerKey: "", id: shared[2]!, shared: true };
  const match = /^(tool|skill|connection):(?:(.+)\/)?([^/#]+)$/.exec(ref);
  if (!match) return undefined;
  return { kind: match[1] as CapabilityKind, ownerKey: match[2] ?? "", id: match[3]!, shared: false };
}

function ownerKeyOf(ref: string): string | undefined {
  if (ref === "agent") return "";
  return ref.startsWith("subagent:") ? ref.slice("subagent:".length) : undefined;
}

function findOwner(root: CapabilityOwner, key: string): CapabilityOwner | undefined {
  if (key === "") return root;
  let current: CapabilityOwner = root;
  for (const part of key.split("/")) {
    const next = current.subagents.find((subagent) => subagent.id === part && subagent.kind === "local");
    if (!next) return undefined;
    current = next;
  }
  return current;
}

function ownerName(key: string): string {
  return key ? `Subagent "${key}"` : "The agent";
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

const SLOT = { tool: "tools", skill: "skills", connection: "connections" } as const;

/** Returns a new project with the capability moved. The input is never mutated. */
export function applyOwnershipChange(project: EveProject, move: OwnershipMove): EveProject {
  const capability = parseCapabilityRef(move.capability);
  if (!capability) throw new OwnershipError(`"${move.capability}" is not a tool, skill or connection.`);
  if (capability.shared) {
    throw new OwnershipError(`"${capability.id}" is shared. Attach it to another agent instead of moving it.`);
  }
  const next = structuredClone(project);
  const toKey = ownerKeyOf(move.to);
  if (toKey === undefined) throw new OwnershipError(`"${move.to}" cannot own tools, skills or connections.`);

  const from = findOwner(next, capability.ownerKey);
  if (!from) throw new OwnershipError(`There is no subagent "${capability.ownerKey}" in this project.`);
  const to = findOwner(next, toKey);
  if (!to) throw new OwnershipError(`There is no local subagent "${toKey}" in this project.`);

  const { kind, id } = capability;
  const taken = (entries: Array<{ id: string }>) => entries.some((entry) => entry.id === id);

  switch (kind) {
    case "tool": {
      const tool = from.tools.find((entry) => entry.id === id);
      if (!tool) throw new OwnershipError(`There is no tool "${id}" there.`);
      if (from === to) return next;
      if (taken(to.tools)) throw new OwnershipError(`${ownerName(toKey)} already has a tool named "${id}".`);
      if (taken(to.subagents)) throw new OwnershipError(`${ownerName(toKey)} has a subagent named "${id}", and Eve rejects that collision.`);
      if (!tool.shared) refuseRelativeImports(id, [tool.source]);
      from.tools = from.tools.filter((entry) => entry !== tool);
      to.tools = [...to.tools, retarget(next, toKey, "tool", tool)].sort(byId);
      return next;
    }
    case "skill": {
      const skill = from.skills.find((entry) => entry.id === id);
      if (!skill) throw new OwnershipError(`There is no skill "${id}" there.`);
      if (from === to) return next;
      if (taken(to.skills)) throw new OwnershipError(`${ownerName(toKey)} already has a skill named "${id}".`);
      if (skill.format === "module" && !skill.shared) refuseRelativeImports(id, [skill.content]);
      from.skills = from.skills.filter((entry) => entry !== skill);
      to.skills = [...to.skills, retarget(next, toKey, "skill", skill)].sort(byId);
      return next;
    }
    case "connection": {
      const connection = from.connections.find((entry) => entry.id === id);
      if (!connection) throw new OwnershipError(`There is no connection "${id}" there.`);
      if (from === to) return next;
      if (taken(to.connections)) throw new OwnershipError(`${ownerName(toKey)} already has a connection named "${id}".`);
      if (!connection.shared) refuseRelativeImports(id, [connection.source]);
      from.connections = from.connections.filter((entry) => entry !== connection);
      to.connections = [...to.connections, retarget(next, toKey, "connection", connection)].sort(byId);
      return next;
    }
  }
}

/** A re-export keeps pointing at its definition from the new directory; anything else moves as is. */
function retarget<T extends Tool | Skill | Connection>(project: EveProject, ownerKey: string, kind: CapabilityKind, entry: T): T {
  if (!entry.shared) return entry;
  const source = renderSharedReexport(sharedSpecifier(project, ownerKey, kind, entry.shared));
  return "content" in entry ? { ...entry, content: source } : { ...entry, source };
}

function refuseRelativeImports(id: string, sources: string[]): void {
  if (sources.some(hasRelativeImports)) {
    throw new OwnershipError(
      `${id} imports other files by relative path, so moving it would break those imports. Move it in the source instead.`,
    );
  }
}

/** The import specifier a consumer in `ownerKey`'s slot uses to reach a shared definition. */
export function sharedSpecifier(project: EveProject, ownerKey: string, kind: CapabilityKind, name: string): string {
  const base = project.root ? `${project.root}/` : "";
  const slot = SLOT[kind];
  const hashBase = hashImportBase(project.files.find((file) => file.path === "package.json")?.content);
  if (hashBase === base) return `#lib/${slot}/${name}.ts`;
  const ownerDir = ownerKey ? ownerKey.split("/").map((part) => `subagents/${part}/`).join("") : "";
  return relativeSpecifier(`${base}${ownerDir}${slot}/`, `${base}lib/${slot}/${name}.ts`);
}

function consumerEntry(project: EveProject, ownerKey: string, kind: "tool", name: string): Tool;
function consumerEntry(project: EveProject, ownerKey: string, kind: "skill", name: string): Skill;
function consumerEntry(project: EveProject, ownerKey: string, kind: "connection", name: string): Connection;
function consumerEntry(project: EveProject, ownerKey: string, kind: CapabilityKind, name: string): Tool | Skill | Connection {
  const source = renderSharedReexport(sharedSpecifier(project, ownerKey, kind, name));
  if (kind === "tool") {
    const definition = project.library.tools.find((entry) => entry.id === name)!;
    return { ...definition, file: `${name}.ts`, source, shared: name };
  }
  if (kind === "skill") {
    const definition = project.library.skills.find((entry) => entry.id === name)!;
    return { id: name, format: "module", description: definition.description, content: source, files: [], shared: name };
  }
  const definition = project.library.connections.find((entry) => entry.id === name)!;
  return { ...definition, file: `${name}.ts`, source, shared: name };
}

/**
 * Moves a resource defined in place into `lib/`, leaving a re-export where it
 * was. Markdown and packaged skills become `defineSkill` modules, because a
 * module can be re-exported and a markdown file cannot.
 */
function promote(project: EveProject, owner: CapabilityOwner, ownerKey: string, kind: CapabilityKind, id: string): void {
  const exists = (entries: Array<{ id: string }>) => entries.some((entry) => entry.id === id);
  if (kind === "tool") {
    const tool = owner.tools.find((entry) => entry.id === id)!;
    if (exists(project.library.tools)) throw new OwnershipError(`A shared tool named "${id}" already exists.`);
    refuseRelativeImports(id, [tool.source]);
    project.library.tools = [...project.library.tools, { ...tool, shared: undefined }].sort(byId);
    owner.tools = owner.tools.map((entry) => (entry === tool ? consumerEntry(project, ownerKey, "tool", id) : entry));
  } else if (kind === "skill") {
    const skill = owner.skills.find((entry) => entry.id === id)!;
    if (exists(project.library.skills)) throw new OwnershipError(`A shared skill named "${id}" already exists.`);
    let content = skill.content;
    if (skill.format === "module") {
      refuseRelativeImports(id, [skill.content]);
    } else {
      const { body } = parseFrontmatter(skill.content);
      content = renderSkillModule({
        description: skill.description || markdownSkillDescription(skill.content),
        markdown: body.trim(),
        files: skill.files,
      });
    }
    project.library.skills = [
      ...project.library.skills,
      { id, format: "module" as const, description: skill.description, content, files: [] },
    ].sort(byId);
    owner.skills = owner.skills.map((entry) => (entry === skill ? consumerEntry(project, ownerKey, "skill", id) : entry));
  } else {
    const connection = owner.connections.find((entry) => entry.id === id)!;
    if (exists(project.library.connections)) throw new OwnershipError(`A shared connection named "${id}" already exists.`);
    refuseRelativeImports(id, [connection.source]);
    project.library.connections = [...project.library.connections, { ...connection, shared: undefined }].sort(byId);
    owner.connections = owner.connections.map((entry) => (entry === connection ? consumerEntry(project, ownerKey, "connection", id) : entry));
  }
}

function entries(owner: CapabilityOwner, kind: CapabilityKind): Array<Tool | Skill | Connection> {
  return kind === "tool" ? owner.tools : kind === "skill" ? owner.skills : owner.connections;
}

/**
 * Resolves a canvas resource id to the name of its shared definition, promoting
 * a resource defined in place first. Returns the name.
 */
function sharedNameFor(project: EveProject, ref: CapabilityRef): string {
  if (ref.shared) {
    const library = ref.kind === "tool" ? project.library.tools : ref.kind === "skill" ? project.library.skills : project.library.connections;
    if (!library.some((entry) => entry.id === ref.id)) throw new OwnershipError(`There is no shared ${ref.kind} "${ref.id}".`);
    return ref.id;
  }
  const owner = findOwner(project, ref.ownerKey);
  if (!owner) throw new OwnershipError(`There is no subagent "${ref.ownerKey}" in this project.`);
  const entry = entries(owner, ref.kind).find((candidate) => candidate.id === ref.id);
  if (!entry) throw new OwnershipError(`There is no ${ref.kind} "${ref.id}" there.`);
  if (entry.shared) return entry.shared;
  promote(project, owner, ref.ownerKey, ref.kind, ref.id);
  return ref.id;
}

export interface AttachRequest {
  /** Canvas id of the resource: "connection:#github", or "tool:researcher/browse" for one defined in place. */
  resource: string;
  /** Canvas id of the agent that should use it. */
  to: string;
}

/**
 * Lets another agent use a resource without copying it. The first time a
 * resource gains a second user it moves to `lib/`; after that each new user
 * only gets a re-export. Attaching a resource an agent already uses changes nothing.
 */
export function attachResource(project: EveProject, request: AttachRequest): EveProject {
  const ref = parseCapabilityRef(request.resource);
  if (!ref) throw new OwnershipError(`"${request.resource}" is not a tool, skill or connection.`);
  const toKey = ownerKeyOf(request.to);
  if (toKey === undefined) throw new OwnershipError(`"${request.to}" cannot use tools, skills or connections.`);
  const next = structuredClone(project);
  const target = findOwner(next, toKey);
  if (!target) throw new OwnershipError(`There is no local subagent "${toKey}" in this project.`);

  const targetEntries = entries(target, ref.kind);
  const expectedName = ref.shared ? ref.id : (findOwner(next, ref.ownerKey) ? entries(findOwner(next, ref.ownerKey)!, ref.kind).find((entry) => entry.id === ref.id)?.shared ?? ref.id : ref.id);
  if (!ref.shared && ref.ownerKey === toKey) return next;
  if (targetEntries.some((entry) => entry.shared === expectedName)) return next;
  // Check the name before anything moves, so a refused attach leaves the project untouched.
  if (targetEntries.some((entry) => entry.id === expectedName)) {
    throw new OwnershipError(`${ownerName(toKey)} already has a ${ref.kind} named "${expectedName}".`);
  }
  if (ref.kind === "tool" && target.subagents.some((subagent) => subagent.id === expectedName)) {
    throw new OwnershipError(`${ownerName(toKey)} has a subagent named "${expectedName}", and Eve rejects that collision.`);
  }

  const name = sharedNameFor(next, ref);
  const refreshed = findOwner(next, toKey)!;
  if (ref.kind === "tool") refreshed.tools = [...refreshed.tools, consumerEntry(next, toKey, "tool", name)].sort(byId);
  else if (ref.kind === "skill") refreshed.skills = [...refreshed.skills, consumerEntry(next, toKey, "skill", name)].sort(byId);
  else refreshed.connections = [...refreshed.connections, consumerEntry(next, toKey, "connection", name)].sort(byId);
  return next;
}

export interface DetachRequest {
  resource: string;
  from: string;
}

/**
 * Stops an agent using a resource. The definition is never lost: a shared one
 * stays in `lib/` even with no users left, and one defined in place moves to
 * `lib/` so it can be attached again.
 */
export function detachResource(project: EveProject, request: DetachRequest): EveProject {
  const ref = parseCapabilityRef(request.resource);
  if (!ref) throw new OwnershipError(`"${request.resource}" is not a tool, skill or connection.`);
  const fromKey = ownerKeyOf(request.from);
  if (fromKey === undefined) throw new OwnershipError(`"${request.from}" does not use tools, skills or connections.`);
  const next = structuredClone(project);
  const owner = findOwner(next, fromKey);
  if (!owner) throw new OwnershipError(`There is no local subagent "${fromKey}" in this project.`);

  let name: string;
  if (ref.shared) {
    name = ref.id;
  } else {
    if (ref.ownerKey !== fromKey) throw new OwnershipError(`${ownerName(fromKey)} does not use "${ref.id}".`);
    name = sharedNameFor(next, ref);
  }
  const before = entries(owner, ref.kind).length;
  if (ref.kind === "tool") owner.tools = owner.tools.filter((entry) => entry.shared !== name);
  else if (ref.kind === "skill") owner.skills = owner.skills.filter((entry) => entry.shared !== name);
  else owner.connections = owner.connections.filter((entry) => entry.shared !== name);
  if (entries(owner, ref.kind).length === before) throw new OwnershipError(`${ownerName(fromKey)} does not use "${name}".`);
  return next;
}

function removeShared(owner: CapabilityOwner, kind: CapabilityKind, name: string): void {
  if (kind === "tool") owner.tools = owner.tools.filter((entry) => entry.shared !== name);
  else if (kind === "skill") owner.skills = owner.skills.filter((entry) => entry.shared !== name);
  else owner.connections = owner.connections.filter((entry) => entry.shared !== name);
  for (const subagent of owner.subagents) if (subagent.kind === "local") removeShared(subagent, kind, name);
}

/**
 * Returns a new project without a tool, skill, connection, subagent or channel,
 * given its canvas id. Removing a shared definition removes every re-export of
 * it too. Generation then drops exactly those files.
 */
/**
 * Removes several entities in one pass, as a canvas selection does. Anything
 * inside a subagent that is also going is skipped, since removing the subagent
 * already takes it.
 */
export function removeEntities(project: EveProject, refs: readonly string[]): EveProject {
  const subagents = refs.filter((ref) => ref.startsWith("subagent:")).map((ref) => ref.slice("subagent:".length));
  const inside = (key: string) => subagents.some((parent) => key.startsWith(`${parent}/`));
  const kept = [...new Set(refs)].filter((ref) => {
    if (ref.startsWith("subagent:")) return !inside(ref.slice("subagent:".length));
    const capability = parseCapabilityRef(ref);
    if (!capability || capability.shared) return true;
    return !subagents.includes(capability.ownerKey) && !inside(capability.ownerKey);
  });
  return kept.reduce(removeEntity, project);
}

export function removeEntity(project: EveProject, ref: string): EveProject {
  const next = structuredClone(project);
  if (ref.startsWith("channel:")) {
    const id = ref.slice("channel:".length);
    if (!next.channels.some((channel) => channel.id === id)) throw new OwnershipError(`There is no channel "${id}".`);
    next.channels = next.channels.filter((channel) => channel.id !== id);
    return next;
  }
  if (ref.startsWith("subagent:")) {
    const key = ref.slice("subagent:".length);
    const parts = key.split("/");
    const id = parts.pop()!;
    const owner = findOwner(next, parts.join("/"));
    if (!owner || !owner.subagents.some((subagent) => subagent.id === id)) {
      throw new OwnershipError(`There is no subagent "${key}" in this project.`);
    }
    owner.subagents = owner.subagents.filter((subagent) => subagent.id !== id);
    return next;
  }

  const capability = parseCapabilityRef(ref);
  if (!capability) throw new OwnershipError(`"${ref}" is not something that can be removed.`);
  const { kind, id } = capability;
  if (capability.shared) {
    const library = kind === "tool" ? next.library.tools : kind === "skill" ? next.library.skills : next.library.connections;
    if (!library.some((entry) => entry.id === id)) throw new OwnershipError(`There is no shared ${kind} "${id}".`);
    if (kind === "tool") next.library.tools = next.library.tools.filter((entry) => entry.id !== id);
    if (kind === "skill") next.library.skills = next.library.skills.filter((entry) => entry.id !== id);
    if (kind === "connection") next.library.connections = next.library.connections.filter((entry) => entry.id !== id);
    removeShared(next, kind, id);
    return next;
  }

  const owner = findOwner(next, capability.ownerKey);
  if (!owner) throw new OwnershipError(`There is no subagent "${capability.ownerKey}" in this project.`);
  const list = entries(owner, kind);
  if (!list.some((entry) => entry.id === id)) throw new OwnershipError(`There is no ${kind} "${id}" there.`);
  if (kind === "tool") owner.tools = owner.tools.filter((entry) => entry.id !== id);
  if (kind === "skill") owner.skills = owner.skills.filter((entry) => entry.id !== id);
  if (kind === "connection") owner.connections = owner.connections.filter((entry) => entry.id !== id);
  return next;
}
