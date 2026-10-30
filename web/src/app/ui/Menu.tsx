import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { useEscape } from "@/app/lib/hooks";
import { ease } from "./motion";

export type MenuItem =
  | {
      label: ReactNode;
      onSelect: () => void;
      icon?: ReactNode;
      /** A quiet second column: a shortcut or a value. */
      hint?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      /** Shows a check (for a choice such as a role). */
      checked?: boolean;
      /** Stable key (defaults to the label text). */
      key?: string;
    }
  | { separator: true; key?: string }
  | { heading: ReactNode; key?: string };

/**
 * A menu in a portal, so no card or sheet can clip it. Opens below its trigger (above when there's no room),
 * Escape or a click outside closes it and returns focus to the trigger, arrow keys move between items.
 *
 *   <Menu trigger={({ open, toggle }) => <IconButton label="More" onClick={toggle} aria-expanded={open}>…</IconButton>}
 *         items={[{ label: "Rename", onSelect }, { separator: true }, { label: "Delete", danger: true, onSelect }]} />
 */
export function Menu({
  trigger,
  items,
  align = "right",
  width = 208,
  label,
}: {
  trigger: (props: { open: boolean; toggle: () => void; close: () => void }) => ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  width?: number;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const id = useId();

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) {
      const btn = anchor.current?.querySelector<HTMLElement>("button, [tabindex]");
      btn?.focus({ preventScroll: true });
    }
  }, []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  useEscape(open, () => close());

  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    if (!a) return;
    const h = menu.current?.offsetHeight ?? 200;
    const up = a.bottom + 6 + h > window.innerHeight - 8 && a.top - 6 - h > 8;
    let left = align === "right" ? a.right - width : a.left;
    left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
    setPos({ left, top: up ? a.top - 6 - h : a.bottom + 6, up });
  }, [align, width]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const raf = requestAnimationFrame(place); // after the menu has its height
    return () => cancelAnimationFrame(raf);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || anchor.current?.contains(t)) return;
      close(false);
    };
    const onMove = () => place();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    const t = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(t);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close, place]);

  const onKeyDown = (e: KeyboardEvent) => {
    const list = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === "Tab") close(false);
  };

  return (
    <>
      <span ref={anchor} className="inline-flex" aria-controls={open ? id : undefined}>
        {trigger({ open, toggle, close: () => close(false) })}
      </span>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={menu}
                id={id}
                role="menu"
                aria-label={label}
                onKeyDown={onKeyDown}
                initial={{ opacity: 0, scale: 0.97, y: pos?.up ? 4 : -4 }}
                animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.16, ease: ease.out } }}
                exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: ease.exit } }}
                style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width, transformOrigin: `${align === "right" ? "right" : "left"} ${pos?.up ? "bottom" : "top"}` }}
                className="fixed z-[85] rounded-[18px] bg-surface p-1.5 shadow-e3 outline-none"
              >
                {items.map((it, i) => {
                  if ("separator" in it) return <div key={it.key ?? `sep-${i}`} className="mx-2 my-1.5 h-px bg-line" role="separator" />;
                  if ("heading" in it)
                    return (
                      <div key={it.key ?? `h-${i}`} className="px-3 pb-1 pt-2 text-[12px] font-medium text-ink-3">
                        {it.heading}
                      </div>
                    );
                  return (
                    <button
                      key={it.key ?? (typeof it.label === "string" ? it.label : i)}
                      type="button"
                      role="menuitem"
                      disabled={it.disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        close(false);
                        it.onSelect();
                      }}
                      className={cn(
                        "flex min-h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[14px] outline-none transition-colors",
                        "disabled:cursor-not-allowed disabled:opacity-40",
                        it.danger ? "text-fail hover:bg-fail-soft focus-visible:bg-fail-soft" : "text-ink hover:bg-surface-2 focus-visible:bg-surface-2",
                      )}
                    >
                      {it.icon && <span className={cn("flex shrink-0 [&>svg]:size-4", it.danger ? "text-fail" : "text-ink-3")}>{it.icon}</span>}
                      <span className="min-w-0 flex-1 truncate">{it.label}</span>
                      {it.hint && <span className="shrink-0 text-[12px] text-ink-3">{it.hint}</span>}
                      {it.checked !== undefined && (
                        <Check className={cn("size-4 shrink-0 text-accent", !it.checked && "invisible")} strokeWidth={2} />
                      )}
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
