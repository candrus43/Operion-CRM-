import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { getSession, logout, type SessionUser } from "~/lib/auth";

export const Route = createFileRoute("/app")({
  loader: async () => {
    // Route guard: /app requires an authenticated session.
    const session = await getSession();
    if (!session) throw redirect({ to: "/" });
    return session;
  },
  component: AppShell,
});

const NAV = [
  { to: "/app", label: "Pipeline", icon: "pipeline" },
  { to: "/app/contacts", label: "Contacts", icon: "contacts" },
  { to: "/app/resources", label: "Resources", icon: "resources" },
  { to: "/app/commissions", label: "Commissions", icon: "commissions" },
  // Owner-only admin — hidden for agents.
  { to: "/app/agents", label: "Agents", icon: "agents", ownerOnly: true },
] as const;

function NavIcon({ icon }: { icon: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (icon) {
    case "pipeline":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "contacts":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "resources":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      );
    case "commissions":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M12 2v20" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      );
    case "agents":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M19 8v6" />
          <path d="M22 11h-6" />
        </svg>
      );
    default:
      return null;
  }
}

function UserChip({ user }: { user: SessionUser }) {
  const [signingOut, setSigningOut] = useState(false);
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
    } finally {
      window.location.assign("/");
    }
  }

  return (
    <div className="border-t border-white/[0.06] p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/70 to-blue-500/40 text-[11px] font-semibold text-white ring-1 ring-white/15">
          {initials || "?"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-fg">{user.name}</p>
          <p className="truncate text-[11px] capitalize text-muted">{user.role}</p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          title="Sign out"
          aria-label="Sign out"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-all duration-300 hover:bg-white/[0.06] hover:text-fg"
        >
          <svg
            width={15}
            height={15}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="M16 17l5-5-5-5" />
            <path d="M21 12H9" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function SidebarContent({
  user,
  onNavigate,
}: {
  user: SessionUser;
  /** Called when a navigation link is pressed (the mobile drawer closes itself). */
  onNavigate?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Brand */}
      <Link
        to="/app"
        onClick={onNavigate}
        className="flex items-center gap-2.5 px-5 pt-6 pb-5"
      >
        <img
          src="/logo.png"
          alt="Operion"
          className="h-7 w-7 object-contain transition-transform duration-700 group-hover:scale-110"
        />
        <span className="text-[15px] font-medium tracking-[-0.02em] text-fg">
          Operion <span className="text-muted">CRM</span>
        </span>
      </Link>

      {/* Nav area scrolls when the drawer is shorter than its content — the
          user chip / Sign out stays pinned at the bottom and always reachable. */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <p className="px-3 pb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-white/25">
          Workspace
        </p>
        <nav className="flex flex-col gap-1">
          {NAV.filter((item) => !("ownerOnly" in item) || item.ownerOnly !== true || user.role === "owner").map(
            (item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                activeOptions={item.to === "/app" ? { exact: true } : undefined}
                activeProps={{ className: "nav-link nav-link-active" }}
                inactiveProps={{ className: "nav-link" }}
              >
                <span className="text-white/50">
                  <NavIcon icon={item.icon} />
                </span>
                {item.label}
              </Link>
            ),
          )}
        </nav>
      </div>

      <div className="mt-auto">
        <UserChip user={user} />
      </div>
    </div>
  );
}

function AppShell() {
  const session = Route.useLoaderData();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useRouterState({ select: (s) => s.location });

  // Belt-and-braces: whatever path closed the drawer, also close it whenever
  // the route changes (covers programmatic navigation and any link that didn't
  // go through onNavigate).
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);

  return (
    <div className="min-h-dvh bg-ink text-fg">
      {/* Desktop sidebar */}
      <aside className="glass-deep fixed inset-y-0 left-0 z-30 hidden w-64 md:flex md:flex-col">
        <SidebarContent user={session} />
      </aside>

      {/* Mobile top bar */}
      <header className="glass-deep sticky top-0 z-30 flex h-16 items-center justify-between border-x-0 border-t-0 px-4 md:hidden">
        <Link to="/app" className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="h-7 w-7 object-contain" />
          <span className="text-[15px] font-medium tracking-[-0.02em] text-fg">
            Operion <span className="text-muted">CRM</span>
          </span>
        </Link>
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          <svg
            width={18}
            height={18}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 5h16" />
            <path d="M4 12h16" />
            <path d="M4 19h16" />
          </svg>
        </button>
      </header>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <div className="glass-deep absolute inset-y-0 left-0 flex w-72 flex-col">
            <div className="flex justify-end p-3">
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setDrawerOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                <svg
                  width={18}
                  height={18}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            <SidebarContent user={session} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      ) : null}

      {/* Main content */}
      <div className="md:pl-64">
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
