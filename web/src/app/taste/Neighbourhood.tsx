/** Where the home is: the plot pinned on a map, shown on the Brief. It is a place, not a design input. */
import { lazy, Suspense, useEffect } from "react";
import { MapPin } from "lucide-react";
import { create } from "zustand";
import type { Locality, Project } from "@contracts/api-types";
import { api } from "@/api/client";
import { canEdit } from "@/app/lib/views";
import { useProject } from "@/app/store/project";

const NeighbourhoodMap = lazy(() => import("./NeighbourhoodMap").then((m) => ({ default: m.NeighbourhoodMap })));

/** The brief's place, as the neighbourhood is read: "DHA Phase 6, Lahore". */
export function placeOf(project: Project): string {
  const b = project.brief;
  return [b?.scheme, b?.city].filter(Boolean).join(", ");
}

const useReads = create<{ busy: Record<string, string>; failed: Record<string, string> }>(() => ({ busy: {}, failed: {} }));

/** Read the neighbourhood once the brief has a place (and again when the place changes). */
export function useLocality(project: Project | null) {
  const where = project ? placeOf(project) : "";
  const have = project?.locality?.location;
  const pid = project?.id;
  const editor = !!project && canEdit(project);
  useEffect(() => {
    if (!pid || !where || !editor || have === where) return;
    const { busy, failed } = useReads.getState();
    if (busy[pid] === where || failed[pid] === where) return;
    useReads.setState({ busy: { ...busy, [pid]: where } });
    api.readLocality(pid)
      .then((p) => {
        const cur = useProject.getState().project;
        if (cur?.id === pid) useProject.setState({ project: { ...cur, locality: p.locality } });
      })
      .catch(() => useReads.setState((s) => ({ failed: { ...s.failed, [pid]: where } })))
      .finally(() => useReads.setState((s) => {
        const { [pid]: _, ...rest } = s.busy;
        return { busy: rest };
      }));
  }, [pid, where, have, editor]);
}

export function useLocalityBusy(project: Project): boolean {
  return useReads((s) => !!s.busy[project.id]);
}

export function Neighbourhood({ project }: { project: Project }) {
  const loc = project.locality;
  const busy = useLocalityBusy(project);
  if (!loc?.center) return busy ? <Reading where={placeOf(project)} /> : null;
  return (
    <section className="relative h-[240px] overflow-hidden rounded-media bg-surface-2 shadow-e1">
      <Suspense fallback={<div className="size-full animate-pulse bg-surface-2" />}>
        <NeighbourhoodMap center={loc.center} places={loc.places} label={`Map of ${loc.location} with your plot`} className="absolute inset-0" />
      </Suspense>
      <div className="pointer-events-none absolute left-4 top-4 inline-flex items-center gap-2 rounded-full glass-light px-3 py-1.5 text-small font-medium text-ink">
        <MapPin className="size-4 text-accent" /> {loc.location}
      </div>
    </section>
  );
}

function Reading({ where }: { where: string }) {
  return (
    <section aria-live="polite" className="grid h-[240px] place-items-center rounded-media bg-surface-2">
      <p className="inline-flex items-center gap-2 text-body text-ink-2"><MapPin className="size-4 animate-breathe text-accent" /> Finding {where || "your plot"}…</p>
    </section>
  );
}

export type { Locality };
