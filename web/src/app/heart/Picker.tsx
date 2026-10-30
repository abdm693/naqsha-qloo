/**
 * "What do you love?": one field. As you type it shows real things with pictures, so you choose the Selena you mean. Anything
 * it doesn't know stays in your own words.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import type { Pick, SuggestedThing } from "@contracts/api-types";
import { api } from "@/api/client";
import { cn } from "@/app/lib/utils";

const PROMPTS = ["A film you'd watch again", "A song that feels like home", "A place you miss", "Your favourite table to eat at", "A book you keep"];

export function Thumb({ src, name, size = 36 }: { src?: string | null; name: string; size?: number }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? (
    <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-dusk-3 font-medium text-lamp-soft" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {(name.trim()[0] || "?").toUpperCase()}
    </span>
  );
}

export function Picker({ value, onChange, single, placeholder, autoFocus }: {
  value: Pick[]; onChange(v: Pick[]): void; single?: boolean; placeholder?: string; autoFocus?: boolean;
}) {
  const uid = useId();
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SuggestedThing[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (placeholder) return;
    const t = setInterval(() => setPrompt((p) => (p + 1) % PROMPTS.length), 3200);
    return () => clearInterval(t);
  }, [placeholder]);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const c = new AbortController();
    const t = setTimeout(() => {
      api.suggest(q, c.signal).then((r) => { setHits(r.results); setActive(0); }).catch(() => {});
    }, 220);
    return () => { clearTimeout(t); c.abort(); };
  }, [text]);

  const q = text.trim();
  const options = useMemo(() => {
    const own = q && !hits.some((h) => h.name.toLowerCase() === q.toLowerCase()) ? [{ name: q } as Pick] : [];
    return [...hits, ...own] as (SuggestedThing | Pick)[];
  }, [hits, q]);

  const add = (x: SuggestedThing | Pick) => {
    const item: Pick = { id: x.id ?? null, name: x.name, kind: x.kind ?? null, image: x.image ?? null };
    onChange(single ? [item] : value.some((v) => v.name === item.name) ? value : [...value, item]);
    setText("");
    setHits([]);
    setOpen(false);
    input.current?.focus();
  };

  const showing = open && q.length >= 2 && options.length > 0;
  return (
    <div>
      <div className="relative">
        <input
          ref={input}
          role="combobox"
          aria-expanded={showing}
          aria-controls={`${uid}-list`}
          aria-activedescendant={showing ? `${uid}-${active}` : undefined}
          aria-label={placeholder ?? "Something you love"}
          autoFocus={autoFocus}
          autoComplete="off"
          value={text}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (!showing) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % options.length); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length); }
            else if (e.key === "Enter") { e.preventDefault(); add(options[active]); }
            else if (e.key === "Escape") setOpen(false);
          }}
          placeholder={placeholder ?? PROMPTS[prompt]}
          className="w-full border-0 border-b-2 border-dusk-line bg-transparent py-3 font-display text-[1.6rem] tracking-[-.02em] text-dusk-ink caret-lamp outline-none transition-colors placeholder:text-dusk-ink-2 focus:border-lamp sm:text-[2rem]"
        />
        {showing && (
          <ul id={`${uid}-list`} role="listbox" className="absolute inset-x-0 top-full z-20 mt-2 max-h-[46vh] overflow-y-auto rounded-2xl bg-dusk-2 py-1.5 shadow-[0_24px_60px_-20px_rgb(4_6_20/.9)]">
            {options.map((o, i) => (
              <li key={`${o.id ?? o.name}-${i}`} id={`${uid}-${i}`} role="option" aria-selected={i === active}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); add(o); }}
                className={cn("flex cursor-pointer items-center gap-3 px-3 py-2", i === active && "bg-dusk-3")}>
                <Thumb src={o.image} name={o.name} />
                <span className="min-w-0 flex-1 truncate text-body text-dusk-ink">{o.id ? o.name : `Use "${o.name}"`}</span>
                {"label" in o && <span className="shrink-0 text-small text-dusk-ink-2">{o.label}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ul aria-label="Your choices" className="mt-5 flex flex-wrap gap-2">
        <AnimatePresence initial={false}>
          {value.map((v) => (
            <motion.li key={v.name} layout initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}
              className="inline-flex items-center gap-2 rounded-full bg-lamp-soft py-1 pl-1 pr-1.5 text-body font-medium text-dusk-1">
              <Thumb src={v.image} name={v.name} size={28} />
              {v.name}
              <button type="button" aria-label={`Remove ${v.name}`} onClick={() => onChange(value.filter((x) => x.name !== v.name))}
                className="grid size-6 place-items-center rounded-full transition hover:bg-dusk-1/10">
                <X className="size-3.5" />
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
