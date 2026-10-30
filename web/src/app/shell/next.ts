/**
 * The Next pill names the move (DESIGN.md §5): "Show me concepts" → "Plan this one" → "Walk through it" →
 * "Revise with 3 comments" (or "Share" with none) → "See what changed". Views can override it through
 * useAskContext({ next }); this is the default for each view.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Project } from "@contracts/api-types";
import { canEdit, hasVersion, roleOf, type ViewId } from "@/app/lib/views";
import { useProject } from "@/app/store/project";
import type { NextMove } from "./ask";
import { useShell } from "./state";

// ── "See what changed" is offered once per revised version ─────────────────────────────────────────────
const SEEN_KEY = "naqsha.seenVersions";
const seenListeners = new Set<() => void>();
function readSeen(): string {
  try { return localStorage.getItem(SEEN_KEY) ?? "[]"; } catch { return "[]"; }
}
export function markVersionSeen(vid: string | null | undefined) {
  if (!vid) return;
  const list = JSON.parse(readSeen()) as string[];
  if (list.includes(vid)) return;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...list.slice(-50), vid])); } catch { /* ignore */ }
  for (const fn of seenListeners) fn();
}
function useSeen(): string[] {
  const raw = useSyncExternalStore(
    (fn) => { seenListeners.add(fn); return () => seenListeners.delete(fn); },
    readSeen,
  );
  return useMemo(() => JSON.parse(raw) as string[], [raw]);
}

/**
 * Opens the share dialog. A guest owner can turn on the client link straight away; the dialog asks for an account
 * only for email invites and team roles.
 */
export async function startShare() {
  useShell.getState().setShare(true);
}

export function useDefaultNext(view: ViewId, project: Project | null): NextMove | null {
  const navigate = useNavigate();
  const comments = useProject((s) => s.comments);
  const designRunning = useProject((s) => s.design.status === "running");
  const reviseRunning = useProject((s) => s.revise.status === "running");
  const conceptsRunning = useProject((s) => !!s.conceptRun?.running);
  const seen = useSeen();
  const [params] = useSearchParams();
  const mode = params.get("mode");

  return useMemo<NextMove | null>(() => {
    if (!project) return null;
    const st = useProject.getState();
    const to = (v: ViewId, qs = "") => {
      // Day or night carries over (the House keeps ?light=night when you come back to it).
      const light = new URLSearchParams(window.location.search).get("light");
      const q = new URLSearchParams(qs.replace(/^\?/, ""));
      if (light && !q.has("light")) q.set("light", light);
      const search = q.toString();
      navigate(`/app/p/${project.id}/${v}${search ? `?${search}` : ""}`);
    };
    const client = roleOf(project) === "client";
    const current = project.current_version_id;
    const latest = [...project.versions].sort((a, b) => b.n - a.n)[0];
    const open = comments.filter((c) => c.status === "open" && c.version_id === current).length;

    if (client) {
      if (view === "plan" && hasVersion(project)) return { label: "Walk through it", run: () => to("house", "?mode=walk") };
      return null;
    }

    switch (view) {
      case "brief":
        if (project.stage === "setup" || conceptsRunning) return null;
        if (!project.taste) return { label: "Who's home?", run: () => to("taste") };
        return {
          label: "Show me concepts",
          run: () => {
            if (!project.concepts.length) void st.generateConcepts();
            to("concepts");
          },
        };
      case "taste":
        if (!project.taste || conceptsRunning) return null;
        return {
          label: project.concepts.some((c) => c.from_taste) ? "See our concepts" : "Design from our taste",
          run: () => {
            if (!project.concepts.some((c) => c.from_taste)) void st.generateConcepts();
            to("concepts");
          },
        };
      case "concepts":
        if (conceptsRunning) return null;
        if (!project.concepts.length) return { label: "Show me concepts", run: () => void st.generateConcepts() };
        if (!project.selected_concept_id) return null;
        if (designRunning || project.versions.length) return { label: "See the plan", run: () => to("plan") };
        return {
          label: "Plan this one",
          run: () => {
            if (!project.versions.length) void st.runDesign();
            to("plan");
          },
        };
      case "plan":
        if (designRunning) return null;
        if (hasVersion(project)) return { label: "Walk through it", run: () => to("house", "?mode=walk") };
        if (project.selected_concept_id && canEdit(project)) return { label: "Plan this one", run: () => void st.runDesign() };
        return null;
      case "house":
        if (reviseRunning || designRunning) return null;
        // A comment saved on this version wins at once: the next move is to revise with it.
        if (open > 0) {
          return {
            label: `Revise with ${open} ${open === 1 ? "comment" : "comments"}`,
            run: () => useShell.getState().openComments({ apply: true }),
          };
        }
        if (latest?.n > 1 && latest.id === current && !seen.includes(latest.id)) {
          // A fresh copy of a sample: walk it first (the house is the point), then see what its revision changed.
          if (project.cloned_from && mode !== "walk") return { label: "Walk through it", run: () => to("house", "?mode=walk") };
          return { label: "See what changed", run: () => to("revisions") };
        }
        if (roleOf(project) === "owner") return { label: "Share", run: () => void startShare() };
        return null;
      case "revisions":
        if (reviseRunning) return null;
        // The page's one "Walk through it": into the version on screen (?v=), the latest by default.
        return hasVersion(project)
          ? {
              label: "Walk through it",
              run: () => {
                const v = new URLSearchParams(window.location.search).get("v");
                to("house", v && v !== current ? `?mode=walk&v=${encodeURIComponent(v)}` : "?mode=walk");
              },
            }
          : null;
    }
  }, [project, view, comments, designRunning, reviseRunning, conceptsRunning, seen, navigate, mode]);
}
