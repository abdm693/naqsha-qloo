/**
 * The landing page (/): the street at dusk. One sentence, one house whose lights come on, and four real families.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight } from "lucide-react";
import type { Project } from "@contracts/api-types";
import { api, assetUrl } from "@/api/client";
import { openSampleHome } from "@/app/lib/samples";
import { useAuth } from "@/app/store/auth";
import { Wordmark } from "@/app/ui/brand";
import { HouseScene } from "@/app/heart/HouseScene";
import { Dusk, LampButton } from "@/app/heart/kit";

/** The sample families as the hero plays them; the words are the real overlap of their tastes. */
const STORIES = [
  { city: "lahore", place: "Lahore", family: "The Maliks", people: ["Ammi", "Abbu", "Sara", "Ali"], words: "Contemporary and traditional" },
  { city: "austin", place: "Austin", family: "The Garcias", people: ["Elena", "Marco", "Sofia", "Mateo"], words: "Nature inspired and fun" },
  { city: "dubai", place: "Dubai", family: "The Al Mansouris", people: ["Baba", "Mama", "Noura", "Saeed"], words: "Elegant and inspiring" },
  { city: "toronto", place: "Toronto", family: "The Parks", people: ["Umma", "Appa", "Jiwoo"], words: "Heartwarming" },
];

function wordsOf(p: Project | undefined, fallback: string): string {
  const w = p?.heart?.words;
  if (!w?.length) return fallback;
  const cap = w.map((x, i) => (i ? x.toLowerCase() : x[0].toUpperCase() + x.slice(1)));
  return cap.length > 1 ? `${cap.slice(0, -1).join(", ")} and ${cap[cap.length - 1]}` : cap[0];
}

function chosenImage(p: Project | undefined): string | null {
  const c = p?.concepts.find((x) => x.id === p.selected_concept_id) ?? p?.concepts.find((x) => x.url);
  return c?.url ?? null;
}

export function Landing() {
  const navigate = useNavigate();
  const still = useReducedMotion();
  const openAuth = useAuth((a) => a.openAuth);
  const user = useAuth((a) => a.user);
  const [samples, setSamples] = useState<Project[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [story, setStory] = useState(0);
  const [step, setStep] = useState(0);

  useEffect(() => {
    api.listSamples().then(setSamples).catch(() => {});
  }, []);

  // One family at a time: their lights come on, the heart lights last, their words appear. Then the next house.
  useEffect(() => {
    if (still) return;
    const heartAt = STORIES[story].people.length + 1;
    const t = setTimeout(() => {
      if (step <= heartAt) setStep(step + 1);
      else { setStory((story + 1) % STORIES.length); setStep(0); }
    }, step === heartAt ? 4200 : step > heartAt ? 500 : 900);
    return () => clearTimeout(t);
  }, [step, story, still]);

  const s = STORIES[story];
  const families = useMemo(() => STORIES.map((x) => ({ ...x, sample: samples.find((p) => (p.brief?.city ?? "").toLowerCase() === x.city) })), [samples]);
  const open = async (id?: string) => {
    setOpening(id ?? "any");
    if (!(await openSampleHome(navigate, id))) setOpening(null);
  };
  const heartAt = s.people.length + 1;
  const showing = still || step === heartAt;

  return (
    <Dusk>
      <header className="absolute inset-x-0 top-0 z-30">
        <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between px-5 py-4 sm:px-8">
          <Link to="/" aria-label="Naqsha home"><Wordmark tone="white" /></Link>
          {user
            ? <Link to="/app" className="text-[15px] text-dusk-ink hover:text-lamp-soft">Your homes</Link>
            : <button type="button" onClick={() => void openAuth({ mode: "signin" })} className="text-[15px] text-dusk-ink hover:text-lamp-soft">Sign in</button>}
        </div>
      </header>

      <section aria-labelledby="hero" className="relative flex min-h-[100dvh] flex-col overflow-hidden">
        <div className="relative z-20 mx-auto w-full max-w-[1200px] px-5 pt-[13dvh] sm:px-8">
          <h1 id="hero" className="max-w-[12ch] font-display text-[clamp(3.2rem,9.2vw,6rem)] leading-[.96] tracking-[-.035em] text-dusk-ink">Home is where the heart is.</h1>
          <p className="mt-5 max-w-[30rem] text-[1.125rem] leading-7 text-dusk-ink-2">Everyone in your family answers alone. What you share becomes the heart of your house.</p>
          <div className="mt-7 flex flex-wrap items-center gap-5">
            <LampButton onClick={() => navigate("/app")}>Start your home</LampButton>
            <button type="button" onClick={() => void open()} className="text-[1.0625rem] text-dusk-ink underline decoration-dusk-line underline-offset-[6px] transition hover:decoration-lamp">See a family's home</button>
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[58dvh]">
          <HouseScene key={story} windows={s.people.map((name, i) => ({ id: String(i), name, lit: !!still || step > i }))} heart={!!still || step >= heartAt}
            className="size-full" title="A house at dusk, its lights coming on" />
        </div>
        <div className="absolute inset-x-0 bottom-3 z-20 mx-auto flex w-full max-w-[1200px] items-baseline justify-between gap-4 px-5 sm:bottom-5 sm:px-8">
          <motion.p initial={false} animate={{ opacity: showing ? 1 : 0 }} transition={{ duration: 0.8 }} className="font-display text-[1.5rem] tracking-[-.02em] text-lamp-soft sm:text-[2rem]">{s.words}</motion.p>
          <motion.p initial={false} animate={{ opacity: showing ? 1 : 0 }} transition={{ duration: 0.8 }} className="text-right text-small text-dusk-ink-2 sm:text-body">{s.family}, {s.place}</motion.p>
        </div>
      </section>

      <section className="bg-dusk-1 px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto grid w-full max-w-[1200px] gap-14 sm:grid-cols-3 sm:gap-10">
          {[
            ["Everyone answers alone.", "A link for each person. The film they rewatch, the song that's home, the place they miss."],
            ["You see what you share.", "Windows light one by one. The heart lights last, and tells you what your family has in common."],
            ["The house grows around it.", "What you share becomes the centre. What's yours alone becomes your room."],
          ].map(([t, l]) => (
            <div key={t}>
              <h2 className="font-display text-[1.9rem] leading-[1.08] tracking-[-.025em] text-dusk-ink">{t}</h2>
              <p className="mt-3 text-[1.0625rem] leading-7 text-dusk-ink-2">{l}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="street" className="bg-dusk-1 px-5 pb-24 sm:px-8 sm:pb-32">
        <div className="mx-auto w-full max-w-[1200px]">
          <h2 id="street" className="font-display text-[2.4rem] leading-[1.05] tracking-[-.03em] text-dusk-ink sm:text-[3.4rem]">Four families, four homes.</h2>
          <ul className="mt-10 grid gap-x-6 gap-y-10 sm:grid-cols-2">
            {families.map((f) => {
              const img = chosenImage(f.sample);
              return (
                <li key={f.city}>
                  <button type="button" disabled={!f.sample || !!opening} onClick={() => f.sample && void open(f.sample.id)} className="group block w-full text-left outline-none">
                    <span className="block aspect-[3/2] overflow-hidden rounded-2xl bg-dusk-2 ring-lamp/60 group-focus-visible:ring-4">
                      {img && <img src={assetUrl(img, { w: 960 })} alt={`${f.family}' home in ${f.place}`} loading="lazy" className="size-full object-cover transition duration-700 group-hover:scale-[1.03]" />}
                    </span>
                    <span className="mt-4 flex items-baseline justify-between gap-4">
                      <span className="font-display text-[1.6rem] tracking-[-.02em] text-lamp-soft">{wordsOf(f.sample, f.words)}</span>
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-body text-dusk-ink-2 group-hover:text-dusk-ink">
                        {opening === f.sample?.id ? "Opening" : `${f.family}, ${f.place}`} <ArrowRight className="size-4" />
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="relative h-[72dvh] overflow-hidden">
        <div className="relative z-20 mx-auto w-full max-w-[1200px] px-5 pt-16 sm:px-8">
          <h2 className="max-w-[14ch] font-display text-[clamp(2.6rem,7vw,4.5rem)] leading-[1] tracking-[-.03em] text-dusk-ink">Whose light goes on first?</h2>
          <div className="mt-6"><LampButton onClick={() => navigate("/app")}>Start your home</LampButton></div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[44dvh]"><HouseScene windows={[{ id: "a", name: "", lit: true }]} className="size-full" title="A house at dusk with one light on" /></div>
      </section>

      <footer className="bg-dusk-1">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-3 px-5 py-6 text-small text-dusk-ink-2 sm:px-8">
          <span>© 2026 Naqsha. Concept designs and rule pre-checks; a registered architect signs the final plans.</span>
          <a href="https://github.com/abdm693/naqsha-qloo" className="underline underline-offset-4 hover:text-dusk-ink">Open source</a>
        </div>
      </footer>
    </Dusk>
  );
}
