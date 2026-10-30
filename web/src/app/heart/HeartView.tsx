/**
 * The Heart tab, one house through four moments: who lives here; waiting for everyone's light; the reveal, where the windows
 * come on one by one and the heart lights last; and the home around it.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, Link2, Plus, X } from "lucide-react";
import type { FamilyMember, Pick, Project } from "@contracts/api-types";
import { api, errorMessage } from "@/api/client";
import { canEdit } from "@/app/lib/views";
import { useViewNav } from "@/app/design/nav";
import { useAskContext } from "@/app/shell/ask";
import { useProject } from "@/app/store/project";
import { ProfileBody } from "@/app/taste/TasteView";
import { HouseScene } from "./HouseScene";
import { Picker, Thumb } from "./Picker";
import { Dusk, LampButton } from "./kit";

const wordsClass = "font-display text-[clamp(3.2rem,11vw,6rem)] leading-[.98] !tracking-[-.02em] text-lamp-soft";
const heading = "font-display text-[2.8rem] leading-[1.02] tracking-[-.03em] text-dusk-ink sm:text-[4rem]";

export function HeartView({ project, onProjectChange }: { project: Project; onProjectChange(p: Project): void }) {
  const editor = canEdit(project);
  // A sample family's reveal plays once on arrival, so the first thing a visitor sees is their lights coming on.
  const [revealing, setRevealing] = useState(() => !!project.heart?.words.length && !!project.cloned_from && firstVisit(project.id));
  const [inside, setInside] = useState(false);
  useAskContext({ hidden: true });

  const commit = (p: Project) => {
    onProjectChange(p);
    useProject.setState({ project: p });
  };

  // Answers arrive from other people's phones.
  const people = project.family?.people;
  const waiting = !!people?.length && !project.heart;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      void api.getProject(project.id).then((p) => {
        const cur = useProject.getState().project;
        if (cur?.id === p.id) useProject.setState({ project: { ...cur, family: p.family } });
      }).catch(() => {});
    }, 6000);
    return () => clearInterval(t);
  }, [waiting, project.id]);

  return (
    <div className="h-full overflow-y-auto">
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-20 h-[calc(var(--chrome-top,72px)+12px)] bg-gradient-to-b from-dusk-1 via-dusk-1/80 to-transparent" />
      <Dusk>
        {revealing ? <Reveal project={project} onDone={(p) => { commit(p); setRevealing(false); setInside(true); }} onFail={() => setRevealing(false)} />
          : !people?.length ? <Who project={project} editor={editor} onDone={commit} />
          : project.heart?.words.length ? <Home project={project} editor={editor} inside={inside} onChange={commit} onAgain={() => setRevealing(true)} />
          : <Waiting project={project} editor={editor} onChange={commit} onReveal={() => setRevealing(true)} />}
      </Dusk>
    </div>
  );
}

function firstVisit(id: string): boolean {
  try {
    if (sessionStorage.getItem(`naqsha.revealed.${id}`)) return false;
    sessionStorage.setItem(`naqsha.revealed.${id}`, "1");
  } catch { /* no storage: it simply plays */ }
  return true;
}

function Who({ project, editor, onDone }: { project: Project; editor: boolean; onDone(p: Project): void }) {
  const [names, setNames] = useState(["", ""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = names.map((n) => n.trim()).filter(Boolean);
  async function go() {
    setBusy(true);
    try {
      onDone(await api.setFamily(project.id, filled.map((name) => ({ name }))));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  if (!editor) return <Scene title="A house at dusk" />;
  return (
    <>
      <section className="relative z-10 mx-auto w-full max-w-[1120px] px-5 pt-[calc(var(--chrome-top,72px)+28px)] sm:px-8">
        <h1 className={heading}>Who's home?</h1>
        <div className="mt-6 flex max-w-[480px] flex-col gap-1">
          {names.map((n, i) => (
            <div key={i} className="flex items-center gap-2">
              <input aria-label={`Person ${i + 1}`} value={n} autoFocus={i === 0} placeholder={i === 0 ? "Your name" : "Who else?"}
                onChange={(e) => setNames((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => { if (e.key === "Enter" && filled.length && i === names.length - 1) void go(); }}
                className="min-w-0 flex-1 border-0 border-b-2 border-dusk-line bg-transparent py-2 font-display text-[1.5rem] tracking-[-.02em] text-dusk-ink caret-lamp outline-none placeholder:text-dusk-ink-2 focus:border-lamp" />
              {names.length > 1 && (
                <button type="button" aria-label="Remove" onClick={() => setNames((xs) => xs.filter((_, j) => j !== i))} className="grid size-9 place-items-center rounded-full text-dusk-ink-2 hover:text-dusk-ink"><X className="size-4" /></button>
              )}
            </div>
          ))}
          {names.length < 8 && (
            <button type="button" onClick={() => setNames((xs) => [...xs, ""])} className="mt-2 inline-flex w-fit items-center gap-1.5 py-1 text-body text-dusk-ink-2 hover:text-dusk-ink"><Plus className="size-4" /> Add someone</button>
          )}
        </div>
        <div className="mt-6">
          <LampButton disabled={!filled.length} loading={busy} onClick={() => void go()}>Light the house</LampButton>
          {error && <p role="alert" className="mt-3 text-body text-lamp-soft">{error}</p>}
        </div>
      </section>
      <Scene windows={filled.map((n, i) => ({ id: String(i), name: n, lit: false }))} />
    </>
  );
}

function Scene(props: Parameters<typeof HouseScene>[0]) {
  return <div className="pointer-events-none fixed inset-x-0 bottom-0 h-[52dvh]"><HouseScene labels {...props} className="size-full" /></div>;
}

function Waiting({ project, editor, onChange, onReveal }: { project: Project; editor: boolean; onChange(p: Project): void; onReveal(): void }) {
  const people = project.family!.people;
  const lit = people.filter((p) => p.answered);
  const [answering, setAnswering] = useState<FamilyMember | null>(null);
  const ready = lit.length >= Math.min(2, people.length);
  if (answering) return <AnswerHere project={project} person={answering} onClose={() => setAnswering(null)} onDone={(p) => { onChange(p); setAnswering(null); }} />;
  const line = lit.length === people.length ? "Everyone's home." : lit.length ? `${lit.length} of ${people.length} lights on.` : "Send everyone their light.";
  return (
    <>
      <section className="relative z-10 mx-auto w-full max-w-[1120px] px-5 pt-[calc(var(--chrome-top,72px)+28px)] sm:px-8">
        <h1 className={heading} aria-live="polite">{line}</h1>
        <ul className="mt-5 flex max-w-[520px] flex-col">
          {people.map((p) => <Person key={p.id} person={p} editor={editor} onAnswer={() => setAnswering(p)} />)}
        </ul>
        {editor && (
          <div className="mt-6">
            <LampButton disabled={!ready} onClick={onReveal}>See what you share</LampButton>
          </div>
        )}
      </section>
      <Scene windows={people.map((p) => ({ id: p.id, name: p.name, lit: p.answered }))} title={`The house, ${lit.length} of ${people.length} lights on`} />
    </>
  );
}

function Person({ person, editor, onAnswer }: { person: FamilyMember; editor: boolean; onAnswer(): void }) {
  const [copied, setCopied] = useState(false);
  async function send() {
    const url = `${location.origin}/h/${person.token}`;
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: "Naqsha", text: `${person.name}, what do you love?`, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch { /* they closed the share sheet */ }
  }
  return (
    <li className="flex min-h-12 items-center gap-3 border-b border-dusk-line/60 py-2">
      <span aria-hidden className={person.answered ? "size-2.5 rounded-full bg-lamp shadow-[0_2px_10px_rgb(255_196_107/.8)]" : "size-2.5 rounded-full bg-dusk-3"} />
      <span className="min-w-0 flex-1 truncate text-body-lg text-dusk-ink">{person.name}</span>
      {person.answered ? <span className="text-small text-lamp-soft">Light's on</span> : editor && person.token ? (
        <span className="flex items-center gap-1">
          <button type="button" onClick={onAnswer} className="rounded-full px-3 py-1.5 text-small text-dusk-ink-2 hover:text-dusk-ink">Answer here</button>
          <button type="button" onClick={() => void send()} className="inline-flex items-center gap-1.5 rounded-full bg-dusk-3 px-3 py-1.5 text-small font-medium text-dusk-ink hover:bg-dusk-line">
            {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />} {copied ? "Copied" : "Send link"}
          </button>
        </span>
      ) : <span className="text-small text-dusk-ink-2">Not yet</span>}
    </li>
  );
}

function AnswerHere({ project, person, onClose, onDone }: { project: Project; person: FamilyMember; onClose(): void; onDone(p: Project): void }) {
  const [picks, setPicks] = useState<Pick[]>([]);
  const [heart, setHeart] = useState<Pick[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.answerHere(project.id, person.id, [...picks, ...heart.map((h) => ({ ...h, heart: true }))]));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <section className="relative z-10 mx-auto w-full max-w-[640px] px-5 pb-16 pt-[calc(var(--chrome-top,72px)+28px)]">
      <h1 className={heading}>{person.name.split(/[\s&]/)[0]}, what do you love?</h1>
      <div className="mt-8"><Picker value={picks} onChange={setPicks} autoFocus /></div>
      <h2 className="mt-12 font-display text-[1.75rem] tracking-[-.02em] text-dusk-ink">Where does your heart live?</h2>
      <div className="mt-3"><Picker value={heart} onChange={setHeart} single placeholder="A city, a street, a village" /></div>
      <div className="mt-8 flex items-center gap-5">
        <LampButton disabled={picks.length < 3} loading={busy} onClick={() => void save()}>{picks.length < 3 ? `${3 - picks.length} more` : "Turn my light on"}</LampButton>
        <button type="button" onClick={onClose} className="text-body text-dusk-ink-2 hover:text-dusk-ink">Back</button>
      </div>
      {error && <p role="alert" className="mt-3 text-body text-lamp-soft">{error}</p>}
      </section>
  );
}

function Reveal({ project, onDone, onFail }: { project: Project; onDone(p: Project): void; onFail(): void }) {
  const still = useReducedMotion();
  const people = (project.family?.people ?? []).filter((p) => p.answered);
  const told = !!project.heart?.words.length;  // a replay: the answer is already in hand
  const [result, setResult] = useState<Project | null>(told ? project : null);
  const [lit, setLit] = useState(0);
  const [heart, setHeart] = useState(false);
  const [words, setWords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || told) return;
    started.current = true;
    api.readHeart(project.id).then(setResult).catch((e) => setError(errorMessage(e)));
  }, [project.id]);

  // The windows come on as soon as the page is ready; the heart waits for the answer, so its light is never a guess.
  useEffect(() => {
    if (still) { setLit(people.length); return; }
    if (lit >= people.length) return;
    const t = setTimeout(() => setLit((n) => n + 1), lit === 0 ? 700 : 1000);
    return () => clearTimeout(t);
  }, [lit, people.length, still]);

  useEffect(() => {
    if (!result || lit < people.length) return;
    const pause = still ? 0 : 1200;
    const a = setTimeout(() => setHeart(true), pause);
    const b = setTimeout(() => setWords(true), pause + (still ? 0 : 1500));
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [result, lit, people.length, still]);

  useEffect(() => {
    if (!words || !result || result.heart?.threads?.length) return;
    let on = true;
    api.traceHeart(project.id).then((p) => { if (on) setResult(p); }).catch(() => {});
    return () => { on = false; };
  }, [words, !!result, project.id]);

  const h = result?.heart;
  return (
    <>
      <section aria-live="polite" className="relative z-10 mx-auto flex min-h-[46dvh] w-full max-w-[1120px] flex-col justify-end px-5 pt-[calc(var(--chrome-top,72px)+20px)] sm:px-8">
        {!words && !error && (
          <p className="font-display text-[clamp(1.75rem,4.5vw,2.75rem)] leading-[1.1] tracking-[-.025em] text-dusk-ink">
            {joinNames(people.map((p) => p.name))} answered alone.
            {lit >= people.length && !result && <span className="ml-3 inline-block size-2.5 animate-breathe rounded-full bg-lamp" aria-label="Reading" />}
          </p>
        )}
        {error ? (
          <div><p className="text-body-lg text-dusk-ink">{error}</p><div className="mt-4"><LampButton onClick={onFail}>Back</LampButton></div></div>
        ) : (
          <AnimatePresence>
            {words && h && (
              <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}>
                <h1 className={wordsClass}>{joinWords(h.words)}</h1>
                {h.line && <p className="mt-3 max-w-[34rem] text-body-lg text-dusk-ink-2">{h.line}</p>}
                <Threads heart={h} />
                <div className="mt-6"><LampButton onClick={() => onDone(result!)}>Look inside</LampButton></div>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </section>
      <Scene windows={people.map((p, i) => ({ id: p.id, name: p.name, lit: i < lit }))} heart={heart} title={heart ? "Every light is on, and the heart of the house is lit" : "The windows are coming on"} />
    </>
  );
}

/** The proof of the reveal: the one thing of each person's that led to the word. */
function Threads({ heart }: { heart: NonNullable<Project["heart"]> }) {
  if (!heart.threads?.length) return null;
  return (
    <motion.ul initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} className="mt-5 flex flex-col gap-2.5">
      {heart.threads.map((t) => {
        const things = new Map<string, { image?: string | null; people: string[] }>();
        t.hands.forEach((h) => {
          const x = things.get(h.name) ?? { image: h.image, people: [] };
          x.people.push(h.person);
          things.set(h.name, x);
        });
        return (
          <li key={t.word} className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {heart.threads!.length > 1 && <span className="w-full text-small text-dusk-ink-2 sm:w-28">{t.word[0].toUpperCase() + t.word.slice(1)}</span>}
            {[...things].map(([name, x]) => (
              <span key={name} className="inline-flex items-center gap-2 text-body text-dusk-ink">
                <Thumb src={x.image} name={name} size={30} />
                <span>{name} <span className="text-dusk-ink-2">· {joinNames(x.people)}</span></span>
              </span>
            ))}
          </li>
        );
      })}
    </motion.ul>
  );
}

const firstUp = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function joinNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
}

function joinWords(words: string[]): string {
  const w = words.map((x) => x[0].toUpperCase() + x.slice(1));
  return w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1].toLowerCase()}` : w[0] ?? "";
}

function Home({ project, editor, inside, onChange, onAgain }: { project: Project; editor: boolean; inside: boolean; onChange(p: Project): void; onAgain(): void }) {
  const goTo = useViewNav();
  const st = useProject();
  const h = project.heart!;
  const people = project.family?.people ?? [];
  const [building, setBuilding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const designed = project.concepts.some((c) => c.from_taste);
  const rooms = useRef<HTMLElement>(null);
  useEffect(() => {
    if (inside) rooms.current?.scrollIntoView();
  }, [inside]);
  useEffect(() => {
    if (!editor || h.threads?.length) return;
    let on = true;
    api.traceHeart(project.id).then((p) => { if (on) onChange({ ...project, heart: p.heart }); }).catch(() => {});
    return () => { on = false; };
  }, [editor, project.id, h.threads?.length]);

  async function build() {
    setError(null);
    setBuilding("Drawing your home");
    try {
      await api.readTaste(project.id, { people: [], location: null, notes: null }, {
        step: (s) => setBuilding(s.message),
        taste: (t) => onChange({ ...project, taste: t }),
        error: (e) => setError(e.message),
      });
      void st.generateConcepts();
      goTo("concepts");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBuilding(null);
    }
  }

  return (
    <>
      <section className="relative mx-auto flex min-h-[100dvh] w-full max-w-[1120px] flex-col px-5 pt-[calc(var(--chrome-top,72px)+24px)] sm:px-8">
        <div className="relative z-10">
          <h1 className={wordsClass}>{joinWords(h.words)}</h1>
          {h.line && <p className="mt-3 max-w-[34rem] text-body-lg text-dusk-ink-2">{h.line}</p>}
          <Threads heart={h} />
          {(editor || designed) && (
            <div className="mt-6 flex flex-wrap items-center gap-5">
              {designed
                ? <LampButton onClick={() => goTo("concepts")}>See the home <ArrowRight className="size-4" /></LampButton>
                : <LampButton loading={!!building} onClick={() => void build()}>{building ?? "Build our home around it"}</LampButton>}
              <button type="button" onClick={onAgain} className="text-body text-dusk-ink-2 underline underline-offset-4 hover:text-dusk-ink">Replay</button>
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-body text-lamp-soft">{error}</p>}
        </div>
        <div className="pointer-events-none absolute bottom-0 left-1/2 h-[56dvh] w-[100vw] -translate-x-1/2">
          <HouseScene windows={people.filter((p) => p.answered).map((p) => ({ id: p.id, name: p.name, lit: true }))} heart labels className="size-full" title="Every light is on, and the heart of the house is lit" />
        </div>
      </section>

      <section ref={rooms} className="relative scroll-mt-[var(--chrome-top,72px)] bg-dusk-1 px-5 py-16 sm:px-8">
        <div className="mx-auto w-full max-w-[1120px]">
          {h.room && <h2 className="font-display text-[2.2rem] leading-[1.05] tracking-[-.03em] text-dusk-ink sm:text-[3rem]">Everything opens onto {h.room.replace(/^(a|an|the)\s+/i, "the ")}.</h2>}
          <ul className="mt-8 flex flex-col">
            {h.people.filter((p) => p.room).map((p) => (
              <li key={p.id} className="grid gap-1 border-t border-dusk-line/60 py-4 sm:grid-cols-[1fr_1fr_1.4fr] sm:gap-6">
                <span className="text-body-lg text-dusk-ink-2">{p.name}</span>
                <span className="text-body-lg font-medium text-dusk-ink">{firstUp(p.room!)}</span>
                {p.line && <span className="text-body text-dusk-ink-2">{p.line}</span>}
              </li>
            ))}
            {h.between.map((b) => (
              <li key={b.names.join()} className="grid gap-1 border-t border-dusk-line/60 py-4 sm:grid-cols-[1fr_1fr_1.4fr] sm:gap-6">
                <span className="text-body-lg text-dusk-ink-2">{b.names.join(" and ")}</span>
                <span className="text-body-lg font-medium text-dusk-ink">{firstUp(b.space)}</span>
                <span />
              </li>
            ))}
          </ul>
          {!!h.near?.length && (
            <div className="mt-12">
              <h3 className="font-display text-[1.5rem] tracking-[-.02em] text-dusk-ink">A little of home, close by</h3>
              <ul className="mt-4 flex flex-wrap gap-3">
                {h.near.map((n) => <li key={n.name} className="inline-flex items-center gap-2.5 text-body text-dusk-ink"><Thumb src={n.image} name={n.name} size={32} />{n.name}</li>)}
              </ul>
            </div>
          )}
          {designed && <div className="mt-10"><LampButton onClick={() => goTo("concepts")}>See the home <ArrowRight className="size-4" /></LampButton></div>}
        </div>
      </section>

      {project.taste && (
        <section className="bg-canvas px-5 py-14 text-ink sm:px-8">
          <div className="mx-auto w-full max-w-[1120px]"><ProfileBody taste={project.taste} project={project} editor={editor} onProjectChange={onChange} /></div>
        </section>
      )}
    </>
  );
}
