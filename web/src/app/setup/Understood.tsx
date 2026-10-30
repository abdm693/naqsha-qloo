/**
 * "Here's what I understood" (DESIGN.md "Brief"): fact tokens (what you said in ink; what Naqsha assumed in ink-3
 * with a dotted underline, tap to edit, × to remove), then two columns, Guaranteed (LDA and the livable rules)
 * and Preferences (your wishes, editable). Tokens rise in with a 40ms stagger.
 */
import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, Plus, X } from "lucide-react";
import type { Brief, ChatMessage, Envelope } from "@contracts/api-types";
import { FACING_LABEL, plotLabel } from "@/api/domain";
import { cn, feetInches, num } from "@/app/lib/utils";
import { solarLabel, tankLabel } from "@/app/lib/roof";
import { sentenceCase, untitle } from "@/app/plan/model";

/**
 * The guarantees for the brief as it stands now: the authority's limits from the current envelope (so a plot edit
 * never leaves stale figures on the card), then the rules that carry no numbers.
 */
export function currentGuarantees(server: string[], envelope: Envelope | null, brief: Brief | null): string[] {
  if (!envelope) return server;
  const a = brief?.authority ?? envelope.authority ?? "LDA";
  const sb = envelope.setbacks_ft;
  const out = [
    `${a}: keep ${feetInches(sb.front)} open at the front and ${feetInches(sb.rear)} at the back${sb.left || sb.right ? `, ${feetInches(Math.max(sb.left, sb.right))} on one side` : ""}`,
    `Up to ${num(envelope.max_coverage_pct)}% ground coverage (${num(Math.min(envelope.buildable_rect.w * envelope.buildable_rect.d, envelope.max_ground_coverage_sqft))} sq ft a floor)`,
    `${envelope.max_storeys} storeys at most, ${feetInches(envelope.max_height_ft)} to the parapet`,
  ];
  if (brief?.plot?.corner) out.push(`A ${(brief.plot.area_marla ?? 10) <= 10.15 ? 5 : 10} ft splay at the corner`);
  // Keep the server's rules that carry no figures (livable rules); its numbered lines may be from an older plot.
  for (const g of server) if (!/\d/.test(g) && !out.includes(g)) out.push(g);
  return out;
}

export interface Fact { key: string; text: string }

/** What the brief records that the person said themselves (not in auto_filled). */
export function saidFacts(b: Brief | null): Fact[] {
  if (!b) return [];
  const auto = new Set(b.auto_filled ?? []);
  const out: Fact[] = [];
  if (b.plot?.width_ft && !auto.has("plot")) out.push({ key: "plot", text: `${plotLabel(b.plot.area_marla)} · ${b.plot.width_ft}′ × ${b.plot.depth_ft}′` });
  // Corner or mid-row is the family's once they say it, even on a plot size Naqsha assumed.
  if (b.plot?.width_ft && !auto.has("corner")) out.push({ key: "corner", text: b.plot.corner ? "Corner plot" : "Mid-row" });
  if (b.scheme && !auto.has("scheme")) out.push({ key: "scheme", text: b.scheme });
  if (b.facing && !auto.has("facing")) out.push({ key: "facing", text: `Faces ${FACING_LABEL[b.facing]?.toLowerCase() ?? b.facing}` });
  if (b.storeys && !auto.has("storeys")) out.push({ key: "storeys", text: `${b.storeys} ${b.storeys === 1 ? "storey" : "storeys"}` });
  if (b.bedrooms && !auto.has("bedrooms")) out.push({ key: "bedrooms", text: `${b.bedrooms} bedrooms` });
  if (b.bathrooms && !auto.has("bathrooms")) out.push({ key: "bathrooms", text: `${b.bathrooms} ${b.bathrooms === 1 ? "bath" : "baths"}` });
  const porch = b.spaces?.find((s) => s.startsWith("car_porch"));
  if (porch && !auto.has("porch")) out.push({ key: "porch", text: `${porch.split(":")[1] ?? 1}-car porch` });
  if (b.style && !auto.has("style")) out.push({ key: "style", text: sentenceCase(b.style) });
  if (b.budget && !auto.has("budget")) out.push({ key: "budget", text: `${b.budget.charAt(0).toUpperCase()}${b.budget.slice(1)} finishes` });
  if (b.water_tank && !auto.has("water_tank")) out.push({ key: "tank", text: tankLabel(b.water_tank) ?? "Water tank" });
  if (b.solar && !auto.has("solar")) out.push({ key: "solar", text: solarLabel(b.solar) ?? "Solar" });
  return out;
}

/** Space names in the server's "spaces" fact line (intake.py SPACE_LABEL). */
const SPACE_WORDS = new Set(["drawing room", "tv lounge", "dining", "kitchen", "dirty kitchen", "servant quarter", "lawn", "prayer room", "store", "laundry", "roof terrace", "study", "gym"]);

/**
 * The brief field an "I assumed" line stands for, read from the lines the server writes (intake.py _fact_items and
 * understood()), or null for the agent's own free-text assumptions.
 */
export function assumptionField(line: string, b: Brief | null): string | null {
  const t = line.trim();
  if (/^[\d.,]+\s+(marla|kanal|sq ft|sq m),\s*[\d.]+\s*×\s*[\d.]+\s*ft\b/i.test(t)) return "plot";
  if (t === "Corner plot" || /^Mid-row plot\b/.test(t) || /^Inside lot\b/.test(t)) return "corner";
  if (/^Front faces /.test(t)) return "facing";
  if (/^(Single storey|Two storeys|Three storeys|\d+ storeys|Kept to \d+ storeys?:)/.test(t)) return "storeys";
  if (/^\d+ bedrooms$/.test(t)) return "bedrooms";
  if (/^\d+ baths$/.test(t)) return "bathrooms";
  if (t === "I'll place the rooms on each floor") return "floors";
  if (/^\d+-car (porch|garage|carport|laneway garage|driveway)$/.test(t)) return "porch";
  if (t === "Concrete water tank in the stair tower" || t === "Blue plastic water tank" || t === "Concrete tank in the stair tower" || t === "Blue plastic tank") return "water_tank";
  if (t === "Roof kept clear for solar" || t === "Solar frame on the roof" || t === "Raised solar frame" || t === "No solar for now" || t === "No solar") return "solar";
  if (/^(Economy|Standard|Premium|Luxury) budget$/.test(t)) return "budget";
  if (b?.style && t.toLowerCase() === `${b.style} style`.toLowerCase()) return "style";
  const parts = t.toLowerCase().split(", ");
  if (parts.length && SPACE_WORDS.has(parts[0]) && parts.every((x) => SPACE_WORDS.has(x) || /^\d+-car /.test(x))) return "spaces";
  return null;
}

/**
 * The latest card's assumptions as the brief stands now: a server fact stays under "I assumed" only while its field is
 * still in auto_filled (once the family states it, it reads under "You said" alone). Free-text assumptions stay.
 */
export function currentAssumptions(snapshot: string[], b: Brief | null): string[] {
  if (!b) return snapshot;
  const auto = new Set(b.auto_filled ?? []);
  const said = new Set(saidFacts(b).map((f) => (f.key === "tank" ? "water_tank" : f.key)));
  return snapshot.filter((a) => {
    const field = assumptionField(a, b);
    return !field || (auto.has(field) && !said.has(field));
  });
}

const rise = (i: number) => ({ initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.24, delay: i * 0.04, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } });

export function UnderstoodCard({
  m,
  brief,
  envelope,
  interactive,
  onCorrect,
  onRemoveAssumption,
  onPreferences,
}: {
  m: ChatMessage;
  brief: Brief | null;
  envelope?: Envelope | null;
  /** Only the latest card can be edited. */
  interactive: boolean;
  /** Send a correction to Naqsha ("It's 2 storeys, not 3"). */
  onCorrect: (before: string, after: string) => void;
  onRemoveAssumption: (text: string) => void;
  /** Replace the brief's preferences (saved directly). */
  onPreferences: (prefs: string[]) => void;
}) {
  const u = m.understood!;
  const said = interactive ? saidFacts(brief) : [];
  // The latest card follows the brief as it stands; folded earlier cards keep their snapshot.
  const assumptions = interactive ? currentAssumptions(u.assumptions, brief) : u.assumptions;
  const prefs = interactive && brief?.preferences ? brief.preferences : u.preferences;
  const guaranteed = interactive ? currentGuarantees(u.guaranteed, envelope ?? null, brief) : u.guaranteed;
  const [expanded, setExpanded] = useState(false);
  let i = 0;
  // Earlier cards fold to one line (the latest card is the brief as it stands).
  if (!interactive && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-ink-2 outline-none hover:text-ink focus-visible:shadow-focus"
        aria-expanded={false}
      >
        <Check className="size-3.5 text-pass" strokeWidth={2.5} />
        What I understood then · {u.guaranteed.length + u.assumptions.length + u.preferences.length} points
      </button>
    );
  }
  return (
    <div className="@container mt-3 overflow-hidden rounded-card bg-surface shadow-e1">
      {(said.length > 0 || assumptions.length > 0) && (
        <div className="space-y-2.5 px-4 pb-3 pt-3.5">
          {said.length > 0 && (
            <div>
              <p className="mb-1.5 text-caption text-ink-3">You said</p>
              <div className="flex flex-wrap gap-1.5">
                {said.map((f) => (
                  <motion.span key={f.key} {...rise(i++)}>
                    <Token text={untitle(f.text)} kind="said" interactive={interactive} onEdit={(t) => onCorrect(f.text, t)} />
                  </motion.span>
                ))}
              </div>
            </div>
          )}
          {assumptions.length > 0 && (
            <div>
              <p className="mb-1.5 text-caption text-ink-3">I assumed</p>
              <div className="flex flex-wrap gap-1.5">
                {assumptions.map((a) => (
                  <motion.span key={a} {...rise(i++)}>
                    <Token text={untitle(a)} kind="assumed" interactive={interactive} onEdit={(t) => onCorrect(a, t)} onRemove={() => onRemoveAssumption(a)} />
                  </motion.span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {/* Two columns only when the card itself is wide enough (it lives in a 420px sheet). */}
      <div className="grid border-t border-line @min-[480px]:grid-cols-2">
        <div className="px-4 py-3 @min-[480px]:border-r @min-[480px]:border-line">
          <p className="mb-1.5 text-caption text-ink-3">Guaranteed</p>
          <ul className="space-y-1">
            {guaranteed.map((g) => (
              <motion.li key={g} {...rise(i++)} className="flex gap-2 text-[13.5px] leading-snug text-ink">
                <Check className="mt-0.5 size-3.5 shrink-0 text-pass" strokeWidth={2.5} />
                {untitle(g)}
              </motion.li>
            ))}
          </ul>
        </div>
        <div className="border-t border-line px-4 py-3 @min-[480px]:border-t-0">
          <p className="mb-1.5 text-caption text-ink-3">Preferences</p>
          <Preferences prefs={prefs} interactive={interactive} onChange={onPreferences} start={i} />
        </div>
      </div>
    </div>
  );
}

function Preferences({ prefs, interactive, onChange, start }: { prefs: string[]; interactive: boolean; onChange: (p: string[]) => void; start: number }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const commit = () => {
    const t = text.trim();
    if (t) onChange([...prefs, t]);
    setText("");
    setAdding(false);
  };
  return (
    <div>
      {!prefs.length && !adding && <p className="text-[13.5px] text-ink-3">Nothing special yet.</p>}
      <ul className="space-y-1">
        {prefs.map((p, k) => (
          <motion.li key={p} {...rise(start + k)} className="group flex items-start gap-2 text-[13.5px] leading-snug text-ink">
            <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-3" />
            <span className="min-w-0 flex-1">{untitle(p.charAt(0).toUpperCase() + p.slice(1))}</span>
            {interactive && (
              <button
                type="button"
                aria-label={`Remove ${p}`}
                onClick={() => onChange(prefs.filter((x) => x !== p))}
                className="-mr-1 grid size-5 shrink-0 place-items-center rounded-full text-ink-4 opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
              >
                <X className="size-3" strokeWidth={2} />
              </button>
            )}
          </motion.li>
        ))}
      </ul>
      {interactive &&
        (adding ? (
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setText(""); setAdding(false); }
              e.stopPropagation();
            }}
            placeholder="A wish, in your words"
            className="mt-1.5 h-8 w-full rounded-chip bg-surface-2 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-4 focus:shadow-focus"
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-medium text-ink-2 hover:text-ink">
            <Plus className="size-3.5" strokeWidth={2} /> Add a wish
          </button>
        ))}
    </div>
  );
}

function Token({ text, kind, interactive, onEdit, onRemove }: { text: string; kind: "said" | "assumed"; interactive: boolean; onEdit: (t: string) => void; onRemove?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const ref = useRef<HTMLInputElement>(null);
  if (editing) {
    const commit = () => {
      setEditing(false);
      const v = value.trim();
      if (v && v !== text) onEdit(v);
      else setValue(text);
    };
    return (
      <input
        ref={ref}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setValue(text); setEditing(false); }
          e.stopPropagation();
        }}
        style={{ width: `${Math.max(8, value.length + 2)}ch` }}
        className="h-8 rounded-chip bg-surface px-2.5 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--color-accent)] outline-none"
        aria-label={`Correct “${text}”`}
      />
    );
  }
  return (
    <span className={cn("inline-flex h-8 items-center rounded-chip bg-surface-2 text-[13px]", kind === "said" ? "text-ink" : "text-ink-3")}>
      <button
        type="button"
        disabled={!interactive}
        onClick={() => setEditing(true)}
        title={interactive ? "Tap to correct" : undefined}
        aria-label={interactive ? `Correct ${text}` : undefined}
        className={cn("h-full rounded-chip px-2.5 outline-none focus-visible:shadow-focus", interactive && "hover:text-ink", kind === "assumed" && "underline decoration-dotted decoration-ink-4 underline-offset-[5px]", onRemove && interactive && "pr-1")}
      >
        {text}
      </button>
      {onRemove && interactive && (
        <button type="button" onClick={onRemove} aria-label={`Don't assume ${text}`} className="mr-1 grid size-6 place-items-center rounded-full text-ink-4 outline-none hover:bg-surface-3 hover:text-ink focus-visible:shadow-focus">
          <X className="size-3" strokeWidth={2} />
        </button>
      )}
    </span>
  );
}
