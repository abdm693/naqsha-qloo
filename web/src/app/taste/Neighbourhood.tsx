/**
 * The neighbourhood, from the moment Naqsha knows where the plot is: the plot pinned on a map among the places people
 * love around it, how the area feels, and four ideas a house there could take from it. It is read once per place
 * (useLocality, mounted by the project shell) and shown on the Brief, at the top of Taste, and on the family's profile.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Building2, MapPin, Sofa, Trees, Users } from "lucide-react";
import { create } from "zustand";
import type { Locality, Project } from "@contracts/api-types";
import { api } from "@/api/client";
import { cn } from "@/app/lib/utils";
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

const WHERE: Record<string, { icon: typeof Building2; label: string }> = {
  facade: { icon: Building2, label: "The house" },
  inside: { icon: Sofa, label: "Inside" },
  garden: { icon: Trees, label: "Garden" },
  living: { icon: Users, label: "Living" },
};

export function Neighbourhood({ project, compact, title, sub, action }: {
  project: Project; compact?: boolean; title?: string; sub?: string; action?: { label: string; onClick(): void };
}) {
  const loc = project.locality;
  const busy = useLocalityBusy(project);
  const [lit, setLit] = useState<string[] | undefined>();
  if (!loc && !busy) return null;
  if (!loc || !loc.places.length) return busy ? <Reading where={placeOf(project)} compact={compact} /> : null;
  const ideas = compact ? loc.ideas.slice(0, 2) : loc.ideas;
  const short = loc.location.split(",")[0];

  return (
    <section aria-labelledby={`nbh-${project.id}`} className={cn("overflow-hidden rounded-panel bg-surface shadow-e2", !compact && "lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]")}>
      <div className={cn("relative bg-surface-2", compact ? "h-[240px]" : "h-[320px] lg:h-auto lg:min-h-[520px]")}>
        {loc.center ? (
          <Suspense fallback={<div className="size-full animate-pulse bg-surface-2" />}>
            <NeighbourhoodMap center={loc.center} places={loc.places} highlight={lit} label={`Map of ${loc.location} with your plot and ${loc.places.length} places around it`} className="absolute inset-0" />
          </Suspense>
        ) : null}
        <div className="pointer-events-none absolute left-4 top-4 inline-flex items-center gap-2 rounded-full glass-light px-3 py-1.5 text-small font-medium text-ink">
          <MapPin className="size-4 text-taste-2" /> {loc.location}
        </div>
      </div>

      <div className={cn("flex flex-col", compact ? "p-5" : "p-6 sm:p-8")}>
        <p className="text-small font-medium uppercase tracking-[.12em] text-ink-3">{sub || `Around ${short}`}</p>
        <h2 id={`nbh-${project.id}`} className={cn("mt-2 font-display leading-tight tracking-[-.03em] text-ink", compact ? "text-[1.35rem]" : "text-[1.9rem]")}>
          {title || "Your neighbourhood"}
        </h2>
        {loc.reading && <p className={cn("mt-3 text-ink-2", compact ? "text-body" : "text-body-lg")}>{loc.reading}</p>}
        {!!loc.feel.length && (
          <ul aria-label={`How ${short} feels`} className="mt-4 flex flex-wrap gap-1.5">
            {loc.feel.slice(0, compact ? 5 : 8).map((f) => (
              <li key={f.name} className="rounded-full bg-taste-soft px-2.5 py-1 text-small font-medium text-taste-ink">{f.name}</li>
            ))}
          </ul>
        )}

        {!!ideas.length && (
          <div className="mt-6">
            <p className="text-small font-medium text-ink-3">What a house here could take from it</p>
            <ul className="mt-2 divide-y divide-line">
              {ideas.map((x, i) => {
                const w = WHERE[x.where || ""] ?? WHERE.living;
                const Icon = w.icon;
                return (
                  <motion.li key={x.title} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 * i }}
                    onMouseEnter={() => setLit(x.from)} onMouseLeave={() => setLit(undefined)} onFocus={() => setLit(x.from)} onBlur={() => setLit(undefined)}
                    tabIndex={x.from?.length ? 0 : undefined}
                    className="group flex gap-3 rounded-control py-3 outline-none focus-visible:shadow-focus">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2 transition group-hover:bg-taste-soft group-hover:text-taste-ink">
                      <Icon className="size-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-body font-semibold text-ink">{x.title}</span>
                      <span className="mt-0.5 block text-body text-ink-2">{x.line}</span>
                      {!!x.from?.length && !compact && (
                        <span className="mt-1 block text-small text-ink-3">From {x.from.join(", ")}</span>
                      )}
                    </span>
                  </motion.li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4">
          <span className="text-small text-ink-3">{loc.places.length} places read around your plot</span>
          {action && (
            <button type="button" onClick={action.onClick} className="inline-flex items-center gap-1.5 text-small font-semibold text-accent hover:underline">
              {action.label} <ArrowRight className="size-4" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Reading({ where, compact }: { where: string; compact?: boolean }) {
  return (
    <section aria-live="polite" className={cn("relative grid place-items-center overflow-hidden rounded-panel taste-wash", compact ? "h-[200px]" : "h-[280px]")}>
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="relative grid size-12 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-taste-2/25" />
          <MapPin className="relative size-7 text-taste-2" />
        </span>
        <p className="text-body font-medium text-ink">Walking around {where || "your neighbourhood"}…</p>
        <p className="max-w-[340px] text-small text-ink-3">Reading the places people love nearby, to see what your house could take from them.</p>
      </div>
    </section>
  );
}

export type { Locality };
