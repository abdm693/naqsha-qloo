/**
 * Routes (track: APP-SHELL).
 *   /                      landing
 *   /app                   your homes (workspace)
 *   /app/signin, /signup   accounts
 *   /app/p/:id/:view       a home: brief · concepts · plan · house · revisions
 *   /s/:token              the client view of a shared home
 * Old links (/p/:id/setup|design|explore…) redirect to their new places.
 */
import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { MotionConfig } from "motion/react";
import { LEGACY_VIEW } from "./lib/views";
import { Landing } from "./landing/Landing";
import { Workspace } from "./workspace/Workspace";
import { AuthPage } from "./auth/AuthPage";
import { AuthDialog } from "./auth/AuthDialog";
import { ProjectShell } from "./shell/ProjectShell";
import { ClientView } from "./share/ClientView";
import { HomeLinkPage } from "@/app/heart/HomeLinkPage";
import { Toaster } from "./ui/Toast";
import { buttonClass } from "./ui/Button";
import { ErrorBoundary } from "./ui/ErrorBoundary";

/** A new page starts at the top (views inside a home keep their own scroll). */
function ScrollToTop() {
  const { pathname } = useLocation();
  const key = pathname.split("/").slice(0, 4).join("/");
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);
  return null;
}

/** A crash anywhere shows a calm message instead of a blank page; moving to another page tries again. */
function RouteBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname} label="This page didn't load" className="min-h-[100dvh]">
      {children}
    </ErrorBoundary>
  );
}

function LegacyProject() {
  const { id = "", "*": rest = "" } = useParams();
  const old = rest.split("/")[0];
  const view = LEGACY_VIEW[old];
  const { search } = useLocation();
  return <Navigate to={`/app/p/${id}${view ? `/${view}` : ""}${search}`} replace />;
}

function NotFound() {
  useEffect(() => {
    document.title = "Not found · Naqsha";
  }, []);
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-canvas p-6 text-center">
      <div>
        <p className="text-display text-ink">Off the plan.</p>
        <p className="mt-2 text-[15px] text-ink-2">This page doesn't exist.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link to="/" className={buttonClass("secondary")}>Home</Link>
          <Link to="/app" className={buttonClass("ink")}>Portal</Link>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <ScrollToTop />
        <RouteBoundary>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/app" element={<Workspace />} />
            <Route path="/app/signin" element={<AuthPage mode="signin" />} />
            <Route path="/app/signup" element={<AuthPage mode="signup" />} />
            {/* Nested so relative links between views ("../plan") resolve inside the home. */}
            <Route path="/app/p/:id" element={<ProjectShell />}>
              <Route index element={null} />
              <Route path=":view" element={null} />
            </Route>
            <Route path="/s/:token" element={<ClientView />} />
            <Route path="/h/:token" element={<HomeLinkPage />} />
            <Route path="/signin" element={<Navigate to="/app/signin" replace />} />
            <Route path="/signup" element={<Navigate to="/app/signup" replace />} />
            <Route path="/p/:id/*" element={<LegacyProject />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </RouteBoundary>
        <AuthDialog />
      </BrowserRouter>
      <Toaster />
    </MotionConfig>
  );
}
