/**
 * Taste: the family tells Naqsha what they love (places, films, music, food, brands), the taste agent reads it with Qloo's
 * taste graph, and the house is designed from what it finds. Three states: the composer, the live reading (every Qloo call
 * shows as it happens), and the profile with the style brief, where each decision cites the Qloo evidence behind it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, MapPin, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import type { Evidence, FoundFavourite, Project, StyleBrief, Taste, TasteInput, TasteProfile } from "@contracts/api-types";
import { api, assetUrl, errorMessage } from "@/api/client";
import { cn } from "@/app/lib/utils";
import { canEdit } from "@/app/lib/views";
import { useViewNav } from "@/app/design/nav";
import { useProject } from "@/app/store/project";
import { Button } from "@/app/ui/Button";

const KINDS: { kind: string; label: string; hint: string }[] = [
  { kind: "destination", label: "Places you loved", hint: "Istanbul, Kyoto, Hunza…" },
  { kind: "film", label: "Films and shows", hint: "Coke Studio, Studio Ghibli, The Crown…" },
  { kind: "artist", label: "Music", hint: "Abida Parveen, Coldplay…" },
  { kind: "restaurant", label: "Restaurants and cafés", hint: "Your favourite spot in town" },
  { kind: "brand", label: "Brands", hint: "Khaadi, IKEA, Aesop…" },
  { kind: "book", label: "Books and podcasts", hint: "Anything you keep going back to" },
];

type Person = { label: string; role: string; items: Record<string, string[]> };
const blankPerson = (label: string, role: string): Person => ({ label, role, items: {} });

function initialPeople(project: Project): Person[] {
  const prev = project.taste?.input?.people;
  if (prev?.length) {
    return prev.map((p) => ({
      label: p.label,
      role: p.role ?? "",
      items: p.favourites.reduce<Record<string, string[]>>((acc, f) => {
        const k = f.kind || "destination";
        (acc[k] ||= []).push(f.name);
        return acc;
      }, {}),
    }));
  }
  return [blankPerson("Parents", "parents"), blankPerson("Children", "kids")];
}

const gradient = "linear-gradient(120deg, var(--color-taste-1, #E8A33D), var(--color-taste-2, #D9486B) 55%, var(--color-taste-3, #6B3FA0))";

export function TasteView({ project, onProjectChange }: { project: Project; onProjectChange(p: Project): void }) {
  const editor = canEdit(project);
  const [editing, setEditing] = useState(!project.taste);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<{ id: string; message: string; tool?: string; done?: boolean }[]>([]);
  const [found, setFound] = useState<FoundFavourite[]>([]);
  const [missing, setMissing] = useState<{ who: string; asked: string }[]>([]);
  const [profile, setProfile] = useState<TasteProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function read(input: TasteInput) {
    setRunning(true);
    setEditing(false);
    setSteps([]);
    setFound([]);
    setMissing([]);
    setProfile(null);
    setError(null);
    try {
      await api.readTaste(project.id, input, {
        step: (s) => setSteps((xs) => [...xs.map((x) => ({ ...x, done: true })), s]),
        favourites: (f) => {
          setFound(f.found);
          setMissing(f.missing);
        },
        profile: (p) => setProfile(p),
        taste: (t: Taste) => {
          setSteps((xs) => xs.map((x) => ({ ...x, done: true })));
          const next = { ...project, taste: t };
          onProjectChange(next);
          useProject.setState({ project: next });
        },
        error: (e) => setError(e.message),
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-[1180px] px-4 pb-40 pt-[calc(var(--chrome-top,72px)+20px)] sm:px-8">
        {editing && editor && !running ? (
          <Composer project={project} onCancel={project.taste ? () => setEditing(false) : undefined} onRead={read} />
        ) : running || (!project.taste && (steps.length || error)) ? (
          <Reading steps={steps} found={found} missing={missing} profile={profile} error={error} onRetry={() => setEditing(true)} />
        ) : project.taste ? (
          <Profile taste={project.taste} project={project} editor={editor} onEdit={() => setEditing(true)} onProjectChange={onProjectChange} />
        ) : (
          <p className="text-body text-ink-3">The family hasn't shared their taste yet.</p>
        )}
      </div>
    </div>
  );
}

// ---- the composer ----------------------------------------------------------------------------------------------------
function Composer({ project, onRead, onCancel }: { project: Project; onRead(i: TasteInput): void; onCancel?: () => void }) {
  const [people, setPeople] = useState<Person[]>(() => initialPeople(project));
  const brief = project.brief;
  const [location, setLocation] = useState(project.taste?.input?.location || [brief?.scheme, brief?.city].filter(Boolean).join(", "));
  const [notes, setNotes] = useState(project.taste?.input?.notes || "");
  const total = people.reduce((n, p) => n + Object.values(p.items).flat().length, 0);

  const update = (i: number, fn: (p: Person) => Person) => setPeople((ps) => ps.map((p, j) => (j === i ? fn(p) : p)));
  const submit = () =>
    onRead({
      people: people
        .map((p) => ({ label: p.label.trim() || "Family", role: p.role || null, favourites: Object.entries(p.items).flatMap(([kind, names]) => names.map((name) => ({ kind, name }))) }))
        .filter((p) => p.favourites.length),
      location: location.trim() || null,
      notes: notes.trim() || null,
    });

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-[760px]">
          <TasteBadge />
          <h1 className="mt-4 font-display text-[clamp(2.2rem,5vw,3.6rem)] leading-[1.02] tracking-[-0.03em] text-ink">
            A home should feel like the people in it.
          </h1>
          <p className="mt-4 text-body-lg text-ink-2">
            Tell us what each of you loves: places you've been, what you watch and listen to, where you like to eat. Qloo's taste
            graph reads the taste behind it, and Naqsha designs the house, the rooms and the garden from that.
          </p>
        </div>
        <ReadButton total={total} onClick={submit} onCancel={onCancel} />
      </header>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {people.map((p, i) => (
          <PersonCard
            key={i}
            person={p}
            index={i}
            onChange={(fn) => update(i, fn)}
            onRemove={people.length > 1 ? () => setPeople((ps) => ps.filter((_, j) => j !== i)) : undefined}
          />
        ))}
        {people.length < 5 && (
          <button
            type="button"
            onClick={() => setPeople((ps) => [...ps, blankPerson(`Person ${ps.length + 1}`, "")])}
            className="grid min-h-[160px] place-items-center rounded-card border border-dashed border-line-strong text-body text-ink-3 transition hover:border-ink-4 hover:text-ink"
          >
            <span className="inline-flex items-center gap-2"><Plus className="size-4" /> Add someone</span>
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <label className="rounded-card bg-surface p-5 shadow-e1">
          <span className="flex items-center gap-2 text-small font-medium text-ink-2"><MapPin className="size-4" /> Where the house will be</span>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="DHA Phase 6, Lahore"
            className="mt-2 w-full bg-transparent text-body-lg text-ink outline-none placeholder:text-ink-4"
          />
          <span className="mt-1 block text-small text-ink-3">Qloo reads how the area feels and what's around it.</span>
        </label>
        <label className="rounded-card bg-surface p-5 shadow-e1">
          <span className="text-small font-medium text-ink-2">Anything else about how you live</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Big family dinners, Abbu reads every evening…"
            className="mt-2 w-full bg-transparent text-body-lg text-ink outline-none placeholder:text-ink-4"
          />
        </label>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <ReadButton total={total} onClick={submit} onCancel={onCancel} />
        {location.trim() && (
          <button type="button" onClick={() => onRead({ people: [], location: location.trim(), notes: notes.trim() || null })}
            className="text-small font-medium text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
            No favourites yet? Start from the taste of {location.trim()}
          </button>
        )}
      </div>
    </div>
  );
}

function ReadButton({ total, onClick, onCancel }: { total: number; onClick(): void; onCancel?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={total < 2}
        onClick={onClick}
        className="taste-glow inline-flex h-12 items-center gap-2 rounded-full px-6 text-body font-semibold text-white shadow-e2 transition hover:brightness-110 disabled:cursor-not-allowed disabled:shadow-none disabled:saturate-50"
        style={{ backgroundImage: gradient }}
      >
        <Sparkles className="size-4" /> Read our taste with Qloo
      </button>
      {onCancel && <Button variant="quiet" onClick={onCancel}>Cancel</Button>}
      <span className="text-small text-ink-3">{total < 2 ? "Add at least two favourites" : `${total} favourites`}</span>
    </div>
  );
}

function PersonCard({ person, index, onChange, onRemove }: { person: Person; index: number; onChange(fn: (p: Person) => Person): void; onRemove?: () => void }) {
  const [more, setMore] = useState(() => KINDS.slice(3).some((k) => person.items[k.kind]?.length));
  const kinds = more ? KINDS : KINDS.slice(0, 3);
  return (
    <section className="rounded-card bg-surface p-5 shadow-e1">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-full text-small font-semibold text-white" style={{ backgroundImage: gradient, filter: `hue-rotate(${index * 35}deg)` }}>
          {(person.label.trim()[0] || "?").toUpperCase()}
        </span>
        <input
          aria-label="Who"
          value={person.label}
          onChange={(e) => onChange((p) => ({ ...p, label: e.target.value }))}
          className="min-w-0 flex-1 bg-transparent text-heading text-ink outline-none"
        />
        {onRemove && (
          <button type="button" aria-label={`Remove ${person.label}`} onClick={onRemove} className="rounded-full p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink">
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="mt-4 space-y-3">
        {kinds.map((k) => (
          <ChipField
            key={k.kind}
            label={k.label}
            hint={k.hint}
            values={person.items[k.kind] || []}
            onChange={(vals) => onChange((p) => ({ ...p, items: { ...p.items, [k.kind]: vals } }))}
          />
        ))}
        {!more && (
          <button type="button" onClick={() => setMore(true)} className="inline-flex items-center gap-1.5 text-small font-medium text-accent hover:underline">
            <Plus className="size-3.5" /> Restaurants, brands, books
          </button>
        )}
      </div>
    </section>
  );
}

function ChipField({ label, hint, values, onChange }: { label: string; hint: string; values: string[]; onChange(v: string[]): void }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim().replace(/,$/, "");
    if (t && !values.includes(t)) onChange([...values, t]);
    setText("");
  };
  return (
    <div>
      <div className="text-small font-medium text-ink-3">{label}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-control border border-line bg-canvas/60 px-2 py-1.5 focus-within:border-accent">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-small text-ink shadow-e1">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="text-ink-3 hover:text-ink">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => (e.target.value.endsWith(",") ? (setText(e.target.value), setTimeout(add)) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={add}
          placeholder={values.length ? "" : hint}
          className="min-w-[140px] flex-1 bg-transparent px-1 py-1 text-body text-ink outline-none placeholder:text-ink-4"
        />
      </div>
    </div>
  );
}

// ---- the live reading ------------------------------------------------------------------------------------------------
function Reading({ steps, found, missing, profile, error, onRetry }: {
  steps: { id: string; message: string; tool?: string; done?: boolean }[]; found: FoundFavourite[]; missing: { who: string; asked: string }[];
  profile: TasteProfile | null; error: string | null; onRetry(): void;
}) {
  const tags = profile?.family ?? [];
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,420px)_1fr]">
      <section>
        <TasteBadge live={!error} />
        <h1 className="mt-4 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.05] tracking-[-0.03em] text-ink">Reading your taste</h1>
        <ol className="mt-6 space-y-3" aria-live="polite">
          <AnimatePresence initial={false}>
            {steps.map((s) => (
              <motion.li key={s.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-3">
                <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full", s.done ? "bg-pass-soft text-pass" : "bg-surface shadow-e1")}>
                  {s.done ? <Check className="size-3" /> : <span className="size-1.5 animate-breathe rounded-full" style={{ backgroundImage: gradient }} />}
                </span>
                <span className={cn("text-body", s.done ? "text-ink-3" : "text-ink")}>
                  {s.message}
                  {s.tool && <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-3">{s.tool}</span>}
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
        {error && (
          <div className="mt-6 rounded-card bg-fail-soft p-4 text-body text-fail">
            {error}
            <div className="mt-3"><Button size="sm" icon={<RefreshCw className="size-4" />} onClick={onRetry}>Change favourites</Button></div>
          </div>
        )}
      </section>
      <section className="space-y-6">
        {found.length > 0 && (
          <div>
            <h2 className="text-small font-medium uppercase tracking-[.12em] text-ink-3">Found in Qloo</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {found.map((f, i) => (
                <motion.span key={f.eid + i} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.04 }}
                  className="inline-flex items-center gap-2 rounded-full bg-surface py-1 pl-1 pr-3 text-small text-ink shadow-e1">
                  {f.image ? <img src={f.image} alt="" className="size-6 rounded-full object-cover" /> : <span className="size-6 rounded-full bg-surface-2" />}
                  {f.name}
                  <span className="text-ink-4">· {f.who}</span>
                </motion.span>
              ))}
              {missing.map((m) => (
                <span key={m.who + m.asked} className="inline-flex items-center rounded-full border border-dashed border-line-strong px-3 py-1 text-small text-ink-3">
                  {m.asked} · not in Qloo yet
                </span>
              ))}
            </div>
          </div>
        )}
        {tags.length > 0 && (
          <div>
            <h2 className="text-small font-medium uppercase tracking-[.12em] text-ink-3">The taste behind them</h2>
            <TagCloud tags={tags.map((t) => ({ name: t.name, weight: t.affinity ?? 0.5 }))} />
          </div>
        )}
      </section>
    </div>
  );
}

// ---- the profile -----------------------------------------------------------------------------------------------------
function Profile({ taste, project, editor, onEdit, onProjectChange }: { taste: Taste; project: Project; editor: boolean; onEdit(): void; onProjectChange(p: Project): void }) {
  const goTo = useViewNav();
  const st = useProject();
  const s = taste.style;
  const p = taste.profile;
  const ev = s.evidence || {};
  const design = () => {
    void st.generateConcepts();
    goTo("concepts");
  };

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-panel p-7 text-white shadow-e3 sm:p-10" style={{ backgroundImage: gradient }}>
        <div className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-white/10 blur-2xl" />
        {!!p.favourites?.length && (
          <ul aria-label="Your favourites" className="absolute right-8 top-10 hidden w-[300px] flex-wrap justify-end gap-2 xl:flex">
            {p.favourites.slice(0, 12).map((f, i) => (
              <motion.li key={f.eid + i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.04 }}
                className="inline-flex items-center gap-2 rounded-full bg-white/15 py-1 pl-1 pr-3 text-small text-white backdrop-blur">
                {f.image ? <img src={f.image} alt="" className="size-6 rounded-full object-cover" /> : <span className="grid size-6 place-items-center rounded-full bg-white/25 text-[11px]">{f.name[0]}</span>}
                {f.name}
              </motion.li>
            ))}
          </ul>
        )}
        <TasteBadge onDark />
        <h1 className="mt-4 max-w-[820px] xl:max-w-[640px] font-display text-[clamp(2.2rem,5vw,4rem)] leading-[1] tracking-[-0.03em]">{s.headline}</h1>
        <p className="mt-4 max-w-[720px] xl:max-w-[620px] text-body-lg text-white/90">{s.story}</p>
        {p.locality_only && (
          <p className="mt-3 max-w-[620px] text-small text-white/85">Read from {p.area?.location || "your area"}: add your favourites to make it yours.</p>
        )}
        <div className="mt-6 flex flex-wrap gap-2">
          {(p.family || []).slice(0, 10).map((t) => (
            <span key={t.eid} className="rounded-full bg-white/15 px-3 py-1 text-small backdrop-blur">{t.name}</span>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          {editor && (
            <button type="button" onClick={design} className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-5 text-body font-semibold text-ink shadow-e2 transition hover:bg-white/90">
              Design our home from this <ArrowRight className="size-4" />
            </button>
          )}
          {editor && (
            <button type="button" onClick={onEdit} className="inline-flex h-11 items-center gap-2 rounded-full bg-white/15 px-5 text-body text-white backdrop-blur transition hover:bg-white/25">
              Change favourites
            </button>
          )}
        </div>
      </section>

      <Impact taste={taste} project={project} />

      {/* Each person */}
      {!!s.people?.length && (
        <section>
          <SectionTitle title="Who this home is for" sub="Each person's favourites, read by Qloo" />
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {s.people.map((x, i) => {
              const tags = p.people.find((pp) => pp.label === x.label)?.tags || [];
              return (
                <article key={x.label} className="rounded-card bg-surface p-5 shadow-e1">
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 place-items-center rounded-full text-small font-semibold text-white" style={{ backgroundImage: gradient, filter: `hue-rotate(${i * 35}deg)` }}>
                      {x.label[0]}
                    </span>
                    <h3 className="text-heading text-ink">{x.label}</h3>
                  </div>
                  <p className="mt-3 text-body text-ink-2">{x.signature}</p>
                  {x.room && <p className="mt-3 text-small text-ink-3">Their room: <span className="text-ink">{x.room.replace(/_/g, " ")}</span></p>}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {tags.slice(0, 6).map((t) => <span key={t.eid} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-small text-ink-2">{t.name}</span>)}
                  </div>
                  <Because ids={x.because} ev={ev} />
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* The decisions */}
      {!!s.decisions?.length && (
        <section>
          <SectionTitle title="What your taste decided" sub="Every choice cites the Qloo signal behind it" />
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {s.decisions.map((d) => (
              <article key={d.decision} className="rounded-card bg-surface p-5 shadow-e1">
                <h3 className="text-heading text-ink">{d.decision}</h3>
                {d.reason && <p className="mt-1.5 text-body text-ink-2">{d.reason}</p>}
                <Because ids={d.because} ev={ev} />
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Exterior and interiors */}
      <section className="grid gap-4 lg:grid-cols-2">
        {s.exterior && (
          <StyleCard title="The house" kicker={s.exterior.style} palette={s.exterior.palette} lines={[s.exterior.massing, ...(s.exterior.materials || []), ...(s.exterior.details || [])]} because={s.exterior.because} ev={ev} />
        )}
        {s.interiors && (
          <StyleCard title="Inside" kicker={s.interiors.mood} palette={s.interiors.palette}
            lines={[...(s.interiors.materials || []), s.interiors.lighting, s.interiors.furniture, s.interiors.objects]} because={s.interiors.because} ev={ev} />
        )}
      </section>

      {/* Rooms */}
      {!!s.rooms?.length && (
        <section>
          <SectionTitle title="A room for each of you" sub="Choose whose taste each room follows, then picture it" />
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {s.rooms.map((r, i) => (
              <RoomCard key={i} index={i} room={r} people={(s.people || []).map((x) => x.label)} ev={ev} project={project} editor={editor} onProjectChange={onProjectChange} />
            ))}
          </div>
        </section>
      )}

      {/* Wider taste: destinations and brands */}
      {(p.destinations.length > 0 || p.brands.length > 0) && (
        <section>
          <SectionTitle title="People with your taste also love" sub="Qloo's cross-domain affinities, used as references" />
          <div className="mt-4 flex flex-wrap gap-2">
            {[...p.destinations, ...p.brands].map((x) => (
              <span key={x.eid} className="inline-flex items-center gap-2 rounded-full bg-surface py-1 pl-1 pr-3 text-body text-ink shadow-e1">
                {x.image ? <img src={x.image} alt="" className="size-7 rounded-full object-cover" /> : <span className="size-7 rounded-full" style={{ backgroundImage: gradient, opacity: 0.35 }} />}
                {x.name}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Neighbourhood and landscape */}
      <section className="grid gap-4 lg:grid-cols-2">
        {(s.neighbourhood || p.area) && (
          <article className="rounded-card bg-surface p-6 shadow-e1">
            <div className="flex items-center gap-2 text-small font-medium text-ink-3"><MapPin className="size-4" /> {p.area?.location || "The neighbourhood"}</div>
            {s.neighbourhood?.reading && <p className="mt-2 text-body-lg text-ink">{s.neighbourhood.reading}</p>}
            {s.neighbourhood?.response && <p className="mt-2 text-body text-ink-2">{s.neighbourhood.response}</p>}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(p.area?.tags || []).slice(0, 8).map((t) => <span key={t.eid} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-small text-ink-2">{t.name}</span>)}
            </div>
            <Because ids={s.neighbourhood?.because} ev={ev} />
          </article>
        )}
        {s.landscape && (
          <article className="rounded-card bg-surface p-6 shadow-e1">
            <div className="text-small font-medium text-ink-3">The garden</div>
            <p className="mt-2 text-body-lg text-ink">{s.landscape.idea}</p>
            {!!s.landscape.plants?.length && <p className="mt-2 text-body text-ink-2">{s.landscape.plants.join(" · ")}</p>}
            <Because ids={s.landscape.because} ev={ev} />
          </article>
        )}
      </section>

      {/* Shop */}
      {!!s.shop?.length && (
        <section>
          <SectionTitle title="Where to find the pieces" sub={`Places near ${p.area?.location || "you"} that suit your taste, from Qloo`} />
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {s.shop.map((x) => {
              const e = ev[x.id];
              if (!e) return null;
              return (
                <article key={x.id} className="rounded-card bg-surface p-5 shadow-e1">
                  <h3 className="text-heading text-ink">{e.name}</h3>
                  {e.address && <p className="text-small text-ink-3">{e.address}</p>}
                  {x.why && <p className="mt-2 text-body text-ink-2">{x.why}</p>}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <p className="text-small text-ink-3">
        Taste signals come from Qloo's taste graph and describe what people with similar taste love; Naqsha's architect turned
        them into design choices. {project.taste?.at ? `Read ${new Date(project.taste.at).toLocaleDateString()}.` : ""}
      </p>
    </div>
  );
}

// ---- measured impact ---------------------------------------------------------------------------------------------------
function Impact({ taste, project }: { taste: Taste; project: Project }) {
  const s = taste.style;
  const p = taste.profile;
  const fitted = project.concepts.filter((c) => c.from_taste && typeof c.taste_fit?.score === "number");
  const chosen = project.concepts.find((c) => c.id === project.selected_concept_id && typeof c.taste_fit?.score === "number");
  const best = chosen ?? [...fitted].sort((a, b) => (b.taste_fit!.score ?? 0) - (a.taste_fit!.score ?? 0))[0];
  const base = taste.baseline;
  const house = project.house_taste_fit;
  const stats = [
    { n: p.locality_only ? (p.area?.places.length ?? 0) : (p.favourites?.length ?? 0), label: p.locality_only ? "local places read" : "favourites found in Qloo" },
    { n: Object.keys(s.evidence || {}).length, label: "Qloo signals cited" },
    { n: s.decisions?.length ?? 0, label: "design decisions from your taste" },
    { n: s.rooms?.length ?? 0, label: "rooms styled for someone" },
  ];
  return (
    <section aria-labelledby="impact-title">
      <SectionTitle title="What Qloo changed" sub="Measured: a vision check counts how many of your taste choices each design actually shows" />
      <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((x) => (
          <div key={x.label} className="rounded-card bg-surface p-5 shadow-e1">
            <dt className="text-small text-ink-3">{x.label}</dt>
            <dd className="mt-1 font-display text-[2.4rem] leading-none text-ink">{x.n}</dd>
          </div>
        ))}
      </dl>
      {base && best && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <FitCard title="Without your taste" sub="The same plot and brief, a typical new house" url={base.url} fit={base.taste_fit?.score} muted />
          <FitCard title={best.title ? `Yours: ${best.title}` : "Yours"} sub={best.why || "Drawn from your taste"} url={best.url} fit={best.taste_fit?.score}
            delta={typeof best.taste_fit?.score === "number" && typeof base.taste_fit?.score === "number" ? best.taste_fit.score - base.taste_fit.score : undefined} />
        </div>
      )}
      {typeof house?.score === "number" && (
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-card bg-surface p-5 shadow-e1">
          <div className="font-display text-[2.4rem] leading-none text-ink">{house.score}%</div>
          <p className="max-w-[640px] text-body text-ink-2">
            of your taste choices show in the photograph of the built 3D house ({house.items.filter((x) => x.status === "present").length} of {house.judged} judged from the {house.angle || "front"}).
          </p>
        </div>
      )}
    </section>
  );
}

function FitCard({ title, sub, url, fit, delta, muted }: { title: string; sub?: string; url: string; fit?: number | null; delta?: number; muted?: boolean }) {
  return (
    <figure className={cn("overflow-hidden rounded-card bg-surface shadow-e1", !muted && "taste-ring")}>
      <div className="relative aspect-[16/10]">
        <img src={assetUrl(url, { w: 960 })} alt={title} className={cn("size-full object-cover", muted && "saturate-[.6]")} loading="lazy" />
        {typeof fit === "number" && (
          <span className={cn("absolute left-3 top-3 rounded-full px-3 py-1 text-small font-semibold shadow-e2", muted ? "bg-surface text-ink-2" : "taste-gradient text-white")}>
            Taste fit {fit}%{typeof delta === "number" && delta > 0 ? `  ·  +${delta} points` : ""}
          </span>
        )}
      </div>
      <figcaption className="p-4">
        <div className="text-heading text-ink">{title}</div>
        {sub && <div className="mt-0.5 text-small text-ink-3">{sub}</div>}
      </figcaption>
    </figure>
  );
}

// ---- rooms -----------------------------------------------------------------------------------------------------------
type Room = NonNullable<StyleBrief["rooms"]>[number];

function RoomCard({ index, room, people, ev, project, editor, onProjectChange }: {
  index: number; room: Room; people: string[]; ev: Record<string, Evidence>; project: Project; editor: boolean; onProjectChange(p: Project): void;
}) {
  const [busy, setBusy] = useState<"follows" | "image" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = ["everyone", ...people];
  const label = String(room.room || "room").replace(/_/g, " ");

  async function run(kind: "follows" | "image", body: { follows?: string; image?: boolean }) {
    setBusy(kind);
    setError(null);
    try {
      const p = await api.styleRoom(project.id, index, body);
      onProjectChange(p);
      useProject.setState({ project: p });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="flex flex-col overflow-hidden rounded-card bg-surface shadow-e1" aria-busy={!!busy || undefined}>
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface-2">
        {room.image ? (
          <img src={assetUrl(room.image, { w: 960 })} alt={`The ${label}, styled for ${room.for === "everyone" ? "everyone" : room.for}`} className="size-full object-cover" />
        ) : (
          <div className="flex size-full">{(room.palette || []).map((h) => <span key={h} className="flex-1" style={{ background: h }} />)}</div>
        )}
        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-ink/35 backdrop-blur-[2px]">
            <span className="inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-small text-ink shadow-e2">
              <span className="taste-gradient size-2 animate-breathe rounded-full" />
              {busy === "image" ? "Picturing the room…" : "Restyling for their taste…"}
            </span>
          </div>
        )}
        {editor && !busy && (
          <button
            type="button"
            onClick={() => run("image", { image: true })}
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-surface/95 px-3 py-1.5 text-small font-medium text-ink shadow-e2 backdrop-blur transition hover:bg-surface"
          >
            <Sparkles className="size-3.5" /> {room.image ? "Picture again" : "Picture this room"}
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-heading capitalize text-ink">{label}</h3>
        {editor && people.length > 0 ? (
          <div role="radiogroup" aria-label={`Whose taste the ${label} follows`} className="mt-2 flex flex-wrap gap-1.5">
            {options.map((o) => {
              const on = (room.for || "everyone") === o;
              return (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!!busy}
                  onClick={() => !on && run("follows", { follows: o, image: !!room.image })}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-small transition",
                    on ? "border-transparent bg-ink text-white" : "border-line bg-canvas text-ink-2 hover:border-ink-4 hover:text-ink",
                  )}
                >
                  {o === "everyone" ? "Everyone" : o}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-small text-ink-3">For {room.for === "everyone" ? "everyone" : room.for}</div>
        )}
        {room.mood && <p className="mt-3 text-body text-ink-2">{room.mood}</p>}
        {!!room.ideas?.length && (
          <ul className="mt-2 space-y-1">
            {room.ideas.slice(0, 4).map((x) => <li key={x} className="text-small text-ink-3">· {x}</li>)}
          </ul>
        )}
        {error && <p className="mt-2 text-small text-fail">{error}</p>}
        <div className="mt-auto"><Because ids={room.because} ev={ev} /></div>
      </div>
    </article>
  );
}

// ---- small pieces ----------------------------------------------------------------------------------------------------
export function TasteBadge({ live, onDark }: { live?: boolean; onDark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1 text-small font-medium", onDark ? "bg-white/15 text-white backdrop-blur" : "bg-surface text-ink shadow-e1")}>
      <span className={cn("size-2 rounded-full", live && "animate-breathe", onDark ? "bg-white" : "taste-gradient")} />
      Taste by Qloo
    </span>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h2 className="font-display text-[1.75rem] leading-tight tracking-[-0.02em] text-ink">{title}</h2>
      {sub && <p className="mt-1 text-body text-ink-3">{sub}</p>}
    </div>
  );
}

function StyleCard({ title, kicker, palette, lines, because, ev }: {
  title: string; kicker?: string; palette?: { name: string; hex: string }[]; lines: (string | undefined)[]; because?: string[]; ev: Record<string, Evidence>;
}) {
  return (
    <article className="overflow-hidden rounded-card bg-surface shadow-e1">
      {!!palette?.length && (
        <div className="flex h-20">
          {palette.map((c) => (
            <span key={c.hex + c.name} className="group relative flex-1" style={{ background: c.hex }}>
              <span className="absolute bottom-1.5 left-2 text-[11px] font-medium text-white/90 mix-blend-difference">{c.name}</span>
            </span>
          ))}
        </div>
      )}
      <div className="p-6">
        <div className="text-small font-medium text-ink-3">{title}</div>
        {kicker && <h3 className="mt-1 font-display text-[1.6rem] leading-tight text-ink">{kicker}</h3>}
        <ul className="mt-3 space-y-1.5">
          {lines.filter(Boolean).map((l) => <li key={l} className="text-body text-ink-2">{l}</li>)}
        </ul>
        <Because ids={because} ev={ev} />
      </div>
    </article>
  );
}

/** "Because" chips: the Qloo evidence behind a choice. Hover or focus shows where it came from. */
export function Because({ ids, ev }: { ids?: string[]; ev: Record<string, Evidence> }) {
  const items = useMemo(() => (ids || []).map((i) => ev[i]).filter(Boolean), [ids, ev]);
  if (!items.length) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[.12em] text-ink-4">Because</span>
      {items.map((e) => <EvidenceChip key={e.eid} e={e} ev={ev} />)}
    </div>
  );
}

function EvidenceChip({ e, ev }: { e: Evidence; ev: Record<string, Evidence> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (x: MouseEvent) => !ref.current?.contains(x.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const kind = e.eid.startsWith("T") ? "taste" : e.eid.startsWith("P") ? "place" : "favourite";
  const from = (e.from || []).map((f) => ev[f]?.name).filter(Boolean);
  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-0.5 text-small text-ink-2 transition hover:border-ink-4 hover:text-ink"
      >
        <span className="size-1.5 rounded-full" style={{ backgroundImage: gradient }} />
        {e.name}
      </button>
      {open && (
        <span role="tooltip" className="absolute bottom-full left-0 z-20 mb-2 w-64 rounded-control bg-hud p-3 text-small text-hud-ink shadow-e3">
          <span className="block font-medium">{e.name} <span className="text-hud-ink-2">· Qloo {kind}</span></span>
          {e.via?.length ? <span className="mt-1 block text-hud-ink-2">From {e.via.join("; ")}</span> : null}
          {from.length ? <span className="mt-1 block text-hud-ink-2">Pointed to by {from.join(", ")}</span> : null}
          {typeof e.affinity === "number" ? <span className="mt-1 block text-hud-ink-2">Affinity {e.affinity.toFixed(2)}</span> : null}
        </span>
      )}
    </span>
  );
}

function TagCloud({ tags }: { tags: { name: string; weight: number }[] }) {
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-2">
      {tags.slice(0, 18).map((t, i) => (
        <motion.span
          key={t.name}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className="font-display text-ink"
          style={{ fontSize: `${1 + Math.max(0, Math.min(1, t.weight)) * 1.4}rem`, opacity: 0.55 + Math.min(1, t.weight) * 0.45 }}
        >
          {t.name}
        </motion.span>
      ))}
    </div>
  );
}

export type { StyleBrief };
