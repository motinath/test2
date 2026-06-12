import { createFileRoute, Outlet, useNavigate, Link, useRouterState } from "@tanstack/react-router";
import { SidebarProvider, SidebarTrigger, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app/app-sidebar";

import { useAuth } from "@/lib/auth/auth-context";
import { DesignProvider } from "@/lib/design-context";
import { ProjectProvider, useProject } from "@/lib/project-context";
import { useEffect } from "react";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppHeader({ getPageTitle }: { getPageTitle: () => string }) {
  const { user } = useAuth();
  const { activeProject } = useProject();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200/50 bg-white/70 px-4 backdrop-blur-md shadow-[0_1px_2px_0_rgba(0,0,0,0.01)] select-none">
      {/* Left Group */}
      <div className="flex items-center gap-3">
        <SidebarTrigger className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer shadow-sm active:scale-95 flex items-center justify-center" />
        <span className="h-4 w-px bg-slate-200" />
        <h1 className="text-sm font-black text-slate-900 tracking-tight font-display">
          {getPageTitle()}
        </h1>
      </div>

      {/* Middle Group - Active Project Pill */}
      <div className="hidden sm:flex items-center justify-center">
        <div className="flex items-center gap-2 px-3 py-1 rounded-full border border-accent/20 bg-accent/5 text-[11px] font-bold text-accent">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          <span>Project: {activeProject?.name ?? "Untitled Project"}</span>
        </div>
      </div>

      {/* Right Group - User Profile Profile Badge */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-2.5 py-1 rounded-full border border-slate-200 bg-white shadow-sm select-none">
          <div className="w-6 h-6 rounded-full bg-accent text-white font-bold text-[10px] flex items-center justify-center">
            {user?.initials ?? "US"}
          </div>
          <span className="text-xs font-bold text-slate-700 pr-1">
            {user?.name ?? "User"}
          </span>
        </div>
      </div>
    </header>
  );
}

function AppLayout() {
  const navigate = useNavigate();
  const { user, hydrated } = useAuth();
  const pathname = useRouterState({ select: (r) => r.location.pathname });

  useEffect(() => {
    if (hydrated && !user) navigate({ to: "/sign-in", replace: true });
  }, [hydrated, user, navigate]);

  if (!hydrated || !user) return null;

  // Resolve clean dynamic page title
  const TITLES: Record<string, string> = {
    "/dashboard": "Workspace",
    "/projects": "Projects",
    "/designer": "Design Copilot",
    "/architecture-explorer": "Architecture Explorer",
    "/schematic-editor": "Schematic Editor",
    "/layout-viewer": "Layout Viewer",
    "/component-library": "Component Library",
    "/simulations": "Simulations",
    "/physics-analysis": "Physics Analysis",
    "/verification": "Verification",
    "/results": "Results",
    "/version-control": "Version Control",
    "/reports": "Reports",
    "/team": "Users & Teams",
    "/integrations": "Integrations",
    "/billing": "Billing & Usage",
    "/settings": "Settings",
    "/profile": "User Profile",
    "/about": "About Platform",
    "/admin": "Admin Console",
  };
  const getPageTitle = () => TITLES[pathname] || "Workspace";

  return (
    <DesignProvider>
      <ProjectProvider>
      <SidebarProvider>
        <div className="flex min-h-screen w-full bg-background text-slate-800 font-sans app-workspace">
          <AppSidebar />
          <SidebarInset className="flex flex-1 flex-col overflow-hidden">
            <AppHeader getPageTitle={getPageTitle} />

            <main className="flex-1 overflow-hidden relative">
              <Outlet />
            </main>
          </SidebarInset>

        </div>
      </SidebarProvider>
      </ProjectProvider>
    </DesignProvider>
  );
}