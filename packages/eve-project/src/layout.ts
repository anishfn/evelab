import type { AgentRoot } from "./types";

/**
 * Eve discovers an agent by walking fixed slots. The recommended layout keeps
 * them under `agent/`; the flat layout puts them at the package root. Both are
 * valid Eve projects, so evelab detects which one it was given and writes back
 * to the same place.
 */

const ROOT_MARKERS = ["agent.ts", "instructions.md", "instructions.ts"];
const SLOT_DIRECTORIES = ["instructions", "tools", "skills", "subagents", "connections", "channels", "schedules"];

export function detectAgentRoot(paths: readonly string[]): AgentRoot {
  const all = new Set(paths);
  if (ROOT_MARKERS.some((marker) => all.has(`agent/${marker}`))) return "agent";
  if (paths.some((path) => path.startsWith("agent/instructions/"))) return "agent";
  if (ROOT_MARKERS.some((marker) => all.has(marker))) return "";
  // A project with neither is new or empty; Eve recommends the nested layout.
  return "agent";
}

/** The repository path of a slot-relative path, e.g. `tools/x.ts` -> `agent/tools/x.ts`. */
export function agentPath(root: AgentRoot, relative: string): string {
  return root ? `${root}/${relative}` : relative;
}

/**
 * Where `#` imports resolve, from package.json's `imports["#*"]`: `"./agent/*"`
 * gives `"agent/"`, `"./*"` gives `""`. Undefined when the project has no such map.
 */
export function hashImportBase(packageJson: string | undefined): string | undefined {
  if (!packageJson) return undefined;
  try {
    const parsed = JSON.parse(packageJson) as { imports?: Record<string, unknown> };
    const target = parsed.imports?.["#*"];
    if (typeof target !== "string") return undefined;
    const match = /^\.\/(?:(.+)\/)?\*$/.exec(target);
    if (!match) return undefined;
    return match[1] ? `${match[1]}/` : "";
  } catch {
    return undefined;
  }
}

/** Joins a directory and a relative specifier, resolving `.` and `..`. */
export function resolveRelative(dir: string, specifier: string): string | undefined {
  const parts = dir.split("/").filter(Boolean);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

/** A relative import specifier from a directory to a file, always starting with `./` or `../`. */
export function relativeSpecifier(fromDir: string, toFile: string): string {
  const from = fromDir.split("/").filter(Boolean);
  const to = toFile.split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  const up = from.length - common;
  const rest = to.slice(common).join("/");
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
}

/** True when a set of paths is recognisably an Eve project, in either layout. */
export function looksLikeEveProject(paths: readonly string[]): boolean {
  const all = new Set(paths);
  return (
    ROOT_MARKERS.some((marker) => all.has(`agent/${marker}`) || all.has(marker)) ||
    paths.some((path) => path.startsWith("agent/instructions/"))
  );
}

/**
 * Members of an eve agent workspace: the `agents/<name>/` directories that hold
 * agent files and no `package.json` of their own. A root `agent/` directory
 * takes precedence, which is why a project that has one is never a workspace.
 */
export function workspaceMembers(paths: readonly string[]): string[] {
  if (paths.some((path) => path.startsWith("agent/"))) return [];
  const members = new Set<string>();
  const packaged = new Set<string>();
  for (const path of paths) {
    const match = /^agents\/([^/]+)\/(.+)$/.exec(path);
    if (!match) continue;
    const name = match[1]!;
    const rest = match[2]!;
    if (rest === "package.json") packaged.add(name);
    else if (ROOT_MARKERS.includes(rest) || SLOT_DIRECTORIES.some((slot) => rest.startsWith(`${slot}/`)) || rest.startsWith("agent/")) {
      members.add(name);
    }
  }
  return [...members].filter((name) => !packaged.has(name)).sort();
}
