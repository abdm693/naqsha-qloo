import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { useEscape, useFocusTrap, useMediaQuery } from "@/app/lib/hooks";
import { ease } from "./motion";
import { useModalOpen } from "./overlay";

/**
 * A modal dialog (DESIGN.md §4): 480px, radius 28, e3, over a scrim with an 8px blur.
 * A title, one line, then content, then buttons right-aligned with the primary last.
 * In: scale .96 → 1 over 320ms. Out: 200ms ease-exit. Below 640px it becomes a bottom sheet.
 * Escape and the scrim close it; focus is trapped inside and restored on close.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  label,
  width = 480,
  className,
  dismissible = true,
  showClose = true,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned; put the primary last. */
  actions?: ReactNode;
  /** Accessible name when there is no title. */
  label?: string;
  width?: number;
  className?: string;
  /** False: the scrim and Escape don't close it (e.g. while saving). */
  dismissible?: boolean;
  showClose?: boolean;
  /** Where focus goes when it closes (default: what had focus when it opened). */
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const sheet = useMediaQuery("(max-width: 639px)");
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(panel, open, returnFocus);
  useEscape(open, () => dismissible && onClose());
  useModalOpen(open);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn("fixed inset-0 z-[70] flex justify-center", sheet ? "items-end" : "items-start p-4 pt-[min(12vh,96px)]")}
          initial={{ opacity: 1 }}
          exit={{ opacity: 1, transition: { duration: 0.2 } }}
        >
          <motion.div
            className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[8px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.24, ease: ease.out } }}
            exit={{ opacity: 0, transition: { duration: 0.2, ease: ease.exit } }}
            onClick={() => dismissible && onClose()}
            aria-hidden
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={title ? undefined : label}
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            initial={sheet ? { y: "100%" } : { opacity: 0, scale: 0.96 }}
            animate={sheet ? { y: 0, transition: { duration: 0.32, ease: ease.sheet } } : { opacity: 1, scale: 1, transition: { duration: 0.32, ease: ease.out } }}
            exit={sheet ? { y: "100%", transition: { duration: 0.2, ease: ease.exit } } : { opacity: 0, scale: 0.98, transition: { duration: 0.2, ease: ease.exit } }}
            // Top-anchored, and it scales in from its top edge, so a taller body (a field error, another tab) never moves it.
            style={sheet ? undefined : { width, maxWidth: "100%", transformOrigin: "50% 0" }}
            className={cn(
              "relative flex flex-col overflow-hidden bg-surface shadow-e3 outline-none",
              sheet ? "max-h-[calc(100dvh-32px)] w-full rounded-t-panel pb-[var(--safe-b)]" : "max-h-[calc(100dvh-min(12vh,96px)-16px)] rounded-panel",
              className,
            )}
          >
            {sheet && <div className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-line-strong" aria-hidden />}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6 sm:p-7">
              {(title || description) && (
                <div className={cn("mb-5", showClose && dismissible && "pr-8")}>
                  {title && (
                    <h2 id={titleId} className="font-display text-[28px] leading-[32px] tracking-[-.035em] text-ink">
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p id={descId} className="mt-1.5 text-[15px] leading-[22px] text-ink-2">
                      {description}
                    </p>
                  )}
                </div>
              )}
              {children}
              {actions && <div className="mt-6 flex flex-wrap items-center justify-end gap-2">{actions}</div>}
            </div>
            {showClose && dismissible && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="absolute right-4 top-4 grid size-8 place-items-center rounded-full text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:shadow-focus sm:right-5 sm:top-5"
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
