import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import type { SessionUser } from "~/lib/auth";
import {
  createAgent,
  listAgents,
  type AgentInfo,
} from "~/lib/agents";

export const Route = createFileRoute("/app/agents")({
  component: AgentsPage,
});

/* ------------------------------------------------------------------ */
/* Icons                                                                */
/* ------------------------------------------------------------------ */

function Svg({
  children,
  className = "h-4 w-4",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const Icons = {
  userPlus: (
    <Svg className="h-5 w-5">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6" />
      <path d="M22 11h-6" />
    </Svg>
  ),
  eye: (
    <Svg className="h-4 w-4">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  eyeOff: (
    <Svg className="h-4 w-4">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </Svg>
  ),
  shield: (
    <Svg className="h-5 w-5">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  ),
  check: (
    <Svg className="h-3.5 w-3.5">
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  ),
  users: (
    <Svg className="h-4 w-4">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  ),
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatUSD(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

/* ------------------------------------------------------------------ */
/* Owner-only guard                                                     */
/* ------------------------------------------------------------------ */

function OwnerOnlyState() {
  return (
    <div className="rise-in flex min-h-[55dvh] items-center justify-center">
      <div className="glass ring-gradient grain relative w-full max-w-md overflow-hidden rounded-3xl p-8 text-center sm:p-10">
        <div className="sheen-overlay" aria-hidden="true" />
        <div className="icon-tile mx-auto mb-5 text-white/50">{Icons.shield}</div>
        <h2 className="text-2xl font-semibold tracking-[-0.045em] text-fg">
          Owner access only
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Agent accounts are managed by the owner. If you need access, ask the owner to
          set up your account from this page.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create-agent form                                                    */
/* ------------------------------------------------------------------ */

const EMPTY_FORM = { name: "", email: "", password: "" };

function CreateAgentForm({ onCreated }: { onCreated: () => void }) {
  const [values, setValues] = useState(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const set = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setError(null);
    setSuccess(null);
    setCreating(true);
    try {
      const res = await createAgent({ data: values });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setValues(EMPTY_FORM);
      setShowPassword(false);
      setSuccess(`${res.agent.name} is on board — they can sign in with ${res.agent.email}.`);
      onCreated();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  const fieldLabel = "text-[12px] font-medium text-white/70";
  return (
    <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-3">
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Name</span>
        <input
          autoFocus
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Jordan Lee"
          className="input-dark"
          aria-label="Agent name"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Email</span>
        <input
          type="email"
          value={values.email}
          onChange={(e) => set({ email: e.target.value })}
          placeholder="jordan@operioncrm.com"
          className="input-dark"
          aria-label="Agent email"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Temporary password</span>
        <div className="relative">
          <input
            type={showPassword ? "text" : "password"}
            value={values.password}
            onChange={(e) => set({ password: e.target.value })}
            placeholder="At least 8 characters"
            className="input-dark pr-10"
            aria-label="Temporary password"
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1.5 text-white/40 transition-colors hover:text-white/80"
          >
            {showPassword ? Icons.eyeOff : Icons.eye}
          </button>
        </div>
      </label>

      <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
        <button type="submit" disabled={creating} className="btn-primary min-w-36">
          {creating ? (
            <>
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black"
              />
              Creating…
            </>
          ) : (
            <>
              {Icons.userPlus}
              Create agent
            </>
          )}
        </button>
        <p className="text-[11px] leading-relaxed text-white/30">
          The agent signs in with this email and password, then sees only the deals
          assigned to them.
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300 sm:col-span-3"
        >
          {error}
        </p>
      ) : null}
      {success ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] px-4 py-3 text-[13px] leading-relaxed text-emerald-300 sm:col-span-3"
        >
          <span className="shrink-0">{Icons.check}</span>
          {success}
        </p>
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Roster                                                               */
/* ------------------------------------------------------------------ */

function RosterTable({ agents, loading }: { agents: AgentInfo[] | null; loading: boolean }) {
  if (loading && agents === null) {
    return (
      <div className="glass-deep flex min-h-[120px] items-center justify-center rounded-2xl px-6 py-8">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
      </div>
    );
  }
  if (agents !== null && agents.length === 0) {
    return (
      <div className="glass-deep flex min-h-[160px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] px-6 py-10 text-center">
        <div className="icon-tile mb-4 text-white/35">{Icons.users}</div>
        <p className="text-sm font-medium text-fg">No agents yet</p>
        <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-muted">
          Create your first agent above — they&apos;ll appear here with their deal counts.
        </p>
      </div>
    );
  }
  if (agents === null) {
    return (
      <div className="glass-deep flex min-h-[120px] items-center justify-center rounded-2xl px-6 py-8">
        <p className="text-[13px] text-muted">Couldn&apos;t load the roster.</p>
      </div>
    );
  }
  return (
    <div className="glass-deep scroll-thin overflow-x-auto rounded-2xl">
      <table className="w-full min-w-[660px] text-left">
        <thead>
          <tr className="border-b border-white/[0.06] text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
            <th className="px-5 py-3.5">Agent</th>
            <th className="px-4 py-3.5">Email</th>
            <th className="px-4 py-3.5">Role</th>
            <th className="px-4 py-3.5 text-right">Open deals</th>
            <th className="px-4 py-3.5 text-right">Open MRR</th>
            <th className="px-5 py-3.5 text-right">Created</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr
              key={a.id}
              className="border-b border-white/[0.04] text-[13px] transition-colors last:border-b-0 hover:bg-white/[0.02]"
            >
              <td className="px-5 py-3.5">
                <span className="flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/70 to-blue-500/40 text-[11px] font-semibold text-white ring-1 ring-white/15">
                    {a.name
                      .split(" ")
                      .map((p) => p[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()}
                  </span>
                  <span className="font-medium text-fg">{a.name}</span>
                </span>
              </td>
              <td className="px-4 py-3.5 text-muted">{a.email}</td>
              <td className="px-4 py-3.5">
                <span className="inline-flex items-center rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-white/60 ring-1 ring-inset ring-white/[0.08]">
                  {a.role === "agent" ? "Agent" : a.role}
                </span>
              </td>
              <td className="px-4 py-3.5 text-right tabular-nums text-fg">{a.openDeals}</td>
              <td className="px-4 py-3.5 text-right tabular-nums text-fg">
                {formatUSD(a.openMrr)}
                <span className="ml-0.5 text-[11px] font-medium text-white/35">/mo</span>
              </td>
              <td className="px-5 py-3.5 text-right text-white/40 tabular-nums">
                {formatDate(a.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

function AgentsAdmin() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const load = useCallback(async () => {
    try {
      const res = await listAgents();
      if (!res.ok) {
        if (res.reason === "not-signed-in") window.location.assign("/");
        setStatus("error");
        return;
      }
      setAgents(res.agents);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const createdRef = useRef(false);

  return (
    <div className="rise-in">
      {/* Header */}
      <div className="mb-6">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
          Admin
        </p>
        <h1 className="text-3xl font-semibold tracking-[-0.045em] text-gradient-violet sm:text-4xl">
          Agents
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
          Create accounts for your sales agents and keep an eye on who owns which
          deals. Agents see only the deals assigned to them.
        </p>
      </div>

      {/* Create form */}
      <div className="glass ring-gradient grain relative mb-6 overflow-hidden rounded-3xl p-6 sm:p-7">
        <div className="sheen-overlay" aria-hidden="true" />
        <div className="mb-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
            New agent
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-[-0.045em] text-fg">
            Add an agent to the team
          </h2>
        </div>
        <CreateAgentForm
          onCreated={() => {
            createdRef.current = true;
            void load();
          }}
        />
      </div>

      {/* Roster */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/35">
          Team roster
        </h2>
        {agents !== null ? (
          <span className="text-[11px] tabular-nums text-white/30">
            {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {status === "error" && agents === null ? (
        <div className="glass-deep flex min-h-[120px] items-center justify-center rounded-2xl px-6 py-8">
          <p className="text-[13px] text-muted">Couldn&apos;t load the roster.</p>
          <button type="button" onClick={() => void load()} className="btn-ghost ml-3 h-8 px-3 text-[12px]">
            Try again
          </button>
        </div>
      ) : (
        <RosterTable agents={agents} loading={status === "loading"} />
      )}
    </div>
  );
}

function AgentsPage() {
  const session = useLoaderData({ from: "/app" }) as SessionUser;
  if (session.role !== "owner") return <OwnerOnlyState />;
  return <AgentsAdmin />;
}
