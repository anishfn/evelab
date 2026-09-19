"use client";

import "@fontsource/caveat/500.css";
import "@fontsource/caveat/700.css";
import { createContext, memo, useContext, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { ANNOTATION_COLORS, type Annotation } from "@/components/canvas/layout";

export type NoteNode = Node<Annotation, "note">;
export type SectionNode = Node<Annotation, "section">;
export type AnnotationNode = NoteNode | SectionNode;

export interface AnnotationContextValue {
  editingId?: string;
  setEditing: (id: string | undefined) => void;
  update: (id: string, patch: Partial<Annotation>) => void;
  remove: (id: string) => void;
  commit: () => void;
}

export const AnnotationContext = createContext<AnnotationContextValue>({
  setEditing: () => {},
  update: () => {},
  remove: () => {},
  commit: () => {},
});

const COLOR_VALUES: Record<Annotation["color"], string> = {
  default: "var(--foreground)",
  gray: "#8f8f8f",
  blue: "#3b82f6",
  cyan: "#06b6d4",
  teal: "#14b8a6",
  green: "#22c55e",
  lime: "#84cc16",
  yellow: "#eab308",
  amber: "#f59e0b",
  orange: "#f97316",
  red: "#ef4444",
  pink: "#ec4899",
  purple: "#a855f7",
  violet: "#8b5cf6",
  indigo: "#6366f1",
};

export const FONT_FAMILIES: Record<Annotation["font"], string> = {
  hand: '"Caveat", "Comic Sans MS", cursive',
  sans: "var(--font-geist-sans), system-ui, sans-serif",
  mono: "var(--font-geist-mono), ui-monospace, monospace",
  serif: "ui-serif, Georgia, serif",
};

const NOTE_SIZES = { s: 18, m: 24, l: 36 };
const SECTION_SIZES = { s: 12, m: 14, l: 18 };

export function isAnnotationId(id: string): boolean {
  return id.startsWith("note:") || id.startsWith("section:");
}

export function toAnnotationNode(annotation: Annotation): AnnotationNode {
  return {
    id: annotation.id,
    type: annotation.type,
    position: { x: annotation.x, y: annotation.y },
    width: annotation.width,
    // A note grows with its text; a section keeps the size it was drawn at.
    ...(annotation.type === "section" ? { height: annotation.height } : {}),
    // Sections sit behind everything so the cards inside them stay clickable.
    zIndex: annotation.type === "section" ? -1 : 2,
    data: annotation,
  } as AnnotationNode;
}

export function fromAnnotationNode(node: AnnotationNode): Annotation {
  return {
    ...node.data,
    x: Math.round(node.position.x),
    y: Math.round(node.position.y),
    // A card not yet measured reports 0; keep the last known size instead of saving an invisible note.
    width: Math.max(24, Math.round(node.width || node.measured?.width || node.data.width)),
    height: Math.max(16, Math.round(node.height || node.measured?.height || node.data.height)),
  };
}

export function newAnnotation(type: Annotation["type"], center: { x: number; y: number }): Annotation {
  const id = `${type}:${crypto.randomUUID().slice(0, 8)}`;
  const base = { bold: false, italic: false, underline: false, size: "m" as const };
  return type === "note"
    ? { ...base, id, type, x: Math.round(center.x - 120), y: Math.round(center.y - 28), width: 240, height: 56, text: "", font: "hand", color: "default" }
    : { ...base, id, type, x: Math.round(center.x - 220), y: Math.round(center.y - 140), width: 440, height: 280, text: "Section", font: "sans", color: "blue" };
}

function textStyle(data: Annotation, sizes: Record<Annotation["size"], number>): CSSProperties {
  return {
    fontFamily: FONT_FAMILIES[data.font],
    fontSize: sizes[data.size],
    fontWeight: data.bold ? 700 : data.font === "hand" ? 500 : 400,
    fontStyle: data.italic ? "italic" : undefined,
    textDecoration: data.underline ? "underline" : undefined,
    color: COLOR_VALUES[data.color],
  };
}

function useAutoFocus(editing: boolean) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => {
    if (!editing || !ref.current) return;
    ref.current.focus();
    ref.current.select();
  }, [editing]);
  return ref;
}

/** Free text in the hand of whoever wrote it. Double-click to edit; an emptied note removes itself. */
function NoteCardBase({ id, data, selected }: NodeProps<NoteNode>) {
  const { editingId, setEditing, update, remove, commit } = useContext(AnnotationContext);
  const editing = editingId === id;
  const ref = useAutoFocus(editing);
  const style = textStyle(data, NOTE_SIZES);

  return (
    <div className="note" data-selected={selected || undefined} data-editing={editing || undefined} onDoubleClick={() => setEditing(id)}>
      <NodeResizer
        isVisible={selected && !editing}
        minWidth={60}
        minHeight={32}
        lineClassName="annotation-resize-line"
        handleClassName="annotation-resize-handle"
        onResizeEnd={commit}
      />
      {editing ? (
        <textarea
          ref={ref}
          className="note-input nodrag nowheel nopan"
          value={data.text}
          placeholder="Write something"
          style={style}
          onChange={(event) => update(id, { text: event.target.value })}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") event.currentTarget.blur();
          }}
          onBlur={(event) => {
            setEditing(undefined);
            if (!event.currentTarget.value.trim()) remove(id);
            else commit();
          }}
        />
      ) : (
        <p className="note-text" style={style}>
          {data.text}
        </p>
      )}
    </div>
  );
}

/** A coloured region with a label tab, for grouping agents the way a whiteboard frame does. */
function SectionCardBase({ id, data, selected }: NodeProps<SectionNode>) {
  const { editingId, setEditing, update, commit } = useContext(AnnotationContext);
  const editing = editingId === id;
  const ref = useAutoFocus(editing);
  const color = COLOR_VALUES[data.color];

  return (
    <div className="section" data-selected={selected || undefined} style={{ "--annotation": color } as CSSProperties}>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        lineClassName="annotation-resize-line"
        handleClassName="annotation-resize-handle"
        onResizeEnd={commit}
      />
      <div className="section-frame" />
      <div className="section-label" onDoubleClick={() => setEditing(id)} style={textStyle(data, SECTION_SIZES)}>
        {editing ? (
          <input
            ref={ref}
            className="section-input nodrag"
            value={data.text}
            aria-label="Section name"
            onChange={(event) => update(id, { text: event.target.value })}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
            }}
            onBlur={() => {
              setEditing(undefined);
              commit();
            }}
            style={{ width: `${Math.max(4, data.text.length + 1)}ch` }}
          />
        ) : (
          data.text || "Section"
        )}
      </div>
    </div>
  );
}

export const NoteCard = memo(NoteCardBase);
export const SectionCard = memo(SectionCardBase);

const FONT_LABELS: Record<Annotation["font"], string> = { hand: "Handwritten", sans: "Sans", mono: "Mono", serif: "Serif" };

/** Style for the selected notes and sections, applied to all of them at once. */
/** Styles the selected notes, followed by whatever acts on the whole selection. With no notes selected, only that. */
export function AnnotationToolbar({
  selection,
  onChange,
  children,
}: {
  selection: Annotation[];
  onChange: (patch: Partial<Annotation>) => void;
  children?: ReactNode;
}) {
  const every = <K extends keyof Annotation>(key: K, value: Annotation[K]) => selection.every((entry) => entry[key] === value);

  return (
    <div className="canvas-float annotation-toolbar" role="toolbar" aria-label={selection.length > 0 ? "Annotation style" : "Selection"}>
      {selection.length > 0 && (
        <>
          {(["s", "m", "l"] as const).map((size) => (
            <button
              key={size}
              type="button"
              className="annotation-tool"
              aria-pressed={every("size", size)}
              aria-label={`Size ${size.toUpperCase()}`}
              onClick={() => onChange({ size })}
            >
              {size.toUpperCase()}
            </button>
          ))}
          <span className="annotation-separator" aria-hidden="true" />
          {(
            [
              ["bold", "B", "Bold"],
              ["italic", "I", "Italic"],
              ["underline", "U", "Underline"],
            ] as const
          ).map(([key, glyph, label]) => (
            <button
              key={key}
              type="button"
              className="annotation-tool"
              data-glyph={key}
              aria-pressed={every(key, true)}
              aria-label={label}
              onClick={() => onChange({ [key]: !every(key, true) })}
            >
              {glyph}
            </button>
          ))}
          <span className="annotation-separator" aria-hidden="true" />
          {(Object.keys(FONT_FAMILIES) as Annotation["font"][]).map((font) => (
            <button
              key={font}
              type="button"
              className="annotation-tool"
              aria-pressed={every("font", font)}
              aria-label={`${FONT_LABELS[font]} font`}
              title={FONT_LABELS[font]}
              style={{ fontFamily: FONT_FAMILIES[font], fontSize: font === "hand" ? 17 : 13 }}
              onClick={() => onChange({ font })}
            >
              Aa
            </button>
          ))}
          <span className="annotation-separator" aria-hidden="true" />
          {ANNOTATION_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="annotation-swatch"
              data-color={color}
              aria-pressed={every("color", color)}
              aria-label={color === "default" ? "Default colour" : `${color} colour`}
              title={color === "default" ? "Default" : color}
              style={{ "--swatch": COLOR_VALUES[color] } as CSSProperties}
              onClick={() => onChange({ color })}
            />
          ))}
        </>
      )}
      {selection.length > 0 && children && <span className="annotation-separator" aria-hidden="true" />}
      {children}
    </div>
  );
}
