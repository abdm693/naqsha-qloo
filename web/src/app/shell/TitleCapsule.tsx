/**
 * Title capsule (DESIGN.md §5.1), top-left: ← Homes, the name (renamed inline) and the status line
 * "v2 · 42/42 LDA · 5/5 livable · Saved". Its menu holds Versions, Print plan…, Share, Rename, Details and All homes.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, CircleAlert, CloudUpload, History, Info, LayoutGrid, Pencil, Printer, Share2 } from "lucide-react";
import type { Project } from "@contracts/api-types";
import { cn } from "@/app/lib/utils";
import { canEdit, resolveVersion, roleOf, viewAvailable } from "@/app/lib/views";
import { requireAccount, useAuth } from "@/app/store/auth";
import { useProject } from "@/app/store/project";
import { Menu, type MenuItem } from "@/app/ui/Menu";
import { Tooltip } from "@/app/ui/Tooltip";
import { notesLine } from "@/app/plan/compliance";
import { complianceCounts, countsLine } from "./narration";
import { startShare } from "./next";
import { useShell } from "./state";

/** "v1 · 35/36 LDA · 10/11 livable · 2 to check · Saved", for the version on screen (?v=), not just the latest. */
export function useStatusLine(project: Project): string {
  const [params] = useSearchParams();
  const versions = useProject((s) => s.versions);
  const asBuilt = useProject((s) => s.asBuilt);
  const saveState = useProject((s) => s.saveState);
  // While a design run is going, its own stage says where it is (the stored project stage isn't refreshed until the
  // build starts, so it would still read "Concepts" while Naqsha plans).
  const runStage = useProject((s) => {
    const r = s.design;
    if (s.pid !== project.id || r.status !== "running") return null;
    for (let i = r.items.length - 1; i >= 0; i--) {
      const it = r.items[i];
      if (it.kind === "stage" && it.stage !== "wait") return it.stage;
    }
    return "plan";
  });
  const shownId = resolveVersion(project, params.get("v")).id;
  const current = project.versions.find((v) => v.id === shownId);
  const counts = complianceCounts(project, versions, asBuilt, shownId);
  const bits: string[] = [];
  if (current) bits.push(`v${current.n}${current.id !== project.current_version_id ? " (earlier)" : ""}`);
  if (counts) bits.push(countsLine(counts));
  if (runStage) bits.push(runStage === "build" || runStage === "save" ? "Building in 3D" : "Planning");
  else if (saveState === "saving") bits.push("Saving…");
  else if (saveState === "saved") bits.push("Saved");
  else if (!current) {
    const s = project.stage;
    bits.push(s === "setup" ? "Brief" : s === "planning" ? "Planning" : s === "building" ? "Building in 3D" : project.concepts.length ? "Concepts" : "Draft");
  }
  return bits.join(" · ");
}

export function TitleCapsule({
  project,
  tone,
  onDetails,
  compact,
  view,
}: {
  project: Project;
  tone: "light" | "hud";
  onDetails: () => void;
  /** Phone: no status line, no menu chevron text. */
  compact?: boolean;
  /** The view on screen: on a phone's House the menu also holds the notes from the 3D model. */
  view?: string;
}) {
  const navigate = useNavigate();
  const rename = useProject((s) => s.rename);
  const signedIn = useAuth((s) => !!s.user);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(project.name);
  const input = useRef<HTMLInputElement>(null);
  const status = useStatusLine(project);
  const [params] = useSearchParams();
  const shownId = resolveVersion(project, params.get("v")).id;
  const notes = useProject((s) => (shownId ? s.asBuilt[shownId]?.checks.filter((c) => c.status !== "pass").length ?? 0 : 0));
  const hud = tone === "hud";
  const editable = canEdit(project);
  const base = `/app/p/${project.id}`;

  useEffect(() => setValue(project.name), [project.name]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = value.trim();
    if (v && v !== project.name) void rename(v);
    else setValue(project.name);
  };

  const items: MenuItem[] = [];
  const notesItem = compact && view === "house" && notes > 0;
  if (notesItem) {
    items.push({ label: notesLine(notes).replace(/^\w/, (c) => c.toUpperCase()), icon: <CircleAlert />, onSelect: () => useShell.getState().setAsBuiltOpen(true) });
    items.push({ separator: true });
  }
  if (viewAvailable(project, "revisions")) items.push({ label: "Versions", icon: <History />, onSelect: () => navigate(`${base}/revisions`) });
  if (project.current_version_id && viewAvailable(project, "plan")) items.push({ label: "Print plan…", icon: <Printer />, onSelect: () => navigate(`${base}/plan?dialog=print`) });
  if (roleOf(project) === "owner") items.push({ label: "Share…", icon: <Share2 />, onSelect: () => void startShare() });
  if (editable) items.push({ label: "Rename", icon: <Pencil />, onSelect: () => setEditing(true) });
  items.push({ label: "Details", icon: <Info />, onSelect: onDetails });
  items.push({ separator: true });
  if (!signedIn) items.push({ label: "Save your work…", icon: <CloudUpload />, onSelect: () => void requireAccount("save") });
  items.push({ label: "All homes", icon: <LayoutGrid />, onSelect: () => navigate("/app") });

  return (
    <div
      className={cn(
        "pointer-events-auto flex h-12 min-w-0 items-center gap-1 rounded-full pl-1.5 pr-1",
        hud ? "glass-hud" : "glass-light",
      )}
    >
      <Tooltip content="All homes">
        <button
          type="button"
          onClick={() => navigate("/app")}
          aria-label="All homes"
          className={cn(
            "hit-44 relative grid size-9 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:shadow-focus",
            hud ? "text-hud-ink-2 hover:bg-white/10 hover:text-hud-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
          )}
        >
          <ArrowLeft className="size-[18px]" strokeWidth={1.75} />
        </button>
      </Tooltip>
      <div className="flex min-w-0 flex-col justify-center pl-1 pr-1">
        {editing ? (
          <input
            ref={input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                e.stopPropagation();
                setValue(project.name);
                setEditing(false);
              }
            }}
            maxLength={80}
            aria-label="Home name"
            className={cn(
              "h-6 w-[min(260px,50vw)] rounded-[6px] px-1 -mx-1 text-[14px] font-semibold tracking-[-.01em] outline-none",
              hud ? "bg-white/10 text-hud-ink" : "bg-surface text-ink shadow-[0_0_0_1px_var(--color-accent)]",
            )}
          />
        ) : (
          <button
            type="button"
            onClick={() => editable && setEditing(true)}
            title={editable ? "Rename" : undefined}
            disabled={!editable}
            className={cn(
              "max-w-[min(280px,56vw)] truncate rounded-[6px] text-left text-[14px] font-semibold leading-[18px] tracking-[-.01em] outline-none focus-visible:shadow-focus disabled:cursor-default",
              // Phones: the name itself is a 44px-tall target (the capsule is 48px and has no status line there).
              compact && "py-[13px]",
              hud ? "text-hud-ink" : "text-ink",
            )}
          >
            {project.name}
          </button>
        )}
        {!compact && status && view !== "taste" && (
          <span className={cn("tabular truncate text-[12px] font-medium leading-[14px]", hud ? "text-hud-ink-2" : "text-ink-3")}>
            {status}
          </span>
        )}
      </div>
      <Menu
        align="left"
        width={notesItem ? 250 : 220}
        label="Home menu"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label="Home menu"
            className={cn(
              "hit-44 relative grid size-8 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:shadow-focus",
              hud ? "text-hud-ink-2 hover:bg-white/10 hover:text-hud-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
              open && (hud ? "bg-white/10" : "bg-surface-2"),
            )}
          >
            <ChevronDown className="size-4" strokeWidth={1.75} />
          </button>
        )}
        items={items}
      />
    </div>
  );
}

