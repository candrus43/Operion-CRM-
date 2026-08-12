import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { changePassword, getSession, logout, type SessionUser } from "~/lib/auth";
import InstallBanner from "~/components/install-banner";

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

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const cls =
    size === "sm"
      ? "h-8 w-8 text-[10px]"
      : "h-11 w-11 text-[13px]";
  return (
    <div
      className={`flex ${cls} shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/70 to-blue-500/40 font-semibold text-white ring-1 ring-white/15`}
    >
      {initials || "?"}
    </div>
  );
}

function UserChip({
  user,
  onOpenAccount,
}: {
  user: SessionUser;
  /** Opens the account modal (change password). */
  onOpenAccount: () => void;
}) {
  const [signingOut, setSigningOut] = useState(false);

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
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenAccount}
          title="Account settings"
          aria-label={`Account settings for ${user.name}`}
          className="-mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors duration-300 hover:bg-white/[0.05]"
        >
          <Avatar name={user.name} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-fg">{user.name}</span>
            <span className="block truncate text-[11px] capitalize text-muted">{user.role}</span>
          </span>
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0 text-white/35"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
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

/* Operion-styled toast, mirroring the pipeline page's toast */
function Toast({ message }: { message: string }) {
  return (
    <div className="rise-in glass-deep fixed right-5 bottom-5 z-[70] flex items-center gap-2.5 rounded-xl px-4 py-3 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]">
      <span className="h-2 w-2 shrink-0 rounded-full bg-accent-light" />
      <p className="text-[13px] font-medium text-fg">{message}</p>
    </div>
  );
}

const fieldLabel = "text-[12px] font-medium text-white/70";

/**
 * Account popover — self-service "Change password" for the signed-in user.
 * Opens from the sidebar user chip (desktop sidebar and mobile drawer).
 * Closes on Escape, backdrop click, or the close button. The current session
 * stays alive after a change; the server revokes the user's other sessions.
 */
function AccountModal({
  user,
  onClose,
  notify,
}: {
  user: SessionUser;
  onClose: () => void;
  notify: (msg: string) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const currentInput = useRef<HTMLInputElement | null>(null);

  // Escape closes; autofocus lands on the first field (whenever the modal
  // mounts, which is exactly when it opens).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    currentInput.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function clearFeedback() {
    setError(null);
    setSuccess(false);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSuccess(false);
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (confirm !== next) {
      setError("New passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await changePassword({ data: { currentPassword: current, newPassword: next } });
      if (res.ok) {
        setSuccess(true);
        setCurrent("");
        setNext("");
        setConfirm("");
        notify("Password updated");
      } else {
        setError(res.message);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Account settings"
        className="rise-in glass ring-gradient grain relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-3xl p-6 sm:p-7"
      >
        <div className="sheen-overlay" aria-hidden="true" />

        {/* Account header */}
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Avatar name={user.name} />
            <div>
              <p className="text-[13px] font-medium text-fg">{user.name}</p>
              <p className="text-[11px] capitalize text-muted">{user.role}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
          >
            <svg
              width={16}
              height={16}
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

        <div className="hairline mb-5" />

        {/* Change password */}
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
          Change password
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-[-0.045em] text-gradient-violet">
          Update your password
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          Use at least 8 characters. You&apos;ll stay signed in; your other
          sessions will be signed out.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 grid gap-4">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Current password</span>
            <input
              ref={currentInput}
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value);
                clearFeedback();
              }}
              placeholder="••••••••••••"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>New password</span>
            <input
              type="password"
              name="newPassword"
              autoComplete="new-password"
              required
              minLength={8}
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                clearFeedback();
              }}
              placeholder="At least 8 characters"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Confirm new password</span>
            <input
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                clearFeedback();
              }}
              placeholder="Repeat the new password"
              className="input-dark"
            />
          </label>

          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300"
            >
              {error}
            </p>
          ) : null}

          {success ? (
            <p
              role="status"
              className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.08] px-4 py-3 text-[13px] leading-relaxed text-emerald-300"
            >
              Password updated
            </p>
          ) : null}

          <button type="submit" disabled={submitting} className="btn-primary mt-1 w-full">
            {submitting ? (
              <>
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black"
                />
                Updating…
              </>
            ) : (
              "Update password"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function SidebarContent({
  user,
  onNavigate,
  onOpenAccount,
}: {
  user: SessionUser;
  /** Called when a navigation link is pressed (the mobile drawer closes itself). */
  onNavigate?: () => void;
  /** Opens the account modal (change password). */
  onOpenAccount: () => void;
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
          src="/logo.png?v=2"
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
        <UserChip user={user} onOpenAccount={onOpenAccount} />
      </div>
    </div>
  );
}

function AppShell() {
  const session = Route.useLoaderData();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const location = useRouterState({ select: (s) => s.location });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  // Belt-and-braces: whatever path closed the drawer, also close it whenever
  // the route changes (covers programmatic navigation and any link that didn't
  // go through onNavigate).
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);

  function openAccount() {
    // On mobile the chip lives inside the drawer — close the drawer so the
    // account modal opens cleanly over the page content.
    setDrawerOpen(false);
    setAccountOpen(true);
  }

  return (
    <div className="min-h-dvh bg-ink text-fg">
      {/* Desktop sidebar */}
      <aside className="glass-deep fixed inset-y-0 left-0 z-30 hidden w-64 md:flex md:flex-col">
        <SidebarContent user={session} onOpenAccount={openAccount} />
      </aside>

      {/* Mobile top bar */}
      <header className="glass-deep sticky top-0 z-30 flex h-16 items-center justify-between border-x-0 border-t-0 px-4 md:hidden">
        <Link to="/app" className="flex items-center gap-2.5">
          <img src="/logo.png?v=2" alt="" className="h-7 w-7 object-contain" />
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
            <SidebarContent
              user={session}
              onNavigate={() => setDrawerOpen(false)}
              onOpenAccount={openAccount}
            />
          </div>
        </div>
      ) : null}

      {/* Main content */}
      <div className="md:pl-64">
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 md:px-8">
          <Outlet />
        </main>
      </div>

      {/* PWA install prompt — only appears when beforeinstallprompt fires */}
      <InstallBanner />

      {/* Account popover (change password) — opens from the sidebar user chip */}
      {accountOpen ? (
        <AccountModal user={session} onClose={() => setAccountOpen(false)} notify={notify} />
      ) : null}
      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}
