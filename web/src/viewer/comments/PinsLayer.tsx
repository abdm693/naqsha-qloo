import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useStore } from "zustand";
import type { Comment, CommentAnchor } from "@contracts/api-types";
import type { ViewerController } from "../core/controller";

/** DESIGN author hues (--color-author-1…6): a person keeps their colour across Plan and House. */
export const AUTHOR_HUES = ["#0D7C72", "#6A4FD6", "#C23F78", "#A8641A", "#4F6378", "#2F7A3A"];

export function authorHue(c: Pick<Comment, "author">): string {
  const key = c.author?.id || c.author?.name;
  if (!key) return AUTHOR_HUES[0];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AUTHOR_HUES[h % AUTHOR_HUES.length];
}

/*
 * Comment pins: a 24 px teardrop whose tip sits exactly on the anchor point, in the author's hue with a white ring
 * and the comment's number (the same number as in Plan). The controller hides pins on hidden floors or above the
 * section cut, and marks occluded ones (dimmed in orbit, hidden while walking).
 *
 * Two halves, so no pin owns a React root of its own (drei <Html> made one per pin, and tearing those down while
 * the canvas re-rendered threw "removeChild" errors):
 *   - <PinAnchors> (inside the Canvas) keeps one THREE.Group per pin at its anchor, for the controller's visibility
 *     and occlusion passes, and projects each anchor to screen space every rendered frame;
 *   - <PinsOverlay> (plain DOM over the canvas) renders every pin button in one layer; the projection writes their
 *     transforms directly (no React state per frame).
 */

const DRAFT = "__draft";
type Wraps = Map<string, HTMLDivElement>;
const registry = new WeakMap<ViewerController, Wraps>();
function wrapsOf(ctrl: ViewerController): Wraps {
  let m = registry.get(ctrl);
  if (!m) registry.set(ctrl, (m = new Map()));
  return m;
}

interface PinData {
  id: string;
  n: string;
  anchor: Pick<CommentAnchor, "position" | "normal" | "level">;
  status: Comment["status"];
  hue: string;
  text?: string;
  author?: string;
  draft?: boolean;
}

function usePins(ctrl: ViewerController, comments: Comment[] | undefined): PinData[] {
  const draft = useStore(ctrl.store, (s) => s.draft);
  return useMemo(() => {
    const list: PinData[] = (comments ?? []).map((c, i) => ({
      id: c.id,
      n: String(i + 1),
      anchor: c.anchor,
      status: c.status,
      text: c.text,
      hue: authorHue(c),
      author: c.author?.name,
    }));
    if (draft) list.push({ id: DRAFT, n: "+", anchor: draft, status: "open", hue: "#6B2A5E", draft: true });
    return list;
  }, [comments, draft]);
}

// ── Inside the Canvas ────────────────────────────────────────────────────────────────────────────────

const tmp = new THREE.Vector3();

export function PinAnchors({ ctrl, comments }: { ctrl: ViewerController; comments?: Comment[] }) {
  const pins = usePins(ctrl, comments);
  const ref = useCallback((g: THREE.Group | null) => void (ctrl.pinsGroup = g), [ctrl]);
  const group = useRef<THREE.Group | null>(null);
  const setGroup = useCallback(
    (g: THREE.Group | null) => {
      group.current = g;
      ref(g);
    },
    [ref],
  );

  // After the camera moved (and the controller ran its pin pass), place every pin on screen.
  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const wraps = wrapsOf(ctrl);
    if (!wraps.size) return;
    const cam = state.camera;
    cam.updateMatrixWorld();
    const { width, height } = state.size;
    for (const o of g.children) {
      const id = o.userData?.pin as string | undefined;
      if (!id) continue;
      const el = wraps.get(id);
      if (!el) continue;
      tmp.copy(o.position);
      tmp.project(cam);
      const off = !o.visible || tmp.z > 1 || tmp.z < -1;
      if (off) {
        if (el.style.visibility !== "hidden") el.style.visibility = "hidden";
        continue;
      }
      const x = (tmp.x * 0.5 + 0.5) * width;
      const y = (-tmp.y * 0.5 + 0.5) * height;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      // Nearer pins on top (the overlay is its own stacking context).
      el.style.zIndex = String(Math.round((1 - tmp.z) * 50000));
      // Shown = inherit (""), never an explicit "visible": the app keeps a hidden House mounted (visibility: hidden)
      // behind Plan, Concepts and Revisions, and "visible" would float these pins over that view and steal its clicks.
      if (el.style.visibility) el.style.visibility = "";
    }
  });

  return (
    <group ref={setGroup} name="naqsha-pins">
      {pins.map((p) => (
        <PinAnchor key={p.id} id={p.id} anchor={p.anchor} />
      ))}
    </group>
  );
}

const PinAnchor = memo(function PinAnchor({ id, anchor }: { id: string; anchor: PinData["anchor"] }) {
  const px = anchor.position.join(), nx = anchor.normal.join();
  const { pos, normal } = useMemo(() => {
    const nrm = new THREE.Vector3(...anchor.normal);
    if (nrm.lengthSq() < 1e-6) nrm.set(0, 1, 0);
    return { pos: new THREE.Vector3(...anchor.position), normal: nrm.normalize() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [px, nx]);
  const userData = useMemo(() => ({ pin: id, level: anchor.level, normal, noPick: true }), [id, anchor.level, normal]);
  return <group position={pos} userData={userData} />;
});

// ── Over the Canvas (DOM) ────────────────────────────────────────────────────────────────────────────

const STATUS_WORD: Record<Comment["status"], string> = { open: "", resolved: "Done", partial: "Partly done", rejected: "Not possible" };

export function PinsOverlay({ ctrl, comments }: { ctrl: ViewerController; comments?: Comment[] }) {
  const pins = usePins(ctrl, comments);
  const selected = useStore(ctrl.store, (s) => s.selectedPin);
  // New or moved pins need one rendered frame to be placed (orbit renders on demand).
  const key = pins.map((p) => `${p.id}@${p.anchor.position.join(",")}`).join("|");
  useLayoutEffect(() => {
    ctrl.invalidate();
  }, [ctrl, key]);
  return (
    <div className="nq-pins" aria-label={pins.length ? "Comment pins" : undefined}>
      {pins.map((p) => (
        <PinButton key={p.id} ctrl={ctrl} pin={p} selected={selected === p.id} />
      ))}
    </div>
  );
}

const PinButton = memo(function PinButton({ ctrl, pin, selected }: { ctrl: ViewerController; pin: PinData; selected: boolean }) {
  const { id, n, status, hue, text, author, draft } = pin;
  const wrapRef = useCallback(
    (el: HTMLDivElement | null) => {
      const wraps = wrapsOf(ctrl);
      if (el) wraps.set(id, el);
      else wraps.delete(id);
    },
    [ctrl, id],
  );
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!draft) ctrl.selectPin(id);
    },
    [ctrl, id, draft],
  );
  const word = STATUS_WORD[status];
  return (
    <div ref={wrapRef} className="nq-pin-wrap" style={{ visibility: "hidden" }}>
      <button
        type="button"
        className="nq-pin"
        data-nq-ui=""
        data-pin={id}
        data-status={status}
        data-draft={draft ? "1" : "0"}
        data-selected={selected ? "1" : "0"}
        style={{ "--pin": hue } as React.CSSProperties}
        onClick={onClick}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={draft ? "New comment" : `Comment ${n}${author ? ` by ${author}` : ""}${word ? ` (${word.toLowerCase()})` : ""}${text ? `: ${text}` : ""}`}
      >
        <span className="nq-pin-drop" aria-hidden>
          <span className="nq-pin-n">{n}</span>
        </span>
        {text && (
          <span className="nq-pin-tip" aria-hidden>
            {author && <b>{author}</b>}
            {text.length > 90 ? `${text.slice(0, 88)}…` : text}
            {word && <i>{word}</i>}
          </span>
        )}
      </button>
    </div>
  );
});
