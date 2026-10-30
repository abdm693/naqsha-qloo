/**
 * The landing page (/): what Naqsha does for a family or a builder, in plain language, with the
 * house-under-construction animation, the taste section, and a separate Portal button into the app (/app).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, MapPin } from "lucide-react";
import type { Project } from "@contracts/api-types";
import { api, assetUrl } from "@/api/client";
import { cn } from "@/app/lib/utils";
import { heroSample, openSampleHome, sampleCaption, sampleCounts, sampleTitle, type SampleCounts } from "@/app/lib/samples";
import { AccountMenu } from "@/app/auth/AccountMenu";
import { Button, buttonClass } from "@/app/ui/Button";
import { Wordmark } from "@/app/ui/brand";
import { ease } from "@/app/ui/motion";
import { Construction } from "./Construction";

// Hyphenated compounds use U+2011 (a non-breaking hyphen) so "approval‑ready" never splits across lines.
const benefits = (counts: SampleCounts | null): { title: string; line: string }[] => [
  { title: "Designed around your family's taste", line: "Share the films, music and places you love. Naqsha reads the taste behind them, and your street's, and turns it into colours, materials and rooms that feel like yours." },
  { title: "Plot to a checked floor plan the same afternoon", line: "Tell Naqsha the plot and the family, and get dimensioned floor plans before the chai goes cold." },
  {
    title: "Checked against the bylaws, every time",
    // The counts are the 10 marla sample's own (they move when the rules do); without them, no number is promised.
    line: counts
      ? `Every bylaw that applies to your plot (${counts.lda} checks on the Lahore sample; anywhere else the agent researches the local rules and cites them) and ${counts.livable} livable rules: setbacks, coverage, height, stairs, railings at every drop.`
      : "Every bylaw that applies to your plot (LDA in this prototype), and the livable rules: setbacks, coverage, height, stairs to the roof, railings at every drop.",
  },
  { title: "Start from your own drawing", line: "Have a naqsha from your architect, or a sketch on paper? Upload a photo of it. Naqsha reads every room and builds from your layout, changing only what the rules need." },
  { title: "Rules for your city, looked up for you", line: "Anywhere in the world, Naqsha searches the web with Tavily for your authority's building rules and checks the design against them, with every source linked." },
  { title: "Walk your home before you build it", line: "Room by room, on any laptop or phone, with photos from the road, the garden and the air. Find the cramped bedroom while it costs nothing to fix." },
  { title: "Change it by asking", line: "Pin a note on a wall or type what you want. Naqsha returns the next version, still compliant, and answers every note in its thread." },
  { title: "Drawings your contractor can use", line: "Print every floor to scale with a title block, area schedule and compliance sheet, on A3 or A4, or save it as a PDF." },
];

/** The taste section: four real families from the samples, in four countries. What they share, what Naqsha finds, what changes. */
const FAMILIES = [
  {
    place: "Lahore, Pakistan",
    shares: [
      { kind: "Places", value: "Istanbul, Fez, Kyoto" },
      { kind: "Music", value: "Abida Parveen, Coke Studio, Coldplay" },
      { kind: "Films", value: "Spirited Away" },
      { kind: "Favourite spot", value: "Kiraz Coffee House" },
    ],
    finds: ["Traditional craftsmanship", "Modern silhouettes", "Rich textiles", "Cultural pride"],
    street: { where: "DHA Phase 6", feel: ["Modern", "Urban", "Lively"], idea: "A lush walled lawn with jasmine" },
    changes: ["Brass jaali screens on the upper façade", "Lahori brick, lime plaster and walnut", "A reading bay for Abbu off the parents' suite", "A music corner in the lounge"],
  },
  {
    place: "Austin, United States",
    shares: [
      { kind: "Places", value: "Oaxaca, Mexico City, Marfa" },
      { kind: "Music", value: "Selena, Bad Bunny" },
      { kind: "Films", value: "Coco, Spider-Verse" },
      { kind: "Favourite spot", value: "Franklin Barbecue" },
    ],
    finds: ["Sustainable, eco-conscious", "Minimalist comfort", "Whimsy and imagination", "Warm elegance"],
    street: { where: "Travis Heights", feel: ["Walkable", "Casual", "Lively"], idea: "A screened porch for year-round lounging" },
    changes: ["A terracotta breeze-block screen at the front", "Clay limewash and reclaimed oak", "Hand-painted Mexican tiles on the stair", "A smoker alcove on the back porch"],
  },
  {
    place: "Dubai, United Arab Emirates",
    shares: [
      { kind: "Places", value: "Granada, Marrakech, Tokyo, Paris" },
      { kind: "Music", value: "Fairuz, Umm Kulthum, The Weeknd" },
      { kind: "Films", value: "Dune" },
      { kind: "Brands", value: "Hermès" },
    ],
    finds: ["Timeless elegance", "Artisanal and crafted", "Sophisticated living", "Wellness"],
    street: { where: "Al Barsha", feel: ["Modern", "Convenient", "Walkable"], idea: "A walled water court with palms" },
    changes: ["A majlis with its own entrance", "A shaded courtyard with a water rill", "Bronze mashrabiya screens to the west", "Saddle-leather and walnut on the stair"],
  },
  {
    place: "Toronto, Canada",
    shares: [
      { kind: "Places", value: "Seoul, Jeju Island, Copenhagen" },
      { kind: "Music", value: "IU, Drake" },
      { kind: "Films", value: "Parasite, Spirited Away" },
      { kind: "Brands", value: "Muji" },
    ],
    finds: ["Minimalist design", "Monochrome calm", "Laid-back city living", "Quietly fashion-forward"],
    street: { where: "Leslieville", feel: ["Historic", "Stylish", "Walkable"], idea: "Red brick and arched masonry, like the street" },
    changes: ["White oak kitchen open to the dining room", "A big picture window onto the garden", "A mudroom with hidden oak lockers", "A laneway garage in charcoal brick and cedar"],
  },
];

/** The hero's right side: four real families, each house drawn from their taste, with its measured taste fit. */
const CITY_ORDER = ["lahore", "austin", "dubai", "toronto"];
function HeroFamilies({ samples, opening, onOpen }: { samples: Project[]; opening: string | null; onOpen(id: string): void }) {
  const list = samples
    .filter((x) => x.taste)
    .sort((a, b) => CITY_ORDER.indexOf(String(a.brief?.city ?? "").toLowerCase()) - CITY_ORDER.indexOf(String(b.brief?.city ?? "").toLowerCase()))
    .slice(0, 4);
  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-4" aria-label="Four families, four homes">
      {list.map((p) => {
        const c = p.concepts.find((x) => x.id === p.selected_concept_id) ?? p.concepts.find((x) => x.from_taste);
        const fit = c?.taste_fit?.score;
        const base = p.taste?.baseline?.taste_fit?.score;
        return (
          <li key={p.id}>
            <button type="button" onClick={() => onOpen(p.id)} disabled={!!opening}
              aria-label={`Open ${sampleTitle(p.name)}: ${p.taste?.style.headline}`}
              className="group block w-full overflow-hidden rounded-card bg-surface text-left shadow-e2 transition hover:-translate-y-0.5 hover:shadow-e3 focus-visible:shadow-focus disabled:opacity-80">
              <div className="relative aspect-[4/3] overflow-hidden bg-surface-2">
                {c && <img src={assetUrl(c.url, { w: 640 })} alt="" className="size-full object-cover transition duration-500 group-hover:scale-[1.03]" />}
                {typeof fit === "number" && (
                  <span className="taste-gradient absolute left-2.5 top-2.5 rounded-full px-2.5 py-1 text-[12px] font-semibold text-white shadow-e2">
                    Taste fit {fit}%{typeof base === "number" ? ` · ${base}% without` : ""}
                  </span>
                )}
                {opening === p.id && <span className="absolute inset-0 grid place-items-center bg-ink/30 text-[13px] font-medium text-white">Opening…</span>}
              </div>
              <div className="px-3.5 pb-3.5 pt-3">
                <div className="text-[11.5px] font-semibold uppercase tracking-[.08em] text-ink-3">{[p.brief?.city, p.brief?.city && countryOf(p.brief.city)].filter(Boolean).join(", ")}</div>
                <div className="mt-1 line-clamp-2 font-display text-[16px] leading-[20px] text-ink">{p.taste?.style.headline}</div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function countryOf(city: string): string {
  return ({ lahore: "Pakistan", austin: "United States", dubai: "UAE", toronto: "Canada" } as Record<string, string>)[city.toLowerCase()] ?? "";
}

/** What this edition runs on. */
const STACK: { name: string; line: string }[] = [
  { name: "Google Gemini on Vertex AI", line: "Talks with the family, designs the plan and the 3D house, and revises it from their notes." },
  { name: "Tavily", line: "Looks up the local building rules wherever the plot is, with every source linked." },
];

const STEPS: { label: string; time: string; title: string; line: string }[] = [
  { label: "Brief", time: "3 min", title: "Tell Naqsha about the plot and the family", line: "Size, which way it faces, who will live there and what they love. Naqsha asks only what it still needs." },
  { label: "Concepts", time: "1 min", title: "Choose a direction", line: "Exteriors by day and by night, shaped by your family's taste. Pick one, and the 3D model is built to match it." },
  { label: "Plan", time: "5 min", title: "See every floor, checked", line: "Dimensioned floors with doors and furniture, checked against LDA and livable rules as they are drawn. Print it for your contractor." },
  { label: "House", time: "5 min", title: "Walk it, change it, share it", line: "Walk through in 3D, pin notes for changes, and bring in your family, your architect or your client." },
];

/** Header links: the same 36px height and 14px type as Sign in and Portal beside them. */
const NAV_LINK = "h-9 items-center rounded-full px-3 text-[14px] font-medium text-ink-2 outline-none transition-colors hover:text-ink focus-visible:shadow-focus";

export function Landing() {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [family, setFamily] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [samples, setSamples] = useState<Project[] | null>(null);

  useEffect(() => {
    document.title = "Naqsha · A home that feels like your family";
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .listSamples()
      .then((list) => alive && setSamples(list))
      .catch(() => alive && setSamples([]));
    return () => {
      alive = false;
    };
  }, []);

  const hero = samples ? heroSample(samples) : undefined;
  const counts = hero ? sampleCounts(hero) : null;

  /** Open one sample (the hero's 10 marla home when no id is given). */
  const sample = async (id?: string) => {
    if (opening) return;
    const target = id ?? hero?.id;
    setOpening(target ?? "hero");
    const ok = await openSampleHome(navigate, target);
    if (!ok) setOpening(null);
  };

  return (
    <div className="relative min-h-[100dvh] overflow-x-clip bg-canvas text-ink">
      {/* A low, warm light across the top of the page, like late sun on a plastered wall. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[900px]"
        style={{ background: "radial-gradient(60% 55% at 78% 8%, rgb(226 186 140 / .28), transparent 70%), radial-gradient(45% 40% at 8% 0%, rgb(236 214 190 / .35), transparent 70%)" }}
        aria-hidden
      />
      {/* Header */}
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-40 transition-[background-color,box-shadow,backdrop-filter] duration-300",
          scrolled ? "glass-light" : "bg-transparent",
        )}
      >
        <div className="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-3 px-4 sm:px-8">
          <Link to="/" aria-label="Naqsha home" className="shrink-0 rounded-[8px] outline-none focus-visible:shadow-focus">
            <Wordmark />
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
            <a href="#taste" className={cn(NAV_LINK, "hidden md:inline-flex")}>
              Taste
            </a>
            <a href="#how" className={cn(NAV_LINK, "hidden md:inline-flex")}>
              How it works
            </a>
            <a href="#samples" className={cn(NAV_LINK, "hidden md:inline-flex")}>
              Samples
            </a>
            <AccountMenu className="h-9 px-3.5 text-[14px]" />
            <Link to="/app" className={buttonClass("ink", "sm", "h-9 px-4 text-[14px]")}>
              Portal
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative">
        {/* Hero */}
        <section
          className="mx-auto grid max-w-[1280px] grid-cols-1 items-center gap-12 px-4 pt-28 sm:px-8 sm:pt-32 lg:min-h-[min(860px,100svh)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16 lg:pb-8 lg:pt-28"
          aria-labelledby="hero-title"
        >
          <div>
            <motion.h1
              id="hero-title"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: ease.out }}
              className="max-w-[11ch] font-display text-[clamp(2.75rem,5.6vw,5.25rem)] leading-[.95] tracking-[-.035em] text-ink"
            >
              A home that feels like <span className="taste-text">your family.</span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: ease.out, delay: 0.08 }}
              className="mt-6 max-w-[33rem] text-body-lg text-ink-2 sm:mt-8 sm:text-[19px] sm:leading-[30px]"
            >
              Tell Naqsha about your plot and the people who will live there. It learns your family's taste and reads your neighbourhood, then designs a bylaw‑checked floor plan and a 3D home you can walk through, built around it.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: ease.out, delay: 0.14 }}
              className="mt-8 flex flex-col gap-3 sm:mt-10 sm:flex-row"
            >
              <Button variant="primary" size="lg" trailing={<ArrowRight className="size-4" strokeWidth={2} />} onClick={() => navigate("/app")}>
                Start your home
              </Button>
              <Button variant="secondary" size="lg" loading={opening === "hero" || (!!hero && opening === hero.id)} onClick={() => void sample()}>
                Explore a sample home
              </Button>
            </motion.div>
            <motion.ul
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, ease: ease.out, delay: 0.24 }}
              className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-[14px] text-ink-3 sm:mt-10"
            >
              {["Learns your taste", "Bylaw‑checked", "Walk every room"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                  {t}
                </li>
              ))}
            </motion.ul>
          </div>
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.9, ease: ease.out, delay: 0.1 }}
          >
            {samples && samples.filter((x) => x.taste).length >= 3 ? (
              <HeroFamilies samples={samples} opening={opening} onOpen={(id) => void sample(id)} />
            ) : (
              <HeroMedia counts={counts} />
            )}
          </motion.div>
        </section>

        {/* Taste: the one place on the landing that uses the taste gradient. */}
        <section id="taste" className="mx-auto max-w-[1280px] scroll-mt-24 px-4 pt-24 sm:px-8 sm:pt-32" aria-labelledby="taste-title">
          <div className="taste-wash relative overflow-hidden rounded-media px-5 py-14 shadow-e1 sm:px-12 sm:py-20">
            <Reveal className="max-w-[46rem]">
              <p className="inline-flex items-center gap-2 text-[13px] font-medium text-taste-ink">
                <span className="taste-gradient size-2 rounded-full" aria-hidden />
                Home is where the heart is
              </p>
              <h2 id="taste-title" className="mt-4 font-display text-[40px]/[44px] tracking-[-.035em] text-ink sm:text-display">
                A house that knows <span className="taste-text pr-1">what you love.</span>
              </h2>
              <p className="mt-4 text-body-lg text-ink-2">
                Two families on the same plot should not get the same house. Tell Naqsha the films you rewatch, the music in the car and the places you keep going back to. Naqsha finds what those choices have in common, reads the street the house will stand on, and the design follows both.
              </p>
            </Reveal>
            <div role="tablist" aria-label="Four families" className="mt-10 flex flex-wrap gap-2">
              {FAMILIES.map((f, i) => (
                <button key={f.place} type="button" role="tab" aria-selected={family === i} onClick={() => setFamily(i)}
                  className={cn("rounded-full border px-4 py-2 text-[14px] font-medium transition", family === i ? "border-transparent bg-ink text-white" : "border-line-strong bg-surface text-ink-2 hover:text-ink")}>
                  {f.place}
                </button>
              ))}
            </div>
            <ol className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-5">
              <TasteStep n={1} title="What your family shares">
                <ul className="flex flex-col gap-2.5">
                  {FAMILIES[family].shares.map((t) => (
                    <li key={t.kind} className="flex items-baseline gap-3 rounded-[14px] bg-surface-2/70 px-3.5 py-2.5">
                      <span className="w-24 shrink-0 text-[12px] font-medium text-ink-3">{t.kind}</span>
                      <span className="min-w-0 text-[14px] leading-5 text-ink">{t.value}</span>
                    </li>
                  ))}
                </ul>
              </TasteStep>
              <TasteStep n={2} title="What Naqsha finds" featured>
                <ul className="flex flex-col gap-3">
                  {FAMILIES[family].finds.map((t) => (
                    <li key={t} className="flex items-start gap-3 text-[15px] leading-[22px] text-ink">
                      <span className="taste-gradient mt-[7px] size-2 shrink-0 rounded-full" aria-hidden />
                      {t}
                    </li>
                  ))}
                </ul>
                {/* The street matters as much as the people: read from the places around the plot. */}
                <div className="mt-5 border-t border-line pt-4">
                  <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink-3">
                    <MapPin className="size-3.5 text-taste-2" strokeWidth={2} aria-hidden /> Around {FAMILIES[family].street.where}
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`How ${FAMILIES[family].street.where} feels`}>
                    {FAMILIES[family].street.feel.map((f) => (
                      <li key={f} className="rounded-full bg-taste-soft px-2.5 py-0.5 text-[12.5px] font-medium text-taste-ink">{f}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[14px] leading-5 text-ink-2">{FAMILIES[family].street.idea}</p>
                </div>
              </TasteStep>
              <TasteStep n={3} title="How the house changes">
                <ul className="flex flex-col gap-3">
                  {FAMILIES[family].changes.map((t) => (
                    <li key={t} className="flex items-start gap-3 text-[15px] leading-[22px] text-ink">
                      <Check className="mt-[3px] size-4 shrink-0 text-accent" strokeWidth={2} aria-hidden />
                      {t}
                    </li>
                  ))}
                </ul>
              </TasteStep>
            </ol>
            <p className="mt-6 max-w-[40rem] text-[13px] leading-5 text-ink-3">
              Four families from the sample homes. Your own answers shape your own house, and every change is still checked against the local rules.
            </p>
          </div>
        </section>

        {/* What it runs on */}
        <section className="mx-auto max-w-[1280px] px-4 pt-16 sm:px-8 sm:pt-20" aria-labelledby="stack-title">
          <h2 id="stack-title" className="text-[13px] font-medium text-ink-3">What it runs on</h2>
          <ul className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-card bg-line shadow-e1 sm:grid-cols-2">
            {STACK.map((t) => (
              <li key={t.name} className="bg-surface px-5 py-5 sm:px-6">
                <p className="text-[15px] font-semibold tracking-[-.01em] text-ink">{t.name}</p>
                <p className="mt-1 text-[14px] leading-[21px] text-ink-2">{t.line}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Benefits */}
        <section className="mx-auto max-w-[1280px] px-4 pt-24 sm:px-8 sm:pt-32" aria-labelledby="benefits-title">
          <SectionHead
            id="benefits-title"
            title="Everything between the plot and the contractor."
            line="What used to take weeks of sketches and site visits now fits in one sitting with your family."
          />
          <ul className="mt-14 grid grid-cols-1 gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
            {benefits(counts).map((b, i) => (
              <Reveal key={b.title} delay={(i % 4) * 0.06} as="li">
                <div className="flex items-center gap-3" aria-hidden>
                  <span className="font-display text-[22px] leading-none text-accent">{String(i + 1).padStart(2, "0")}</span>
                  <span className="h-px flex-1 bg-line-strong" />
                </div>
                {/* Two lines reserved: a title that wraps never pushes its body below its neighbours'. */}
                <h3 className="mt-4 text-heading text-ink sm:min-h-[2lh]">{b.title}</h3>
                <p className="mt-2 text-[15px] leading-[24px] text-ink-2">{b.line}</p>
              </Reveal>
            ))}
          </ul>
        </section>

        {/* How it works */}
        <section id="how" className="mx-auto max-w-[1280px] scroll-mt-24 px-4 pt-28 sm:px-8 sm:pt-36" aria-labelledby="how-title">
          <div className="rounded-media bg-surface px-5 py-14 shadow-e2 sm:px-12 sm:py-20">
            <SectionHead id="how-title" title="How it works" line="Four views of one home, one conversation. You can stop at any point and come back." />
            <ol className="mt-14 grid grid-cols-1 gap-10 md:grid-cols-2 md:gap-8 lg:grid-cols-4">
              {STEPS.map((s, i) => (
                <Reveal key={s.label} delay={i * 0.08} as="li" className="relative">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-7 items-center rounded-full bg-accent-soft px-3 text-[13px] font-semibold text-accent">{s.label}</span>
                    <span className="h-px flex-1 bg-line" aria-hidden />
                    <span className="tabular text-[12px] font-medium text-ink-3">{s.time}</span>
                  </div>
                  <h3 className="mt-5 text-heading text-ink">{s.title}</h3>
                  <p className="mt-2 text-[15px] leading-[24px] text-ink-2">{s.line}</p>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        {/* Samples */}
        <section id="samples" className="mx-auto max-w-[1280px] scroll-mt-24 px-4 pt-28 sm:px-8 sm:pt-36" aria-labelledby="samples-title">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <SectionHead id="samples-title" title="Sample homes" line="Open a finished home and walk through it. No account needed." />
            {!!hero && (
              <Button variant="secondary" className="self-start sm:self-auto" loading={opening === hero.id} onClick={() => void sample(hero.id)} trailing={<ArrowRight className="size-4" strokeWidth={1.75} />}>
                Walk through one
              </Button>
            )}
          </div>
          {samples === null ? (
            <ul className="mt-12 grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2" aria-label="Loading sample homes" aria-busy>
              {[0, 1].map((i) => (
                <li key={i} className="flex flex-col gap-3">
                  <div className="relative aspect-[4/3] overflow-hidden rounded-card bg-surface-2">
                    <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-surface/70 to-transparent" />
                  </div>
                  <div className="h-4 w-2/3 rounded-full bg-surface-2" />
                  <div className="h-3 w-1/2 rounded-full bg-surface-2" />
                </li>
              ))}
            </ul>
          ) : samples.length ? (
            <ul className={cn("mt-12 grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2", samples.length > 2 && "lg:grid-cols-3")}>
              {/* The home the hero animates comes first. */}
              {[...samples].sort((a, b) => Number(b.id === hero?.id) - Number(a.id === hero?.id)).map((s, i) => {
                const img = assetUrl(s.thumbnail_url);
                return (
                  <Reveal key={s.id} delay={i * 0.06} as="li">
                    <button
                      type="button"
                      onClick={() => void sample(s.id)}
                      disabled={!!opening}
                      aria-busy={opening === s.id || undefined}
                      className="group/s block w-full text-left outline-none disabled:cursor-progress"
                      aria-label={`Explore the sample home: ${sampleTitle(s.name)}`}
                    >
                      <span className="relative block overflow-hidden rounded-card bg-surface-2 shadow-e1 transition-[box-shadow,transform] duration-[600ms] ease-out group-hover/s:-translate-y-1 group-hover/s:shadow-e2 group-focus-visible/s:shadow-focus">
                        {img ? (
                          <img src={img} alt="" loading="lazy" className="aspect-[4/3] w-full object-cover transition-transform duration-[600ms] ease-out group-hover/s:scale-[1.02]" />
                        ) : (
                          <span className="block aspect-[4/3] w-full" />
                        )}
                        {opening === s.id && (
                          <span className="glass-light absolute left-3 top-3 inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-ink">
                            <span className="size-1.5 animate-breathe rounded-full bg-accent" aria-hidden />
                            Opening
                          </span>
                        )}
                      </span>
                      <span className="mt-4 block px-0.5 font-display text-[24px] leading-[28px] text-ink">{sampleTitle(s.name)}</span>
                      <span className="mt-1 block px-0.5 text-[13px] text-ink-3">{sampleCaption(s)}</span>
                    </button>
                  </Reveal>
                );
              })}
            </ul>
          ) : (
            <p className="mt-12 rounded-card bg-surface px-6 py-10 text-center text-[15px] text-ink-2 shadow-e1">
              The sample homes are resting right now. <Link to="/app" className="font-medium text-ink underline underline-offset-4">Start your own</Link> instead.
            </p>
          )}
        </section>

        {/* For builders */}
        <section className="mx-auto max-w-[1280px] px-4 pt-28 sm:px-8 sm:pt-36" aria-labelledby="builders-title">
          <div
            className="flex flex-col items-start gap-8 rounded-media bg-ink px-6 py-14 text-white shadow-e3 sm:px-12 sm:py-20 lg:flex-row lg:items-end lg:justify-between"
            style={{ backgroundImage: "radial-gradient(70% 90% at 100% 0%, rgb(107 42 94 / .45), transparent 65%)" }}
          >
            <div className="max-w-[40rem]">
              <h2 id="builders-title" className="font-display text-[36px]/[40px] tracking-[-.035em] sm:text-display">
                For builders and architects: win the client in the first meeting.
              </h2>
              <p className="mt-4 text-body-lg text-white/75">
                Arrive with a laptop. Leave with a walkable design the family has already commented on, and a link they can share with everyone who has a say.
              </p>
            </div>
            <Link to="/app" className={buttonClass("secondary", "lg", "border-transparent bg-surface text-ink hover:bg-surface-2")}>
              Portal
              <ArrowRight className="size-4" strokeWidth={2} />
            </Link>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="mx-auto mt-28 max-w-[1280px] px-4 pb-12 sm:mt-36 sm:px-8">
        <div className="flex flex-col gap-8 border-t border-line pt-10 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Wordmark />
            <p className="mt-3 max-w-xs text-[14px] leading-[22px] text-ink-3">Homes designed around your family, checked against your city's rules, and ready to walk.</p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 text-[14px]">
            <Link to="/app" className="inline-flex min-h-11 items-center text-ink-2 hover:text-ink sm:min-h-8">Portal</Link>
            <a href="#taste" className="inline-flex min-h-11 items-center text-ink-2 hover:text-ink sm:min-h-8">Taste</a>
            <a href="#how" className="inline-flex min-h-11 items-center text-ink-2 hover:text-ink sm:min-h-8">How it works</a>
            <a href="#samples" className="inline-flex min-h-11 items-center text-ink-2 hover:text-ink sm:min-h-8">Samples</a>
            <Link to="/app/signin" className="inline-flex min-h-11 items-center text-ink-2 hover:text-ink sm:min-h-8">Sign in</Link>
          </nav>
        </div>
        <p className="mt-10 text-[13px] text-ink-3">© 2026 Naqsha · Made in Lahore · Designed with Google Gemini on Vertex AI · Local rules found with Tavily · Open source (AGPL‑3.0)</p>
      </footer>
    </div>
  );
}

/**
 * The hero frame: Naqsha's 2D drawing of a home (plot, structure, walls, render, night) plays first, then hands over
 * to the 3D film of a sample home being built in the viewer (a real capture, looped).
 */
function HeroMedia({ counts }: { counts: SampleCounts | null }) {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<"draw" | "build">(reduce ? "build" : "draw");
  const film = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (stage !== "build" || reduce) return;
    const v = film.current;
    if (!v) return;
    v.currentTime = 0;
    void v.play().catch(() => {});
  }, [stage, reduce]);

  const label = "A sample home being built in 3D by Naqsha, from the plot to the finished house at night";
  return (
    <figure className="relative mx-auto w-full max-w-[640px]">
      <div className="relative aspect-square overflow-hidden rounded-media bg-surface shadow-e3">
        {reduce ? (
          <img src="/hero/naqsha-build-poster.jpg" alt={label} className="size-full object-cover" />
        ) : (
          <>
            <video
              ref={film}
              className={cn("absolute inset-0 size-full object-cover transition-opacity duration-1000 ease-out", stage === "build" ? "opacity-100" : "opacity-0")}
              muted
              loop
              playsInline
              preload="auto"
              poster="/hero/naqsha-build-poster.jpg"
              aria-label={label}
            >
              <source src="/hero/naqsha-build-720.mp4" type="video/mp4" media="(max-width: 767px)" />
              <source src="/hero/naqsha-build.webm" type="video/webm" />
              <source src="/hero/naqsha-build.mp4" type="video/mp4" />
            </video>
            <div
              className={cn(
                "absolute inset-0 flex items-center bg-surface transition-opacity duration-1000 ease-out",
                stage === "draw" ? "opacity-100" : "pointer-events-none opacity-0",
              )}
              style={{
                backgroundImage:
                  "linear-gradient(rgb(74 52 30 / .05) 1px, transparent 1px), linear-gradient(90deg, rgb(74 52 30 / .05) 1px, transparent 1px)",
                backgroundSize: "24px 24px",
              }}
              aria-hidden={stage !== "draw"}
            >
              <Construction className="w-full rounded-none bg-transparent shadow-none" counts={counts} hideReplay onDone={() => setStage("build")} />
            </div>
          </>
        )}
        <div className="pointer-events-none absolute inset-0 rounded-media ring-1 ring-inset ring-[rgb(74_52_30/.08)]" aria-hidden />
      </div>
      <figcaption
        className={cn(
          "absolute left-4 top-4 flex items-center gap-2 rounded-full bg-surface/85 px-3 py-1.5 text-[13px] font-medium text-ink shadow-e1 backdrop-blur transition-opacity duration-700 sm:left-5 sm:top-5",
          stage === "build" ? "opacity-100" : "opacity-0",
        )}
      >
        <span className="size-1.5 rounded-full bg-accent" aria-hidden />
        A sample home, built in 3D by Naqsha
      </figcaption>
    </figure>
  );
}

/** One step of the taste section: a numbered card. The middle one ("What Naqsha finds") wears the taste ring. */
function TasteStep({ n, title, featured, children }: { n: number; title: string; featured?: boolean; children: ReactNode }) {
  return (
    <Reveal as="li" delay={(n - 1) * 0.08} className="relative">
      {n > 1 && (
        <span
          className="absolute left-1/2 top-0 z-[1] grid size-7 -translate-x-1/2 -translate-y-[22px] place-items-center rounded-full bg-surface text-ink-3 shadow-e1 lg:left-0 lg:top-1/2 lg:-translate-x-[24px] lg:-translate-y-1/2"
          aria-hidden
        >
          <ArrowRight className="size-3.5 rotate-90 lg:rotate-0" strokeWidth={2} />
        </span>
      )}
      <div className={cn("h-full rounded-card p-6 sm:p-7", featured ? "taste-ring taste-glow" : "bg-surface/85 shadow-e1 backdrop-blur-sm")}>
        <p className="flex items-center gap-2.5">
          <span className={cn("grid size-6 place-items-center rounded-full text-[12px] font-semibold", featured ? "bg-taste-3 text-white" : "bg-surface-2 text-ink-2")}>{n}</span>
          <span className="text-[13px] font-semibold text-ink-2">{title}</span>
        </p>
        <div className="mt-5">{children}</div>
      </div>
    </Reveal>
  );
}

function SectionHead({ id, title, line }: { id: string; title: string; line: string }) {
  return (
    <Reveal className="max-w-[44rem]">
      <h2 id={id} className="font-display text-[40px]/[44px] tracking-[-.035em] text-ink sm:text-display">{title}</h2>
      <p className="mt-4 text-body-lg text-ink-2">{line}</p>
    </Reveal>
  );
}

/** Fades content up once as it scrolls into view. */
function Reveal({ children, delay = 0, className, as = "div" }: { children: ReactNode; delay?: number; className?: string; as?: "div" | "li" }) {
  const Comp = as === "li" ? motion.li : motion.div;
  return (
    <Comp
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.6, ease: ease.out, delay }}
      className={className}
    >
      {children}
    </Comp>
  );
}
