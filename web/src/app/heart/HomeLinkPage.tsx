/** The private link: one person, on their phone, turning their light on. Nobody else sees what they say. */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { motion } from "motion/react";
import type { HomeLink, Pick } from "@contracts/api-types";
import { api, errorMessage } from "@/api/client";
import { HouseScene } from "./HouseScene";
import { Picker } from "./Picker";
import { Dusk, LampButton } from "./kit";

const MIN = 3;

export function HomeLinkPage() {
  const { token = "" } = useParams();
  const [link, setLink] = useState<HomeLink | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [heartPlace, setHeartPlace] = useState<Pick[]>([]);
  const [step, setStep] = useState<"love" | "heart" | "done">("love");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.openLink(token).then((l) => {
      setLink(l);
      const saved = l.you.favourites;
      setPicks(saved.filter((f) => !f.heart));
      setHeartPlace(saved.filter((f) => f.heart));
      if (saved.length) setStep("done");
    }).catch((e) => setFailed(errorMessage(e)));
  }, [token]);

  useEffect(() => {
    if (step !== "done") return;
    const t = setInterval(() => void api.openLink(token).then(setLink).catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [step, token]);

  const windows = useMemo(() => (link?.family ?? []).map((p, i) => ({ id: String(i), name: p.name, lit: p.answered || (p.you && step === "done") })), [link, step]);

  async function finish() {
    setSaving(true);
    try {
      setLink(await api.answerLink(token, [...picks, ...heartPlace.map((h) => ({ ...h, heart: true }))]));
      setStep("done");
    } catch (e) {
      setFailed(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (failed) {
    return <Dusk><p className="mx-auto max-w-md px-6 pt-32 text-center text-body-lg text-dusk-ink">{failed}</p></Dusk>;
  }
  if (!link) return <Dusk />;
  const first = link.you.name.split(/[\s&]/)[0];
  const waiting = link.family.filter((p) => !p.answered && !p.you);

  return (
    <Dusk>
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[640px] flex-col px-5 pt-10 sm:pt-16">
        {step === "love" && (
          <motion.section key="love" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="relative z-10">
            <h1 className="font-display text-[2.6rem] leading-[1.02] tracking-[-.03em] text-dusk-ink sm:text-[3.4rem]">{first}, what do you love?</h1>
            <p className="mt-3 text-body-lg text-dusk-ink-2">Only Naqsha sees this. Your family won't.</p>
            <div className="mt-8"><Picker value={picks} onChange={setPicks} autoFocus /></div>
            <div className="mt-8">
              <LampButton disabled={picks.length < MIN} onClick={() => setStep("heart")}>
                {picks.length < MIN ? `${MIN - picks.length} more` : "That's me"}
              </LampButton>
            </div>
          </motion.section>
        )}
        {step === "heart" && (
          <motion.section key="heart" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="relative z-10">
            <h1 className="font-display text-[2.6rem] leading-[1.02] tracking-[-.03em] text-dusk-ink sm:text-[3.4rem]">Where does your heart live?</h1>
            <div className="mt-8"><Picker value={heartPlace} onChange={setHeartPlace} single placeholder="A city, a street, a village" autoFocus /></div>
            <div className="mt-8 flex flex-wrap items-center gap-5">
              <LampButton loading={saving} onClick={() => void finish()}>Turn my light on</LampButton>
              {!heartPlace.length && <button type="button" onClick={() => void finish()} className="text-body text-dusk-ink-2 underline underline-offset-4 hover:text-dusk-ink">Skip</button>}
            </div>
          </motion.section>
        )}
        {step === "done" && (
          <motion.section key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="relative z-10 text-center">
            <h1 className="font-display text-[2.6rem] leading-[1.02] tracking-[-.03em] text-dusk-ink sm:text-[3.4rem]">Your light's on.</h1>
            <p className="mt-3 text-body-lg text-dusk-ink-2">
              {link.heart ? "Your family has seen what you share." : waiting.length ? `Waiting for ${waiting.map((p) => p.name).join(", ")}.` : "Everyone's home."}
            </p>
            <button type="button" onClick={() => setStep("love")} className="mt-4 text-small text-dusk-ink-2 underline underline-offset-4 hover:text-dusk-ink">Change my answers</button>
          </motion.section>
        )}
      </div>
      {/* The house stays at the foot of the screen; the person's own window answers as soon as they finish. */}
      <div aria-hidden={step !== "done"} className="pointer-events-none fixed inset-x-0 bottom-0 h-[38dvh]">
        <HouseScene windows={windows} className="size-full" title={`The house, ${windows.filter((w) => w.lit).length} of ${windows.length} lights on`} />
      </div>
    </Dusk>
  );
}
