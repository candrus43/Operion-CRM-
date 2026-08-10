import { useEffect, useState } from "react";
import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import type { SessionUser } from "~/lib/auth";
import {
  commissionSummary,
  type AgentCommissionSummary,
  type CommissionRow,
} from "~/lib/pipeline";
import type { Plan } from "~/lib/pricing";

// Auth guard: /app/commissions lives under the /app shell, whose loader already
// checks the session and redirects to "/" when signed out (same as contacts /
// resources / reports).

export const Route = createFileRoute("/app/commissions")({
  component: CommissionsPage,
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const PLAN_BADGE: Record<Plan, string> = {
  Founder: "bg-sky-400/10 text-sky-300 ring-1 ring-inset ring-sky-400/20",
  Studio: "bg-violet-400/10 text-violet-300 ring-1 ring-inset ring-violet-400/20",
};

function PlanBadge({ plan }: { plan: Plan }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${PLAN_BADGE[plan]}`}
    >
      {plan}
    </span>
  );
}

function formatUSD(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

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
  coin: (
    <Svg className="h-5 w-5">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v12" />
      <path d="M14.5 9.5a2.5 2.5 0 0 0-5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 1 5 0" />
    </Svg>
  ),
  check: (
    <Svg className="h-3.5 w-3.5">
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  ),
  clock: (
    <Svg className="h-5 w-5">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  ),
};

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function TotalsCard({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: "pending" | "earned";
  icon: React.ReactNode;
}) {
  const valueCls = tone === "earned" ? "text-emerald-300" : "text-amber-300";
  const ringCls =
    tone === "earned"
      ? "border-emerald-400/20 bg-emerald-500/[0.05]"
      : "border-amber-400/20 bg-amber-500/[0.05]";
  return (
    <div className={`glass rounded-2xl p-5 ${ringCls}`}>
      <div className="flex items-center gap-2">
        <span className="text-white/35">{icon}</span>
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
          {label}
        </p>
      </div>
      <p className={`mt-2 text-2xl font-semibold tabular-nums tracking-[-0.03em] ${valueCls}`}>
        {formatUSD(value)}
      </p>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentCommissionSummary }) {
  return (
    <div className="glass rounded-2xl p-4">
      <p className="text-[13px] font-medium text-fg">{agent.name}</p>
      <div className="mt-2.5 flex items-center justify-between gap-3 text-[12px]">
        <span className="text-white/40">Earned</span>
        <span className="font-semibold tabular-nums text-emerald-300">
          {formatUSD(agent.totals.earnedCommission)}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-[12px]">
        <span className="text-white/40">Pending</span>
        <span className="font-semibold tabular-nums text-amber-300">
          {formatUSD(agent.totals.pendingCommission)}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-[12px]">
        <span className="text-white/40">Closed won</span>
        <span className="font-semibold tabular-nums text-white/70">{agent.totals.dealCount}</span>
      </div>
    </div>
  );
}

function CommissionTable({ rows, showOwner }: { rows: CommissionRow[]; showOwner: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="glass-deep flex min-h-[140px] flex-col items-center justify-center rounded-2xl px-6 py-10 text-center">
        <p className="text-[13px] text-muted">No Closed Won deals yet.</p>
        <p className="mt-1 text-[12px] text-white/30">
          Commission of 25% of the setup fee appears here once a deal closes.
        </p>
      </div>
    );
  }
  return (
    <div className="glass-deep scroll-thin overflow-x-auto rounded-2xl">
      <table className="w-full min-w-[640px] text-left">
        <thead>
          <tr className="border-b border-white/[0.06] text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
            <th className="px-5 py-3.5">Company</th>
            {showOwner ? <th className="px-4 py-3.5">Agent</th> : null}
            <th className="px-4 py-3.5">Plan</th>
            <th className="px-4 py-3.5 text-right">Setup fee</th>
            <th className="px-4 py-3.5 text-right">Commission</th>
            <th className="px-4 py-3.5">Status</th>
            <th className="px-5 py-3.5 text-right">Collected</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.dealId}
              className="border-b border-white/[0.04] text-[13px] transition-colors last:border-b-0 hover:bg-white/[0.02]"
            >
              <td className="px-5 py-3.5 font-medium text-fg">{row.company}</td>
              {showOwner ? (
                <td className="px-4 py-3.5 text-muted">{row.ownerName}</td>
              ) : null}
              <td className="px-4 py-3.5">
                <PlanBadge plan={row.plan} />
              </td>
              <td className="px-4 py-3.5 text-right tabular-nums text-fg">
                {formatUSD(row.setupFee)}
              </td>
              <td className="px-4 py-3.5 text-right font-semibold tabular-nums text-emerald-300">
                {formatUSD(row.commission)}
              </td>
              <td className="px-4 py-3.5">
                {row.collected ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/25">
                    {Icons.check}
                    Earned
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/25">
                    {Icons.clock}
                    Pending
                  </span>
                )}
              </td>
              <td className="px-5 py-3.5 text-right tabular-nums text-white/50">
                {row.collected ? formatDate(row.collectedAt) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function CommissionsPage() {
  const session = useLoaderData({ from: "/app" }) as SessionUser;
  const isOwner = session.role === "owner";

  const [status, setStatus] = useState<"loading" | "ready" | "not-connected" | "error">(
    "loading",
  );
  const [rows, setRows] = useState<CommissionRow[]>([]);
  const [totals, setTotals] = useState({ pendingCommission: 0, earnedCommission: 0, dealCount: 0 });
  const [agents, setAgents] = useState<AgentCommissionSummary[] | null>(null);

  const load = async () => {
    const res = await commissionSummary();
    if (!res.ok) {
      if (res.reason === "db-not-connected") return setStatus("not-connected");
      if (res.reason === "not-signed-in") return window.location.assign("/");
      return setStatus("error");
    }
    setRows(res.rows);
    setTotals(res.totals);
    setAgents(res.agents);
    setStatus("ready");
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="rise-in">
      {/* Header */}
      <div className="mb-6">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
          Commissions
        </p>
        <h1 className="text-3xl font-semibold tracking-[-0.045em] text-gradient-violet sm:text-4xl">
          Commission ledger
        </h1>
        <p className="mt-2 text-sm text-muted">
          Each Closed Won deal earns {isOwner ? "agents" : "you"} 25% of the setup fee once it
          is collected — computed from the plan, never typed.
        </p>
      </div>

      {status === "not-connected" ? (
        <div className="glass flex min-h-[240px] items-center justify-center rounded-3xl p-8 text-center">
          <div>
            <div className="icon-tile mx-auto mb-4 text-white/50">{Icons.coin}</div>
            <h2 className="text-xl font-semibold tracking-[-0.045em] text-fg">
              Database is not connected yet
            </h2>
            <p className="mt-2 text-sm text-muted">
              Connect the database from the dashboard to see commissions.
            </p>
            <button type="button" onClick={() => void load()} className="btn-ghost mt-5">
              Try again
            </button>
          </div>
        </div>
      ) : status === "error" ? (
        <div className="glass flex min-h-[240px] items-center justify-center rounded-3xl p-8 text-center">
          <div>
            <h2 className="text-xl font-semibold tracking-[-0.045em] text-fg">
              Couldn&apos;t load commissions
            </h2>
            <p className="mt-2 text-sm text-muted">
              Something went wrong while loading your commissions.
            </p>
            <button type="button" onClick={() => void load()} className="btn-ghost mt-5">
              Try again
            </button>
          </div>
        </div>
      ) : status === "loading" ? (
        <div className="flex min-h-[240px] items-center justify-center">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
        </div>
      ) : (
        <>
          {/* Totals cards */}
          <div className="grid gap-4 sm:grid-cols-2">
            <TotalsCard
              label="Pending commission"
              value={totals.pendingCommission}
              tone="pending"
              icon={Icons.clock}
            />
            <TotalsCard
              label="Earned (collected)"
              value={totals.earnedCommission}
              tone="earned"
              icon={Icons.check}
            />
          </div>

          {/* Owner: per-agent summary */}
          {isOwner && agents ? (
            <div className="mt-6">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-white/35">
                By agent
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {agents.map((a) => (
                  <AgentCard key={a.id} agent={a} />
                ))}
              </div>
            </div>
          ) : null}

          {/* Ledger table */}
          <div className="mt-6">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-white/35">
              {totals.dealCount} closed-won deal{totals.dealCount === 1 ? "" : "s"}
            </p>
            <CommissionTable rows={rows} showOwner={isOwner} />
          </div>
        </>
      )}
    </div>
  );
}
