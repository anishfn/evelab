"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  type Connection,
  type EdgeMouseHandler,
  type IsValidConnection,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type OnNodeDrag,
} from "@xyflow/react";
import type { CanvasEdge, CanvasGraph, CanvasNode, CanvasNodeKind } from "@evelab/eve-project";
import {
  IconFullscreen,
  IconHelp,
  IconMinus,
  IconPlus,
  IconRedo,
  IconSettingsSliders,
  IconSidebarLeft,
  IconUndo,
  IconWireCurved,
  IconWireElbow,
  IconWireStraight,
} from "@/components/icons";
import {
  AnnotationContext,
  AnnotationToolbar,
  fromAnnotationNode,
  isAnnotationId,
  newAnnotation,
  NoteCard,
  SectionCard,
  toAnnotationNode,
  type AnnotationContextValue,
  type AnnotationNode,
} from "@/components/canvas/annotations";
import { CanvasConnectionLine, READABLE_ZOOM, RelationEdgePath, type EdgeBend, type RelationEdge } from "@/components/canvas/canvas-edge";
import {
  CanvasContext,
  CanvasNodeCard,
  isAgentKind,
  portHandle,
  isResourceKind,
  type CanvasContextValue,
  type CanvasNodeData,
  type CapabilityNode,
} from "@/components/canvas/canvas-node";
import {
  CanvasInspector,
  dialogIsOpen,
  InspectorColumn,
  type CreateKind,
  type Issue,
  type SourceState,
} from "@/components/canvas/canvas-inspector";
import { CanvasCreatePanel, type DraftKind } from "@/components/canvas/canvas-create-panel";
import { ResourceBrowser } from "@/components/canvas/resource-browser";
import { PhoneSheet, useMediaQuery, usePhone } from "@/components/phone-sheet";
import {
  CanvasPicker,
  CanvasToolbar,
  isAnnotationPiece,
  PICKER_WIDTH,
  PIECE_ORDER,
  type CanvasTool,
  type PieceKind,
} from "@/components/canvas/canvas-toolbar";
import {
  autoLayout,
  type Annotation,
  type LayoutMode,
  type NodeSizes,
  type Positions,
  type WireStyle,
} from "@/components/canvas/layout";
import type { ChatSdkOption } from "@/components/channel-form";
import { ConfirmDialog } from "@/components/confirm";
import { Icon, type IconData } from "@/components/icon";
import { KINDS } from "@/components/kinds";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attachResourceAction, changeOwnershipAction, detachResourceAction, removeNodeAction, removeNodesAction, saveLayoutAction } from "@/lib/actions";
import "@/app/canvas.css";

const nodeTypes = { capability: CanvasNodeCard, note: NoteCard, section: SectionCard };
const edgeTypes = { relation: RelationEdgePath };

type FlowNode = CapabilityNode | AnnotationNode;

export interface CanvasProps {
  projectId: string;
  graph: CanvasGraph;
  /** Contents of each node's file, so selecting a node opens instantly. */
  contents: Record<string, string>;
  positions: Positions;
  mode: LayoutMode;
  collapsed: string[];
  annotations: Annotation[];
  wireStyle: WireStyle;
  defaultModel: string;
  models: { id: string; label: string }[];
  /** Where the agent lives: "agent" or "" for the flat layout. */
  root: string;
  issues: Issue[];
  chatSdkAdapters: ChatSdkOption[];
  chatSdkStates: ChatSdkOption[];
}

type Result = { ok: true } | { ok: false; message: string };

type Point = { x: number; y: number };

/** What a Delete press will take once confirmed: cards, the wires it also detaches, and whether selected notes go with them. */
type Deletion = { nodes: CanvasNode[]; wires: { resource: string; agent: string }[]; annotations: boolean };

type HistoryEntry =
  | { type: "move"; before: Positions; after: Positions }
  | { type: "attach" | "detach"; resource: string; agent: string }
  | { type: "annotations"; before: Annotation[]; after: Annotation[] };

const LAYOUTS: { mode: LayoutMode; label: string }[] = [
  { mode: "hierarchical", label: "Hierarchical" },
  { mode: "horizontal", label: "Horizontal" },
  { mode: "freeform", label: "Freeform" },
];

/** Room for the floating panels, so fitting never tucks a card under them. */
const FIT_PADDING_WIDE = { top: "112px", right: "48px", bottom: "72px", left: "288px" } as const;
/** On a phone-width canvas the panels are sheets over the board, so a fit reserves no room beside it for them. */
const FIT_PADDING_NARROW = { top: "72px", right: "16px", bottom: "72px", left: "16px" } as const;

/** Matches the canvas container width in canvas.css below which the phone layout applies. */
function fitPadding() {
  const width = document.querySelector<HTMLElement>(".canvas-layout")?.clientWidth ?? 1024;
  return width <= 560 ? FIT_PADDING_NARROW : FIT_PADDING_WIDE;
}


/**
 * What a tap may land on without closing a phone sheet: the cards (a tap there
 * picks the card, and the inspector follows it) and the canvas's own controls.
 */
const SHEET_CONTROLS = ".react-flow__node, .canvas-toolbar-wrap, .canvas-view-menu, .canvas-bottom-left, .canvas-bottom-right, .canvas-picker";

/** What each wire colour means: the kind of card it leads to, and how the wire is drawn. */
const LEGEND: { kind: CanvasNodeKind; hint: string; dashed?: boolean }[] = [
  { kind: "subagent", hint: "Dashed wire: an agent contains this subagent", dashed: true },
  { kind: "tool", hint: "Solid wire: an agent has this tool" },
  { kind: "skill", hint: "Solid wire: an agent has this skill" },
  { kind: "connection", hint: "Solid wire: an agent connects to this MCP or OpenAPI service" },
  { kind: "channel", hint: "Dashed wire: this channel routes messages to the root agent", dashed: true },
];

const WIRE_OPTIONS: { value: WireStyle; label: string; icon: IconData }[] = [
  { value: "curved", label: "Curved", icon: IconWireCurved },
  { value: "elbow", label: "Elbow", icon: IconWireElbow },
  { value: "straight", label: "Straight", icon: IconWireStraight },
];

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

type Arrangement = "left" | "center" | "right" | "top" | "middle" | "bottom" | "row" | "column";

const ALIGNMENTS: { how: Arrangement; label: string }[] = [
  { how: "left", label: "Align left" },
  { how: "center", label: "Align centers" },
  { how: "right", label: "Align right" },
  { how: "top", label: "Align top" },
  { how: "middle", label: "Align middles" },
  { how: "bottom", label: "Align bottom" },
];

const DISTRIBUTIONS: { how: Arrangement; label: string }[] = [
  { how: "row", label: "Space evenly across" },
  { how: "column", label: "Space evenly down" },
];

/**
 * Where each chosen card goes to line up or spread out. Alignment takes two cards,
 * even spacing three, since two are always evenly spaced.
 */
function arranged(chosen: Node[], how: Arrangement): Positions | undefined {
  const spread = how === "row" || how === "column";
  if (chosen.length < (spread ? 3 : 2)) return undefined;
  const boxes = chosen.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    w: node.measured?.width ?? node.width ?? 0,
    h: node.measured?.height ?? node.height ?? 0,
  }));
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  if (spread) {
    const across = how === "row";
    const sorted = [...boxes].sort((a, b) => (across ? a.x - b.x : a.y - b.y));
    const room = (across ? right - left : bottom - top) - sorted.reduce((sum, box) => sum + (across ? box.w : box.h), 0);
    const gap = room / (sorted.length - 1);
    let at = across ? left : top;
    const placed: Positions = {};
    for (const box of sorted) {
      placed[box.id] = across ? { x: at, y: box.y } : { x: box.x, y: at };
      at += (across ? box.w : box.h) + gap;
    }
    return placed;
  }
  const place = (box: (typeof boxes)[number]): Point => {
    switch (how) {
      case "left":
        return { x: left, y: box.y };
      case "center":
        return { x: (left + right) / 2 - box.w / 2, y: box.y };
      case "right":
        return { x: right - box.w, y: box.y };
      case "top":
        return { x: box.x, y: top };
      case "middle":
        return { x: box.x, y: (top + bottom) / 2 - box.h / 2 };
      default:
        return { x: box.x, y: bottom - box.h };
    }
  };
  return Object.fromEntries(boxes.map((box) => [box.id, place(box)]));
}

/** Align and space-evenly entries, shared by the view menu, the selection bar and the right-click menu. */
function ArrangeItems({ count, onArrange }: { count: number; onArrange: (how: Arrangement) => void }) {
  return (
    <>
      {ALIGNMENTS.map((item) => (
        <DropdownMenuItem key={item.how} disabled={count < 2} onSelect={() => onArrange(item.how)}>
          {item.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      {DISTRIBUTIONS.map((item) => (
        <DropdownMenuItem key={item.how} disabled={count < 3} onSelect={() => onArrange(item.how)}>
          {item.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** The same entries tucked under one "Arrange" row, for menus that hold more than this. */
function ArrangeMenu({ count, onArrange }: { count: number; onArrange: (how: Arrangement) => void }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={count < 2}>Arrange</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        <ArrangeItems count={count} onArrange={onArrange} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

const SHORTCUTS: [string, string][] = [
  ["1 to 5", "Add a subagent, tool, skill, connection or channel"],
  ["6 or N", "New note"],
  ["7 or S", "New section"],
  ["V", "Select"],
  ["H", "Hand"],
  ["F", "Focus selection"],
  ["0", "Fit everything"],
  ["G", "Go to root"],
  ["Space", "Hold to pan"],
  ["Shift drag", "Select an area"],
  ["Ctrl Z", "Undo"],
  ["Ctrl Shift Z", "Redo"],
  ["Ctrl C / V", "Attach copies to an agent"],
  ["Ctrl D", "Duplicate notes"],
  ["Arrows", "Nudge the selection, Shift for more"],
  ["Delete", "Delete or detach everything selected"],
];

function isCapability(node: Node): node is CapabilityNode {
  return node.type === "capability";
}

/** "tool:#github" or "tool:researcher/github" to "github". */
function refName(ref: string): string {
  return ref.slice(Math.max(ref.lastIndexOf("#"), ref.lastIndexOf("/"), ref.indexOf(":")) + 1);
}

/** The id a resource has once it lives in lib/, which is where attach and detach leave it. */
function sharedId(ref: string): string {
  return `${ref.slice(0, ref.indexOf(":"))}:#${refName(ref)}`;
}

function nodeData(node: CanvasNode, fresh: boolean): CanvasNodeData {
  const { name, detail, description, counts, filePath, kind, shared } = node;
  return { name, detail, description, counts, filePath, kind, shared, usedBy: node.usedBy?.length, fresh };
}

function sameData(previous: CanvasNodeData, node: CanvasNode): boolean {
  return (
    previous.name === node.name &&
    previous.detail === node.detail &&
    previous.description === node.description &&
    previous.filePath === node.filePath &&
    previous.shared === node.shared &&
    previous.usedBy === node.usedBy?.length &&
    JSON.stringify(previous.counts) === JSON.stringify(node.counts)
  );
}

function toEdge(
  edge: Pick<CanvasEdge, "source" | "target" | "relation">,
  kind: CanvasNodeKind,
  bend: EdgeBend = "middle",
): RelationEdge {
  return {
    id: `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: "relation",
    sourceHandle: portHandle(kind),
    className: edgeClass(kind, edge.relation),
    interactionWidth: 18,
    data: { relation: edge.relation, kind, bend, detachable: isResourceKind(kind) },
  };
}

function edgeClass(kind: CanvasNodeKind, relation: CanvasEdge["relation"] | undefined, extra?: string): string {
  const structure = relation === "contains" || relation === "routes to";
  return [`edge-${kind}`, structure ? "relation-structure" : "relation-use", extra].filter(Boolean).join(" ");
}

function snapshot(nodes: Node[]): Positions {
  return Object.fromEntries(nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }]));
}

/** What folding an agent hides: its subagents, and resources nobody visible still uses. */
function foldedNodes(graph: CanvasGraph, collapsed: Set<string>) {
  const hidden = new Set<string>();
  const counts = new Map<string, number>();
  if (collapsed.size === 0) return { hidden, counts };
  const out = new Map<string, CanvasEdge[]>();
  const consumers = new Map<string, string[]>();
  for (const edge of graph.edges) {
    out.set(edge.source, [...(out.get(edge.source) ?? []), edge]);
    consumers.set(edge.target, [...(consumers.get(edge.target) ?? []), edge.source]);
  }
  const hideUnder = (id: string, owner: string) => {
    for (const edge of out.get(id) ?? []) {
      if (hidden.has(edge.target)) continue;
      const users = consumers.get(edge.target) ?? [];
      if (edge.relation !== "contains" && !users.every((user) => user === id || hidden.has(user) || collapsed.has(user))) {
        continue;
      }
      hidden.add(edge.target);
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
      if (edge.relation === "contains") hideUnder(edge.target, owner);
    }
  };
  for (const id of collapsed) if (!hidden.has(id)) hideUnder(id, id);
  return { hidden, counts };
}

/** What the delete confirmation says: the one file it removes, or what a larger selection holds. */
function deletionCopy(nodes: CanvasNode[]): { title: string; description: string; confirmLabel: string } {
  const [only] = nodes;
  if (nodes.length <= 1) {
    return {
      title: `Delete ${only?.name ?? ""}?`,
      confirmLabel: "Delete",
      description:
        only?.kind === "subagent"
          ? "This removes the subagent's folder with everything defined inside it. Commit first if you might want it back."
          : only?.shared
            ? `This removes ${only.filePath} and the re-export from all ${only.usedBy?.length ?? 0} agents using it.`
            : `This removes ${only?.filePath ?? "the file"} from the project. Commit first if you might want it back.`,
    };
  }
  const names = nodes.slice(0, 4).map((node) => node.name);
  const rest = nodes.length - names.length;
  const listed = rest > 0 ? `${names.join(", ")} and ${rest} more` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const folders = nodes.some((node) => node.kind === "subagent") ? " Subagents go with everything inside their folders." : "";
  return {
    title: `Delete ${nodes.length} items?`,
    confirmLabel: `Delete ${nodes.length}`,
    description: `This removes ${listed} from the project.${folders} Commit first if you might want them back.`,
  };
}

function typingInto(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true'], .monaco-editor"));
}

function ToolbarButton({
  label,
  tooltip,
  onClick,
  className,
  disabled,
  children,
}: {
  label: string;
  tooltip: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={label}
          className={className}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/** How long the pointer rests on a card or wire before its neighbourhood lights up, and before it lets go. */
const HOVER_DELAY = 90;
const UNHOVER_DELAY = 60;

/** Only the zoom, so a pan never re-renders what reads it. */
const selectZoom = (state: { transform: [number, number, number] }) => state.transform[2];

/**
 * Dots that stay a steady size on screen. React Flow scales dots with zoom, so
 * zoomed out they vanish; here the dot size counters the zoom, and the spacing
 * doubles in steps so a zoomed-out board is dotted, not grey.
 */
function DottedBackground() {
  const zoom = useStore(selectZoom);
  const step = zoom >= 0.6 ? 1 : 2 ** Math.ceil(Math.log2(0.6 / zoom));
  return <Background variant={BackgroundVariant.Dots} gap={20 * step} size={1.3 / zoom} color="var(--canvas-dot-color)" />;
}

/** Marks a zoomed-out board on the surface, so quiet wire labels hide from CSS rather than remounting. */
function ZoomTier({ surface }: { surface: RefObject<HTMLDivElement | null> }) {
  const far = useStore((state) => state.transform[2] < READABLE_ZOOM);
  useLayoutEffect(() => {
    surface.current?.toggleAttribute("data-far", far);
  }, [far, surface]);
  return null;
}

/** Its own component so zooming re-renders the zoom readout, not the canvas. */
function ZoomControls() {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const zoom = useStore(selectZoom);
  return (
    <div className="canvas-float canvas-zoom" role="toolbar" aria-label="Zoom">
      <ToolbarButton label="Zoom out" tooltip="Zoom out" onClick={() => void zoomOut({ duration: 200 })}>
        <Icon icon={IconMinus} />
      </ToolbarButton>
      <ToolbarButton
        label="Reset zoom to 100%"
        tooltip="Reset to 100%"
        className="w-12 font-mono text-xs tabular-nums text-muted-foreground"
        onClick={() => void zoomTo(1, { duration: 200 })}
      >
        {Math.round(zoom * 100)}%
      </ToolbarButton>
      <ToolbarButton label="Zoom in" tooltip="Zoom in" onClick={() => void zoomIn({ duration: 200 })}>
        <Icon icon={IconPlus} />
      </ToolbarButton>
      <ToolbarButton
        label="Fit to screen"
        tooltip="Fit everything (0)"
        onClick={() => void fitView({ duration: 280, padding: fitPadding(), maxZoom: 1 })}
      >
        <Icon icon={IconFullscreen} />
      </ToolbarButton>
    </div>
  );
}

function CanvasInner(props: CanvasProps) {
  const { projectId, graph, contents, positions, issues, root } = props;
  const router = useRouter();
  const { fitView, getNodes, getNode, getEdges, getIntersectingNodes, setCenter, getZoom, screenToFlowPosition } = useReactFlow<
    FlowNode,
    RelationEdge
  >();

  // Columns were retired when cards gained ports; a saved columns layout opens as hierarchical.
  const initialMode: LayoutMode = props.mode === "vertical" ? "hierarchical" : props.mode;
  const [mode, setMode] = useState<LayoutMode>(initialMode);
  const [collapsed, setCollapsed] = useState(() => new Set(props.collapsed));
  const [snap, setSnap] = useState(false);
  const [locked, setLocked] = useState(false);
  const [minimap, setMinimap] = useState(false);
  const [wireStyle, setWireStyle] = useState<WireStyle>(props.wireStyle);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [panelOpen, setPanelOpen] = useState(true);
  // A narrow board (a phone, or a tablet beside the sidebar) shows the panel as a sheet over everything,
  // so there the board opens first and the panel waits to be asked for. The board's own width decides, not the window's.
  useEffect(() => {
    if ((layoutRef.current?.clientWidth ?? window.innerWidth) < 700) setPanelOpen(false);
  }, []);
  const [summaryOpen, setSummaryOpen] = useState(false);
  // The wire under the pointer, which shows its label; the rest of hovering never touches React state.
  const [hoveredEdge, setHoveredEdge] = useState<string>();
  const hoverTimer = useRef<number>(undefined);
  // The board or a card is moving under the pointer, so nothing lights up. Two flags, since a card
  // dragged to the edge pans the board, and that pan ending must not wake hovering mid-drag.
  const moving = useRef({ board: false, card: false });
  const lit = useRef<Element[]>([]);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  /**
   * Lights up what a card or wire touches by marking those few elements in the DOM, and dims the rest from CSS.
   * Doing it through React re-rendered every card and wire on each hover, which was most of the canvas's lag.
   */
  const light = useCallback((target: { type: "node" | "edge"; id: string } | undefined) => {
    for (const element of lit.current) element.removeAttribute("data-lit");
    lit.current = [];
    const surface = surfaceRef.current;
    if (!surface) return;
    if (!target || isAnnotationId(target.id)) {
      surface.removeAttribute("data-focus");
      return;
    }
    const nodes = new Set<string>();
    const wires: string[] = [];
    for (const edge of graphRef.current.edges) {
      const id = `${edge.source}->${edge.target}`;
      const touches = target.type === "edge" ? id === target.id : edge.source === target.id || edge.target === target.id;
      if (!touches) continue;
      wires.push(id);
      nodes.add(edge.source).add(edge.target);
    }
    if (target.type === "node") nodes.add(target.id);
    const selectors = [
      ...[...nodes].map((id) => `.react-flow__node[data-id="${CSS.escape(id)}"]`),
      ...wires.map((id) => `.react-flow__edge[data-id="${CSS.escape(id)}"]`),
    ];
    if (selectors.length > 0) lit.current = [...surface.querySelectorAll(selectors.join(","))];
    for (const element of lit.current) element.setAttribute("data-lit", "");
    surface.setAttribute("data-focus", "");
  }, []);

  // It waits for the pointer to settle on something, so sweeping across the board does not flash it,
  // and never fires while the board slides under a still cursor.
  const hoverSoon = useCallback(
    (next: { type: "node" | "edge"; id: string } | undefined) => {
      window.clearTimeout(hoverTimer.current);
      if (moving.current.board || moving.current.card) return;
      hoverTimer.current = window.setTimeout(
        () => {
          light(next);
          setHoveredEdge(next?.type === "edge" ? next.id : undefined);
        },
        next ? HOVER_DELAY : UNHOVER_DELAY,
      );
    },
    [light],
  );
  const unhover = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    light(undefined);
    setHoveredEdge(undefined);
  }, [light]);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const [attachTarget, setAttachTarget] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const [settling, setSettling] = useState(false);
  const [draft, setDraft] = useState<{ kind: DraftKind; owner?: string }>();
  const [picker, setPicker] = useState<{ kind: CreateKind; target: string; at: Point; origin: string; instant: boolean }>();
  const [confirmDelete, setConfirmDelete] = useState<Deletion>();
  const [notice, setNotice] = useState<{ text: string; tone?: "error"; undo?: boolean }>();
  const [pendingCount, setPendingCount] = useState(0);
  const [sourceState, setSourceState] = useState<SourceState>("saved");
  const [editingId, setEditingId] = useState<string>();
  const [annotations, setAnnotations] = useState<AnnotationNode[]>(() => props.annotations.map(toAnnotationNode));

  const layoutState = useRef<{ mode: LayoutMode; collapsed: Set<string>; wireStyle: WireStyle }>({
    mode: initialMode,
    collapsed: new Set(props.collapsed),
    wireStyle: props.wireStyle,
  });
  const annotationsRef = useRef(annotations);
  const savedAnnotations = useRef(JSON.stringify(props.annotations));
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Positions for nodes the server has not sent yet, or that are about to change id. */
  const pending = useRef<Positions>({});
  const history = useRef<{ past: HistoryEntry[]; future: HistoryEntry[] }>({ past: [], future: [] });
  const dragStart = useRef<Positions>({});
  const clipboard = useRef<{ resources: string[]; annotations: Annotation[] }>({ resources: [], annotations: [] });
  const renderedGraph = useRef(graph);

  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const kinds = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node.kind] as const)), [graph.nodes]);
  const graphEdges = useMemo(() => {
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    for (const edge of graph.edges) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    }
    return graph.edges.map((edge) =>
      toEdge(
        edge,
        kinds.get(edge.target) ?? "tool",
        (incoming.get(edge.target) ?? 0) > 1 ? "target" : (outgoing.get(edge.source) ?? 0) > 1 ? "source" : "middle",
      ),
    );
  }, [graph.edges, kinds]);

  const [nodes, setNodes, onGraphNodesChange] = useNodesState<CapabilityNode>(
    useMemo(() => {
      const layout = { ...autoLayout(graph, initialMode === "freeform" ? "hierarchical" : initialMode), ...positions };
      return graph.nodes.map((node) => ({
        id: node.id,
        type: "capability" as const,
        position: layout[node.id] ?? { x: 0, y: 0 },
        data: nodeData(node, false),
      }));
      // Initial state only; later graphs are merged in the effect below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelationEdge>(graphEdges);

  /** Rendered card sizes, so layouts space real cards rather than estimates. */
  const measuredSizes = useCallback((): NodeSizes => {
    const sizes: NodeSizes = new Map();
    for (const node of getNodes()) {
      if (isCapability(node) && node.measured?.width && node.measured.height) {
        sizes.set(node.id, { width: node.measured.width, height: node.measured.height });
      }
    }
    return sizes;
  }, [getNodes]);

  // Fit once the cards have real sizes; fitting on mount measures placeholder boxes.
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (!initialized || fitted.current) return;
    fitted.current = true;
    const startMode = layoutState.current.mode;
    // Nothing arranged by hand yet: lay out again with the measured sizes before fitting.
    if (Object.keys(positions).length === 0 && startMode !== "freeform") {
      const placed = autoLayout(graph, startMode, undefined, measuredSizes());
      setNodes((current) => current.map((node) => (placed[node.id] ? { ...node, position: placed[node.id]! } : node)));
    }
    requestAnimationFrame(() => requestAnimationFrame(() => void fitView({ padding: fitPadding(), maxZoom: 1 })));
    // A relayout lands a frame or two later; fitting again once it has settled keeps a narrow screen from opening on an empty corner.
    setTimeout(() => void fitView({ padding: fitPadding(), maxZoom: 1 }), 320);
    // Runs once, when the cards are first measured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized]);

  // An arranged layout takes new cards in once they are measured: everything
  // moves to its place in the arrangement and the view follows.
  const relayout = useRef(false);
  useEffect(() => {
    if (!initialized || !relayout.current) return;
    relayout.current = false;
    const mode = layoutState.current.mode;
    if (mode === "freeform") return;
    applyPositions(autoLayout(graph, mode, foldedNodes(graph, layoutState.current.collapsed).hidden, measuredSizes()));
    requestAnimationFrame(() => void fitView({ duration: 360, padding: fitPadding(), maxZoom: 1 }));
    // Runs when newly added cards finish measuring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized]);

  // Handles move with the layout mode; React Flow keeps measured handle positions until told to measure again.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const frame = requestAnimationFrame(() => updateNodeInternals(getNodes().filter(isCapability).map((node) => node.id)));
    return () => cancelAnimationFrame(frame);
  }, [getNodes, mode, updateNodeInternals]);

  const usesSet = useMemo(() => new Set(edges.map((edge) => `${edge.source}|${edge.target}`)), [edges]);
  const uses = useCallback(
    (agent: string, resource: string) => usesSet.has(`${agent}|${resource}`) || usesSet.has(`${agent}|${sharedId(resource)}`),
    [usesSet],
  );

  // Merge a refreshed graph into the live nodes, keeping positions, measurements
  // and selection for everything that already exists.
  useEffect(() => {
    if (renderedGraph.current === graph) return;
    renderedGraph.current = graph;
    const auto = autoLayout(graph, layoutState.current.mode === "freeform" ? "hierarchical" : layoutState.current.mode);
    if (layoutState.current.mode !== "freeform" && graph.nodes.some((node) => !getNode(node.id))) relayout.current = true;
    setNodes((current) => {
      const existing = new Map(current.map((node) => [node.id, node]));
      const placedChildren = new Map<string, number>();
      return graph.nodes.map((node) => {
        const previous = existing.get(node.id);
        if (previous) {
          return sameData(previous.data, node) ? previous : { ...previous, data: nodeData(node, previous.data.fresh) };
        }
        let position = pending.current[node.id] ?? positions[node.id];
        delete pending.current[node.id];
        if (!position) {
          // A new node sits under the agent it belongs to, beside anything added with it.
          const parent = graph.edges.find((edge) => edge.target === node.id);
          const owner = parent ? existing.get(parent.source) : undefined;
          if (owner) {
            // Past the children it already has, so a second addition never lands on the first.
            const siblings = graph.edges.filter((edge) => edge.source === owner.id && existing.has(edge.target)).length;
            const index = placedChildren.get(owner.id) ?? siblings;
            placedChildren.set(owner.id, index + 1);
            const horizontal = layoutState.current.mode === "horizontal";
            position = horizontal
              ? { x: owner.position.x + (owner.measured?.width ?? 260) + 120, y: owner.position.y + index * 132 }
              : { x: owner.position.x + index * 256, y: owner.position.y + (owner.measured?.height ?? 140) + 96 };
          }
        }
        return {
          id: node.id,
          type: "capability" as const,
          position: position ?? auto[node.id] ?? { x: 0, y: 0 },
          data: nodeData(node, true),
        };
      });
    });
    setEdges((current) => {
      const selected = new Set(current.filter((edge) => edge.selected).map((edge) => edge.id));
      return graphEdges.map((edge) => (selected.has(edge.id) ? { ...edge, selected: true } : edge));
    });
  }, [graph, graphEdges, positions, setEdges, setNodes]);

  const flushRef = useRef<(() => void) | undefined>(undefined);
  const persist = useCallback(() => {
    clearTimeout(saveTimer.current);
    const save = () => {
      flushRef.current = undefined;
      const next: Positions = {};
      for (const node of getNodes()) {
        if (isCapability(node)) next[node.id] = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
      }
      for (const [id, position] of Object.entries(pending.current)) {
        next[id] = { x: Math.round(position.x), y: Math.round(position.y) };
      }
      void saveLayoutAction(projectId, next, {
        mode: layoutState.current.mode,
        collapsed: [...layoutState.current.collapsed],
        annotations: annotationsRef.current.map(fromAnnotationNode),
        wireStyle: layoutState.current.wireStyle,
      });
    };
    flushRef.current = save;
    saveTimer.current = setTimeout(save, 400);
  }, [getNodes, projectId]);

  // Leaving the canvas inside the debounce window still saves what was just drawn.
  useEffect(() => {
    const flush = () => {
      clearTimeout(saveTimer.current);
      flushRef.current?.();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // Annotations save whenever what they say or where they are changes, not when they are merely selected.
  useEffect(() => {
    const serialized = JSON.stringify(annotations.map(fromAnnotationNode));
    if (serialized === savedAnnotations.current) return;
    savedAnnotations.current = serialized;
    persist();
  }, [annotations, persist]);

  const say = useCallback((next: { text: string; tone?: "error"; undo?: boolean } | undefined) => {
    clearTimeout(noticeTimer.current);
    setNotice(next);
    if (next && next.tone !== "error") noticeTimer.current = setTimeout(() => setNotice(undefined), 5000);
  }, []);

  const settle = useCallback(() => {
    clearTimeout(settleTimer.current);
    setSettling(true);
    settleTimer.current = setTimeout(() => setSettling(false), 360);
  }, []);

  const record = useCallback((entry: HistoryEntry) => {
    history.current.past = [...history.current.past.slice(-99), entry];
    history.current.future = [];
  }, []);

  const run = useCallback(
    async (task: () => Promise<Result>): Promise<boolean> => {
      setPendingCount((count) => count + 1);
      try {
        const result = await task();
        if (!result.ok) say({ text: result.message, tone: "error" });
        return result.ok;
      } catch {
        say({ text: "Something went wrong writing the project.", tone: "error" });
        return false;
      } finally {
        setPendingCount((count) => count - 1);
        router.refresh();
      }
    },
    [router, say],
  );

  /** A resource keeps its place on the canvas when attaching or detaching moves it to lib/. */
  const carry = useCallback(
    (resource: string) => {
      const node = getNode(resource);
      if (node && !resource.includes("#")) pending.current[sharedId(resource)] = node.position;
    },
    [getNode],
  );

  const attach = useCallback(
    async (resource: string, agent: string, options: { record?: boolean } = {}) => {
      const kind = resource.slice(0, resource.indexOf(":")) as CanvasNodeKind;
      const agentName = byId.get(agent)?.name ?? agent;
      if (!isResourceKind(kind) || !isAgentKind(kinds.get(agent))) return;
      if (uses(agent, resource)) {
        say({ text: `${agentName} already uses ${refName(resource)}` });
        return;
      }
      carry(resource);
      const relation = kind === "tool" ? "has tool" : kind === "skill" ? "has skill" : "connects to";
      setEdges((current) => [...current, toEdge({ source: agent, target: resource, relation }, kind, "middle")]);
      const ok = await run(() => attachResourceAction({ projectId, resource, agent }));
      if (!ok) {
        setEdges(graphEdges);
        return;
      }
      if (options.record !== false) record({ type: "attach", resource: sharedId(resource), agent });
      say({ text: `${refName(resource)} attached to ${agentName}`, undo: options.record !== false });
    },
    [byId, carry, graphEdges, kinds, projectId, record, run, say, setEdges, uses],
  );

  const detach = useCallback(
    async (resource: string, agent: string, options: { record?: boolean } = {}) => {
      const agentName = byId.get(agent)?.name ?? agent;
      carry(resource);
      setEdges((current) =>
        current.filter((edge) => !(edge.source === agent && (edge.target === resource || edge.target === sharedId(resource)))),
      );
      const ok = await run(() => detachResourceAction({ projectId, resource, agent }));
      if (!ok) {
        setEdges(graphEdges);
        return;
      }
      if (options.record !== false) record({ type: "detach", resource: sharedId(resource), agent });
      say({ text: `${refName(resource)} detached from ${agentName}`, undo: options.record !== false });
    },
    [byId, carry, graphEdges, projectId, record, run, say, setEdges],
  );

  const applyPositions = useCallback(
    (placed: Positions) => {
      settle();
      setNodes((current) => current.map((node) => (placed[node.id] ? { ...node, position: placed[node.id]! } : node)));
      setAnnotations((current) =>
        current.map((node) => (placed[node.id] ? ({ ...node, position: placed[node.id]! } as AnnotationNode) : node)),
      );
      persist();
    },
    [persist, setNodes, settle],
  );

  const applyAnnotations = useCallback((list: Annotation[]) => {
    setEditingId(undefined);
    setAnnotations(list.map(toAnnotationNode));
  }, []);

  const undo = useCallback(() => {
    const entry = history.current.past.pop();
    if (!entry) return;
    history.current.future.push(entry);
    say(undefined);
    if (entry.type === "move") applyPositions(entry.before);
    else if (entry.type === "annotations") applyAnnotations(entry.before);
    else if (entry.type === "attach") void detach(entry.resource, entry.agent, { record: false });
    else void attach(entry.resource, entry.agent, { record: false });
  }, [applyAnnotations, applyPositions, attach, detach, say]);

  const redo = useCallback(() => {
    const entry = history.current.future.pop();
    if (!entry) return;
    history.current.past.push(entry);
    if (entry.type === "move") applyPositions(entry.after);
    else if (entry.type === "annotations") applyAnnotations(entry.after);
    else if (entry.type === "attach") void attach(entry.resource, entry.agent, { record: false });
    else void detach(entry.resource, entry.agent, { record: false });
  }, [applyAnnotations, applyPositions, attach, detach]);

  const applyLayout = useCallback(
    (next: LayoutMode) => {
      setMode(next);
      layoutState.current.mode = next;
      if (next !== "freeform") {
        const placed = autoLayout(graph, next, foldedNodes(graph, layoutState.current.collapsed).hidden, measuredSizes());
        record({ type: "move", before: snapshot(getNodes().filter(isCapability)), after: placed });
        applyPositions(placed);
        requestAnimationFrame(() => void fitView({ duration: 360, padding: fitPadding(), maxZoom: 1 }));
      }
      persist();
    },
    [applyPositions, fitView, getNodes, graph, measuredSizes, persist, record],
  );

  /** A card moved by hand leaves the arranged layout, as dragging one does. */
  const leaveLayout = useCallback((moved: Node[]) => {
    if (moved.some(isCapability) && layoutState.current.mode !== "freeform") {
      layoutState.current.mode = "freeform";
      setMode("freeform");
    }
  }, []);

  const arrange = useCallback(
    (how: Arrangement) => {
      const chosen = getNodes().filter((node) => node.selected && !node.hidden);
      const after = arranged(chosen, how);
      if (!after) return;
      record({ type: "move", before: snapshot(chosen), after });
      leaveLayout(chosen);
      applyPositions(after);
    },
    [applyPositions, getNodes, leaveLayout, record],
  );

  /** Arrow keys move the selection; a run of presses is one step to undo. */
  const lastNudge = useRef<{ entry: HistoryEntry; at: number }>(undefined);
  const nudge = useCallback(
    (dx: number, dy: number) => {
      const chosen = getNodes().filter((node) => node.selected && !node.hidden);
      if (chosen.length === 0) return false;
      const after: Positions = Object.fromEntries(
        chosen.map((node) => [node.id, { x: node.position.x + dx, y: node.position.y + dy }]),
      );
      const last = lastNudge.current;
      const past = history.current.past;
      if (last && past.at(-1) === last.entry && performance.now() - last.at < 1000 && last.entry.type === "move") {
        Object.assign(last.entry.after, after);
        last.at = performance.now();
      } else {
        const entry: HistoryEntry = { type: "move", before: snapshot(chosen), after };
        record(entry);
        lastNudge.current = { entry, at: performance.now() };
      }
      leaveLayout(chosen);
      setNodes((current) => current.map((node) => (after[node.id] ? { ...node, position: after[node.id]! } : node)));
      setAnnotations((current) =>
        current.map((node) => (after[node.id] ? ({ ...node, position: after[node.id]! } as AnnotationNode) : node)),
      );
      persist();
      return true;
    },
    [getNodes, leaveLayout, persist, record, setNodes],
  );

  const toggleCollapse = useCallback(
    (id: string) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        layoutState.current.collapsed = next;
        return next;
      });
      persist();
    },
    [persist],
  );

  const clearSelection = useCallback(() => {
    setNodes((current) => (current.some((node) => node.selected) ? current.map((node) => ({ ...node, selected: false })) : current));
    setEdges((current) => (current.some((edge) => edge.selected) ? current.map((edge) => ({ ...edge, selected: false })) : current));
    setAnnotations((current) =>
      current.some((node) => node.selected) ? current.map((node) => ({ ...node, selected: false }) as AnnotationNode) : current,
    );
  }, [setEdges, setNodes]);

  const select = useCallback(
    (id: string) => {
      setDraft(undefined);
      setSummaryOpen(false);
      clearSelection();
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, selected: true } : node)));
      const node = getNode(id);
      if (node) {
        const width = node.measured?.width ?? 240;
        const height = node.measured?.height ?? 100;
        void setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: Math.max(getZoom(), 0.8), duration: 320 });
      }
    },
    [clearSelection, getNode, getZoom, setCenter, setNodes],
  );

  const create = useCallback((kind: CreateKind, owner?: string) => {
    setPicker(undefined);
    setSummaryOpen(false);
    // Skills install at the root, so only other kinds are created for a subagent.
    setDraft({ kind, owner: owner && owner !== "agent" && kind !== "channel" && kind !== "skill" ? owner : undefined });
  }, []);

  const agentAt = useCallback(
    (point: Point): string | undefined => {
      for (const element of document.elementsFromPoint(point.x, point.y)) {
        const id = (element as HTMLElement).closest<HTMLElement>(".react-flow__node")?.dataset.id;
        if (id && isAgentKind(kinds.get(id))) return id;
      }
      return undefined;
    },
    [kinds],
  );

  const overCanvas = useCallback((point: Point) => {
    const target = document.elementFromPoint(point.x, point.y);
    return Boolean(target && surfaceRef.current?.contains(target) && !target.closest(".canvas-float"));
  }, []);

  /**
   * A piece from the toolbar asks which one to add. With nothing to choose from,
   * such as a new subagent or channel, it goes straight to the create form.
   */
  const openPicker = useCallback(
    (kind: CreateKind, options: { drop?: Point; anchor?: DOMRect; keyboard?: boolean } = {}) => {
      setAttachTarget(undefined);
      const chosen = getNodes().filter((node): node is CapabilityNode => node.selected === true && isCapability(node));
      const selectedAgent = chosen.length === 1 && isAgentKind(chosen[0]!.data.kind) ? chosen[0]!.id : undefined;
      const target =
        kind === "channel" ? "agent" : options.drop ? (agentAt(options.drop) ?? "agent") : (selectedAgent ?? "agent");
      const choices = isResourceKind(kind) ? graph.nodes.filter((node) => node.kind === kind && !uses(target, node.id)) : [];
      const rect = layoutRef.current?.getBoundingClientRect();
      if (choices.length === 0 || !rect) {
        create(kind, target);
        return;
      }
      const screen = options.drop
        ? { x: options.drop.x + 12, y: options.drop.y + 12 }
        : options.anchor
          ? { x: options.anchor.left + options.anchor.width / 2 - PICKER_WIDTH / 2, y: options.anchor.bottom + 36 }
          : { x: rect.left + rect.width / 2 - PICKER_WIDTH / 2, y: rect.top + 104 };
      const at = {
        x: Math.max(12, Math.min(screen.x - rect.left, rect.width - PICKER_WIDTH - 12)),
        y: Math.max(12, Math.min(screen.y - rect.top, rect.height - 400)),
      };
      // It grows out of whatever opened it: the toolbar button above it, or the drop point at its corner.
      const origin = options.anchor ? `${options.anchor.left + options.anchor.width / 2 - rect.left - at.x}px 0` : "0 0";
      setPicker({ kind, target, at, origin, instant: options.keyboard === true });
    },
    [agentAt, create, getNodes, graph.nodes, uses],
  );

  const closePicker = useCallback(() => setPicker(undefined), []);

  /** What dropping a toolbar piece here would do, shown on the tile while it is carried. */
  const describeDrop = useCallback(
    (kind: PieceKind, point: Point): string | undefined => {
      if (!overCanvas(point)) {
        setAttachTarget(undefined);
        return undefined;
      }
      if (isAnnotationPiece(kind)) return "Release to place";
      const agent = kind === "channel" ? "agent" : (agentAt(point) ?? "agent");
      setAttachTarget((current) => (current === agent ? current : agent));
      return `Add to ${byId.get(agent)?.name ?? "the agent"}`;
    },
    [agentAt, byId, overCanvas],
  );

  /* ---------- Annotations ---------- */

  const viewportCenter = useCallback((): Point => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return screenToFlowPosition({
      x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2,
    });
  }, [screenToFlowPosition]);

  const addAnnotations = useCallback(
    (added: Annotation[], options: { edit?: boolean } = {}) => {
      const before = annotationsRef.current.map(fromAnnotationNode);
      clearSelection();
      setAnnotations((current) => [
        ...current.map((node) => (node.selected ? ({ ...node, selected: false } as AnnotationNode) : node)),
        ...added.map((annotation) => ({ ...toAnnotationNode(annotation), selected: true }) as AnnotationNode),
      ]);
      record({ type: "annotations", before, after: [...before, ...added] });
      if (options.edit && added.length === 1) setEditingId(added[0]!.id);
    },
    [clearSelection, record],
  );

  const addAnnotation = useCallback(
    (type: Annotation["type"], point?: Point) => {
      addAnnotations([newAnnotation(type, point ?? viewportCenter())], { edit: true });
    },
    [addAnnotations, viewportCenter],
  );

  const duplicateAnnotations = useCallback(
    (source: Annotation[]) => {
      if (source.length === 0) return;
      addAnnotations(
        source.map((annotation) => ({
          ...annotation,
          id: `${annotation.type}:${crypto.randomUUID().slice(0, 8)}`,
          x: annotation.x + 32,
          y: annotation.y + 32,
        })),
      );
    },
    [addAnnotations],
  );

  const removeSelectedAnnotations = useCallback((): boolean => {
    const current = annotationsRef.current;
    if (!current.some((node) => node.selected)) return false;
    record({
      type: "annotations",
      before: current.map(fromAnnotationNode),
      after: current.filter((node) => !node.selected).map(fromAnnotationNode),
    });
    setAnnotations((list) => list.filter((node) => !node.selected));
    return true;
  }, [record]);

  const styleSelected = useCallback(
    (patch: Partial<Annotation>) => {
      const current = annotationsRef.current;
      const next = current.map((node) => (node.selected ? ({ ...node, data: { ...node.data, ...patch } } as AnnotationNode) : node));
      record({ type: "annotations", before: current.map(fromAnnotationNode), after: next.map(fromAnnotationNode) });
      setAnnotations(next);
    },
    [record],
  );

  const annotationContext = useMemo<AnnotationContextValue>(
    () => ({
      editingId,
      setEditing: setEditingId,
      update: (id, patch) =>
        setAnnotations((current) =>
          current.map((node) => (node.id === id ? ({ ...node, data: { ...node.data, ...patch } } as AnnotationNode) : node)),
        ),
      remove: (id) => setAnnotations((current) => current.filter((node) => node.id !== id)),
      commit: persist,
    }),
    [editingId, persist],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const forAnnotations = changes.filter((change) => "id" in change && isAnnotationId(change.id));
      const forGraph = changes.filter((change) => !("id" in change && isAnnotationId(change.id)));
      if (forGraph.length > 0) onGraphNodesChange(forGraph as NodeChange<CapabilityNode>[]);
      if (forAnnotations.length > 0) {
        setAnnotations((current) => applyNodeChanges(forAnnotations as NodeChange<AnnotationNode>[], current));
      }
    },
    [onGraphNodesChange],
  );

  /* ---------- Deletion ---------- */

  /**
   * Everything selected goes in one press: notes, wires, and cards. Notes and wires come back with undo,
   * so alone they go at once; cards delete files, so a selection holding any asks first.
   */
  const deleteSelection = useCallback(() => {
    const cards = getNodes()
      .filter((node): node is CapabilityNode => node.selected === true && isCapability(node) && !node.hidden && node.id !== "agent")
      .flatMap((node) => byId.get(node.id) ?? []);
    const going = new Set(cards.map((node) => node.id));
    const subagents = cards.filter((node) => node.kind === "subagent").map((node) => node.id.slice("subagent:".length));
    // A wire into or out of something being deleted goes with it, as does anything inside a subagent being deleted.
    const gone = (ref: string) => going.has(ref) || subagents.some((key) => ref.includes(`:${key}/`));
    const wires = getEdges()
      .filter((edge) => edge.selected && edge.data?.detachable && !gone(edge.source) && !gone(edge.target))
      .map((edge) => ({ resource: edge.target, agent: edge.source }));
    const annotations = annotationsRef.current.some((node) => node.selected);
    if (cards.length > 0) {
      setConfirmDelete({ nodes: cards, wires, annotations });
      return;
    }
    removeSelectedAnnotations();
    for (const wire of wires) void detach(wire.resource, wire.agent);
  }, [byId, detach, getEdges, getNodes, removeSelectedAnnotations]);

  const confirmDeletion = useCallback(async () => {
    const deletion = confirmDelete;
    setConfirmDelete(undefined);
    if (!deletion) return;
    if (deletion.annotations) removeSelectedAnnotations();
    for (const wire of deletion.wires) void detach(wire.resource, wire.agent);
    clearSelection();
    const [first] = deletion.nodes;
    const ok = await run(() =>
      deletion.nodes.length === 1
        ? removeNodeAction({ projectId, ref: first!.id })
        : removeNodesAction({ projectId, refs: deletion.nodes.map((node) => node.id) }),
    );
    if (ok) say({ text: deletion.nodes.length === 1 ? `Deleted ${first!.name}` : `Deleted ${deletion.nodes.length} items` });
  }, [clearSelection, confirmDelete, detach, projectId, removeSelectedAnnotations, run, say]);

  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedEdges = edges.filter((edge) => edge.selected);
  const selectedAnnotations = annotations.filter((node) => node.selected);
  const selected = selectedNodes.length === 1 ? byId.get(selectedNodes[0]!.id) : undefined;
  const addTarget = selected && isAgentKind(selected.kind) ? selected : byId.get("agent");

  const focusSelection = useCallback(() => {
    const targets = getNodes().filter((node) => node.selected);
    void fitView({
      nodes: targets.length > 0 ? targets.map((node) => ({ id: node.id })) : undefined,
      duration: 320,
      padding: 0.35,
      maxZoom: 1.2,
    });
  }, [fitView, getNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (typingInto(event.target) || dialogIsOpen()) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && key === "a") {
        event.preventDefault();
        setNodes((current) => current.map((node) => (node.hidden ? node : { ...node, selected: true })));
        setAnnotations((current) => current.map((node) => ({ ...node, selected: true }) as AnnotationNode));
        return;
      }
      if (mod && key === "c") {
        const resources = getNodes().filter((node): node is CapabilityNode => node.selected === true && isCapability(node) && isResourceKind(node.data.kind));
        const notes = annotationsRef.current.filter((node) => node.selected).map(fromAnnotationNode);
        if (resources.length === 0 && notes.length === 0) return;
        clipboard.current = { resources: resources.map((node) => node.id), annotations: notes };
        if (resources.length > 0) {
          say({ text: `Copied ${resources.length === 1 ? resources[0]!.data.name : `${resources.length} resources`}. Select an agent and paste to attach.` });
        }
        return;
      }
      if (mod && key === "v") {
        event.preventDefault();
        duplicateAnnotations(clipboard.current.annotations);
        if (addTarget) for (const resource of clipboard.current.resources) void attach(resource, addTarget.id);
        return;
      }
      if (mod && key === "d") {
        event.preventDefault();
        duplicateAnnotations(annotationsRef.current.filter((node) => node.selected).map(fromAnnotationNode));
        return;
      }
      if (mod || event.altKey) return;

      const arrow = ARROWS[event.key];
      if (arrow) {
        const step = snap ? 24 : event.shiftKey ? 20 : 4;
        if (nudge(arrow[0] * step, arrow[1] * step)) event.preventDefault();
        return;
      }

      switch (event.key) {
        case "Delete":
        case "Backspace":
          event.preventDefault();
          deleteSelection();
          break;
        case "f":
        case "F":
          focusSelection();
          break;
        case "0":
          void fitView({ duration: 320, padding: fitPadding(), maxZoom: 1 });
          break;
        case "g":
        case "G":
          void fitView({ nodes: [{ id: "agent" }], duration: 320, padding: 0.6, maxZoom: 1 });
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
          event.preventDefault();
          openPicker(PIECE_ORDER[Number(event.key) - 1]!, { keyboard: true });
          break;
        case "h":
        case "H":
          setTool("hand");
          break;
        case "v":
        case "V":
          setTool("select");
          break;
        case "6":
        case "n":
        case "N":
          event.preventDefault();
          addAnnotation("note");
          break;
        case "7":
        case "s":
        case "S":
          event.preventDefault();
          addAnnotation("section");
          break;
        case "Escape":
          setPicker(undefined);
          setDraft(undefined);
          setSummaryOpen(false);
          clearSelection();
          say(undefined);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    addAnnotation,
    addTarget,
    attach,
    clearSelection,
    deleteSelection,
    duplicateAnnotations,
    fitView,
    focusSelection,
    getNodes,
    nudge,
    openPicker,
    redo,
    say,
    setNodes,
    snap,
    undo,
  ]);

  const { hidden, counts } = useMemo(() => foldedNodes(graph, collapsed), [collapsed, graph]);

  const displayNodes = useMemo(
    () =>
      nodes.map((node) => {
        const classes: string[] = [];
        if (node.id === attachTarget) classes.push("is-attach-target");
        if (settling) classes.push("is-settling");
        const className = classes.join(" ") || undefined;
        const isHidden = hidden.has(node.id);
        const isCollapsed = collapsed.has(node.id) || undefined;
        const hiddenCount = counts.get(node.id);
        const dataChanged = node.data.collapsed !== isCollapsed || node.data.hiddenCount !== hiddenCount;
        if (!dataChanged && node.className === className && Boolean(node.hidden) === isHidden) return node;
        return {
          ...node,
          className,
          hidden: isHidden,
          data: dataChanged ? { ...node.data, collapsed: isCollapsed, hiddenCount } : node.data,
        };
      }),
    [attachTarget, collapsed, counts, hidden, nodes, settling],
  );

  const flowNodes = useMemo<FlowNode[]>(
    () => [
      ...annotations.filter((node) => node.type === "section"),
      ...displayNodes,
      ...annotations.filter((node) => node.type === "note"),
    ],
    [annotations, displayNodes],
  );

  const displayEdges = useMemo(() => {
    // Wires into a shared resource all end at the same point, so only one of them may carry a label there:
    // the one being looked at if there is one, otherwise the first.
    const lookedAt = new Set(
      edges.filter((edge) => edge.selected || edge.id === hoveredEdge).map((edge) => edge.target),
    );
    const labelled = new Set<string>();
    const list = edges.map((edge) => {
      const pointed = edge.id === hoveredEdge;
      const kind = kinds.get(edge.target) ?? "tool";
      const className = edgeClass(kind, edge.data?.relation);
      // A label shows strongly only for the wire being pointed at or selected.
      const showLabel = Boolean(edge.selected || pointed);
      const labelOwner = lookedAt.has(edge.target) ? showLabel : !labelled.has(edge.target);
      if (labelOwner) labelled.add(edge.target);
      if (edge.className === className && edge.data?.showLabel === showLabel && edge.data?.labelOwner === labelOwner) return edge;
      return { ...edge, className, data: { ...edge.data!, showLabel, labelOwner } };
    });
    if (dragging && attachTarget) {
      const kind = kinds.get(dragging) ?? "tool";
      list.push({
        ...toEdge({ source: attachTarget, target: dragging, relation: "has tool" }, kind),
        id: "attach-preview",
        className: edgeClass(kind, "has tool", "is-preview"),
        selectable: false,
        data: { detachable: false },
      });
    }
    return list;
  }, [attachTarget, dragging, edges, hoveredEdge, kinds]);

  const isValidConnection = useCallback<IsValidConnection<RelationEdge>>(
    (connection) =>
      isAgentKind(kinds.get(connection.source)) &&
      isResourceKind(kinds.get(connection.target)) &&
      // A port only takes its own kind: the skill port attaches skills.
      connection.sourceHandle === portHandle(kinds.get(connection.target)!) &&
      !uses(connection.source, connection.target),
    [kinds, uses],
  );

  const onConnect = useCallback((connection: Connection) => void attach(connection.target, connection.source), [attach]);

  const onNodeDragStart = useCallback<OnNodeDrag<FlowNode>>(
    (_, node) => {
      dragStart.current = snapshot(getNodes());
      setDragging(node.id);
      moving.current.card = true;
      unhover();
    },
    [getNodes, unhover],
  );

  const onNodeDrag = useCallback<OnNodeDrag<FlowNode>>(
    (_, node) => {
      if (!isCapability(node) || !isResourceKind(node.data.kind)) return;
      const hit = getIntersectingNodes(node).find((candidate) => isAgentKind(kinds.get(candidate.id)) && !uses(candidate.id, node.id));
      setAttachTarget((current) => (current === hit?.id ? current : hit?.id));
    },
    [getIntersectingNodes, kinds, uses],
  );

  const onNodeDragStop = useCallback<OnNodeDrag<FlowNode>>(
    (_, node, dragged) => {
      setDragging(undefined);
      moving.current.card = false;
      const target = attachTarget;
      setAttachTarget(undefined);
      if (target) {
        // Dropped onto an agent: attach, and the card returns to where it was picked up.
        applyPositions({ [node.id]: dragStart.current[node.id]! });
        void attach(node.id, target);
        return;
      }
      const before: Positions = {};
      const after: Positions = {};
      for (const moved of dragged) {
        const start = dragStart.current[moved.id];
        if (start && (start.x !== moved.position.x || start.y !== moved.position.y)) {
          before[moved.id] = start;
          after[moved.id] = moved.position;
        }
      }
      if (Object.keys(after).length === 0) return;
      record({ type: "move", before, after });
      leaveLayout(dragged);
      persist();
    },
    [applyPositions, attach, attachTarget, leaveLayout, persist, record],
  );

  const context = useMemo<CanvasContextValue>(
    () => ({
      mode,
      wireStyle,
      uses,
      toggleCollapse,
      detachEdge: (agent, resource) => void detach(resource, agent),
    }),
    [detach, mode, toggleCollapse, uses, wireStyle],
  );

  const errors = issues.filter((issue) => issue.level === "error");
  const saveState =
    pendingCount > 0
      ? { label: "Saving", tone: "busy" }
      : sourceState === "conflict"
        ? { label: "Conflict", tone: "error" }
        : sourceState === "dirty"
          ? { label: "Unsaved", tone: "warning" }
          : { label: "Saved", tone: "ok" };

  const notes = annotations.length;
  const rootNode = byId.get("agent");
  const empty = graph.nodes.every((node) => node.kind === "agent" || node.kind === "channel");
  const showInspector = Boolean(draft || selected || summaryOpen);
  const inspectorLabel = draft ? "Create" : selected ? `${selected.name} inspector` : "Architecture";

  // On a phone both side panels are bottom sheets, and only one is up at a time.
  const phone = usePhone();
  // A finger on the board pans it, as on a map; cards stay put under it, so a pan never reshuffles the layout.
  const touch = useMediaQuery("(pointer: coarse)");
  useEffect(() => {
    if (phone && showInspector) setPanelOpen(false);
  }, [phone, showInspector]);

  const closeInspector = () => {
    setDraft(undefined);
    clearSelection();
    setSummaryOpen(false);
  };

  const resourceBrowser = (
    <ResourceBrowser
      title={rootNode?.name}
      save={saveState}
      nodes={graph.nodes}
      selectedId={selected?.id}
      onSelect={select}
      onCreate={(kind) => create(kind)}
      canDrop={(resource, point) => {
        const target = agentAt(point);
        const ok = Boolean(target && !uses(target, resource));
        setAttachTarget((current) => {
          const next = ok ? target : undefined;
          return current === next ? current : next;
        });
        return ok;
      }}
      onDrop={(resource, point) => {
        const target = agentAt(point);
        setAttachTarget(undefined);
        if (target) void attach(resource, target);
      }}
      onHoverDrop={(over) => {
        if (!over) setAttachTarget(undefined);
      }}
      canPlace={overCanvas}
      onAnnotate={(type, point) => addAnnotation(type, point ? screenToFlowPosition(point) : undefined)}
    />
  );

  const inspectorBody = (
    <>
    {draft ? (
      <CanvasCreatePanel
        key={`${draft.kind}-${draft.owner ?? "root"}`}
        projectId={projectId}
        kind={draft.kind}
        root={root}
        owner={draft.owner ? byId.get(draft.owner)?.name : undefined}
        defaultModel={props.defaultModel}
        models={props.models}
        existingChannels={graph.nodes.filter((node) => node.kind === "channel").map((node) => node.name)}
        chatSdkAdapters={props.chatSdkAdapters}
        chatSdkStates={props.chatSdkStates}
        onClose={() => setDraft(undefined)}
        onSubmitted={(entityId) => {
          const owner = draft.owner;
          const kind = draft.kind;
          setDraft(undefined);
          say({ text: `Created ${entityId}` });
          if (owner && (kind === "tool" || kind === "connection")) {
            // Created at the root first, then moved into the subagent's own folder.
            void run(() => changeOwnershipAction({ projectId, capability: `${kind}:${entityId}`, to: owner }));
          }
        }}
      />
    ) : (
      <CanvasInspector
        projectId={projectId}
        graph={graph}
        node={selected}
        content={selected ? (contents[selected.filePath] ?? "") : ""}
        issues={issues}
        onSelect={select}
        onFocus={(id) => void fitView({ nodes: [{ id }], duration: 360, padding: fitPadding(), maxZoom: 1.1 })}
        onClear={() => {
          clearSelection();
          setSummaryOpen(false);
        }}
        onAttach={(resource, agent) => void attach(resource, agent)}
        onDetach={(resource, agent) => void detach(resource, agent)}
        onCreate={create}
        onDelete={(node) => setConfirmDelete({ nodes: [node], wires: [], annotations: false })}
        onSourceState={setSourceState}
      />
    )}
    </>
  );

  return (
    <CanvasContext.Provider value={context}>
      <AnnotationContext.Provider value={annotationContext}>
        <div
          ref={layoutRef}
          className="canvas-layout"
          data-mode={mode}
          data-panel={panelOpen || undefined}
          data-inspector={showInspector || undefined}
        >
          <div
            className="canvas-surface"
            ref={surfaceRef}
            data-locked={locked || undefined}
            data-tool={tool}
            onDoubleClick={(event) => {
              // Double-click on empty canvas writes a note there, as on a whiteboard.
              if (!(event.target as HTMLElement).classList.contains("react-flow__pane")) return;
              addAnnotation("note", screenToFlowPosition({ x: event.clientX, y: event.clientY }));
            }}
          >
            <ReactFlow<FlowNode, RelationEdge>
              nodes={flowNodes}
              edges={displayEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeMouseEnter={useCallback<NodeMouseHandler<FlowNode>>((_, node) => hoverSoon({ type: "node", id: node.id }), [hoverSoon])}
              onNodeMouseLeave={useCallback(() => hoverSoon(undefined), [hoverSoon])}
              onEdgeMouseEnter={useCallback<EdgeMouseHandler<RelationEdge>>((_, edge) => hoverSoon({ type: "edge", id: edge.id }), [hoverSoon])}
              onEdgeMouseLeave={useCallback(() => hoverSoon(undefined), [hoverSoon])}
              onMoveStart={useCallback(() => {
                moving.current.board = true;
                unhover();
              }, [unhover])}
              onMoveEnd={useCallback(() => {
                moving.current.board = false;
              }, [])}
              onNodeClick={() => {
                setDraft(undefined);
                setSummaryOpen(false);
              }}
              onPaneClick={() => setDraft(undefined)}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              connectionLineComponent={CanvasConnectionLine}
              connectionRadius={40}
              // Whiteboard controls as in Excalidraw: select drags a selection, hand or Space pans, scroll pans, Ctrl or pinch zooms.
              panOnDrag={tool === "hand" || touch ? true : [1, 2]}
              selectionOnDrag={tool === "select" && !touch}
              panOnScroll
              selectionKeyCode="Shift"
              multiSelectionKeyCode={["Meta", "Control"]}
              zoomOnDoubleClick={false}
              // Deleting a node removes files; the canvas asks first, so React Flow never deletes on its own.
              deleteKeyCode={null}
              snapToGrid={snap}
              snapGrid={[24, 24]}
              nodesDraggable={!locked && tool === "select" && !touch}
              nodesConnectable={!locked && tool === "select"}
              elementsSelectable={tool === "select"}
              // React Flow asks open projects without a Pro plan to keep its attribution.
              attributionPosition="top-right"
              minZoom={0.15}
              maxZoom={2.5}
              // Past a few hundred cards, mounting only what is on screen beats painting them all;
              // below that, mounting cards as they scroll in costs more than it saves.
              onlyRenderVisibleElements={graph.nodes.length > 400}
            >
              <DottedBackground />
              <ZoomTier surface={surfaceRef} />
              {minimap && (
                <MiniMap
                  pannable
                  zoomable
                  position="bottom-right"
                  nodeBorderRadius={4}
                  nodeStrokeWidth={0}
                  nodeClassName={(node) =>
                    node.type === "capability" ? `minimap-node minimap-${(node.data as CanvasNodeData).kind}` : "minimap-node minimap-annotation"
                  }
                  ariaLabel="Minimap"
                />
              )}
            </ReactFlow>
          </div>

          {!panelOpen && (
            <div className="canvas-float canvas-title">
              <div className="canvas-title-text">
                <p className="canvas-title-name" title={rootNode?.name}>
                  {rootNode?.name}
                </p>
                <p className="canvas-save" data-tone={saveState.tone} role="status" aria-label="Save state">
                  <span className="sync-dot" aria-hidden="true" />
                  {saveState.label}
                </p>
              </div>
            </div>
          )}

          <CanvasToolbar
            tool={tool}
            onTool={setTool}
            locked={locked}
            onLock={() => setLocked((value) => !value)}
            describeDrop={describeDrop}
            onDragEnd={() => setAttachTarget(undefined)}
            onPieceDrop={(kind, point) => {
              if (isAnnotationPiece(kind)) addAnnotation(kind, screenToFlowPosition(point));
              else openPicker(kind, { drop: point });
            }}
            onPieceActivate={(kind, anchor) => {
              if (isAnnotationPiece(kind)) addAnnotation(kind);
              else openPicker(kind, { anchor });
            }}
          />

          {picker && (
            <CanvasPicker
              key={`${picker.kind}-${picker.target}`}
              kind={picker.kind}
              targetName={byId.get(picker.target)?.name ?? "the agent"}
              at={picker.at}
              origin={picker.origin}
              instant={picker.instant}
              options={graph.nodes
                .filter((node) => node.kind === picker.kind && !uses(picker.target, node.id))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((node) => ({ id: node.id, name: node.name, detail: node.detail, shared: node.shared }))}
              onPick={(id) => {
                setPicker(undefined);
                void attach(id, picker.target);
              }}
              onCreate={() => create(picker.kind, picker.target)}
              onClose={closePicker}
            />
          )}

          <div className="canvas-float canvas-view-menu">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Wire style" className="canvas-wire-button">
                      <Icon icon={WIRE_OPTIONS.find((option) => option.value === wireStyle)!.icon} />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">Wire style</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" sideOffset={10} className="wire-panel w-auto">
                <p className="wire-panel-label">Wire style</p>
                <div className="wire-panel-row" role="radiogroup" aria-label="Wire style">
                  {WIRE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={wireStyle === option.value}
                      aria-label={option.label}
                      title={option.label}
                      className="wire-panel-option"
                      onClick={() => {
                        setWireStyle(option.value);
                        layoutState.current.wireStyle = option.value;
                        persist();
                      }}
                    >
                      <Icon icon={option.icon} />
                    </button>
                  ))}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="View options">
                  <Icon icon={IconSettingsSliders} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={10} className="w-56">
                <DropdownMenuLabel>Layout</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={mode} onValueChange={(value) => applyLayout(value as LayoutMode)}>
                  {LAYOUTS.map((layout) => (
                    <DropdownMenuRadioItem key={layout.mode} value={layout.mode}>
                      {layout.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <ArrangeMenu count={selectedNodes.length + selectedAnnotations.length} onArrange={arrange} />
                <DropdownMenuItem
                  disabled={collapsed.size === 0}
                  onSelect={() => {
                    setCollapsed(new Set());
                    layoutState.current.collapsed = new Set();
                    persist();
                  }}
                >
                  Expand everything
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={snap} onCheckedChange={(value) => setSnap(value === true)}>
                  Snap to grid
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={minimap} onCheckedChange={(value) => setMinimap(value === true)}>
                  Minimap
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {phone ? (
            <PhoneSheet open={panelOpen} onOpenChange={setPanelOpen} title="Resources" keepOpenOn={SHEET_CONTROLS}>
              {resourceBrowser}
            </PhoneSheet>
          ) : (
            panelOpen && resourceBrowser
          )}

          <div className="canvas-bottom-left">
            <div className="canvas-float canvas-icon-float">
              <ToolbarButton
                label={panelOpen ? "Hide resources" : "Show resources"}
                tooltip={panelOpen ? "Hide resources" : "Show resources"}
                onClick={() => setPanelOpen((open) => !open)}
              >
                <Icon icon={IconSidebarLeft} />
              </ToolbarButton>
            </div>
            <ZoomControls />
            <div className="canvas-float canvas-icon-float canvas-history">
              <ToolbarButton label="Undo" tooltip="Undo (Ctrl Z)" onClick={undo}>
                <Icon icon={IconUndo} />
              </ToolbarButton>
              <ToolbarButton label="Redo" tooltip="Redo (Ctrl Shift Z)" onClick={redo}>
                <Icon icon={IconRedo} />
              </ToolbarButton>
            </div>
          </div>

          <div className="canvas-bottom-right">
            <div className="canvas-float canvas-status" role="list" aria-label="Wire colours">
              <span className="legend-title" aria-hidden="true">
                Wires to
              </span>
              {LEGEND.map((item) => (
                <Tooltip key={item.kind}>
                  <TooltipTrigger asChild>
                    <span
                      role="listitem"
                      tabIndex={0}
                      className="legend-item"
                      data-kind={item.kind}
                      aria-label={`${KINDS[item.kind].label}: ${item.hint}`}
                    >
                      <i data-dashed={item.dashed || undefined} aria-hidden="true" />
                      <Icon icon={KINDS[item.kind].icon} size={14} />
                      <span className="legend-text">{KINDS[item.kind].plural}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={8}>
                    {item.hint}
                  </TooltipContent>
                </Tooltip>
              ))}
              <span className="canvas-status-mode">{LAYOUTS.find((layout) => layout.mode === mode)?.label}</span>
            </div>
            <div className="canvas-float canvas-icon-float">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts">
                    <Icon icon={IconHelp} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" sideOffset={10} className="w-72">
                  <DropdownMenuLabel>Shortcuts</DropdownMenuLabel>
                  <dl className="shortcut-list">
                    {SHORTCUTS.map(([keys, label]) => (
                      <div key={keys}>
                        <dt>{label}</dt>
                        <dd>
                          <kbd>{keys}</kbd>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {selectedAnnotations.length > 0 && (
            <AnnotationToolbar selection={selectedAnnotations.map((node) => node.data)} onChange={styleSelected} />
          )}

          {empty && !draft && !notice && annotations.length === 0 && (
            <p className="canvas-empty">Drag a piece from the toolbar onto the agent</p>
          )}

          {notice && (
            <div className="canvas-float canvas-notice" role="status" data-tone={notice.tone} data-raised={selectedAnnotations.length > 0 || undefined}>
              <span>{notice.text}</span>
              {notice.undo && (
                <button type="button" className="canvas-notice-action" onClick={undo}>
                  Undo
                </button>
              )}
            </div>
          )}

          {phone ? (
            <PhoneSheet open={showInspector} onOpenChange={(open) => !open && closeInspector()} title={inspectorLabel} keepOpenOn={SHEET_CONTROLS}>
              {inspectorBody}
            </PhoneSheet>
          ) : (
            showInspector && <InspectorColumn label={inspectorLabel}>{inspectorBody}</InspectorColumn>
          )}

          <ConfirmDialog
            open={Boolean(confirmDelete)}
            onOpenChange={(open) => {
              if (!open) setConfirmDelete(undefined);
            }}
            {...deletionCopy(confirmDelete?.nodes ?? [])}
            onConfirm={() => void confirmDeletion()}
          />
        </div>
      </AnnotationContext.Provider>
    </CanvasContext.Provider>
  );
}

export function CanvasView(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
