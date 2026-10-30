/**
 * The client view (/s/:token): calm and read-only. The plan and the 3D home, walk-through and comments.
 * No Brief, no Details. A banner says who shared it; the visitor gives only a name, once, on their first comment.
 * Next reads "Approve vN". Comments refresh every 10 s so the owner's answers show up.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { MessageSquare } from "lucide-react";
import type { Comment } from "@contracts/api-types";
import { api, ApiError } from "@/api/client";
import { cn } from "@/app/lib/utils";
import { isTyping, useMediaQuery, usePhone } from "@/app/lib/hooks";
import { setNameAsker, useProject } from "@/app/store/project";
import { toast } from "@/app/store/toast";
import { CommentsSheet } from "@/app/comments/CommentsSheet";
import { FloorPlan, type PlanPin } from "@/app/plan/FloorPlan";
import { anchorLevel, anchorPlanXY, authorHue, levelKey, levelName, levelsOf } from "@/app/plan/model";
import { FloorStack, stackItems } from "@/app/design/FloorStack";
import { pinNumbers } from "@/app/comments/model";
import { Dock } from "@/app/shell/Dock";
import { useAsk } from "@/app/shell/ask";
import { useShell } from "@/app/shell/state";
import type { Command } from "@/app/shell/ask";
import { Button } from "@/app/ui/Button";
import { Dialog } from "@/app/ui/Dialog";
import { Input } from "@/app/ui/Input";
import { Segmented } from "@/app/ui/Segmented";
import { Spinner } from "@/app/ui/Spinner";
import { Tooltip } from "@/app/ui/Tooltip";
import { Wordmark } from "@/app/ui/brand";
import { frontCamera, generalAnchor } from "./anchor";

const HouseStage = lazy(() => import("./HouseStage").then((m) => ({ default: m.HouseStage })));

type ClientTab = "plan" | "house";
const approvedKey = (vid: string) => `naqsha.approved.${vid}`;

export function ClientView() {
  const { token = "" } = useParams();
  const openShared = useProject((s) => s.openShared);
  const loadState = useProject((s) => s.loadState);
  const loadError = useProject((s) => s.loadError);
  const project = useProject((s) => (s.shareToken === token ? s.project : null));

  useEffect(() => {
    void openShared(token);
  }, [token, openShared]);
  useEffect(() => {
    document.title = project?.name ? `${project.name} · Naqsha` : loadState === "error" ? "This link isn't working · Naqsha" : "Opening the home · Naqsha";
  }, [project?.name, loadState]);

  // Presence: pick up new comments and replies every 10 s (the light comments endpoint), and whether a newer
  // version exists every 30 s.
  const pid = project?.id;
  const [revoked, setRevoked] = useState(false);
  useEffect(() => setRevoked(false), [token]);
  useEffect(() => {
    if (!pid) return;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const list = await api.listSharedComments(token);
        const st = useProject.getState();
        if (st.shareToken !== token) return;
        // Keep optimistic replies that the server hasn't echoed yet.
        const pending = new Map(st.comments.map((c) => [c.id, (c.replies ?? []).filter((r) => r.id.startsWith("reply-"))]));
        const next = list.map((c) => ({ ...c, replies: [...(c.replies ?? []), ...(pending.get(c.id) ?? [])] }));
        if (JSON.stringify(next) !== JSON.stringify(st.comments)) useProject.setState({ comments: next });
      } catch (e) {
        // The owner turned the link off: say so on this poll instead of failing quietly on the next send.
        if (e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 410)) setRevoked(true);
        /* otherwise stay quiet; try again next tick */
      }
    }, 10_000);
    return () => clearInterval(t);
  }, [pid, token]);
  useEffect(() => {
    if (!pid) return;
    let warned: string | null = null;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const meta = await api.getSharedMeta(token);
        const st = useProject.getState();
        const shownId = st.project?.current_version_id;
        if (st.shareToken !== token || !meta.current_version_id || meta.current_version_id === shownId || warned === meta.current_version_id) return;
        warned = meta.current_version_id;
        const n = meta.versions.find((v) => v.id === meta.current_version_id)?.n;
        toast.show(`Version ${n ?? "a new"} is ready`, { action: { label: "View", run: () => void useProject.getState().openShared(token) }, duration: 0 });
      } catch { /* try again later */ }
    }, 30_000);
    return () => clearInterval(t);
  }, [pid, token]);

  if (revoked) {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-canvas px-4 text-center">
        <div className="max-w-sm">
          <Wordmark className="justify-center" />
          <h1 className="mt-8 text-title text-ink">This link is no longer shared</h1>
          <p className="mt-2 text-[15px] leading-[22px] text-ink-2">The owner turned it off. Ask them to share the home again if you still need it.</p>
          <Link to="/" className="mt-6 inline-block text-[14px] font-medium text-accent underline-offset-4 hover:underline">What is Naqsha?</Link>
        </div>
      </div>
    );
  }
  if (!project) {
    if (loadState === "error") {
      return (
        <div className="grid min-h-[100dvh] place-items-center bg-canvas px-4 text-center">
          <div className="max-w-sm">
            <Wordmark className="justify-center" />
            <h1 className="mt-8 text-title text-ink">This link isn't working</h1>
            <p className="mt-2 text-[15px] leading-[22px] text-ink-2">{loadError ?? "Ask the person who shared it to send it again."}</p>
            <Link to="/" className="mt-6 inline-block text-[14px] font-medium text-accent underline-offset-4 hover:underline">What is Naqsha?</Link>
          </div>
        </div>
      );
    }
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-canvas">
        <span className="flex items-center gap-2.5 text-[14px] text-ink-3"><Spinner /> Opening the home…</span>
      </div>
    );
  }
  return <ClientShell token={token} />;
}

function ClientShell({ token }: { token: string }) {
  const project = useProject((s) => s.project)!;
  const versions = useProject((s) => s.versions);
  const comments = useProject((s) => s.comments);
  const sharedBy = useProject((s) => s.sharedBy);
  const guestName = useProject((s) => s.guestName);
  const addComment = useProject((s) => s.addComment);
  const [params, setParams] = useSearchParams();
  const phone = usePhone();
  // Touch screens say "Tap", never "Click".
  const touch = useMediaQuery("(pointer: coarse)");
  const ask = useAsk();
  const right = useShell((s) => s.right);
  const focusComment = useShell((s) => s.focusComment);
  const { openComments, closeComments, reset } = useShell.getState();
  const [askName, setAskName] = useState<string | null>(null);
  const version = project.current_version_id ? versions[project.current_version_id] : undefined;
  const tab: ClientTab = params.get("view") === "plan" ? "plan" : "house";
  const [houseSeen, setHouseSeen] = useState(tab === "house");
  useEffect(() => { if (tab === "house") setHouseSeen(true); }, [tab]);
  const tone = tab === "house" ? "hud" : "light";
  // Approval is per version: a new version shown is a new question.
  const [approved, setApproved] = useState(false);
  useEffect(() => {
    try { setApproved(!!version && localStorage.getItem(approvedKey(version.id)) === "1"); } catch { setApproved(false); }
  }, [version?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const owner = sharedBy || "the owner";
  // The visitor's name is asked once, before their first note of any kind (replies included).
  const nameWaiter = useRef<((name: string | null) => void) | null>(null);
  const ensureName = useCallback(async (): Promise<boolean> => {
    if (useProject.getState().guestName) return true;
    const name = await new Promise<string | null>((resolve) => {
      nameWaiter.current = resolve;
      setAskName("");
    });
    return !!name;
  }, []);
  useEffect(() => {
    setNameAsker(async () => ((await ensureName()) ? useProject.getState().guestName : null));
    return () => setNameAsker(null);
  }, [ensureName]);

  useEffect(() => () => reset(), [reset]);

  const setTab = useCallback(
    (t: ClientTab) =>
      setParams((p) => {
        const n = new URLSearchParams(p);
        if (t === "plan") n.set("view", "plan");
        else n.delete("view");
        n.delete("mode");
        return n;
      }),
    [setParams],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); ask.focus(); return; }
      if (isTyping(e.target) || mod || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); ask.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask]);

  /** A note on the whole home (from Ask or Approve). */
  const postGeneral = useCallback(
    async (text: string) => {
      if (!version) return false;
      const c = await addComment({ version_id: version.id, text, anchor: generalAnchor(version.plan), camera: frontCamera(version.plan) });
      if (c) openComments({ focus: c.id });
      return !!c;
    },
    [version, addComment, openComments],
  );

  const submit = async (text: string): Promise<boolean> => {
    if (!(await ensureName())) return false;
    const ok = await postGeneral(text);
    if (ok) toast.show(`Sent to ${owner}`);
    return ok;
  };

  // Approve always targets the version on screen.
  const approve = async () => {
    if (!version) return;
    if (!(await ensureName())) return;
    if (await postGeneral(`Approved version ${version.n}.`)) {
      try { localStorage.setItem(approvedKey(version.id), "1"); } catch { /* ignore */ }
      setApproved(true);
      toast.show(`Approval sent to ${owner}`);
    }
  };

  const commands: Command[] = useMemo(
    () => [
      { id: "plan", group: "go", label: "Plan", run: () => setTab("plan") },
      { id: "house", group: "go", label: "House", run: () => setTab("house") },
      { id: "walk", group: "do", label: "Walk through it", hint: "V", run: () => setParams({ mode: "walk" }) },
      { id: "comments", group: "do", label: "Comments", run: () => openComments() },
    ],
    [setTab, setParams, openComments],
  );

  const open = comments.filter((c) => c.status === "open").length;

  // Plan: one floor at a time (?floor=), with the same numbered pins as the house.
  const plan = version?.plan;
  const levels = useMemo(() => (plan ? levelsOf(plan) : []), [plan]);
  const floorParam = params.get("floor");
  const level = levels.find((l) => l.id === floorParam)?.id ?? levels.find((l) => l.index === 0)?.id ?? levels[0]?.id ?? "ground";
  const setLevel = useCallback(
    (id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set("floor", id); return n; }, { replace: true }),
    [setParams],
  );
  const floorItems = useMemo(() => stackItems(levels, (l) => levelKey(l, levels), levelName), [levels]);
  const pins = useMemo<PlanPin[]>(() => {
    if (!plan || !version) return [];
    const mine = comments.filter((c) => c.version_id === version.id);
    const numbers = pinNumbers(mine);
    return mine
      .filter((c) => anchorLevel(plan, c) === level && c.anchor.kind !== "view")
      .map((c) => {
        const [x, y] = anchorPlanXY(c);
        return { id: c.id, n: numbers.get(c.id) ?? 0, x, y, hue: authorHue(c), text: c.text, selected: focusComment === c.id };
      })
      .filter((p) => p.x > -2 && p.y > -2 && p.x < plan.site.plot.width_ft + 2 && p.y < plan.site.plot.depth_ft + 2);
  }, [plan, version, comments, level, focusComment]);
  const shellVars = {
    "--chrome-top": phone ? "128px" : "calc(var(--chrome) * 2 + 48px)",
    "--sheet-top": phone ? "0px" : "calc(var(--chrome) * 2 + 48px)",
  } as CSSProperties;
  const sheetRight = !phone && right === "comments";

  return (
    <div className={cn("relative h-[100dvh] overflow-hidden", tone === "hud" ? "bg-hud" : "bg-canvas")} style={shellVars}>
      <main className="absolute inset-0">
        {/* Once opened, the house stays mounted behind the plan (it idles), so switching back is instant. */}
        {version && houseSeen && (
          <Suspense fallback={<div className="absolute inset-0 grid place-items-center bg-hud text-hud-ink-2"><span className="flex items-center gap-2.5 text-[14px]"><Spinner /> Opening the house…</span></div>}>
            <HouseStage project={project} version={version} clientView active={tab === "house"} />
          </Suspense>
        )}
        {!version || tab === "house" ? null : (
          <div className="absolute inset-0" style={{ paddingTop: "var(--chrome-top)", paddingBottom: "calc(var(--dock-h) + var(--chrome))" }}>
            <div className="mx-auto h-full max-w-[1100px] px-3 sm:px-6" style={{ paddingRight: sheetRight ? "calc(380px + var(--chrome) * 2)" : undefined }}>
              <div className="relative h-full overflow-hidden rounded-panel bg-surface shadow-e1">
                <FloorPlan
                  plan={version.plan}
                  level={level}
                  pins={pins}
                  onPin={(id) => openComments({ focus: id })}
                  setbacks={version.compliance?.envelope?.setbacks_ft}
                  resetKey={version.id}
                  fit={phone ? "plot" : "sheet"}
                  inset={{ top: phone && levels.length > 1 ? 64 : 16, right: 16, bottom: 16, left: !phone && levels.length > 1 ? 72 : 16 }}
                />
                {levels.length > 1 && (
                  <div className={cn("absolute z-10", phone ? "inset-x-3 top-3" : "left-3 top-1/2 -translate-y-1/2")}>
                    <FloorStack items={floorItems} value={level} onChange={setLevel} orientation={phone ? "horizontal" : "vertical"} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Top: banner capsule · Plan / House · Comments */}
      <div className={cn("pointer-events-none absolute inset-x-0 top-0 z-30 p-[var(--chrome)]", phone ? "flex flex-col gap-2" : "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3")}>
        <div className={cn("flex min-w-0", phone ? "items-center justify-between gap-2" : "justify-start")}>
          <div className={cn("pointer-events-auto flex h-12 min-w-0 items-center gap-3 rounded-full pl-4 pr-4", tone === "hud" ? "glass-hud" : "glass-light")}>
            <Link to="/" aria-label="Naqsha" className="shrink-0 rounded-[6px] outline-none focus-visible:shadow-focus">
              <Wordmark compact tone={tone === "hud" ? "white" : "ink"} className="[&>span]:text-[16px]" />
            </Link>
            <span className={cn("h-5 w-px shrink-0", tone === "hud" ? "bg-white/15" : "bg-line")} />
            <div className="flex min-w-0 flex-col">
              <span className={cn("truncate text-[14px] font-semibold leading-[18px]", tone === "hud" ? "text-hud-ink" : "text-ink")}>{project.name}</span>
              <span className={cn("truncate text-[11px] font-medium leading-[14px]", tone === "hud" ? "text-hud-ink-2" : "text-ink-3")}>
                {sharedBy ? `Shared by ${sharedBy}` : "Shared with you"} · You can comment
              </span>
            </div>
          </div>
          {phone && <CommentsButton tone={tone} open={open} active={right === "comments"} onClick={() => (right === "comments" ? closeComments() : openComments())} compact />}
        </div>
        <div className={cn("pointer-events-auto rounded-full", tone === "hud" ? "glass-hud" : "glass-light", phone && "w-full")}>
          <Segmented<ClientTab>
            label="Views"
            value={tab}
            onChange={setTab}
            tone={tone === "hud" ? "hud" : "light"}
            fill={phone}
            className={cn("h-12 bg-transparent p-1.5 [&>button]:px-4", phone && "w-full")}
            options={[{ value: "plan", label: "Plan" }, { value: "house", label: "House" }]}
          />
        </div>
        {!phone && (
          <div className="flex justify-end">
            <CommentsButton tone={tone} open={open} active={right === "comments"} onClick={() => (right === "comments" ? closeComments() : openComments())} />
          </div>
        )}
      </div>

      {/* Dock */}
      {!(phone && right) && (
        <div
          className="pointer-events-none absolute bottom-0 z-30 flex justify-center px-3 pb-[calc(var(--chrome)+var(--safe-b))] transition-[right] duration-[320ms] ease-sheet"
          style={{ left: 0, right: sheetRight ? "calc(380px + var(--chrome) * 2)" : 0 }}
        >
          <div className="w-full max-w-[720px]">
            <Dock
              view={tab}
              project={project}
              tone={tone}
              defaultNext={
                tab === "plan"
                  ? { label: "Walk through it", run: () => setParams({ mode: "walk" }) }
                  : version && !approved
                    ? { label: `Approve v${version.n}`, run: () => void approve() }
                    : null
              }
              defaultLine={
                approved && version
                  ? `You approved version ${version.n}. ${sharedBy ?? "The owner"} can see it in the comments.`
                  : tab === "house"
                    ? `${touch ? "Tap" : "Click"} a spot on the house to leave a note, or walk through it room by room.`
                    : `This is version ${version?.n ?? 1}, checked against the rules.`
              }
              defaultPlaceholder={`Leave a note for ${owner}`}
              defaultSuggestions={[]}
              defaultSubmit={submit}
              commands={commands}
              conversation={false}
              askLabel="Send to the owner"
            />
          </div>
        </div>
      )}

      <CommentsSheet
        open={right === "comments"}
        onClose={closeComments}
        project={project}
        clientView
        focusId={focusComment}
        emptyHint={`${touch ? "Tap" : "Click"} anywhere on the house to pin a note for ${owner}, or type one below.`}
        onShow={(c: Comment) => setParams({ comment: c.id })}
      />

      <NameDialog
        open={askName !== null}
        initial={guestName ?? ""}
        onClose={() => {
          setAskName(null);
          nameWaiter.current?.(null);
          nameWaiter.current = null;
        }}
        onSave={(name) => {
          useProject.getState().setGuestName(name);
          setAskName(null);
          nameWaiter.current?.(name);
          nameWaiter.current = null;
        }}
      />
    </div>
  );
}

function CommentsButton({ tone, open, active, onClick, compact }: { tone: "light" | "hud"; open: number; active: boolean; onClick: () => void; compact?: boolean }) {
  const hud = tone === "hud";
  return (
    <Tooltip content="Comments">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        aria-label={`Comments${open ? `, ${open} open` : ""}`}
        className={cn(
          "pointer-events-auto inline-flex h-12 items-center gap-2 rounded-full px-4 text-[14px] font-medium outline-none focus-visible:shadow-focus",
          hud ? "glass-hud text-hud-ink" : "glass-light text-ink",
          compact && "px-3.5",
        )}
      >
        <MessageSquare className="size-4" strokeWidth={1.75} />
        {!compact && <span>Comments</span>}
        {open > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold tabular text-white">{open}</span>}
      </button>
    </Tooltip>
  );
}

function NameDialog({ open, initial, onClose, onSave }: { open: boolean; initial: string; onClose: () => void; onSave: (name: string) => void | Promise<void> }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState(false);
  useEffect(() => { if (open) { setName(initial); setError(false); } }, [open, initial]);
  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) { setError(true); return; }
    void onSave(name.trim());
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={420}
      title="Your name"
      description="So the owner knows who wrote this. We'll only ask once."
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save()}>Continue</Button>
        </>
      }
    >
      <form onSubmit={save}>
        <Input aria-label="Your name" placeholder="Sana Malik" value={name} onChange={(e) => { setName(e.target.value); setError(false); }} error={error ? "Add your name to continue." : undefined} autoComplete="name" maxLength={60} data-autofocus />
      </form>
    </Dialog>
  );
}
