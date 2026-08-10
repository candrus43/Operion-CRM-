import { useEffect, useState } from "react";
import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import type { SessionUser } from "~/lib/auth";
import {
  commissionSummary,
  reportsSummary,
  type AgentCommissionSummary,
  type AgentMrrRow,
  type CommissionRow,
  type SummaryMetrics,
} from "~/lib/pipeline";
import type { Plan } from "~/lib/pricing";

// Auth guard: /app/commissions lives under the /app shell, whose loader already
// checks the session and redirects to "/" when signed out.

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

function formatPercent(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const rounded = Math.round(v * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "August 2026" — the calendar month (UTC) the server buckets by. */
function currentMonthLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Q3 2026" — the calendar quarter (UTC) the server buckets by. */
function currentQuarterLabel(): string {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  return `Q${q} ${now.getUTCFullYear()}`;
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
  trend: (
    <Svg className="h-5 w-5">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </Svg>
  ),
  gauge: (
    <Svg className="h-5 w-5">
      <path d="M12 15l3.5-3.5" />
      <path d="M20.3 18a10 10 0 1 0-16.6 0" />
    </Svg>
  ),
  calendar: (
    <Svg className="h-5 w-5">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </Svg>
  ),
  percent: (
    <Svg className="h-5 w-5">
      <path d="M19 5 5 19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </Svg>
  ),
};

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

/**
 * Big MRR stat card in the Operion glass-deep style. `kind` drives the honest
 * labeling: FORECAST numbers are weighted by stage probability; ACTUAL numbers
 * come from closed deals in the CRM.
 */
function MetricCard({
  label,
  value,
  sub,
  kind,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  kind: "forecast" | "actual";
  icon: React.ReactNode;
}) {
  const badgeCls =
    kind === "forecast"
      ? "bg-sky-400/10 text-sky-300 ring-1 ring-inset ring-sky-400/20"
      : "bg-emerald-400/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20";
  return (
    <div className="glass-deep rounded-2xl p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-white/35">{icon}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${badgeCls}`}>
          {kind === "forecast" ? "Forecast" : "Actual"}
        </span>
      </div>
      <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
        {label}
      </p>
      <p className="mt-1.5 text-3xl font-semibold tabular-nums tracking-[-0.03em] text-fg">
        {value}
      </p>
      <p className="mt-1.5 text-[11px] leading-snug text-white/30">{sub}</p>
    </div>
  );
}

/** Per-agent MRR breakdown (owner sees all agents; an agent sees their own row). */
function AgentMrrTable({ rows }: { rows: AgentMrrRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="glass-deep flex min-h-[120px] items-center justify-center rounded-2xl px-6 py-8 text-center">
        <p className="text-[13px] text-muted">No agents yet.</p>
      </div>
    );
  }
  return (
    <div className="glass-deep scroll-thin overflow-x-auto rounded-2xl">
      <table className="w-full min-w-[560px] text-left">
        <thead>
          <tr className="border-b border-white/[0.06] text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
            <th className="px-5 py-3.5">Agent</th>
            <th className="px-4 py-3.5 text-right">Open MRR</th>
            <th className="px-4 py-3.5 text-right">Weighted MRR</th>
            <th className="px-4 py-3.5 text-right">Closed-won MRR</th>
            <th className="px-5 py-3.5 text-right">Deals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr
              key={a.id}
              className="border-b border-white/[0.04] text-[13px] transition-colors last:border-b-0 hover:bg-white/[0.02]"
            >
              <td className="px-5 py-3.5 font-medium text-fg">{a.name}</td>
              <td className="px-4 py-3.5 text-right tabular-nums text-fg">
                {formatUSD(a.openMrr)}
              </td>
              <td className="px-4 py-3.5 text-right tabular-nums text-sky-300">
                {formatUSD(a.weightedMrr)}
              </td>
              <td className="px-4 py-3.5 text-right tabular-nums text-emerald-300">
                {formatUSD(a.closedWonMrr)}
              </td>
              <td className="px-5 py-3.5 text-right tabular-nums text-white/50">
                {a.dealCount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
          Commission of 25% of the setup fee appears here once an agent&apos;s deal closes.
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
  const [metrics, setMetrics] = useState<SummaryMetrics | null>(null);
  const [agentRows, setAgentRows] = useState<AgentMrrRow[] | null>(null);
  const [rows, setRows] = useState<CommissionRow[]>([]);
  const [totals, setTotals] = useState({ pendingCommission: 0, earnedCommission: 0, dealCount: 0 });
  const [agents, setAgents] = useState<AgentCommissionSummary[] | null>(null);

  const load = async () => {
    const [summary, ledger] = await Promise.all([reportsSummary(), commissionSummary()]);
    if (!summary.ok) {
      if (summary.reason === "db-not-connected") return setStatus("not-connected");
      if (summary.reason === "not-signed-in") return window.location.assign("/");
      return setStatus("error");
    }
    if (!ledger.ok) return setStatus("error");
    setMetrics(summary.metrics);
    setAgentRows(summary.agents);
    setRows(ledger.rows);
    setTotals(ledger.totals);
    setAgents(ledger.agents);
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
          Business overview
        </h1>
        <p className="mt-2 text-sm text-muted">
          MRR and win-rate metrics computed from the CRM&apos;s own deals — pipeline
          numbers are a forecast weighted by stage probability, closed-won MRR is
          actual. {isOwner ? "Team-wide" : "Your"} figures; the commission ledger
          sits below.
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
              Connect the database from the dashboard to see your numbers.
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
              Couldn&apos;t load the numbers
            </h2>
            <p className="mt-2 text-sm text-muted">
              Something went wrong while loading the overview.
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
          {/* MRR stat cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard
              label="Total pipeline MRR"
              value={formatUSD(metrics?.totalPipelineMrr)}
              sub="Sum of open-deal MRR — not yet revenue"
              kind="forecast"
              icon={Icons.coin}
            />
            <MetricCard
              label="Weighted pipeline MRR"
              value={formatUSD(metrics?.weightedPipelineMrr)}
              sub="Open-deal MRR × stage probability"
              kind="forecast"
              icon={Icons.trend}
            />
            <MetricCard
              label={`Closed-won MRR · ${currentMonthLabel()}`}
              value={formatUSD(metrics?.closedWonMrrThisMonth)}
              sub={`Deals closed in ${currentMonthLabel()}`}
              kind="actual"
              icon={Icons.calendar}
            />
            <MetricCard
              label={`Closed-won MRR · ${currentQuarterLabel()}`}
              value={formatUSD(metrics?.closedWonMrrThisQuarter)}
              sub={`Deals closed in ${currentQuarterLabel()}`}
              kind="actual"
              icon={Icons.calendar}
            />
            <MetricCard
              label="Avg deal size"
              value={formatUSD(metrics?.avgDealSize)}
              sub="Mean MRR per closed-won deal"
              kind="actual"
              icon={Icons.gauge}
            />
            <MetricCard
              label="Win rate"
              value={formatPercent(metrics?.winRate)}
              sub={`${metrics?.closedWonCount ?? 0} won · ${metrics?.closedLostCount ?? 0} lost`}
              kind="actual"
              icon={Icons.percent}
            />
          </div>

          {/* Per-agent MRR breakdown */}
          <div className="mt-8">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-white/35">
              {isOwner ? "By agent" : "Your deals"}
            </p>
            {agentRows ? <AgentMrrTable rows={agentRows} /> : null}
          </div>

          {/* Commission ledger */}
          <div className="mt-8">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.18em] text-white/35">
              Commission ledger
            </p>
            <p className="mb-4 text-[12px] text-white/30">
              {isOwner
                ? "Agents earn 25% of the collected setup fee per Closed Won deal — computed from the plan, never typed."
                : "You earn 25% of the collected setup fee per Closed Won deal — computed from the plan, never typed."}
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <TotalsCard
                label={isOwner ? "Agents pending" : "Pending commission"}
                value={totals.pendingCommission}
                tone="pending"
                icon={Icons.clock}
              />
              <TotalsCard
                label={isOwner ? "Agents earned" : "Earned (collected)"}
                value={totals.earnedCommission}
                tone="earned"
                icon={Icons.check}
              />
            </div>

            {/* Owner: per-agent commission summary */}
            {isOwner && agents ? (
              <div className="mt-6">
                <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-white/35">
                  Agent commissions
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
          </div>
        </>
      )}
    </div>
  );
}
