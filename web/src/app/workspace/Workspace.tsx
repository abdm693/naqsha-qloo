/**
 * The workspace (/app, DESIGN.md §6 "Workspace"): the wordmark and the account, a composer to start a home in one
 * message, then Your homes · Shared with you · Samples in a 3/2/1-column grid with real thumbnails.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowUpRight, Ellipsis, ExternalLink, PencilLine, RefreshCw, Trash2 } from "lucide-react";
import type { Project } from "@contracts/api-types";
import { api, assetUrl, errorMessage } from "@/api/client";
import { plotLabel } from "@/api/domain";
import { cn, relativeTime } from "@/app/lib/utils";
import { usePhone } from "@/app/lib/hooks";
import { roleOf, stageBusy, stageLabel } from "@/app/lib/views";
import { sampleTitle } from "@/app/lib/samples";
import { sentenceCase } from "@/app/plan/model";
import { requireAccount, useAuth } from "@/app/store/auth";
import { queueFirstMessage } from "@/app/store/project";
import { useDrawingPicker } from "@/app/setup/DrawingCard";
import { importDrawing, notAnImage, sheetsIn } from "@/app/setup/drawing";
import { toast } from "@/app/store/toast";
import { AccountMenu } from "@/app/auth/AccountMenu";
import { Button } from "@/app/ui/Button";
import { Card } from "@/app/ui/Card";
import { StatusChip } from "@/app/ui/Chip";
import { Composer } from "@/app/ui/Composer";
import { Dialog } from "@/app/ui/Dialog";
import { Input } from "@/app/ui/Input";
import { Menu } from "@/app/ui/Menu";
import { Segmented } from "@/app/ui/Segmented";
import { Wordmark, PlotSketch } from "@/app/ui/brand";
import { ease } from "@/app/ui/motion";

type Tab = "mine" | "shared" | "samples";

export function Workspace() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const epoch = useAuth((s) => s.epoch);
  const phone = usePhone();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [samples, setSamples] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  // Focus goes back to the card's More button after Rename or Delete (or to the next card after a delete).
  const focusAfter = useRef<string | null>(null);
  const moreButton = (id: string | null) => (id ? document.querySelector<HTMLElement>(`[data-card-more="${CSS.escape(id)}"]`) : null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  // The header is clear over the warm light at the top and turns to glass once the page scrolls.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    document.title = "Your homes · Naqsha";
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => {
    void load();
  }, [load, epoch]);
  useEffect(() => {
    // Samples are optional: an older server without /samples simply shows none.
    api.listSamples().then((s) => setSamples(Array.isArray(s) ? s : []), () => setSamples([]));
  }, []);

  const mine = useMemo(() => projects?.filter((p) => roleOf(p) === "owner") ?? [], [projects]);
  const shared = useMemo(() => projects?.filter((p) => roleOf(p) !== "owner") ?? [], [projects]);
  // New people see the samples first.
  const active: Tab = tab ?? (projects && !mine.length && !shared.length ? "samples" : "mine");

  const create = async (message?: string) => {
    if (creating) return;
    setCreating(true);
    try {
      const p = await api.createProject();
      if (message) queueFirstMessage(p.id, message);
      navigate(`/app/p/${p.id}/brief`);
    } catch (e) {
      toast.error("Couldn't start a new home", e);
      setCreating(false);
    }
  };

  /** A home started from the family's own floor plan: it is read while the Brief opens (the Brief shows the reading). */
  const createFromDrawing = async (files: File[]) => {
    if (creating) return;
    if (!sheetsIn(files).length) return notAnImage();
    setCreating(true);
    try {
      const p = await api.createProject();
      void importDrawing(p.id, files);
      navigate(`/app/p/${p.id}/brief`);
    } catch (e) {
      toast.error("Couldn't start a new home", e);
      setCreating(false);
    }
  };
  const drawing = useDrawingPicker((files) => void createFromDrawing(files));

  /** Open your copy of a sample (made once, then reused). */
  const openSample = async (s: Project) => {
    if (opening) return;
    setOpening(s.id);
    try {
      const p = await api.cloneProject(s.id);
      navigate(`/app/p/${p.id}/${p.current_version_id ? "house" : ""}`);
    } catch (e) {
      toast.error("Couldn't open the sample", e);
      setOpening(null);
    }
  };

  const rename = async (p: Project, name: string) => {
    const prev = projects;
    setProjects((list) => list?.map((x) => (x.id === p.id ? { ...x, name } : x)) ?? null);
    try {
      await api.updateProject(p.id, { name });
    } catch (e) {
      setProjects(prev);
      toast.error("Couldn't rename this home", e);
    }
  };

  const remove = async (p: Project) => {
    try {
      await api.deleteProject(p.id);
      const i = mine.findIndex((x) => x.id === p.id);
      const next = mine[i + 1] ?? mine[i - 1];
      focusAfter.current = next?.id ?? null;
      setProjects((list) => list?.filter((x) => x.id !== p.id) ?? null);
      toast.show("Home deleted");
      return true;
    } catch (e) {
      toast.error("Couldn't delete this home", e);
      return false;
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (t) void create(t);
  };

  const list = active === "mine" ? mine : active === "shared" ? shared : samples ?? [];

  return (
    <div className="relative min-h-[100dvh] overflow-x-clip bg-canvas">
      {/* The same warm light as the landing, behind the greeting. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px]"
        style={{ background: "radial-gradient(55% 60% at 85% 0%, rgb(226 186 140 / .24), transparent 70%), radial-gradient(40% 50% at 0% 0%, rgb(236 214 190 / .30), transparent 70%)" }}
        aria-hidden
      />
      <header className={cn("sticky top-0 z-20 transition-[background-color,box-shadow,backdrop-filter] duration-300", scrolled ? "glass-light" : "bg-transparent")}>
        <div className="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-3 px-4 sm:px-8">
          <Link to="/" aria-label="Naqsha home" className="rounded-[8px] outline-none focus-visible:shadow-focus">
            <Wordmark />
          </Link>
          <div className="flex items-center gap-2">
            {api.mock && <span className="hidden text-[12px] font-medium text-ink-3 sm:inline">Demo data</span>}
            {!user && <span className="hidden text-[13px] text-ink-3 md:inline">Guest · saved in this browser</span>}
            <AccountMenu guestLabel="Sign in" />
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-[1280px] px-4 pb-24 sm:px-8">
        {/* Start a home in one message */}
        {/* One left edge: the heading, the composer, the tabs and the grid all start at the container's gutter. */}
        <section className="max-w-[720px] pb-10 pt-10 sm:pb-14 sm:pt-16" aria-labelledby="start-heading">
          <h1 id="start-heading" className="font-display text-[44px]/[48px] font-normal tracking-[-.015em] text-ink sm:text-[64px]/[68px]">
            {user?.name ? `Salaam, ${user.name.split(" ")[0]}.` : mine.length || shared.length ? "Your homes" : "Start a home"}
          </h1>
          <p className="mt-3 text-body-lg text-ink-2">Describe your plot and your family to start. One message is enough.</p>
          <form onSubmit={submit} className="mt-6">
            <Composer
              value={text}
              onChange={setText}
              onSubmit={() => submit()}
              placeholder={phone ? "10 marla, Johar Town, for six" : "10 marla in Johar Town, east-facing, mid-row, for six"}
              label="Describe your plot"
              busy={creating}
              className="shadow-e2"
            />
          </form>
          <p className="mt-3 text-[13px] text-ink-3">
            Or{" "}
            <button type="button" onClick={() => void create()} className="hit-44 relative font-medium text-ink-2 underline-offset-4 outline-none hover:text-ink hover:underline focus-visible:underline" disabled={creating}>
              start with questions
            </button>
            {" "}and Naqsha will ask one at a time.
          </p>
          <p className="mt-1 text-[13px] text-ink-3">
            Have a floor plan already?{" "}
            <button type="button" onClick={drawing.pick} className="hit-44 relative font-medium text-ink-2 underline-offset-4 outline-none hover:text-ink hover:underline focus-visible:underline" disabled={creating}>
              Start from your drawing
            </button>
            {" "}and the design keeps its layout.
          </p>
          {drawing.input}
        </section>

        {/* Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pb-6 pt-8">
          <Segmented<Tab>
            label="Homes"
            value={active}
            onChange={setTab}
            options={[
              { value: "mine", label: `Your homes${mine.length ? ` · ${mine.length}` : ""}` },
              ...(shared.length || user ? [{ value: "shared" as const, label: `Shared with you${shared.length ? ` · ${shared.length}` : ""}` }] : []),
              { value: "samples", label: "Samples" },
            ]}
          />
          {!user && mine.length > 0 && (
            <button
              type="button"
              onClick={() => void requireAccount("save")}
              className="rounded-full px-3 py-1.5 text-[13px] font-medium text-accent outline-none hover:bg-accent-soft focus-visible:shadow-focus"
            >
              Save your work to an account
            </button>
          )}
        </div>

        {error ? (
          <div className="grid place-items-center rounded-panel bg-surface px-6 py-16 text-center shadow-e1">
            <p className="text-heading text-ink">Your homes didn't load</p>
            <p className="mt-1.5 max-w-sm text-[15px] text-ink-2">{error}</p>
            <Button className="mt-5" icon={<RefreshCw className="size-4" strokeWidth={1.75} />} onClick={() => void load()}>Try again</Button>
          </div>
        ) : (active !== "samples" && !projects) || (active === "samples" && !samples) ? (
          <SkeletonGrid />
        ) : (
          <motion.ul
            key={active}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: ease.out }}
            // Two samples fill two columns; homes run three across.
            className={cn("grid grid-cols-1 gap-x-6 gap-y-9 sm:grid-cols-2", active !== "samples" && "lg:grid-cols-3")}
          >
            {/* The composer above starts a home: no dashed "New home" tile repeating it. */}
            {active === "mine" && !list.length && (
              <li className="col-span-full">
                <Empty title="No homes yet" line="Describe your plot above to start one, or open a sample to walk a finished home." />
              </li>
            )}
            {list.map((p) => (
              <li key={p.id}>
                {active === "samples" ? (
                  <SampleCard sample={p} opening={opening === p.id} onOpen={() => void openSample(p)} />
                ) : (
                  <HomeCard
                    project={p}
                    onOpen={() => navigate(`/app/p/${p.id}`)}
                    onRename={() => { focusAfter.current = p.id; setRenaming(p); }}
                    onDelete={() => { focusAfter.current = p.id; setDeleting(p); }}
                  />
                )}
              </li>
            ))}
            {active === "shared" && !list.length && (
              <li className="col-span-full">
                <Empty title="Nothing shared with you yet" line="When an architect or a family member invites you to a home, it appears here." />
              </li>
            )}
            {active === "samples" && !list.length && (
              <li className="col-span-full">
                <Empty title="No samples right now" line="Start your own home above. It takes one message." />
              </li>
            )}
          </motion.ul>
        )}
      </main>

      <RenameDialog project={renaming} onClose={() => setRenaming(null)} onRename={rename} returnFocus={() => moreButton(focusAfter.current)} />
      <DeleteDialog project={deleting} onClose={() => setDeleting(null)} onDelete={remove} returnFocus={() => moreButton(focusAfter.current) ?? document.querySelector<HTMLElement>("[aria-label='Start a new home']")} />
    </div>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The chosen concept's day image (at card size) when the home has one; else the stored thumbnail. A version's
 * capture (a grey aerial or a cut-away) never stands in for a concept the family picked.
 */
function cardImage(p: Project): string | undefined {
  const chosen = p.concepts?.find((c) => c.id === p.selected_concept_id);
  if (chosen?.url) return assetUrl(chosen.url, { w: 640 });
  return assetUrl(p.thumbnail_url);
}

function Thumb({ p }: { p: Project }) {
  const url = cardImage(p);
  const [failed, setFailed] = useState(false);
  if (url && !failed) return <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />;
  return (
    <div className="grid size-full place-items-center bg-surface p-8" style={{ backgroundImage: "linear-gradient(rgb(74 52 30 / .04) 1px, transparent 1px), linear-gradient(90deg, rgb(74 52 30 / .04) 1px, transparent 1px)", backgroundSize: "20px 20px" }}>
      <PlotSketch envelope={p.envelope} width={p.brief?.plot?.width_ft} depth={p.brief?.plot?.depth_ft} />
    </div>
  );
}

function caption(p: Project): string {
  const bits: string[] = [];
  const v = p.versions.length;
  // A home with no version yet is a draft, whatever step its brief has reached: "Draft · 8 hours ago".
  if (!v) return ["Draft", relativeTime(p.updated_at)].join(" · ");
  bits.push(`Version ${v}`);
  if (p.cloned_from) bits.push("From the samples");
  else if (p.members_count) bits.push(`Shared with ${p.members_count}`);
  else if (p.brief?.plot?.area_marla) bits.push(plotLabel(p.brief.plot.area_marla));
  bits.push(relativeTime(p.updated_at));
  return bits.join(" · ");
}

function HomeCard({ project: p, onOpen, onRename, onDelete }: { project: Project; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
  const owner = roleOf(p) === "owner";
  return (
    <Card
      media={<Thumb p={p} />}
      title={p.name}
      caption={caption(p)}
      onClick={onOpen}
      label={`Open ${p.name}`}
      badge={stageBusy(p) ? <StatusChip tone="progress" className="glass-light">{stageLabel(p)}</StatusChip> : roleOf(p) !== "owner" ? <StatusChip className="glass-light">{roleOf(p) === "team" ? "Team" : "Client"}</StatusChip> : undefined}
      actions={
        <Menu
          width={200}
          label={`Actions for ${p.name}`}
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-label={`More for ${p.name}`}
              aria-expanded={open}
              aria-haspopup="menu"
              data-card-more={p.id}
              className={cn(
                "hit-44 relative grid size-9 place-items-center rounded-full text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:shadow-focus",
                open && "bg-surface-2 text-ink",
              )}
            >
              <Ellipsis className="size-[18px]" strokeWidth={1.75} />
            </button>
          )}
          items={[
            { label: "Open", icon: <ArrowUpRight />, onSelect: onOpen },
            { label: "Open in a new tab", icon: <ExternalLink />, onSelect: () => window.open(`/app/p/${p.id}`, "_blank", "noopener") },
            ...(owner
              ? [
                  { label: "Rename", icon: <PencilLine />, onSelect: onRename },
                  { separator: true as const },
                  { label: "Delete", icon: <Trash2 />, danger: true, onSelect: onDelete },
                ]
              : []),
          ]}
        />
      }
    />
  );
}

function SampleCard({ sample: s, opening, onOpen }: { sample: Project; opening: boolean; onOpen: () => void }) {
  const b = s.brief;
  return (
    <Card
      media={<Thumb p={s} />}
      title={sampleTitle(s.name)}
      caption={[b?.plot?.area_marla ? plotLabel(b.plot.area_marla) : null, b?.style ? sentenceCase(b.style) : null, "Ready to walk"].filter(Boolean).join(" · ")}
      onClick={onOpen}
      label={`Explore the sample: ${sampleTitle(s.name)}`}
      badge={opening ? <StatusChip tone="progress" className="glass-light">Opening</StatusChip> : <StatusChip className="glass-light" dot={false}>Sample</StatusChip>}
    />
  );
}

function Empty({ title, line }: { title: string; line: string }) {
  return (
    <div className="rounded-panel bg-surface px-6 py-14 text-center shadow-e1">
      <p className="font-display text-[28px] leading-[32px] text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-[15px] leading-[22px] text-ink-2">{line}</p>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-9 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading homes">
      {Array.from({ length: 3 }, (_, i) => (
        <li key={i} className="flex flex-col gap-3">
          <div className="relative aspect-[4/3] overflow-hidden rounded-card bg-surface-2">
            <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-surface/70 to-transparent" />
          </div>
          <div className="h-4 w-2/3 rounded-full bg-surface-2" />
          <div className="h-3 w-1/2 rounded-full bg-surface-2" />
        </li>
      ))}
    </ul>
  );
}

// ── Dialogs ─────────────────────────────────────────────────────────────────────────────────────────

function RenameDialog({ project, onClose, onRename, returnFocus }: { project: Project | null; onClose: () => void; onRename: (p: Project, name: string) => Promise<void>; returnFocus?: () => HTMLElement | null }) {
  const [name, setName] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (project) {
      setName(project.name);
      requestAnimationFrame(() => ref.current?.select());
    }
  }, [project]);
  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!project) return;
    const n = name.trim();
    if (n && n !== project.name) void onRename(project, n);
    onClose();
  };
  return (
    <Dialog
      open={!!project}
      onClose={onClose}
      returnFocus={returnFocus}
      title="Rename this home"
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save()} disabled={!name.trim()}>Save</Button>
        </>
      }
    >
      <form onSubmit={save}>
        <Input ref={ref} aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-autofocus />
      </form>
    </Dialog>
  );
}

function DeleteDialog({ project, onClose, onDelete, returnFocus }: { project: Project | null; onClose: () => void; onDelete: (p: Project) => Promise<boolean>; returnFocus?: () => HTMLElement | null }) {
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Project | null>(project);
  useEffect(() => { if (project) setShown(project); }, [project]);
  const go = async () => {
    if (!project) return;
    setBusy(true);
    const ok = await onDelete(project);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      open={!!project}
      onClose={onClose}
      dismissible={!busy}
      returnFocus={returnFocus}
      title="Delete this home?"
      description={
        <>
          <span className="font-medium text-ink">{shown?.name}</span>, its versions and its comments will be gone for everyone. This can't be undone.
        </>
      }
      actions={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void go()} loading={busy}>Delete</Button>
        </>
      }
    />
  );
}

