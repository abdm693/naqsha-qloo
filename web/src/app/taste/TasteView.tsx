/**
 * The family's home after the reveal: how much of them is in it, a room for each person, and the reasons for anyone who
 * wants them. The product never names its data sources.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, Sparkles } from "lucide-react";
import type { Evidence, Project, StyleBrief, Taste } from "@contracts/api-types";
import { api, assetUrl, errorMessage } from "@/api/client";
import { cn } from "@/app/lib/utils";
import { useProject } from "@/app/store/project";

/** Tags that say nothing useful about a home, or that a family would not want said about them (older readings kept some). */
const UNHELPFUL = new Set(["seductive", "sexy", "marriage", "motivated", "professional", "ethnicity", "elite", "authoritative", "beauty oriented",
  "romantically inclined", "athletic", "weddings", "dynamic", "ethnic", "ethnic diversity", "culturally aware", "affluent", "wealthy",
  "world traveler", "global perspective", "business travelers", "seasonal residents", "remote", "volcanoes", "coral reefs", "canyons",
  "scuba diving", "hot springs", "camping"]);
const shown = <T extends { name: string }>(tags: T[] | undefined): T[] => (tags || []).filter((t) => !UNHELPFUL.has(t.name.trim().toLowerCase()));

const gradient = "linear-gradient(120deg, var(--color-taste-1, #E8A33D), var(--color-taste-2, #D9486B) 55%, var(--color-taste-3, #6B3FA0))";

// ---- the family's home, once the heart is known ------------------------------------------------------------------------
/** What's left after the reveal: how much of them is in it, their rooms, and the reasons for anyone who wants them. */
export function ProfileBody({ taste, project, editor, onProjectChange }: { taste: Taste; project: Project; editor: boolean; onProjectChange(p: Project): void }) {
  const s = taste.style;
  const p = taste.profile;
  const ev = s.evidence || {};
  return (
    <div className="space-y-12">
      <Impact taste={taste} project={project} />

      {/* Rooms */}
      {!!s.rooms?.length && (
        <section>
          <SectionTitle title="Inside: a room for each of you" />
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {s.rooms.map((r, i) => (
              <RoomCard key={i} index={i} room={r} people={(s.people || []).map((x) => x.label)} ev={ev} project={project} editor={editor} onProjectChange={onProjectChange} />
            ))}
          </div>
        </section>
      )}


      <details className="group">
        <summary className="cursor-pointer list-none font-display text-[1.5rem] tracking-[-.02em] text-ink marker:hidden">
          Why it looks like this <span aria-hidden className="ml-1 inline-block text-ink-3 transition group-open:rotate-90">›</span>
        </summary>
        <div className="mt-8 space-y-10">
      {/* Each person */}
      {!!s.people?.length && (
        <section>
          <SectionTitle title="Who this home is for" sub="What each of you brings to it" />
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {s.people.map((x, i) => {
              const tags = shown(p.people.find((pp) => pp.label === x.label)?.tags);
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
          <SectionTitle title="What your taste decided" sub="Every choice shows what it came from. Hover one to see." />
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

      {/* Wider taste: destinations and brands */}
      {(p.destinations.length > 0 || p.brands.length > 0) && (
        <section>
          <SectionTitle title="People with your taste also love" sub="Places and labels the design borrows from" />
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

      {/* What the family's taste makes of the neighbourhood, and the garden */}
      <section className="grid gap-4 lg:grid-cols-2">
        {(s.neighbourhood || p.area) && (
          <article className="rounded-card bg-surface p-6 shadow-e1">
            <div className="flex items-center gap-2 text-small font-medium text-ink-3"><MapPin className="size-4" /> Your house on {p.area?.location ? `${p.area.location.split(",")[0]}'s streets` : "its street"}</div>
            {s.neighbourhood?.reading && <p className="mt-2 text-body-lg text-ink">{s.neighbourhood.reading}</p>}
            {s.neighbourhood?.response && <p className="mt-2 text-body text-ink-2">{s.neighbourhood.response}</p>}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {shown(p.area?.tags).slice(0, 8).map((t) => <span key={t.eid} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-small text-ink-2">{t.name}</span>)}
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
          <SectionTitle title="Where to find the pieces" sub={`Places near ${p.area?.location || "you"} that suit your taste`} />
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

        </div>
      </details>
    </div>
  );
}

// ---- measured impact ---------------------------------------------------------------------------------------------------
function Impact({ taste, project }: { taste: Taste; project: Project }) {
  const fitted = project.concepts.filter((c) => c.from_taste && typeof c.taste_fit?.score === "number");
  const chosen = project.concepts.find((c) => c.id === project.selected_concept_id && typeof c.taste_fit?.score === "number");
  const best = chosen ?? [...fitted].sort((a, b) => (b.taste_fit!.score ?? 0) - (a.taste_fit!.score ?? 0))[0];
  const base = taste.baseline;
  if (!base || !best) return null;
  return (
    <section aria-labelledby="impact-title">
      <SectionTitle title="How much of you is in it" sub="The same plot, drawn with you and without you." />
      {base && best && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <FitCard title="Without your taste" sub="The same plot and brief, a typical new house" url={base.url} fit={base.taste_fit?.score} muted />
          <FitCard title={best.title ? `Yours: ${best.title}` : "Yours"} sub={best.why || "Drawn from your taste"} url={best.url} fit={best.taste_fit?.score}
            delta={typeof best.taste_fit?.score === "number" && typeof base.taste_fit?.score === "number" ? best.taste_fit.score - base.taste_fit.score : undefined} />
        </div>
      )}
    </section>
  );
}

function FitCard({ title, sub, url, fit, delta, muted }: { title: string; sub?: string; url: string; fit?: number | null; delta?: number; muted?: boolean }) {
  return (
    <figure className={cn("overflow-hidden rounded-card bg-surface shadow-e1", !muted && "ring-2 ring-lamp")}>
      <div className="relative aspect-[16/10]">
        <img src={assetUrl(url, { w: 960 })} alt={title} className={cn("size-full object-cover", muted && "saturate-[.6]")} loading="lazy" />
        {typeof fit === "number" && (
          <span className={cn("absolute left-3 top-3 rounded-full px-3 py-1 text-small font-semibold shadow-e2", muted ? "bg-surface text-ink-2" : "bg-dusk-1 text-lamp-soft")}>
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
              <span className="size-2 animate-breathe rounded-full bg-lamp" />
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
      <span className={cn("size-2 rounded-full", live && "animate-breathe", onDark ? "bg-white" : "bg-lamp")} />
      Naqsha Taste
    </span>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h2 className="font-display text-[1.75rem] leading-tight tracking-[-.035em] text-ink">{title}</h2>
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

/** "Because" chips: the evidence behind a choice. Hover or focus shows where it came from. */
export function Because({ ids, ev }: { ids?: string[]; ev: Record<string, Evidence> }) {
  const items = useMemo(() => shown((ids || []).map((i) => ev[i]).filter(Boolean)), [ids, ev]);
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
          <span className="block font-medium">{e.name} <span className="text-hud-ink-2">· {kind}</span></span>
          {e.via?.length ? <span className="mt-1 block text-hud-ink-2">From {e.via.join("; ")}</span> : null}
          {from.length ? <span className="mt-1 block text-hud-ink-2">Pointed to by {from.join(", ")}</span> : null}
        </span>
      )}
    </span>
  );
}

export type { StyleBrief };
