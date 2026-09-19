<div align="center">

# evelab

### Draw your agent. Get real code.

**evelab is the open source visual IDE for AI agents built on [Eve](https://eve.dev).**
Design your agent on a canvas, plug in tools, skills, MCP servers and chat channels,
and ship production-ready TypeScript that you fully own.

[Website](https://evelab.vercel.app) · [Templates](https://evelab.vercel.app/templates) · [Eve docs](https://eve.dev/docs) · [Report a bug](https://github.com/anishfn/evelab/issues)

![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white) ![React Flow](https://img.shields.io/badge/React_Flow-12-ff0072) ![AI SDK](https://img.shields.io/badge/AI_SDK-7-black?logo=vercel) ![Vercel](https://img.shields.io/badge/Deploy-Vercel-black?logo=vercel)

</div>

---

## What is evelab?

[Eve](https://eve.dev) is a framework for building durable AI agents in TypeScript. An Eve agent is a folder of plain files, and you run it with the `eve` command.

**evelab is the visual layer on top.** It lets you see and build that folder as a diagram. You design the agent in evelab, the files it writes are a normal Eve project, and Eve runs it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/what-is-evelab-dark.png">
  <img alt="You design in evelab, evelab writes a normal Eve project, Eve runs it, and your agent answers in Slack, Discord, Teams and the web" src=".github/readme/what-is-evelab-light.png">
</picture>

### evelab and Eve, side by side

| | **Eve** (eve.dev) | **evelab** |
| --- | --- | --- |
| **What it is** | The framework and CLI that runs AI agents | A visual IDE for designing and editing Eve agents |
| **How you build** | Write each file by hand in your editor | Drag pieces onto a canvas, or edit the code. Both stay in sync |
| **Seeing the big picture** | Read through the folder | Every agent, tool, skill and channel in one live diagram |
| **Connecting services** | Write the connection and channel files | Pick Slack, Linear, an MCP server and more from a catalog |
| **What you end up with** | An Eve project | The exact same Eve project, with nothing extra added |
| **Running the agent** | `eve dev` and `eve deploy` | Your agent always runs on Eve |

evelab does not replace Eve. It makes Eve faster to learn, easier to see and quicker to build with.

---

## Why evelab

Building an AI agent usually means juggling a pile of files: instructions, tools, skills, sub-agents, connections to other services and the chat apps it lives in. It is hard to see how it all fits together.

evelab turns that pile into a picture.

- **See your whole agent at once.** Every piece is a card on a canvas, wired to the agent that uses it.
- **Build by dragging.** Drop a tool, skill, channel or MCP server onto an agent and evelab writes the file for you.
- **Keep real code.** Everything is a normal Eve project. Open it in any editor, commit it, run it with `eve dev`. No lock-in, no hidden format.
- **Change either side.** Edit the canvas and the code updates. Edit the code and the canvas redraws.

---

## Features

| | |
| --- | --- |
| **Visual canvas** | Agents, sub-agents, tools, skills, connections and channels drawn as one architecture. Tree, row or freeform layouts, notes and sections, undo and redo, minimap and keyboard shortcuts. |
| **Drag and drop building** | Drag a piece onto an agent to attach it. Share one tool or skill across many agents. Detach a wire to remove it. |
| **MCP and OpenAPI** | Paste an MCP server URL, see its tools and choose which ones your agent may call. Connect OpenAPI services too. |
| **Channels** | Put your agent in Slack, Discord, Microsoft Teams, Telegram, Twilio, GitHub, Linear and more. |
| **Skill import** | Bring in skills from GitHub or skills.sh. evelab shows every file and flags anything that can run code before it installs. |
| **Code editor** | Monaco for every file, a Zed style file explorer, autosave, quick open and a command palette. |
| **Built-in assistant** | An AI assistant (`Ctrl+I`) that reads your project and builds pieces through the same operations as the UI. |
| **GitHub, both ways** | Import any Eve repo, review changes side by side, commit, push and pull. |
| **Export anywhere** | Download a zip that runs with `npm install` and `eve dev`, or push it straight to GitHub. |
| **Teams ready** | Optional GitHub sign-in with private, per-account projects. |
| **Polished everywhere** | Light and dark themes, responsive from phone to wide screen, skeleton loading states and accessible controls. |

---

## How it works

The idea behind evelab is simple: **the files are the source of truth, and the canvas is a live view of them.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/how-it-works-dark.png">
  <img alt="The loop: evelab reads the project files, draws the canvas, you change something, and the code writer saves only what moved" src=".github/readme/how-it-works-light.png">
</picture>

1. **Read.** evelab parses the project into a typed model and turns it into a graph.
2. **Draw.** The canvas shows that graph: who owns what, who shares what and how messages reach the agent.
3. **Change.** When you drag a piece, rename something or edit code, evelab updates the exact file involved and leaves the rest of your code untouched.
4. **Save and redraw.** The project is read again, so the canvas always matches what is on disk.

---

## Architecture

evelab is a Next.js app on top of a small set of focused packages. Every service beyond the core is optional: with nothing configured it runs as a local, single-user tool on your filesystem.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/architecture-dark.png">
  <img alt="evelab architecture: the Next.js web app uses the core packages, which save to storage and talk to GitHub, AI Gateway and Vercel Sandbox" src=".github/readme/architecture-light.png">
</picture>

### The pieces

| Piece | What it does |
| --- | --- |
| **Web app** (`apps/web`) | The whole product: landing page, projects, canvas, agent editor, resource pages, file explorer, source control and the assistant. |
| **Project engine** (`packages/eve-project`) | Reads an Eve project into a typed model, validates it, turns it into a graph and writes code back. Its round trip is covered by tests so your files never lose anything. |
| **GitHub client** (`packages/github`) | Reads repository trees, works out what changed, plans safe pulls that never overwrite your edits, and makes commits. |
| **Auth** (`packages/auth`) | Optional GitHub sign-in through Better Auth, so each person only sees their own projects. |
| **Database** (`packages/db`) | Drizzle schema for users, sessions, project membership, repository links, and project files when running on Vercel. |

### Where your data lives

evelab picks the right place automatically:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/where-data-lives-dark.png">
  <img alt="Locally projects are real folders, on Vercel project files live in Postgres, and layouts and app state are kept separately" src=".github/readme/where-data-lives-light.png">
</picture>

Your project files are never mixed with evelab's own state. Canvas positions, repository links and history are kept separately, so a project folder is always a clean Eve project.

### What happens when you drag a tool onto an agent

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/drag-a-tool-dark.png">
  <img alt="Sequence: you drop a tool, the canvas asks a server action, the engine generates and writes the file, reads it back, and the new card appears" src=".github/readme/drag-a-tool-light.png">
</picture>

---

## Tech stack

| Area | Tools |
| --- | --- |
| Framework | Next.js 15 (App Router, Server Actions), React 19, TypeScript |
| Canvas | React Flow, Dagre for automatic layout |
| Editor | Monaco |
| UI | Tailwind CSS 4, Radix UI, shadcn/ui, Motion, Geist |
| AI | Vercel AI SDK, Vercel AI Gateway, Model Context Protocol SDK |
| Data | Postgres with Drizzle ORM, Vercel Blob |
| Auth | Better Auth with GitHub |
| Platform | Vercel, Vercel Sandbox, Vercel Workflow |
| Tooling | pnpm workspaces, Turborepo, Vitest, Playwright |

---

## Quick start

You need **Node.js 22.13+** and **pnpm**.

```bash
git clone https://github.com/anishfn/evelab.git
cd evelab
pnpm install
pnpm start
```

Open **http://localhost:3000** and create your first agent. That is it: no accounts, keys or database needed to get going.

For development with hot reload:

```bash
pnpm --filter @evelab/web dev
```

Your projects are saved in `.evelab/workspace/`. Each one is a normal Eve project, so you can `cd` into it and run `eve dev` at any time.

---

## Configuration

Everything below is optional. Copy [`.env.example`](.env.example) to `.env` and turn on only what you need.

| Variable | Turns on |
| --- | --- |
| `EVELAB_WORKSPACE` | A different folder for your projects |
| `AI_GATEWAY_API_KEY` | The live model list and the assistant |
| `EVELAB_ASSISTANT_MODEL` | A different assistant model (default `anthropic/claude-sonnet-5`) |
| `GITHUB_TOKEN` | Import, commit, push and pull with a personal access token |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | Source control through a GitHub App instead of a token |
| `DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | GitHub sign-in with private projects (set all of them, then run `pnpm --filter @evelab/db db:migrate`) |
| `BLOB_READ_WRITE_TOKEN` | Store layouts and app state in Vercel Blob |
| `EVELAB_STORAGE` | Force `fs` or `database` storage for projects |
| `NEXT_PUBLIC_SITE_URL` | The public address used for links and share images |

---

## Deploy on Vercel

1. Import this repository into Vercel and set the root directory to `apps/web`.
2. Add a Postgres database (for example Neon from the Vercel Marketplace) and set `DATABASE_URL`.
3. Create a GitHub OAuth app with the callback `https://<your-domain>/api/auth/callback/github`, then set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
4. Run `pnpm --filter @evelab/db db:migrate` against the database.
5. Optionally add `AI_GATEWAY_API_KEY`, `BLOB_READ_WRITE_TOKEN` and `NEXT_PUBLIC_SITE_URL`.

On Vercel, evelab stores project files in Postgres automatically, because a serverless disk does not keep files between requests.

---

## Repository

```text
apps/web               The evelab web app
packages/eve-project   Project engine: parse, generate, validate, graph
packages/github        GitHub client: trees, status, safe pulls, commits
packages/auth          GitHub sign-in with Better Auth
packages/db            Drizzle schema and migrations
```

## Development

```bash
pnpm test         # unit tests across the workspace
pnpm typecheck    # TypeScript across the workspace
pnpm build        # production build

cd apps/web
CHROMIUM_PATH=/usr/bin/chromium pnpm e2e   # browser tests
```

Stop any running dev server before `pnpm build`, since both use the `.next` folder.

---

## Roadmap

- [x] Visual canvas with drag and drop building
- [x] Tools, skills, sub-agents, connections, channels and schedules
- [x] MCP and OpenAPI connections
- [x] GitHub import, commit, push and pull
- [x] Built-in assistant
- [x] Private projects with GitHub sign-in
- [ ] **Runs:** chat with your agent and watch every tool call live, in Vercel Sandbox
- [ ] **Observability:** usage, cost, latency and errors for every run
- [ ] **One click deploys** to Vercel with `eve deploy`

---

## Contributing

Ideas, bug reports and pull requests are all welcome. Open an [issue](https://github.com/anishfn/evelab/issues) to talk about a change, or send a pull request with a short description of what it does.

<div align="center">

**If evelab helps you build agents, give it a star so more people can find it.**

</div>
