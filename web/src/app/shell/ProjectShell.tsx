/**
 * The project shell (DESIGN.md §5): one full-bleed canvas per view at /app/p/:id/:view, with five floating pieces
 * and no bars: the title capsule, the view switch, the people cluster, the dock (Ask + Next) and the sheets.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties, type ComponentType } from "react";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { Project } from "@contracts/api-types";
import { cn } from "@/app/lib/utils";
import { isTyping, useMediaQuery, usePhone } from "@/app/lib/hooks";
import { canEdit, defaultView, hasVersion, isViewId, LEGACY_VIEW, resolveVersion, roleOf, viewAvailable, VIEWS, type ViewId } from "@/app/lib/views";
import { requireAccount, useAuth } from "@/app/store/auth";
import { useMembers } from "@/app/store/members";
import { useProject } from "@/app/store/project";
import { Button } from "@/app/ui/Button";
import { ErrorBoundary } from "@/app/ui/ErrorBoundary";
import { Spinner } from "@/app/ui/Spinner";
import { CommentsSheet } from "@/app/comments/CommentsSheet";
import { ShareDialog } from "@/app/share/ShareDialog";
import { BriefView } from "@/app/setup/BriefView";
import { ConceptsView } from "@/app/concepts/ConceptsView";
import { PlanView } from "@/app/plan/PlanView";
import { RevisionsView } from "@/app/revisions/RevisionsView";
import { HeartView } from "@/app/heart/HeartView";
import { useLocality } from "@/app/taste/Neighbourhood";
import { setLocaleFrom } from "@/app/lib/locale";
import { useAsk, useAskStore } from "./ask";
import { buildCommands } from "./commands";
import { ConversationSheet } from "./ConversationSheet";
import { DetailsDialog } from "./DetailsDialog";
import { Dock } from "./Dock";
import { complianceCounts, setRoomNames, useLastLine } from "./narration";
import { statusLine, type Summary } from "@/app/plan/compliance";
import { markVersionSeen, startShare, useDefaultNext } from "./next";
import { People } from "./People";
import { useShell } from "./state";
import { TitleCapsule } from "./TitleCapsule";
import { ViewSwitch } from "./ViewSwitch";

// The 3D view pulls in three.js: load it only when someone opens House.
const HouseView = lazy(() => import("@/app/explore/HouseView").then((m) => ({ default: m.HouseView })));

type ViewProps = { project: Project; onProjectChange(p: Project): void; active?: boolean };
const VIEW_COMPONENT: Record<ViewId, ComponentType<ViewProps>> = {
  brief: BriefView,
  taste: HeartView,
  concepts: ConceptsView,
  plan: PlanView,
  house: HouseView,
  revisions: RevisionsView,
};

export function ProjectShell() {
  const { id = "" } = useParams();
  const location = useLocation();
  // The view is the child route's segment: /app/p/:id/:view
  const rawView = decodeURIComponent(location.pathname.split("/")[4] ?? "") || undefined;
  const open = useProject((s) => s.open);
  const loadState = useProject((s) => s.loadState);
  const loadError = useProject((s) => s.loadError);
  const project = useProject((s) => (s.pid === id && !s.shareToken ? s.project : null));
  setLocaleFrom(project?.brief);  // plot sizes and rule labels follow where the home is
  const epoch = useAuth((s) => s.epoch);
  const resetShell = useShell((s) => s.reset);

  useEffect(() => {
    void open(id);
  }, [id, open]);
  // Signing in or out changes what this person may do here.
  useEffect(() => {
    if (epoch) void useProject.getState().refresh();
  }, [epoch]);
  useEffect(() => () => resetShell(), [id, resetShell]);
  useEffect(() => {
    if (project?.name) document.title = `${project.name} · Naqsha`;
  }, [project?.name]);

  if (rawView && !isViewId(rawView)) {
    const mapped = LEGACY_VIEW[rawView];
    return <Navigate to={`/app/p/${id}${mapped ? `/${mapped}` : ""}${location.search}`} state={location.state} replace />;
  }

  if (loadState === "error" && !project) return <ShellError message={loadError} onRetry={() => void open(id)} />;
  if (!project) return <ShellLoading />;
  if (!rawView || !viewAvailable(project, rawView as ViewId)) {
    const fallback = defaultView(project);
    if (!viewAvailable(project, fallback)) return <ShellError message="There's nothing to show yet. The owner is still designing this home." />;
    return <Navigate to={`/app/p/${id}/${fallback}${location.search}`} state={location.state} replace />;
  }
  return <Shell project={project} view={rawView as ViewId} />;
}

function Shell({ project, view }: { project: Project; view: ViewId }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const phone = usePhone();
  const touch = useMediaQuery("(pointer: coarse)");
  const ask = useAsk();
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const left = useShell((s) => s.left);
  const right = useShell((s) => s.right);
  const share = useShell((s) => s.share);
  const applyMode = useShell((s) => s.applyMode);
  const focusComment = useShell((s) => s.focusComment);
  const viewSheet = useShell((s) => s.viewSheet);
  const switchHidden = useShell((s) => s.switchHidden);
  const { toggleChat, openComments, closeComments, setShare, setApplyMode } = useShell.getState();
  const versions = useProject((s) => s.versions);
  const loadVersion = useProject((s) => s.loadVersion);
  const loadComments = useProject((s) => s.loadComments);
  const commentsFor = useProject((s) => s.commentsFor);
  const comments = useProject((s) => s.comments);
  const conceptsRunning = useProject((s) => !!s.conceptRun?.running);
  const loadMembers = useMembers((s) => s.load);
  const [details, setDetails] = useState(false);
  const lastLine = useLastLine();
  const messages = useProject((s) => s.messages);

  const tone: "light" | "hud" = view === "house" || view === "taste" ? "hud" : "light";
  const current = project.current_version_id;
  const version = current ? versions[current] ?? null : null;
  const editor = canEdit(project);
  // The neighbourhood is read as soon as the brief knows the place, so recommendations start before any favourites.
  useLocality(project);

  // Data every view shares: the current version (status line, commands), its comments, the people.
  useEffect(() => {
    if (current) void loadVersion(current);
  }, [current, loadVersion]);
  useEffect(() => {
    if (current && !commentsFor) void loadComments(current);
  }, [current, commentsFor, loadComments]);
  // Notes from clients and teammates show up without a reload.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void useProject.getState().refreshComments();
    }, 20_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (user) void loadMembers(project.id);
    else useMembers.getState().reset();
  }, [user, project.id, loadMembers]);
  useEffect(() => {
    if (view === "revisions") markVersionSeen(current);
  }, [view, current]);
  // Narration names rooms in words ("the kitchen"), not ids.
  useEffect(() => {
    setRoomNames(version?.plan.rooms);
  }, [version]);

  // ── Keyboard: ⌘1–4 views, ⌘K or / Ask, ⌘J conversation, C comments outside House ──────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && /^[1-4]$/.test(e.key)) {
        const v = VIEWS[Number(e.key) - 1];
        if (v && viewAvailable(project, v.id)) {
          e.preventDefault();
          const light = new URLSearchParams(window.location.search).get("light");
          navigate(`/app/p/${project.id}/${v.id}${light ? `?light=${light}` : ""}`);
        }
        return;
      }
      if (mod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        ask.focus();
        return;
      }
      if (mod && (e.key === "j" || e.key === "J") && editor && view !== "brief") {
        e.preventDefault();
        toggleChat();
        return;
      }
      if (isTyping(e.target) || mod || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        ask.focus();
      } else if ((e.key === "c" || e.key === "C") && view !== "house" && current) {
        if (useShell.getState().right === "comments") closeComments();
        else openComments();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project, view, current, editor, navigate, ask, toggleChat, openComments, closeComments]);

  // ── Dock defaults per view ─────────────────────────────────────────────────────────────────────
  const defaultNext = useDefaultNext(view, project);
  const openCount = comments.filter((c) => c.status === "open" && c.version_id === current).length;
  const lastSuggestions = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return messages[i].suggestions ?? [];
    return [];
  }, [messages]);

  const asBuilt = useProject((s) => s.asBuilt);
  const defaultLine = useMemo(() => {
    const counts = complianceCounts(project, versions, asBuilt);
    switch (view) {
      case "brief":
        return lastLine ?? "Tell me about the plot and who will live there. One message is enough.";
      case "taste":
        return null;
      case "concepts":
        if (conceptsRunning) return null;
        if (!project.concepts.length) return "Your brief is ready. Shall I sketch four exteriors?";
        if (!project.selected_concept_id) return `${touch ? "Tap" : "Click"} the one you like. Ask for a change and I'll draw variations.`;
        if (current) return "Your plan follows the concept marked Chosen. Open another to plan it instead.";
        return "Good choice. I'll plan the floors around it next.";
      case "plan":
        if (!current) return "I'll lay out the floors and check every LDA rule as I go.";
        return counts ? planLine(counts) : null;
      case "house": {
        if (!editor) return null;
        const shownId = resolveVersion(project, params.get("v")).id;
        if (shownId && shownId !== current) return "This is an earlier version. Switch to the latest to pin notes.";
        if (openCount) return openCount === 1 ? "1 note so far. I'll turn it into the next version." : `${openCount} notes so far. I'll turn them into the next version.`;
        return touch ? "Look around, then tap Comment to pin a note anywhere." : "Look around, then press C to pin a note anywhere.";
      }
      case "revisions":
        return null;
    }
  }, [view, project, versions, asBuilt, lastLine, conceptsRunning, current, editor, openCount, params, touch]);

  // Suggestions come from the family's taste, so every one-tap request is theirs; the generic ones are a fallback.
  const tasteSuggestions = project.taste?.style?.suggestions;
  const defaultSuggestions = useMemo(() => {
    if (!editor) return [];
    if (view === "brief") return lastSuggestions;
    const fromTaste = (k: "concepts" | "plan" | "house") =>
      (tasteSuggestions?.[k] ?? []).map((x) => x.text).slice(0, 3);
    if (view === "concepts" && project.selected_concept_id) return fromTaste("concepts").length ? fromTaste("concepts") : ["Darker glass", "More greenery", "Add solar panels"];
    if (view === "plan" && current) return fromTaste("plan").length ? fromTaste("plan") : ["Make the kitchen open", "Bigger master bedroom", "Add a skylight over the stair"];
    if (view === "house" && current) return fromTaste("house");
    return [];
  }, [editor, view, lastSuggestions, project.selected_concept_id, current, tasteSuggestions]);

  const defaultPlaceholder =
    !editor ? "Leave a note for the owner"
    : view === "brief" ? "Tell me about the plot and who will live there"
    : view === "concepts" ? (project.selected_concept_id ? "Ask for a change, e.g. darker glass" : "Describe the look you want")
    : current ? "Ask for a change, e.g. a bigger kitchen"
    : "Ask Naqsha";

  const defaultSubmit = useCallback(
    async (text: string) => {
      const st = useProject.getState();
      const p = st.project;
      if (!p) return;
      if (!canEdit(p)) return;
      if (view === "brief" || (!p.current_version_id && view !== "concepts")) {
        await st.sendIntake({ message: text });
        return;
      }
      if (view === "concepts") {
        if (p.selected_concept_id) await st.generateConcepts({ count: 2, instruction: text, base_concept_id: p.selected_concept_id });
        else await st.generateConcepts({ count: 4, instruction: text });
        return;
      }
      toggleChat(true);
      await st.runRevise(p.current_version_id!, [], text);
    },
    [view, toggleChat],
  );

  const commands = useMemo(
    () =>
      buildCommands({
        project,
        version,
        view,
        params,
        go: (path) => navigate(path),
        setParams: (patch) =>
          setParams((prev) => {
            const n = new URLSearchParams(prev);
            for (const [k, v] of Object.entries(patch)) (v === null ? n.delete(k) : n.set(k, v));
            return n;
          }),
        share: () => void startShare(),
        comments: () => openComments(),
        chat: () => toggleChat(true),
        signedIn: !!user,
        signIn: () => void requireAccount("save"),
        signOut,
      }),
    [project, version, view, params, navigate, setParams, openComments, toggleChat, user, signOut],
  );

  const onApply = (ids: string[]) => {
    if (!current) return;
    setApplyMode(false);
    closeComments();
    toggleChat(true);
    if (view !== "house") navigate(`/app/p/${project.id}/house`);
    void useProject.getState().runRevise(current, ids);
  };

  // Clear of the floating top row: 12/16px + 48px + 12px on desktop; phone adds the full-width switch.
  const shellVars = {
    "--chrome-top": phone ? (VIEWS.filter((v) => viewAvailable(project, v.id)).length > 1 ? "128px" : "72px") : "calc(var(--chrome) * 2 + 48px)",
    "--sheet-top": phone ? "0px" : "calc(var(--chrome) * 2 + 48px)",
  } as CSSProperties;
  const chatOpen = left === "chat" && view !== "brief";
  const sheetLeft = !phone && chatOpen;
  const sheetRight = !phone && right === "comments";
  const anySheetOnPhone = phone && (chatOpen || right || viewSheet > 0);
  const View = VIEW_COMPONENT[view];
  const hideNext = right === "comments" && applyMode;
  // House stays mounted (hidden) once opened, so coming back from Plan keeps the camera, the light and the built
  // model instead of rebuilding for seconds.
  const [houseKept, setHouseKept] = useState(view === "house");
  useEffect(() => {
    if (view === "house") setHouseKept(true);
  }, [view]);
  const keepHouse = houseKept && hasVersion(project) && view !== "brief";

  return (
    <div className={cn("relative h-[100dvh] overflow-hidden", tone === "hud" ? "bg-hud" : "bg-canvas")} style={shellVars}>
      {/* Top: title capsule · view switch · people. First in the DOM, so Tab reaches All homes, the title, the switch,
          Comments and Share before the view's own HUD. z-[31]: now that it comes first, it still paints over the view's z-30 layers exactly as it did when it came after them. */}
      {phone ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[31] flex flex-col gap-2 px-3 pt-3">
          <div className="flex h-12 items-center justify-between gap-2">
            <TitleCapsule project={project} tone={tone} onDetails={() => setDetails(true)} compact view={view} />
            <People project={project} tone={tone} compact />
          </div>
          {!switchHidden && <ViewSwitch project={project} view={view} tone={tone} fill />}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[31] grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3 p-[var(--chrome)]">
          <div className="flex min-w-0 justify-start">
            <TitleCapsule project={project} tone={tone} onDetails={() => setDetails(true)} view={view} />
          </div>
          {/* Always a centre cell, even when the switch has nothing to show, so People keeps the right column. */}
          <div className="flex justify-center">
            <ViewSwitch project={project} view={view} tone={tone} />
          </div>
          <div className="flex min-w-0 justify-end">
            <People project={project} tone={tone} />
          </div>
        </div>
      )}

      <main className="absolute inset-0" aria-label={VIEWS.find((v) => v.id === view)?.label ?? "Versions"}>
        <ErrorBoundary resetKey={view} tone={tone} label="This view didn't load">
          <Suspense fallback={<ViewLoading tone={tone} />}>
            {view !== "house" && <View project={project} onProjectChange={(p) => useProject.setState({ project: p })} />}
            {(view === "house" || keepHouse) && (
              <div className={cn("absolute inset-0", view !== "house" && "pointer-events-none invisible")} aria-hidden={view !== "house" || undefined}>
                <HouseView project={project} onProjectChange={(p) => useProject.setState({ project: p })} active={view === "house"} />
              </div>
            )}
          </Suspense>
        </ErrorBoundary>
      </main>

      {/* Dock */}
      {!anySheetOnPhone && (
        <div
          className="pointer-events-none absolute bottom-0 z-30 flex justify-center px-3 pb-[calc(var(--chrome)+var(--safe-b))] transition-[left,right] duration-[320ms] ease-sheet"
          style={{
            left: sheetLeft ? "calc(420px + var(--chrome) * 2)" : 0,
            right: sheetRight ? "calc(380px + var(--chrome) * 2)" : viewSheet ? `calc(${viewSheet}px + var(--chrome) * 2)` : 0,
          }}
        >
          <div className="w-full max-w-[720px]">
            <Dock
              view={view}
              project={project}
              tone={tone}
              defaultNext={hideNext ? null : defaultNext}
              defaultLine={defaultLine}
              defaultPlaceholder={defaultPlaceholder}
              defaultSuggestions={defaultSuggestions}
              defaultSubmit={defaultSubmit}
              commands={commands}
              conversation={editor && view !== "brief"}
            />
          </div>
        </div>
      )}

      {editor && view !== "brief" && <ConversationSheet project={project} view={view} />}
      <CommentsSheet
        open={right === "comments"}
        onClose={closeComments}
        project={project}
        applyMode={applyMode}
        onApplyModeChange={setApplyMode}
        focusId={focusComment}
        onShow={(c) => {
          if (view === "house") setParams((p) => { const n = new URLSearchParams(p); n.set("comment", c.id); return n; }, { replace: true });
          else navigate(`/app/p/${project.id}/house?comment=${encodeURIComponent(c.id)}`);
        }}
        onApply={editor ? onApply : undefined}
        // In the House, the Comment button is right there: say how to use it (touch has no C key).
        emptyHint={view === "house" ? (touch ? "Tap Comment, then tap the house to pin a note." : "Click Comment (or press C), then click the house to pin a note.") : undefined}
      />
      {roleOf(project) === "owner" && <ShareDialog open={share} onClose={() => setShare(false)} project={project} />}
      <DetailsDialog open={details} onClose={() => setDetails(false)} project={project} />
      <DraftReset />
    </div>
  );
}

/**
 * The dock's line on Plan, in the one phrasing every count uses ("36/36 LDA · 10/12 livable · 2 to check"), then
 * what to do next. Never the as-built notes or the architect's notes.
 */
function planLine(s: Summary): string {
  const line = statusLine(s);
  if (s.fails.length) return `${line}. Ask me to fix ${s.fails.length === 1 ? "it" : "them"}, or open the checks.`;
  if (s.warns.length) return `${line}. Open the checks to see what to look at, or walk through it.`;
  return `${line}. Every check passes. Want to walk through it?`;
}

/** Leaving a project clears what was typed into Ask. */
function DraftReset() {
  useEffect(() => () => useAskStore.setState({ draft: "" }), []);
  return null;
}

function ViewLoading({ tone }: { tone: "light" | "hud" }) {
  return (
    <div className={cn("absolute inset-0 grid place-items-center", tone === "hud" ? "bg-hud text-hud-ink-2" : "bg-canvas text-ink-3")}>
      <span className="flex items-center gap-2.5 text-[14px]"><Spinner /> Opening…</span>
    </div>
  );
}

function ShellLoading() {
  useEffect(() => {
    document.title = "Opening your home · Naqsha";
  }, []);
  return (
    <div className="grid h-[100dvh] place-items-center bg-canvas">
      <span className="flex items-center gap-2.5 text-[14px] text-ink-3"><Spinner /> Opening your home…</span>
    </div>
  );
}

function ShellError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const notFound = /not found|404/i.test(message ?? "");
  useEffect(() => {
    document.title = `${notFound ? "This home isn't here" : "This home didn't open"} · Naqsha`;
  }, [notFound]);
  return (
    <div className="grid h-[100dvh] place-items-center bg-canvas px-4">
      <div className="max-w-sm text-center">
        <h1 className="text-title text-ink">{notFound ? "This home isn't here" : onRetry ? "This home didn't open" : "Not ready yet"}</h1>
        <p className="mt-2 text-[15px] leading-[22px] text-ink-2">
          {notFound
            ? user
              ? "It may have been deleted, or it belongs to another account."
              : "It may belong to an account. Sign in to see homes saved there."
            : message}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button variant="secondary" icon={<ArrowLeft className="size-4" strokeWidth={1.75} />} onClick={() => navigate("/app")}>All homes</Button>
          {notFound && !user ? (
            <Button variant="primary" onClick={() => void requireAccount("generic").then((ok) => ok && onRetry?.())}>Sign in</Button>
          ) : onRetry ? (
            <Button variant="primary" icon={<RefreshCw className="size-4" strokeWidth={1.75} />} onClick={onRetry}>Try again</Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
