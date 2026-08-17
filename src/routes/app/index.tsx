import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, createFileRoute, useLoaderData } from "@tanstack/react-router";
import type { SessionUser } from "~/lib/auth";
import {
  ACTIVITY_TYPES,
  STAGES,
  createActivity,
  createDeal,
  getDealDetail,
  listDeals,
  listUsers,
  markSetupFeeCollected,
  markWon,
  moveDealStage,
  unmarkSetupFeeCollected,
  updateDeal,
  type Activity,
  type ActivityType,
  type Deal,
  type DbStatus,
  type DealInput,
  type LinkedContact,
  type PipelineUser,
  type Stage,
} from "~/lib/pipeline";
import { listContacts, type Contact } from "~/lib/contacts";
import { reassignDeal } from "~/lib/agents";
import { isDealStale, staleDays } from "~/lib/briefing";
import { MorningBriefing } from "~/components/morning-briefing";
import {
  PLANS,
  PLAN_PRICING,
  annualValue,
  commissionFor,
  firstYearValue,
  type Plan,
} from "~/lib/pricing";

export const Route = createFileRoute("/app/")({
  component: PipelinePage,
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const STAGE_META: Record<Stage, { dot: string; badge: string }> = {
  Lead: { dot: "bg-white/40", badge: "bg-white/[0.07] text-white/70" },
  Contacted: { dot: "bg-sky-400", badge: "bg-sky-400/10 text-sky-300" },
  Meeting: { dot: "bg-violet-400", badge: "bg-violet-400/10 text-violet-300" },
  Proposal: { dot: "bg-indigo-400", badge: "bg-indigo-400/10 text-indigo-300" },
  Negotiation: { dot: "bg-amber-400", badge: "bg-amber-400/10 text-amber-300" },
  "Closed Won": { dot: "bg-emerald-400", badge: "bg-emerald-400/10 text-emerald-300" },
  "Closed Lost": { dot: "bg-rose-400", badge: "bg-rose-400/10 text-rose-300" },
};

/** Plan badge styling — Founder sky, Studio violet. */
const PLAN_META: Record<Plan, { badge: string }> = {
  Founder: {
    badge: "bg-sky-400/10 text-sky-300 ring-1 ring-inset ring-sky-400/20",
  },
  Studio: {
    badge: "bg-violet-400/10 text-violet-300 ring-1 ring-inset ring-violet-400/20",
  },
};

function PlanBadge({ plan, className = "" }: { plan: Plan; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${PLAN_META[plan].badge} ${className}`}
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

/** Compact date for badges (e.g. "Aug 7, 2025"). */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** "Jordan Lee" → "JL" — tiny avatar initials for the assigned-agent chip. */
function ownerInitials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function friendlyError(reason: DbStatus): string {
  switch (reason) {
    case "db-not-connected":
      return "Database is not connected yet.";
    case "not-signed-in":
      return "Your session expired. Please sign in again.";
    case "forbidden":
      return "You don't have permission to do that.";
    case "invalid":
      return "Check the form and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** Effective customer email — live contact row preferred, else the deal's snapshot. */
function effectiveDealEmail(contact: LinkedContact | null, deal: Deal): string | null {
  return (contact?.email ?? deal.contact_email) || null;
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
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
  plus: (
    <Svg>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  ),
  close: (
    <Svg className="h-4 w-4">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  ),
  grip: (
    <Svg className="h-3.5 w-3.5">
      <circle cx="9" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1" fill="currentColor" stroke="none" />
    </Svg>
  ),
  mail: (
    <Svg>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </Svg>
  ),
  phone: (
    <Svg>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </Svg>
  ),
  users: (
    <Svg>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  ),
  note: (
    <Svg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  ),
  arrow: (
    <Svg>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Svg>
  ),
  calendar: (
    <Svg>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </Svg>
  ),
  database: (
    <Svg className="h-5 w-5">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </Svg>
  ),
  edit: (
    <Svg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  ),
  send: (
    <Svg>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </Svg>
  ),
  check: (
    <Svg>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  ),
};

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function DealCard({
  deal,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  deal: Deal;
  dragging: boolean;
  onDragStart: (e: React.DragEvent, dealId: string) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const won = deal.stage === "Closed Won";
  const lost = deal.stage === "Closed Lost";
  // Stale = open deal with no activity for STALE_DEAL_DAYS (5) — effective
  // last touch falls back to created_at. Closed deals never wear the badge.
  const stale = isDealStale(deal);
  return (
    <div
      draggable
      role="button"
      tabIndex={0}
      onDragStart={(e) => onDragStart(e, deal.id)}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`glass lift-sm group cursor-grab rounded-2xl p-4 text-left outline-none transition-all duration-300 select-none focus-visible:ring-2 focus-visible:ring-accent/50 active:cursor-grabbing ${
        dragging ? "opacity-40" : ""
      } ${won ? "border-emerald-400/25 bg-emerald-500/[0.05]" : ""} ${
        lost ? "border-rose-400/25 bg-rose-500/[0.05]" : ""
      } ${stale ? "border-amber-400/30" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-[14px] font-semibold tracking-[-0.045em] text-fg">
          {deal.company}
        </p>
        <span className="flex shrink-0 items-center gap-1.5">
          {stale ? (
            <span
              title={`No activity for ${staleDays(deal)} days`}
              className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-300 uppercase ring-1 ring-inset ring-amber-400/25"
            >
              <span aria-hidden="true" className="h-1 w-1 rounded-full bg-amber-400" />
              Stale · {staleDays(deal)}d
            </span>
          ) : null}
          <PlanBadge plan={deal.plan} />
        </span>
      </div>
      {/* Operion subscription pricing — computed from the plan, never typed */}
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl border border-white/[0.04] bg-white/[0.03] px-2.5 py-2">
        <div>
          <p className="text-[9px] font-medium uppercase tracking-[0.12em] text-white/30">
            Setup fee
          </p>
          <p className="mt-0.5 text-[12px] font-semibold tabular-nums text-white/85">
            {formatUSD(deal.setupFee)}
          </p>
        </div>
        <div>
          <p className="text-[9px] font-medium uppercase tracking-[0.12em] text-white/30">MRR</p>
          <p className="mt-0.5 text-[12px] font-semibold tabular-nums text-white/85">
            {formatUSD(deal.mrr)}
            <span className="text-[10px] font-medium text-white/45">/mo</span>
          </p>
        </div>
        <div>
          <p className="text-[9px] font-medium uppercase tracking-[0.12em] text-white/30">
            Annual value
          </p>
          <p className="mt-0.5 text-[12px] font-semibold tabular-nums text-white/85">
            {formatUSD(deal.annual)}
          </p>
        </div>
        <div>
          <p className="text-[9px] font-medium uppercase tracking-[0.12em] text-white/30">
            First-year total
          </p>
          <p className="mt-0.5 text-[12px] font-semibold tabular-nums text-gradient-violet">
            {formatUSD(deal.firstYear)}
          </p>
        </div>
      </div>
      <p className="mt-0.5 truncate text-[12px] text-muted">
        {deal.contact_name || "No contact"}
      </p>
      <p className="mt-2 truncate text-[12px] text-faint">
        {deal.next_step ? (
          <>
            <span className="mr-1 text-white/25">Next:</span>
            {deal.next_step}
          </>
        ) : (
          "No next step set"
        )}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.05] pt-2.5">
        <span className="flex min-w-0 items-center gap-2">
          {deal.owner_name ? (
            <span
              title={`Assigned to ${deal.owner_name}`}
              className="inline-flex min-w-0 max-w-[55%] items-center gap-1.5 rounded-full bg-white/[0.05] py-0.5 pr-2 pl-0.5 ring-1 ring-inset ring-white/[0.06]"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/70 to-blue-500/40 text-[7px] font-semibold text-white">
                {ownerInitials(deal.owner_name)}
              </span>
              <span className="truncate text-[11px] text-white/60">{deal.owner_name}</span>
            </span>
          ) : null}
          <span className="shrink-0 text-[11px] text-white/35">
            {relTime(deal.last_activity_at)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-white/25 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          {Icons.grip}
          <span className="tracking-wide">drag</span>
        </span>
      </div>
    </div>
  );
}

function StageColumn({
  stage,
  deals,
  draggingId,
  dragOver,
  onDragStart,
  onDragEnd,
  onDrop,
  onDragOverStage,
  onDragLeaveStage,
  onOpenDeal,
}: {
  stage: Stage;
  deals: Deal[];
  draggingId: string | null;
  dragOver: Stage | null;
  onDragStart: (e: React.DragEvent, dealId: string) => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent, stage: Stage) => void;
  onDragOverStage: (stage: Stage) => void;
  onDragLeaveStage: (stage: Stage) => void;
  onOpenDeal: (dealId: string) => void;
}) {
  const meta = STAGE_META[stage];
  const totalMrr = deals.reduce((sum, d) => sum + d.mrr, 0);
  const isOver = dragOver === stage;
  return (
    <div
      className={`glass-deep flex h-full w-[268px] shrink-0 flex-col rounded-2xl transition-colors duration-300 ${
        isOver ? "border-accent/40 bg-accent/[0.03]" : ""
      }`}
    >
      <div className="flex items-center gap-2 px-4 pt-4 pb-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
        <h3 className="truncate text-[13px] font-semibold tracking-[-0.02em] text-fg">
          {stage}
        </h3>
        <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/60">
          {deals.length}
        </span>
        <span className="ml-auto truncate text-[11px] tabular-nums text-muted">
          {formatUSD(totalMrr)}
          <span className="text-white/35">/mo</span>
        </span>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onDragOverStage(stage);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          onDragOverStage(stage);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            onDragLeaveStage(stage);
          }
        }}
        onDrop={(e) => onDrop(e, stage)}
        className={`scroll-thin flex min-h-[110px] flex-1 flex-col gap-2.5 overflow-y-auto rounded-b-2xl px-3 pb-3 pt-1.5 ${
          isOver ? "ring-1 ring-inset ring-accent/30" : ""
        }`}
      >
        {deals.length === 0 ? (
          <div className="flex min-h-[110px] flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-center">
            <p className="text-[12px] leading-relaxed text-white/30">
              No deals in this stage yet
            </p>
          </div>
        ) : (
          deals.map((d) => (
            <DealCard
              key={d.id}
              deal={d}
              dragging={draggingId === d.id}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onOpen={() => onOpenDeal(d.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function FilterBar({
  filters,
  onFilterChange,
  onReset,
  users,
  me,
}: {
  filters: { agentId: string; stage: string; plan: string; minMrr: string; maxMrr: string };
  onFilterChange: (patch: Partial<typeof filters>) => void;
  onReset: () => void;
  users: PipelineUser[];
  me: PipelineUser;
}) {
  const selectCls = "select-dark select-dark-sm";
  return (
    <div className="glass-deep mb-6 grid grid-cols-2 items-end gap-x-3 gap-y-3 rounded-2xl px-4 py-3.5 sm:flex sm:flex-wrap sm:items-end sm:gap-x-4">
      <label className="flex min-w-0 flex-col gap-1.5 sm:min-w-36">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
          Agent
        </span>
        <div className="relative">
          <select
            value={filters.agentId}
            onChange={(e) => onFilterChange({ agentId: e.target.value })}
            className={selectCls}
            aria-label="Filter by agent"
          >
            {me.role === "owner" ? <option value="all">All agents</option> : null}
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </label>

      <label className="flex min-w-0 flex-col gap-1.5 sm:min-w-40">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
          Stage
        </span>
        <div className="relative">
          <select
            value={filters.stage}
            onChange={(e) => onFilterChange({ stage: e.target.value })}
            className={selectCls}
            aria-label="Filter by stage"
          >
            <option value="all">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </label>

      <label className="flex min-w-0 flex-col gap-1.5 sm:min-w-36">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
          Plan
        </span>
        <div className="relative">
          <select
            value={filters.plan}
            onChange={(e) => onFilterChange({ plan: e.target.value })}
            className={selectCls}
            aria-label="Filter by plan"
          >
            <option value="all">All plans</option>
            {PLANS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
          Min MRR
        </span>
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[12px] text-white/30">
            $
          </span>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="249"
            value={filters.minMrr}
            onChange={(e) => onFilterChange({ minMrr: e.target.value })}
            className="input-dark h-9 w-28 py-0 pl-7 pr-3 text-[13px]"
            aria-label="Minimum monthly recurring revenue"
          />
        </div>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
          Max MRR
        </span>
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[12px] text-white/30">
            $
          </span>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="499"
            value={filters.maxMrr}
            onChange={(e) => onFilterChange({ maxMrr: e.target.value })}
            className="input-dark h-9 w-28 py-0 pl-7 pr-3 text-[13px]"
            aria-label="Maximum monthly recurring revenue"
          />
        </div>
      </label>

      <button type="button" onClick={onReset} className="btn-ghost col-span-2 mb-0.5">
        Reset filters
      </button>
    </div>
  );
}

function DealFormModal({
  deal,
  users,
  me,
  contacts,
  onClose,
  onSaved,
  notify,
}: {
  deal: Deal | null;
  users: PipelineUser[];
  me: PipelineUser;
  contacts: Contact[];
  onClose: () => void;
  onSaved: (dealId?: string) => void;
  notify: (msg: string) => void;
}) {
  const editing = deal !== null;
  const [values, setValues] = useState({
    company: deal?.company ?? "",
    contactId: deal?.contact_id ?? "",
    contactName: deal?.contact_name ?? "",
    contactEmail: deal?.contact_email ?? "",
    contactPhone: deal?.contact_phone ?? "",
    plan: (deal?.plan ?? "Founder") as Plan,
    stage: (deal?.stage ?? "Lead") as Stage,
    ownerId: deal?.owner_id ?? me.id,
    nextStep: deal?.next_step ?? "",
    notes: deal?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }));

  /** Picking a contact links the deal AND pre-fills the denormalized snapshot fields. */
  function handleContactSelect(id: string) {
    const c = contacts.find((x) => x.id === id);
    set({
      contactId: id,
      ...(c
        ? { contactName: c.name, contactEmail: c.email ?? "", contactPhone: c.phone ?? "" }
        : {}),
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const company = values.company.trim();
    if (!company) {
      setError("Company name is required.");
      return;
    }
    setError(null);
    setSaving(true);
    const payload: DealInput = {
      company,
      plan: values.plan,
      contactId: values.contactId.trim() || null,
      contactName: values.contactName.trim() || null,
      contactEmail: values.contactEmail.trim() || null,
      contactPhone: values.contactPhone.trim() || null,
      stage: values.stage,
      nextStep: values.nextStep.trim() || null,
      notes: values.notes.trim() || null,
    };
    try {
      const res = editing
        ? await updateDeal({
            data: {
              dealId: deal.id,
              ...payload,
              ...(me.role === "owner" ? { ownerId: values.ownerId } : {}),
            },
          })
        : await createDeal({
            data: me.role === "owner" ? { ...payload, ownerId: values.ownerId } : payload,
          });
      if (!res.ok) {
        setError(friendlyError(res.reason));
        return;
      }
      onSaved(res.dealId);
      notify(editing ? "Deal updated" : "Deal created");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const fieldLabel = "text-[12px] font-medium text-white/70";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="rise-in glass ring-gradient grain relative max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-3xl p-6 sm:p-7">
        <div className="sheen-overlay" aria-hidden="true" />
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
              {editing ? "Edit deal" : "New deal"}
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.045em] text-gradient-violet">
              {editing ? deal.company : "Add a deal to your pipeline"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
          >
            {Icons.close}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Company *</span>
            <input
              required
              autoFocus
              value={values.company}
              onChange={(e) => set({ company: e.target.value })}
              placeholder="Acme Corp"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Contact</span>
            <select
              value={values.contactId}
              onChange={(e) => handleContactSelect(e.target.value)}
              className="select-dark"
            >
              <option value="">— None (fill in manually below) —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.company ? ` — ${c.company}` : ""}
                </option>
              ))}
            </select>
            <span className="text-[11px] leading-relaxed text-white/30">
              Picking a contact links the deal to them and pre-fills the fields below. You
              can still edit the snapshot fields.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Contact name</span>
            <input
              value={values.contactName}
              onChange={(e) => set({ contactName: e.target.value })}
              placeholder="Dana Whitfield"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Contact email</span>
            <input
              type="email"
              value={values.contactEmail}
              onChange={(e) => set({ contactEmail: e.target.value })}
              placeholder="dana@acme.com"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Contact phone</span>
            <input
              value={values.contactPhone}
              onChange={(e) => set({ contactPhone: e.target.value })}
              placeholder="+1 (415) 555-0142"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Plan *</span>
            <select
              value={values.plan}
              onChange={(e) => set({ plan: e.target.value as Plan })}
              className="select-dark"
            >
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {p} — ${PLAN_PRICING[p].mrr}/mo
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Stage</span>
            <select
              value={values.stage}
              onChange={(e) => set({ stage: e.target.value as Stage })}
              className="select-dark"
            >
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          {/* Operion subscription pricing — computed from the plan, never typed */}
          <div className="glass rounded-2xl p-4 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                Operion subscription — {values.plan}
              </p>
              <PlanBadge plan={values.plan} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-[10px] text-white/30">Setup fee</p>
                <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">
                  {formatUSD(PLAN_PRICING[values.plan].setupFee)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-white/30">MRR</p>
                <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">
                  {formatUSD(PLAN_PRICING[values.plan].mrr)}
                  <span className="text-[11px] font-medium text-white/50">/mo</span>
                </p>
              </div>
              <div>
                <p className="text-[10px] text-white/30">Annual value</p>
                <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">
                  {formatUSD(annualValue(values.plan))}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-white/30">First-year total</p>
                <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-gradient-violet">
                  {formatUSD(firstYearValue(values.plan))}
                </p>
              </div>
            </div>
            <p className="mt-2.5 text-[11px] leading-relaxed text-white/30">
              Values are computed from the {values.plan} plan — no manual pricing entry.
            </p>
          </div>

          {me.role === "owner" ? (
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className={fieldLabel}>Assigned to</span>
              <select
                value={values.ownerId}
                onChange={(e) => set({ ownerId: e.target.value })}
                className="select-dark"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.id === me.id ? " (you)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="flex items-center gap-2 text-[12px] text-muted sm:col-span-2">
              <span className="text-white/25">{Icons.users}</span>
              New deals are assigned to you.
            </p>
          )}

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Next step</span>
            <input
              value={values.nextStep}
              onChange={(e) => set({ nextStep: e.target.value })}
              placeholder="Book kickoff call for next week"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Notes</span>
            <textarea
              rows={3}
              value={values.notes}
              onChange={(e) => set({ notes: e.target.value })}
              placeholder="Context, objections, next steps…"
              className="input-dark resize-none"
            />
          </label>

          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300 sm:col-span-2"
            >
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-3 pt-1 sm:col-span-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary min-w-28">
              {saving ? (
                <>
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black"
                  />
                  Saving…
                </>
              ) : editing ? (
                "Save changes"
              ) : (
                "Create deal"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const ACTIVITY_META: Record<string, { icon: React.ReactNode; label: string; tone: string }> = {
  email: { icon: Icons.mail, label: "Email", tone: "text-sky-300" },
  call: { icon: Icons.phone, label: "Call", tone: "text-teal-300" },
  meeting: { icon: Icons.users, label: "Meeting", tone: "text-fuchsia-300" },
  stage: { icon: Icons.arrow, label: "Stage change", tone: "text-violet-300" },
  note: { icon: Icons.note, label: "Note", tone: "text-amber-300" },
  created: { icon: Icons.plus, label: "Created", tone: "text-emerald-300" },
  plan: { icon: Icons.calendar, label: "Plan", tone: "text-indigo-300" },
  contact: { icon: Icons.users, label: "Contact", tone: "text-cyan-300" },
  edit: { icon: Icons.edit, label: "Edit", tone: "text-white/60" },
};

function DealDetailDrawer({
  dealId,
  me,
  users,
  onClose,
  onEdit,
  onChanged,
  notify,
}: {
  dealId: string;
  me: PipelineUser;
  users: PipelineUser[];
  onClose: () => void;
  onEdit: (deal: Deal) => void;
  onChanged: () => void;
  notify: (msg: string) => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; reason: DbStatus }
    | {
        status: "ready";
        deal: Deal;
        activities: Activity[];
        contact: LinkedContact | null;
      }
  >({ status: "loading" });
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [markWonOpen, setMarkWonOpen] = useState(false);
  const [markWonBusy, setMarkWonBusy] = useState(false);
  const [markWonError, setMarkWonError] = useState<string | null>(null);
  const [feeBusy, setFeeBusy] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [stageMoveBusy, setStageMoveBusy] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [actOpen, setActOpen] = useState(false);
  const [actType, setActType] = useState<ActivityType>("call");
  const [actSummary, setActSummary] = useState("");
  const [actBusy, setActBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setMarkWonOpen(false);
    setMarkWonError(null);
    getDealDetail({ data: { dealId } }).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setState({ status: "error", reason: res.reason });
        return;
      }
      setNotes(res.deal.notes ?? "");
      setState({
        status: "ready",
        deal: res.deal,
        activities: res.activities,
        contact: res.contact,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  /** Re-fetch deal + activities so server-written timeline rows (stage moves,
   *  closes, note saves) appear in the open drawer without a reopen. */
  async function reloadDetail() {
    const res = await getDealDetail({ data: { dealId } });
    if (!res.ok) return;
    setState((s) =>
      s.status === "ready"
        ? { status: "ready", deal: res.deal, activities: res.activities, contact: res.contact }
        : s,
    );
  }
  async function saveNotes() {
    if (state.status !== "ready") return;
    setSavingNotes(true);
    const res = await updateDeal({ data: { dealId, notes } });
    setSavingNotes(false);
    if (!res.ok) {
      notify(friendlyError(res.reason));
      return;
    }
    setState((s) => (s.status === "ready" ? { ...s, deal: { ...s.deal, notes } } : s));
    notify("Notes saved");
    onChanged();
  }

  /** Log a manual activity (call / email / meeting / note) and prepend it to the timeline. */
  async function handleLogActivity() {
    if (state.status !== "ready" || actBusy) return;
    const summary = actSummary.trim();
    if (!summary) {
      setActError("Add a short summary for this activity.");
      return;
    }
    setActBusy(true);
    setActError(null);
    try {
      const res = await createActivity({ data: { dealId, type: actType, summary } });
      if (!res.ok) {
        if (res.reason === "not-signed-in") window.location.assign("/");
        else setActError(res.message);
        return;
      }
      // Prepend so the timeline updates without a page reload; keep the deal's
      // last_activity_at in sync too (the server bumps it).
      setState((s) =>
        s.status === "ready"
          ? {
              ...s,
              activities: [res.activity, ...s.activities],
              deal: { ...s.deal, last_activity_at: res.activity.created_at },
            }
          : s,
      );
      setActSummary("");
      setActError(null);
      notify("Activity logged");
      onChanged();
    } catch {
      setActError("Something went wrong. Please try again.");
    } finally {
      setActBusy(false);
    }
  }

  /** Mark Won — confirmed in a dialog, then POSTs the payment-link handoff to Operion. */
  async function handleMarkWon() {
    if (state.status !== "ready" || markWonBusy) return;
    setMarkWonBusy(true);
    setMarkWonError(null);
    try {
      const res = await markWon({ data: { dealId } });
      if (!res.ok) {
        if (res.reason === "not-signed-in") window.location.assign("/");
        else setMarkWonError(res.message);
        return;
      }
      setMarkWonOpen(false);
      // Reflect the new stage in the open drawer, then refresh the board so the
      // card moves to Closed Won (same refresh path as drag/create).
      setState((s) => (s.status === "ready" ? { ...s, deal: res.deal } : s));
      notify("Payment link sent — deal closed");
      void reloadDetail();
      onChanged();
    } catch {
      setMarkWonError("Something went wrong. Please try again.");
    } finally {
      setMarkWonBusy(false);
    }
  }

  /** Quick-jump "move to" — same server path as a drag, so semantics match. */
  async function handleStageMove(next: Stage) {
    if (state.status !== "ready" || stageMoveBusy || next === state.deal.stage) return;
    setStageMoveBusy(true);
    const res = await moveDealStage({ data: { dealId: state.deal.id, stage: next } });
    setStageMoveBusy(false);
    if (!res.ok) {
      if (res.reason === "not-signed-in") window.location.assign("/");
      else notify(friendlyError(res.reason));
      return;
    }
    setState((s) => (s.status === "ready" ? { ...s, deal: { ...s.deal, stage: next } } : s));
    notify(`Moved to ${next}`);
    void reloadDetail();
    onChanged();
  }

  /** Mark the Closed Won deal's setup fee as collected (commission earned). */
  async function handleMarkFeeCollected() {
    if (state.status !== "ready" || feeBusy) return;
    setFeeBusy(true);
    setFeeError(null);
    try {
      const res = await markSetupFeeCollected({ data: { dealId } });
      if (!res.ok) {
        if (res.reason === "not-signed-in") window.location.assign("/");
        else setFeeError(res.message);
        return;
      }
      setState((s) => (s.status === "ready" ? { ...s, deal: res.deal } : s));
      notify("Setup fee marked collected — commission earned");
      onChanged();
    } catch {
      setFeeError("Something went wrong. Please try again.");
    } finally {
      setFeeBusy(false);
    }
  }

  /** Owner-only: undo a collected mark. */
  async function handleUnmarkFee() {
    if (state.status !== "ready" || feeBusy) return;
    setFeeBusy(true);
    setFeeError(null);
    try {
      const res = await unmarkSetupFeeCollected({ data: { dealId } });
      if (!res.ok) {
        if (res.reason === "not-signed-in") window.location.assign("/");
        else setFeeError(res.message);
        return;
      }
      setState((s) => (s.status === "ready" ? { ...s, deal: res.deal } : s));
      notify("Setup fee mark undone");
      onChanged();
    } catch {
      setFeeError("Something went wrong. Please try again.");
    } finally {
      setFeeBusy(false);
    }
  }

  /** Owner-only: reassign the deal to another user, live from the drawer. */
  async function handleReassign(newOwnerId: string) {
    if (state.status !== "ready" || assignBusy || newOwnerId === state.deal.owner_id) return;
    setAssignBusy(true);
    setAssignError(null);
    try {
      const res = await reassignDeal({ data: { dealId: state.deal.id, newOwnerId } });
      if (!res.ok) {
        if (res.reason === "not-signed-in") window.location.assign("/");
        else setAssignError(res.message);
        return;
      }
      const next = users.find((u) => u.id === newOwnerId);
      setState((s) =>
        s.status === "ready"
          ? { ...s, deal: { ...s.deal, owner_id: newOwnerId, owner_name: next?.name ?? null } }
          : s,
      );
      notify(`Assigned to ${next?.name ?? "new owner"}`);
      onChanged();
    } catch {
      setAssignError("Something went wrong. Please try again.");
    } finally {
      setAssignBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <aside className="drawer-in glass-deep fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-r-0 border-y-0">
        <div className="scroll-thin flex-1 overflow-y-auto">
          {state.status === "loading" ? (
            <div className="flex h-64 items-center justify-center">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
            </div>
          ) : state.status === "error" ? (
            <div className="p-8 text-center">
              <p className="text-sm text-muted">{friendlyError(state.reason)}</p>
              <button type="button" className="btn-ghost mt-4" onClick={onClose}>
                Close
              </button>
            </div>
          ) : (
            <div className="p-6">
              {/* Header */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
                    Deal detail
                  </p>
                  <h2 className="mt-1 truncate text-2xl font-semibold tracking-[-0.045em] text-gradient-violet">
                    {state.deal.company}
                  </h2>
                  <span
                    className={`mt-2.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${(STAGE_META[state.deal.stage] ?? STAGE_META.Lead).badge}`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${(STAGE_META[state.deal.stage] ?? STAGE_META.Lead).dot}`}
                    />
                    {state.deal.stage}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
                >
                  {Icons.close}
                </button>
              </div>

              {/* Plan + owner */}
              <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="glass rounded-2xl p-4">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                    Plan
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <PlanBadge plan={state.deal.plan} />
                    <span className="text-sm font-medium text-fg">{state.deal.plan}</span>
                  </div>
                </div>
                <div className="glass rounded-2xl p-4">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                    {me.role === "owner" ? "Assigned to" : "Owner"}
                  </p>
                  {me.role === "owner" ? (
                    <>
                      <select
                        value={state.deal.owner_id ?? ""}
                        onChange={(e) => void handleReassign(e.target.value)}
                        disabled={assignBusy}
                        className="select-dark select-dark-sm mt-2 w-full"
                        aria-label="Assigned to"
                      >
                        {state.deal.owner_id ? null : (
                          <option value="" disabled>
                            — Unassigned —
                          </option>
                        )}
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                            {u.id === me.id ? " (you)" : ""}
                          </option>
                        ))}
                      </select>
                      {assignError ? (
                        <p
                          role="alert"
                          className="mt-2 rounded-lg border border-red-400/20 bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-300"
                        >
                          {assignError}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="mt-1.5 truncate text-sm font-medium text-fg">
                      {state.deal.owner_name || "You"}
                    </p>
                  )}
                </div>
              </div>

              {/* Quick-jump — move straight to any stage without a full-board drag */}
              <div className="glass mt-3 flex items-center justify-between gap-3 rounded-2xl p-4">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                    Move to stage
                  </p>
                  <p className="mt-1 truncate text-[11px] leading-relaxed text-white/30">
                    Shortcut for long jumps — same as dragging the card.
                  </p>
                </div>
                <select
                  value={state.deal.stage}
                  onChange={(e) => void handleStageMove(e.target.value as Stage)}
                  disabled={stageMoveBusy}
                  className="select-dark select-dark-sm w-40 shrink-0"
                  aria-label="Move deal to stage"
                >
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              {/* Operion subscription pricing — computed from the plan */}
              <div className="glass mt-3 rounded-2xl p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                    Operion subscription
                  </p>
                  <span className="text-[11px] tabular-nums text-white/40">
                    {formatUSD(state.deal.mrr)}/mo · {formatUSD(state.deal.firstYear)} yr 1
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <p className="text-[10px] text-white/30">Setup fee</p>
                    <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">
                      {formatUSD(state.deal.setupFee)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-white/30">MRR</p>
                    <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">
                      {formatUSD(state.deal.mrr)}
                      <span className="text-[11px] font-medium text-white/50">/mo</span>
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-white/30">Annual value</p>
                    <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">
                      {formatUSD(state.deal.annual)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-white/30">First-year total</p>
                    <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-gradient-violet">
                      {formatUSD(state.deal.firstYear)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Mark Won — Operion payment-link handoff (Negotiation only) */}
              {state.deal.stage === "Negotiation" ? (
                <div className="mt-3 rounded-2xl border border-emerald-400/20 bg-emerald-500/[0.05] p-4">
                  <button
                    type="button"
                    onClick={() => {
                      setMarkWonError(null);
                      setMarkWonOpen(true);
                    }}
                    disabled={!effectiveDealEmail(state.contact, state.deal)}
                    title={
                      effectiveDealEmail(state.contact, state.deal)
                        ? undefined
                        : "Add a contact email to send a payment link"
                    }
                    className="btn-primary w-full"
                  >
                    {Icons.send}
                    Mark won
                  </button>
                  {effectiveDealEmail(state.contact, state.deal) ? (
                    <p className="mt-2.5 text-center text-[11px] leading-relaxed text-white/35">
                      Emails{" "}
                      <span className="text-white/60">
                        {effectiveDealEmail(state.contact, state.deal)}
                      </span>{" "}
                      a Stripe payment link from Operion, then closes the deal.
                    </p>
                  ) : (
                    <p className="mt-2.5 text-center text-[11px] leading-relaxed text-amber-300/70">
                      Add a contact email to send a payment link.
                    </p>
                  )}
                </div>
              ) : null}

              {/* Commission — 25% of the collected setup fee (Closed Won only) */}
              {state.deal.stage === "Closed Won" ? (
                <div className="mt-3 rounded-2xl border border-emerald-400/20 bg-emerald-500/[0.05] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                      Commission
                    </p>
                    <span className="text-[13px] font-semibold tabular-nums text-emerald-300">
                      {formatUSD(commissionFor(state.deal.plan))}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] text-fg">
                    {formatUSD(commissionFor(state.deal.plan))} · 25% of{" "}
                    {formatUSD(state.deal.setupFee)} setup fee
                  </p>
                  {state.deal.setup_fee_collected ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-3 py-1 text-[12px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/25">
                        {Icons.check}
                        Collected {formatDate(state.deal.setup_fee_collected_at)}
                      </span>
                      {me.role === "owner" ? (
                        <button
                          type="button"
                          onClick={handleUnmarkFee}
                          disabled={feeBusy}
                          className="btn-ghost h-8 px-3 text-[12px]"
                        >
                          Undo
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={handleMarkFeeCollected}
                        disabled={feeBusy}
                        className="btn-primary mt-3 w-full"
                      >
                        {feeBusy ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black"
                            />
                            Saving…
                          </>
                        ) : (
                          <>
                            {Icons.check}
                            Mark setup fee collected
                          </>
                        )}
                      </button>
                      <p className="mt-2 text-center text-[11px] leading-relaxed text-white/35">
                        Mark once the customer pays the {formatUSD(state.deal.setupFee)} setup
                        fee — this deal earns{" "}
                        <span className="text-emerald-300/80">
                          {formatUSD(commissionFor(state.deal.plan))}
                        </span>{" "}
                        in commission.
                      </p>
                    </>
                  )}
                  {feeError ? (
                    <p
                      role="alert"
                      className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300"
                    >
                      {feeError}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* Contact — live contact row when linked, else the deal's snapshot */}
              <div className="glass mt-3 rounded-2xl p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                    Contact
                  </p>
                  {state.contact ? (
                    <Link
                      to="/app/contacts"
                      search={{ contact: state.contact.id }}
                      className="btn-ghost h-7 px-2.5 text-[11px]"
                    >
                      <span className="text-white/40">{Icons.users}</span>
                      View contact
                    </Link>
                  ) : null}
                </div>
                <div className="mt-2 space-y-2 text-[13px]">
                  <p className="text-fg">
                    {state.contact?.name ??
                      state.deal.contact_name ??
                      "No contact name"}
                  </p>
                  {state.contact?.email ?? state.deal.contact_email ? (
                    <a
                      href={`mailto:${state.contact?.email ?? state.deal.contact_email}`}
                      className="flex items-center gap-2 text-muted transition-colors hover:text-accent-light"
                    >
                      <span className="text-white/25">{Icons.mail}</span>
                      <span className="truncate">
                        {state.contact?.email ?? state.deal.contact_email}
                      </span>
                    </a>
                  ) : null}
                  {state.contact?.phone ?? state.deal.contact_phone ? (
                    <a
                      href={`tel:${state.contact?.phone ?? state.deal.contact_phone}`}
                      className="flex items-center gap-2 text-muted transition-colors hover:text-accent-light"
                    >
                      <span className="text-white/25">{Icons.phone}</span>
                      <span className="truncate">
                        {state.contact?.phone ?? state.deal.contact_phone}
                      </span>
                    </a>
                  ) : null}
                  {!(state.contact?.email ?? state.deal.contact_email) &&
                  !(state.contact?.phone ?? state.deal.contact_phone) ? (
                    <p className="text-[12px] text-white/30">No contact details yet</p>
                  ) : null}
                </div>
              </div>

              {/* Next step */}
              <div className="glass mt-3 flex items-start gap-2.5 rounded-2xl p-4">
                <span className="mt-0.5 text-white/25">{Icons.calendar}</span>
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                    Next step
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-fg">
                    {state.deal.next_step || "Nothing scheduled"}
                  </p>
                </div>
              </div>

              {/* Notes (editable) */}
              <div className="glass mt-3 rounded-2xl p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                    Notes
                  </p>
                  <span className="text-[11px] text-white/25">
                    {savingNotes ? "Saving…" : "editable"}
                  </span>
                </div>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add context, objections, next steps…"
                  className="input-dark mt-2 resize-none"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={saveNotes}
                    disabled={savingNotes}
                    className="btn-ghost h-8 px-3 text-[12px]"
                  >
                    Save notes
                  </button>
                </div>
              </div>

              {/* Edit + activity timeline */}
              <div className="mt-6 flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/35">
                  Activity
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setActOpen((v) => !v);
                      setActError(null);
                    }}
                    className="btn-ghost h-8 px-3 text-[12px]"
                  >
                    <span className="text-white/40">{Icons.plus}</span>
                    {actOpen ? "Cancel" : "Log activity"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onEdit(state.deal)}
                    className="btn-ghost h-8 px-3 text-[12px]"
                  >
                    <span className="text-white/40">{Icons.edit}</span>
                    Edit deal
                  </button>
                </div>
              </div>

              {/* Add activity — collapsed by default, expands into a compact form */}
              {actOpen ? (
                <div className="glass mt-3 rounded-2xl p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="flex flex-col gap-1.5 sm:w-40 sm:shrink-0">
                      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/30">
                        Type
                      </span>
                      <select
                        value={actType}
                        onChange={(e) => setActType(e.target.value as ActivityType)}
                        className="select-dark select-dark-sm w-full"
                      >
                        {ACTIVITY_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {ACTIVITY_META[t]?.label ?? t}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/30">
                        Summary
                      </span>
                      <textarea
                        rows={2}
                        value={actSummary}
                        onChange={(e) => setActSummary(e.target.value)}
                        placeholder="What happened on this call / email…"
                        className="input-dark resize-none"
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex items-center justify-end gap-3">
                    <span className="text-[11px] text-white/25">
                      {actSummary.length > 0 ? `${actSummary.length}/1000` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={handleLogActivity}
                      disabled={actBusy}
                      className="btn-primary h-8 px-3 text-[12px]"
                    >
                      {actBusy ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-black/20 border-t-black"
                          />
                          Logging…
                        </>
                      ) : (
                        "Log activity"
                      )}
                    </button>
                  </div>
                  {actError ? (
                    <p
                      role="alert"
                      className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300"
                    >
                      {actError}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-3 space-y-2.5 pb-4">
                {state.activities.length === 0 ? (
                  <div className="glass flex min-h-[96px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] px-4 py-6 text-center">
                    <p className="text-[12px] text-white/30">No activity yet</p>
                  </div>
                ) : (
                  state.activities.map((a) => {
                    const meta = ACTIVITY_META[a.type] ?? {
                      icon: Icons.note,
                      label: "Activity",
                      tone: "text-white/50",
                    };
                    return (
                      <div key={a.id} className="glass flex items-start gap-3 rounded-2xl p-3.5">
                        <div className="icon-tile-sm mt-0.5 shrink-0 text-white/40">
                          {meta.icon}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className={`text-[11px] font-medium ${meta.tone}`}>{meta.label}</p>
                            <p className="shrink-0 text-[11px] text-white/30">
                              {relTime(a.created_at)}
                            </p>
                          </div>
                          {a.summary ? (
                            <p className="mt-1 text-[13px] leading-relaxed text-fg">
                              {a.summary}
                            </p>
                          ) : null}
                          {a.author_name ? (
                            <p className="mt-1 text-[11px] text-white/35">{a.author_name}</p>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Mark Won confirmation — explains the payment-link handoff before closing */}
      {markWonOpen && state.status === "ready" ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
          <button
            type="button"
            aria-label="Close dialog"
            onClick={() => {
              if (!markWonBusy) {
                setMarkWonOpen(false);
                setMarkWonError(null);
              }
            }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <div className="rise-in glass ring-gradient grain relative w-full max-w-md rounded-3xl p-6 sm:p-7">
            <div className="sheen-overlay" aria-hidden="true" />
            <div className="mb-5">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
                Close deal
              </p>
              <h3 className="mt-1 text-2xl font-semibold tracking-[-0.045em] text-gradient-violet">
                Mark won & send payment link?
              </h3>
            </div>
            <p className="text-[13px] leading-relaxed text-muted">
              Send{" "}
              <span className="font-medium text-fg">
                {state.deal.contact_name || state.deal.company}
              </span>{" "}
              a payment link from Operion and close this deal? This emails the customer a
              Stripe payment link — the deal moves to Closed Won only after Operion accepts.
            </p>

            {/* Operion subscription — computed from the plan */}
            <div className="glass mt-4 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                  Operion subscription
                </p>
                <PlanBadge plan={state.deal.plan} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] text-white/30">Setup fee</p>
                  <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">
                    {formatUSD(state.deal.setupFee)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-white/30">MRR</p>
                  <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">
                    {formatUSD(state.deal.mrr)}
                    <span className="text-[11px] font-medium text-white/50">/mo</span>
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-white/30">Annual value</p>
                  <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">
                    {formatUSD(state.deal.annual)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-white/30">First-year total</p>
                  <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-gradient-violet">
                    {formatUSD(state.deal.firstYear)}
                  </p>
                </div>
              </div>
            </div>

            {markWonError ? (
              <p
                role="alert"
                className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300"
              >
                {markWonError}
              </p>
            ) : null}

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setMarkWonOpen(false);
                  setMarkWonError(null);
                }}
                disabled={markWonBusy}
                className="btn-ghost"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleMarkWon}
                disabled={markWonBusy}
                className="btn-primary min-w-36"
              >
                {markWonBusy ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black"
                    />
                    Sending…
                  </>
                ) : (
                  <>
                    {Icons.check}
                    Send & close
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function DbNotConnected({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[58dvh] items-center justify-center">
      <div className="rise-in w-full max-w-md">
        <div className="glass ring-gradient grain relative overflow-hidden rounded-3xl p-8 text-center sm:p-10">
          <div className="sheen-overlay" aria-hidden="true" />
          <div className="icon-tile mx-auto mb-5 text-white/50">{Icons.database}</div>
          <h2 className="text-2xl font-semibold tracking-[-0.045em] text-fg">
            Database is not connected yet
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Connect the database from the dashboard to start managing your deal pipeline.
            Your deals, contacts and activity will show up here as soon as it&apos;s
            connected.
          </p>
          <button type="button" onClick={onRetry} className="btn-ghost mt-6">
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-[55dvh] items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
        <p className="text-[13px] text-muted">Loading pipeline…</p>
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[55dvh] items-center justify-center">
      <div className="glass w-full max-w-md rounded-3xl p-8 text-center">
        <h2 className="text-xl font-semibold tracking-[-0.045em] text-fg">
          Couldn&apos;t load the pipeline
        </h2>
        <p className="mt-2 text-sm text-muted">Something went wrong while loading your deals.</p>
        <button type="button" onClick={onRetry} className="btn-ghost mt-5">
          Try again
        </button>
      </div>
    </div>
  );
}

function Toast({ message }: { message: string }) {
  return (
    <div className="rise-in glass-deep fixed right-5 bottom-5 z-[70] flex items-center gap-2.5 rounded-xl px-4 py-3 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]">
      <span className="h-2 w-2 shrink-0 rounded-full bg-accent-light" />
      <p className="text-[13px] font-medium text-fg">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

interface FiltersState {
  agentId: string;
  stage: string;
  plan: string;
  minMrr: string;
  maxMrr: string;
}

function PipelinePage() {
  const session = useLoaderData({ from: "/app" }) as SessionUser;
  const me: PipelineUser = useMemo(
    () => ({ id: session.id, name: session.name, email: session.email, role: session.role }),
    [session],
  );

  const [status, setStatus] = useState<"loading" | "ready" | "not-connected" | "error">(
    "loading",
  );
  const [deals, setDeals] = useState<Deal[]>([]);
  const [users, setUsers] = useState<PipelineUser[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [filters, setFilters] = useState<FiltersState>({
    agentId: session.role === "owner" ? "all" : session.id,
    stage: "all",
    plan: "all",
    minMrr: "",
    maxMrr: "",
  });
  const [debounced, setDebounced] = useState(filters);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<Stage | null>(null);
  // Auto-scroll during card drag: the horizontally scrollable board container,
  // the pointer's latest clientX (updated by a document-level dragover
  // listener), and the rAF loop id driving the scroll.
  const boardRef = useRef<HTMLDivElement | null>(null);
  const pointerXRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  /** Stops the auto-scroll loop (idempotent — called from drop and dragend). */
  const stopAutoScroll = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pointerXRef.current = null;
  }, []);

  /**
   * rAF loop that scrolls the board horizontally while the pointer sits within
   * ~100px of the container's left/right edge. Runs for the whole drag (started
   * on dragstart, stopped on drop/dragend); when the pointer is outside the
   * edge zones it simply doesn't scroll, so entering a zone resumes instantly.
   */
  const startAutoScroll = useCallback(() => {
    stopAutoScroll();
    const EDGE_ZONE = 100; // px from the container edge that triggers scrolling
    const EDGE_SPEED = 12; // px per animation frame (~720px/s at 60fps)
    const loop = () => {
      const board = boardRef.current;
      const x = pointerXRef.current;
      if (board && x != null) {
        const rect = board.getBoundingClientRect();
        if (x < rect.left + EDGE_ZONE) {
          board.scrollLeft -= EDGE_SPEED;
        } else if (x > rect.right - EDGE_ZONE) {
          board.scrollLeft += EDGE_SPEED;
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [stopAutoScroll]);

  // While a card is being dragged, track the pointer's X from every dragover
  // event (they fire continuously on whatever element is under the pointer and
  // bubble to document — including over the board gaps). Also stop the loop if
  // the drag is cancelled anywhere (Escape / window dragend).
  useEffect(() => {
    if (!draggingId) return;
    const onDragOver = (e: DragEvent) => {
      pointerXRef.current = e.clientX;
    };
    const onDragEnd = () => stopAutoScroll();
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragend", onDragEnd);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragend", onDragEnd);
    };
  }, [draggingId, stopAutoScroll]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async (f: FiltersState) => {
    const toFilters = {
      agentId: f.agentId === "all" ? null : f.agentId,
      stage: f.stage === "all" ? null : (f.stage as Stage),
      plan: f.plan === "all" ? null : (f.plan as Plan),
      minMrr: f.minMrr === "" ? null : Number(f.minMrr),
      maxMrr: f.maxMrr === "" ? null : Number(f.maxMrr),
    };
    const [usersRes, dealsRes] = await Promise.all([
      listUsers(),
      listDeals({ data: toFilters }),
    ]);
    if (!usersRes.ok) {
      if (usersRes.reason === "db-not-connected") return setStatus("not-connected");
      if (usersRes.reason === "not-signed-in") return window.location.assign("/");
      return setStatus("error");
    }
    if (!dealsRes.ok) {
      if (dealsRes.reason === "db-not-connected") return setStatus("not-connected");
      if (dealsRes.reason === "not-signed-in") return window.location.assign("/");
      return setStatus("error");
    }
    setUsers(usersRes.users);
    setDeals(dealsRes.deals);
    setStatus("ready");
    // Contacts power the deal form's Contact dropdown — non-fatal if it fails.
    listContacts()
      .then((res) => {
        if (res.ok) setContacts(res.contacts);
      })
      .catch(() => {});
  }, []);

  // Debounce filter changes (min/max typing), then refetch.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(filters), 350);
    return () => clearTimeout(t);
  }, [filters]);

  useEffect(() => {
    void load(debounced);
  }, [load, debounced]);

  const refresh = useCallback(() => {
    void load(debounced);
  }, [load, debounced]);

  const byStage = useMemo(() => {
    const map = new Map<Stage, Deal[]>();
    for (const s of STAGES) map.set(s, []);
    for (const d of deals) {
      const arr = map.get(d.stage);
      if (arr) arr.push(d);
    }
    return map;
  }, [deals]);

  const visibleStages: Stage[] =
    debounced.stage === "all" ? [...STAGES] : [debounced.stage as Stage];

  /* --- drag & drop --- */
  const handleDragStart = useCallback(
    (e: React.DragEvent, dealId: string) => {
      setDraggingId(dealId);
      e.dataTransfer.setData("text/plain", dealId);
      e.dataTransfer.effectAllowed = "move";
      pointerXRef.current = e.clientX;
      startAutoScroll();
    },
    [startAutoScroll],
  );

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setDragOver(null);
    stopAutoScroll();
  }, [stopAutoScroll]);

  const handleDrop = useCallback(
    async (e: React.DragEvent, stage: Stage) => {
      e.preventDefault();
      stopAutoScroll();
      const dealId = e.dataTransfer.getData("text/plain") || draggingId;
      setDragOver(null);
      if (!dealId) return;
      const deal = deals.find((d) => d.id === dealId);
      if (!deal || deal.stage === stage) return;
      const previous = deals;
      setDeals((ds) => ds.map((d) => (d.id === dealId ? { ...d, stage } : d)));
      const res = await moveDealStage({ data: { dealId, stage } });
      if (!res.ok) {
        setDeals(previous); // roll back — a failed write must not silently lose the drag
        if (res.reason === "not-signed-in") window.location.assign("/");
        else notify(friendlyError(res.reason));
      } else {
        void refresh();
      }
    },
    [deals, draggingId, notify, refresh],
  );

  /* --- modals / drawers --- */
  const openCreate = useCallback(() => {
    setEditingDeal(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((deal: Deal) => {
    setDetailId(null);
    setEditingDeal(deal);
    setFormOpen(true);
  }, []);

  const handleSaved = useCallback(
    (dealId?: string) => {
      setFormOpen(false);
      setEditingDeal(null);
      void refresh();
      if (dealId) setDetailId(dealId);
    },
    [refresh],
  );

  const filterCount =
    (filters.agentId !== "all" && filters.agentId !== session.id ? 1 : 0) +
    (filters.stage !== "all" ? 1 : 0) +
    (filters.plan !== "all" ? 1 : 0) +
    (filters.minMrr !== "" ? 1 : 0) +
    (filters.maxMrr !== "" ? 1 : 0);

  return (
    <div className="rise-in">
      {status === "not-connected" ? (
        <DbNotConnected onRetry={() => void load(debounced)} />
      ) : status === "error" ? (
        <ErrorState onRetry={() => void load(debounced)} />
      ) : status === "loading" ? (
        <LoadingState />
      ) : (
        <>
          {/* Header */}
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
                Pipeline
              </p>
              <h1 className="text-3xl font-semibold tracking-[-0.045em] text-gradient-violet sm:text-4xl">
                Deal pipeline
              </h1>
              <p className="mt-2 text-sm text-muted">
                Move deals through the stages as the sale progresses.
              </p>
            </div>
            <button type="button" onClick={openCreate} className="btn-primary">
              {Icons.plus}
              New deal
            </button>
          </div>

          {/* Filters */}
          <MorningBriefing />
          <FilterBar
            filters={filters}
            onFilterChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
            onReset={() =>
              setFilters({
                agentId: session.role === "owner" ? "all" : session.id,
                stage: "all",
                plan: "all",
                minMrr: "",
                maxMrr: "",
              })
            }
            users={users}
            me={me}
          />

          {/* Board */}
          <div ref={boardRef} className="scroll-thin -mx-1 overflow-x-auto px-1 pb-2">
            <div className="flex h-[calc(100dvh-285px)] min-h-[420px] items-stretch gap-4">
              {visibleStages.map((stage) => (
                <StageColumn
                  key={stage}
                  stage={stage}
                  deals={byStage.get(stage) ?? []}
                  draggingId={draggingId}
                  dragOver={dragOver}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDrop={handleDrop}
                  onDragOverStage={(s) => setDragOver(s)}
                  onDragLeaveStage={(s) => setDragOver((cur) => (cur === s ? null : cur))}
                  onOpenDeal={(id) => setDetailId(id)}
                />
              ))}
            </div>
            <p className="mt-2 text-[11px] text-white/25">
              {filterCount > 0
                ? `${deals.length} deal${deals.length === 1 ? "" : "s"} match your filters`
                : "Drag deals between stages to move them."}
            </p>
          </div>
        </>
      )}

      {formOpen ? (
        <DealFormModal
          deal={editingDeal}
          users={users}
          me={me}
          contacts={contacts}
          onClose={() => {
            setFormOpen(false);
            setEditingDeal(null);
          }}
          onSaved={handleSaved}
          notify={notify}
        />
      ) : null}

      {detailId ? (
        <DealDetailDrawer
          dealId={detailId}
          me={me}
          users={users}
          onClose={() => setDetailId(null)}
          onEdit={openEdit}
          onChanged={refresh}
          notify={notify}
        />
      ) : null}

      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}
