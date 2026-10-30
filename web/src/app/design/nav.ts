/**
 * Moving between the project's views. The shell routes them at /app/p/:id/{brief,concepts,plan,house,revisions};
 * the pre-overhaul router used /p/:id/{setup,concepts,design,explore,revisions}. Views call `goTo("plan")` and
 * this resolves the right sibling path for whichever router is mounting them.
 */
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export type ViewId = "brief" | "taste" | "concepts" | "plan" | "house" | "revisions";

const LEGACY: Record<ViewId, string> = { brief: "setup", taste: "taste", concepts: "concepts", plan: "design", house: "explore", revisions: "revisions" };
const LEGACY_ONLY = new Set(["setup", "design", "explore"]);

export function viewPath(pathname: string, view: ViewId): string {
  const m = pathname.match(/^(.*?\/p\/[^/]+)(?:\/([^/?#]+))?/);
  const base = m?.[1] ?? pathname.replace(/\/$/, "");
  const seg = m?.[2] ?? "";
  const legacy = LEGACY_ONLY.has(seg) || (!pathname.startsWith("/app/") && !["brief", "taste", "plan", "house"].includes(seg));
  return `${base}/${legacy ? LEGACY[view] : view}`;
}

export function useViewNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useCallback(
    (view: ViewId, opts?: { search?: string; state?: unknown; replace?: boolean }) => {
      const path = viewPath(pathname, view) + (opts?.search ? (opts.search.startsWith("?") ? opts.search : `?${opts.search}`) : "");
      navigate(path, { state: opts?.state, replace: opts?.replace });
    },
    [navigate, pathname],
  );
}
