/**
 * Operion CRM — pipeline server functions (client-safe surface).
 *
 * Mirrors the pattern in `~/lib/auth`: all database/authorization code is
 * referenced only from inside `createServerFn` handler bodies, so it is
 * tree-shaken out of client bundles. Every handler:
 *   1. degrades to a clean `db-not-connected` result when DATABASE_URL is unset,
 *   2. re-reads the session (never trusts the client),
 *   3. scopes every read through `dealQueryScope(user)` and checks ownership on
 *      every write — owners manage any deal, agents only their own.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "~/db";
import { dealQueryScope, type DealQueryScope } from "./auth";
import { readSession, type SessionUser } from "./auth-core";
import {
  COMMISSION_RATE,
  PLAN_PRICING,
  STAGE_PROBABILITY,
  annualValue,
  commissionFor,
  firstYearValue,
  isPlan,
  type Plan,
} from "./pricing";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export const STAGES = [
  "Lead",
  "Contacted",
  "Meeting",
  "Proposal",
  "Negotiation",
  "Closed Won",
  "Closed Lost",
] as const;
export type Stage = (typeof STAGES)[number];

export interface PipelineUser {
  id: string;
  name: string;
  email: string;
  role: "owner" | "agent";
}

export interface Deal {
  id: string;
  company: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  /** Operion subscription plan — the only pricing input. */
  plan: Plan;
  /** Computed from the plan — never stored. */
  setupFee: number;
  /** Computed from the plan — never stored. */
  mrr: number;
  /** Computed from the plan (MRR × 12) — never stored. */
  annual: number;
  /**
   * Computed from the plan (setup fee + 11 × MRR — the revision-6 first-year
   * cash total: setup at signup, then 11 monthly charges from day 31).
   * Never stored.
   */
  firstYear: number;
  /** True once the Closed Won deal's setup fee was collected (commission earned). */
  setup_fee_collected: boolean;
  /** When the setup fee was marked collected (null until collected). */
  setup_fee_collected_at: string | null;
  stage: Stage;
  owner_id: string | null;
  owner_name: string | null;
  next_step: string | null;
  notes: string | null;
  last_activity_at: string | null;
  /** When a deal closed (won or lost) — reliable close date for MRR reporting. */
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The contact linked to a deal (via deals.contact_id), if any. */
export interface LinkedContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface Activity {
  id: string;
  deal_id: string;
  type: string;
  summary: string | null;
  author_name: string | null;
  created_at: string;
}

export interface DealFilters {
  agentId: string | null;
  stage: Stage | null;
  /** Filter by plan (null = all plans). */
  plan: Plan | null;
  /** Optional MRR range — matched against the deal plan's MRR. */
  minMrr: number | null;
  maxMrr: number | null;
}

export type DbStatus =
  | "db-not-connected"
  | "not-signed-in"
  | "db-error"
  | "forbidden"
  | "invalid";

export interface DealInput {
  company: string;
  /** Operion subscription plan — the only pricing input. Defaults to Founder. */
  plan?: Plan;
  contactId?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  stage: Stage;
  ownerId?: string | null;
  nextStep?: string | null;
  notes?: string | null;
}

export type WriteResult = { ok: true; dealId?: string } | { ok: false; reason: DbStatus };

/* ------------------------------------------------------------------ */
/* Shared helpers (server-only)                                        */
/* ------------------------------------------------------------------ */

const STAGE_SET = new Set<string>(STAGES);

function coerceDeal(r: Record<string, unknown>): Deal {
  const plan = isPlan(r.plan) ? r.plan : "Founder";
  const pricing = PLAN_PRICING[plan];
  return {
    id: String(r.id),
    company: String(r.company),
    contact_id: r.contact_id == null ? null : String(r.contact_id),
    contact_name: r.contact_name == null ? null : String(r.contact_name),
    contact_email: r.contact_email == null ? null : String(r.contact_email),
    contact_phone: r.contact_phone == null ? null : String(r.contact_phone),
    plan,
    setupFee: pricing.setupFee,
    mrr: pricing.mrr,
    annual: annualValue(plan),
    firstYear: firstYearValue(plan),
    setup_fee_collected: r.setup_fee_collected === true || r.setup_fee_collected === "true",
    setup_fee_collected_at:
      r.setup_fee_collected_at == null
        ? null
        : new Date(r.setup_fee_collected_at as Date).toISOString(),
    stage: String(r.stage) as Stage,
    owner_id: r.owner_id == null ? null : String(r.owner_id),
    owner_name: r.owner_name == null ? null : String(r.owner_name),
    next_step: r.next_step == null ? null : String(r.next_step),
    notes: r.notes == null ? null : String(r.notes),
    last_activity_at:
      r.last_activity_at == null ? null : new Date(r.last_activity_at as Date).toISOString(),
    closed_at: r.closed_at == null ? null : new Date(r.closed_at as Date).toISOString(),
    created_at: new Date(r.created_at as Date).toISOString(),
    updated_at: new Date(r.updated_at as Date).toISOString(),
  };
}

/**
 * Applies the board filters on top of the authorization scope from
 * `dealQueryScope`. The scope's WHERE clause (agent → `owner_id = $1`) is
 * preserved untouched — extra filter conditions are appended with AND, and
 * their bind parameters are numbered after the scope's own, so the scope is
 * the single source of deal visibility.
 */
function scopedWithFilters(user: SessionUser, f: DealFilters): DealQueryScope {
  const scope = dealQueryScope(user);
  const extra: string[] = [];
  const extraArgs: unknown[] = [];
  const next = () => scope.args.length + extraArgs.length + 1;

  if (f.agentId) {
    extra.push(`owner_id = $${next()}`);
    extraArgs.push(f.agentId);
  }
  if (f.stage) {
    extra.push(`stage = $${next()}`);
    extraArgs.push(f.stage);
  }
  if (f.plan) {
    extra.push(`plan = $${next()}`);
    extraArgs.push(f.plan);
  }
  // MRR is derived from the plan in code (not a column), so match it with a
  // CASE expression over the plan constants — Founder 249 / Studio 499.
  const mrrExpr = `case plan when 'Founder' then ${PLAN_PRICING.Founder.mrr} else ${PLAN_PRICING.Studio.mrr} end`;
  if (f.minMrr != null && Number.isFinite(f.minMrr)) {
    extra.push(`${mrrExpr} >= $${next()}`);
    extraArgs.push(f.minMrr);
  }
  if (f.maxMrr != null && Number.isFinite(f.maxMrr)) {
    extra.push(`${mrrExpr} <= $${next()}`);
    extraArgs.push(f.maxMrr);
  }

  if (extra.length === 0) return scope;
  // `dealQueryScope` always ends with `order by updated_at desc`.
  const base = scope.sql.replace(/\s+order by updated_at desc\s*$/, "");
  const sep = /\bwhere\b/i.test(base) ? " and " : " where ";
  return {
    sql: `${base}${sep}${extra.join(" and ")} order by updated_at desc`,
    args: [...scope.args, ...extraArgs],
  };
}

/** Fetches a deal with an ownership check baked into the SQL. */
async function fetchOwnedDeal(
  db: ReturnType<typeof sql>,
  user: SessionUser,
  dealId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db`
    select d.*, u.name as owner_name
    from deals d left join users u on u.id = d.owner_id
    where d.id = ${dealId}
      and (${user.role} = 'owner' or d.owner_id = ${user.id})
    limit 1
  `;
  return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
}

/**
 * Runs a dynamic SQL string (with positional `$1..$n` placeholders) through the
 * Neon driver's tagged-template path — the only call form that works in every
 * runtime. `db.query()` throws `ReferenceError: require is not defined` under
 * Vite's dev SSR module loader, so dynamic scoped/filter queries must go
 * through this instead.
 *
 * The SQL string is split at each `$n` marker so the driver re-inserts the bind
 * markers at exactly the same spots and pairs them with the values in order —
 * the resulting query text is identical to the original, and the values stay
 * parameterized (never `db.unsafe()`).
 */
export async function runDynamicQuery(
  db: ReturnType<typeof sql>,
  sqlText: string,
  args: unknown[],
): Promise<Record<string, unknown>[]> {
  const parts: string[] = [];
  let rest = sqlText;
  for (let i = 1; i <= args.length; i++) {
    const marker = "$" + i;
    const idx = rest.indexOf(marker);
    if (idx < 0) {
      throw new Error(`[operion-crm] runDynamicQuery: missing bind marker ${marker}`);
    }
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + marker.length);
  }
  parts.push(rest);
  const template = Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  const rows = await db(template, ...args);
  return rows as Record<string, unknown>[];
}
/**
 * Writes one row to the deal activity timeline and bumps the deal's
 * `last_activity_at` so the board's "last activity" chip stays in sync.
 * Non-fatal by design (mirrors markWon): the underlying deal mutation has
 * already succeeded, so a failed activity insert must never fail that call.
 */
async function recordActivity(
  db: ReturnType<typeof sql>,
  dealId: string,
  type: string,
  summary: string,
  authorId: string | null,
): Promise<void> {
  try {
    await db`
      insert into activities (deal_id, type, summary, author_id)
      values (${dealId}, ${type}, ${summary}, ${authorId})
    `;
    await db`
      update deals set last_activity_at = now(), updated_at = now() where id = ${dealId}
    `;
  } catch (err) {
    console.error("[operion-crm] activity insert failed (non-fatal):", err);
  }
}

/* ------------------------------------------------------------------ */
/* Server functions                                                    */
/* ------------------------------------------------------------------ */

export type UsersResult =
  | { ok: true; me: PipelineUser; users: PipelineUser[] }
  | { ok: false; reason: DbStatus };

/** Owner sees every user (for the agent filter + assignment); agents see themselves. */
export const listUsers = createServerFn({ method: "GET" }).handler(
  async (): Promise<UsersResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();
      const rows =
        user.role === "owner"
          ? await db`select id, name, email, role from users order by name asc`
          : await db`select id, name, email, role from users where id = ${user.id}`;
      return {
        ok: true,
        me: { id: user.id, name: user.name, email: user.email, role: user.role },
        users: rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          email: String(r.email),
          role: r.role as PipelineUser["role"],
        })),
      };
    } catch (err) {
      console.error("[operion-crm] listUsers failed:", err);
      return { ok: false, reason: "db-error" };
    }
  },
);

export type DealsResult =
  | { ok: true; deals: Deal[] }
  | { ok: false; reason: DbStatus };

/** Scoped + filtered deal list for the board. */
export const listDeals = createServerFn({ method: "POST" })
  .validator((d: DealFilters) => d)
  .handler(async ({ data }): Promise<DealsResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();
      const q = scopedWithFilters(user, data ?? { agentId: null, stage: null, plan: null, minMrr: null, maxMrr: null });
      const rows = await runDynamicQuery(db, q.sql, q.args);
      return { ok: true, deals: rows.map((r) => coerceDeal(r as Record<string, unknown>)) };
    } catch (err) {
      console.error("[operion-crm] listDeals failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });

export type DealDetailResult =
  | { ok: true; deal: Deal; activities: Activity[]; contact: LinkedContact | null }
  | { ok: false; reason: DbStatus };

/** Full deal + read-only activity timeline (agents can only open their own deals). */
export const getDealDetail = createServerFn({ method: "POST" })
  .validator((d: { dealId: string }) => d)
  .handler(async ({ data }): Promise<DealDetailResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();
      const deal = await fetchOwnedDeal(db, user, data.dealId);
      if (!deal) return { ok: false, reason: "forbidden" };

      // The linked contact record (if deals.contact_id is set) — the deal keeps
      // denormalized contact_name/email/phone as a snapshot, but the drawer
      // prefers the live contact row when one is linked.
      let contact: LinkedContact | null = null;
      if (deal.contact_id != null) {
        const cRows = await db`
          select id, name, email, phone from contacts where id = ${deal.contact_id} limit 1
        `;
        if (cRows.length > 0) {
          const c = cRows[0];
          contact = {
            id: String(c.id),
            name: String(c.name),
            email: c.email == null ? null : String(c.email),
            phone: c.phone == null ? null : String(c.phone),
          };
        }
      }

      const actRows = await db`
        select a.id, a.deal_id, a.type, a.summary, u.name as author_name, a.created_at
        from activities a left join users u on u.id = a.author_id
        where a.deal_id = ${data.dealId}
        order by a.created_at desc
      `;
      return {
        ok: true,
        deal: coerceDeal(deal),
        contact,
        activities: actRows.map((a) => ({
          id: String(a.id),
          deal_id: String(a.deal_id),
          type: String(a.type),
          summary: a.summary == null ? null : String(a.summary),
          author_name: a.author_name == null ? null : String(a.author_name),
          created_at: new Date(a.created_at as Date).toISOString(),
        })),
      };
    } catch (err) {
      console.error("[operion-crm] getDealDetail failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });

/** Create a deal. Agents are always assigned to themselves; only owners assign. */
export const createDeal = createServerFn({ method: "POST" })
  .validator((d: DealInput) => d)
  .handler(async ({ data }): Promise<WriteResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const company = (data.company ?? "").trim();
      if (!company || !STAGE_SET.has(data.stage)) return { ok: false, reason: "invalid" };
      if (data.plan !== undefined && !isPlan(data.plan)) return { ok: false, reason: "invalid" };
      const plan = data.plan ?? "Founder";
      const db = sql();
      const ownerId = user.role === "owner" && data.ownerId ? data.ownerId : user.id;
      const rows = await db`
        insert into deals (company, contact_id, contact_name, contact_email, contact_phone, plan, stage, owner_id, next_step, notes)
        values (
          ${company},
          ${data.contactId || null},
          ${data.contactName?.trim() || null},
          ${data.contactEmail?.trim() || null},
          ${data.contactPhone?.trim() || null},
          ${plan},
          ${data.stage},
          ${ownerId},
          ${data.nextStep?.trim() || null},
          ${data.notes?.trim() || null}
        )
        returning id
      `;
      // First row on the timeline — every deal starts with its creation event.
      await recordActivity(db, String(rows[0].id), "created", "Deal created", user.id);
      return { ok: true, dealId: String(rows[0].id) };
    } catch (err) {
      console.error("[operion-crm] createDeal failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });

export type UpdateDealInput = { dealId: string } & Partial<DealInput>;

/** Edit a deal (partial). Agents may only edit their own; owners may edit any. */
export const updateDeal = createServerFn({ method: "POST" })
  .validator((d: UpdateDealInput) => d)
  .handler(async ({ data }): Promise<WriteResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      if (data.stage !== undefined && !STAGE_SET.has(data.stage)) {
        return { ok: false, reason: "invalid" };
      }
      const db = sql();
      const owned = await fetchOwnedDeal(db, user, data.dealId);
      if (!owned) return { ok: false, reason: "forbidden" };

      const sets: string[] = [];
      const args: unknown[] = [];
      const push = (col: string, val: unknown) => {
        sets.push(`${col} = $${args.length + 1}`);
        args.push(val);
      };
      if (data.company !== undefined) {
        const c = (data.company ?? "").trim();
        if (!c) return { ok: false, reason: "invalid" };
        push("company", c);
      }
      if (data.contactName !== undefined) push("contact_name", data.contactName?.trim() || null);
      if (data.contactEmail !== undefined) push("contact_email", data.contactEmail?.trim() || null);
      if (data.contactPhone !== undefined) push("contact_phone", data.contactPhone?.trim() || null);
      // undefined → leave the link untouched; null → clear it (denormalized fields remain)
      if (data.contactId !== undefined) push("contact_id", data.contactId || null);
      if (data.plan !== undefined) {
        if (!isPlan(data.plan)) return { ok: false, reason: "invalid" };
        push("plan", data.plan);
      }
      if (data.stage !== undefined) push("stage", data.stage);
      if (user.role === "owner" && data.ownerId !== undefined) push("owner_id", data.ownerId || null);
      if (data.nextStep !== undefined) push("next_step", data.nextStep?.trim() || null);
      if (data.notes !== undefined) push("notes", data.notes?.trim() || null);
      if (sets.length === 0) return { ok: true };
      // Timeline diff — compare each submitted field against the pre-update
      // row so an unchanged field (the edit form always posts every field)
      // never produces a spurious activity row. Values are derived from the
      // plan in code, so a plan change is the only pricing edit to log.
      const s = (v: unknown) => (v == null ? null : String(v));
      const changes: { type: string; summary: string }[] = [];
      if (data.stage !== undefined && data.stage !== String(owned.stage)) {
        changes.push({ type: "stage", summary: `Stage changed to ${data.stage}` });
      }
      if (data.plan !== undefined && data.plan !== String(owned.plan)) {
        changes.push({ type: "plan", summary: `Plan changed to ${data.plan}` });
      }
      const contactChanged =
        (data.contactId !== undefined && s(data.contactId) !== s(owned.contact_id)) ||
        (data.contactName !== undefined &&
          s(data.contactName.trim() || null) !== s(owned.contact_name)) ||
        (data.contactEmail !== undefined &&
          s(data.contactEmail.trim() || null) !== s(owned.contact_email)) ||
        (data.contactPhone !== undefined &&
          s(data.contactPhone.trim() || null) !== s(owned.contact_phone));
      if (contactChanged) changes.push({ type: "contact", summary: "Contact updated" });
      if (data.company !== undefined && data.company.trim() !== String(owned.company)) {
        changes.push({ type: "edit", summary: `Company renamed to ${data.company.trim()}` });
      }
      if (data.nextStep !== undefined && s(data.nextStep.trim() || null) !== s(owned.next_step)) {
        changes.push({ type: "edit", summary: "Next step updated" });
      }
      if (data.notes !== undefined && s(data.notes.trim() || null) !== s(owned.notes)) {
        changes.push({ type: "edit", summary: "Notes updated" });
      }
      if (user.role === "owner" && data.ownerId !== undefined && s(data.ownerId) !== s(owned.owner_id)) {
        // Match reassignDeal's phrasing when we can resolve the new owner's name.
        const uRows = data.ownerId
          ? await db`select name from users where id = ${data.ownerId} limit 1`
          : [];
        const name = uRows.length > 0 && uRows[0].name != null ? String(uRows[0].name) : null;
        changes.push({
          type: "assignment",
          summary: name ? `Assigned to ${name}` : "Deal reassigned",
        });
      }

      sets.push(`updated_at = $${args.length + 1}`);
      args.push(new Date());
      await runDynamicQuery(
        db,
        `update deals set ${sets.join(", ")} where id = $${args.length + 1}`,
        [...args, data.dealId],
      );
      // Editing a deal can also close it — notify Operion when the persisted
      // stage transitioned into a closed stage (closed → closed is no new close).
      if (data.stage !== undefined && isClosedStage(data.stage) && !isClosedStage(String(owned.stage))) {
        await fireDealClosedWebhook({
          ...dealClosedPayload(data.dealId, data.stage, owned),
        });
      }
      // One timeline row per detected change (stage, plan, contact, details).
      for (const c of changes) {
        await recordActivity(db, data.dealId, c.type, c.summary, user.id);
      }
      return { ok: true };
    } catch (err) {
      console.error("[operion-crm] updateDeal failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });

/** Drag-and-drop: move a deal between stages (scope-checked). */
export const moveDealStage = createServerFn({ method: "POST" })
  .validator((d: { dealId: string; stage: Stage }) => d)
  .handler(async ({ data }): Promise<WriteResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      if (!STAGE_SET.has(data.stage)) return { ok: false, reason: "invalid" };
      const db = sql();
      const owned = await fetchOwnedDeal(db, user, data.dealId);
      if (!owned) return { ok: false, reason: "forbidden" };
      // A deal that lands on a closed stage gets a close date (kept if it was
      // already closed and is being re-moved between closed stages).
      await db`
        update deals
        set stage = ${data.stage}, updated_at = now(),
            closed_at = case
              when ${data.stage} in ('Closed Won', 'Closed Lost')
                then coalesce(closed_at, now())
              else closed_at
            end
        where id = ${data.dealId}
      `;
      // Notify Operion when the deal TRANSITIONS into a closed stage. A re-move
      // between two closed stages is not a new close — no duplicate webhook.
      if (isClosedStage(data.stage) && !isClosedStage(String(owned.stage))) {
        await fireDealClosedWebhook({
          ...dealClosedPayload(data.dealId, data.stage, owned),
        });
      }
      // Timeline row for the stage move (drag-and-drop and the drawer's
      // "Move to stage" select both land here). Same-stage no-ops are guarded
      // in the UI, but double-check server-side so re-drops log nothing.
      if (data.stage !== String(owned.stage)) {
        await recordActivity(db, data.dealId, "stage", `Stage changed to ${data.stage}`, user.id);
      }
      return { ok: true };
    } catch (err) {
      console.error("[operion-crm] moveDealStage failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });

/* ------------------------------------------------------------------ */
/* Operion deal-closed webhook                                         */
/* ------------------------------------------------------------------ */

/** True when `s` is one of the two closed stages (also a type guard). */
function isClosedStage(s: string): s is "Closed Won" | "Closed Lost" {
  return s === "Closed Won" || s === "Closed Lost";
}

interface DealClosedWebhookPayload {
  dealId: string;
  stage: "Closed Won" | "Closed Lost";
  plan: Plan;
  customerName: string | null;
  customerEmail: string | null;
  company: string;
  closedAt: string;
}

/**
 * Builds the deal-closed webhook payload from a persisted deal row. Only
 * `dealId` is required by Operion; the rest is useful context. `closedAt` is
 * the close-event timestamp (server now — the close just persisted).
 */
function dealClosedPayload(
  dealId: string,
  stage: "Closed Won" | "Closed Lost",
  row: Record<string, unknown>,
): DealClosedWebhookPayload {
  return {
    dealId,
    stage,
    plan: isPlan(row.plan) ? row.plan : "Founder",
    customerName: row.contact_name == null ? null : String(row.contact_name),
    customerEmail: row.contact_email == null ? null : String(row.contact_email),
    company: String(row.company),
    closedAt: new Date().toISOString(),
  };
}

/**
 * POSTs a deal-closed notification to Operion after a deal transitions into a
 * closed stage. NON-BLOCKING by contract: the caller has already persisted the
 * stage, and any failure here is logged and swallowed — never thrown — so a
 * slow or down Operion endpoint can never reject the close. Config comes from
 * env (`OPERION_DEAL_CLOSED_WEBHOOK_URL` / `OPERION_DEAL_CLOSED_WEBHOOK_TOKEN`);
 * when either is missing this is a no-op (one log line, request unaffected),
 * mirroring the payment-link handoff's "not configured" guard. Short 8s
 * timeout so a stalled Operion endpoint can't hold up the request path.
 */
async function fireDealClosedWebhook(payload: DealClosedWebhookPayload): Promise<void> {
  const url = process.env.OPERION_DEAL_CLOSED_WEBHOOK_URL;
  const token = process.env.OPERION_DEAL_CLOSED_WEBHOOK_TOKEN;
  if (!url || !token) {
    console.error(
      "[operion-crm] deal-closed webhook not configured (OPERION_DEAL_CLOSED_WEBHOOK_URL/TOKEN) — skipping",
    );
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status < 200 || res.status >= 300) {
      console.error(
        `[operion-crm] deal-closed webhook failed: Operion returned HTTP ${res.status} for deal ${payload.dealId}`,
      );
      return;
    }
    console.log(
      `[operion-crm] deal-closed webhook sent: deal ${payload.dealId} → ${payload.stage} (HTTP ${res.status})`,
    );
  } catch (err) {
    console.error(
      `[operion-crm] deal-closed webhook failed for deal ${payload.dealId}:`,
      err,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Operion payment-link handoff (Mark Won)                             */
/* ------------------------------------------------------------------ */

/** Operion's CRM handoff endpoint — emails the customer a Stripe payment link. */
const OPERION_PAYMENT_LINK_URL = "https://operion.ctonew.app/api/crm/send-payment-link";

export type MarkWonResult =
  | { ok: true; deal: Deal }
  | {
      ok: false;
      reason: DbStatus | "operion-error" | "not-negotiation" | "no-email";
      message: string;
    };

/**
 * Mark a Negotiation deal Won via Operion's payment-link handoff.
 *
 * The CRM never handles payment — Operion emails the customer a Stripe payment
 * link and owns the money. The deal only moves to Closed Won when Operion
 * ACCEPTS the request (2xx). Anything else (network failure, non-2xx, a
 * redirect to Operion's login wall) leaves the deal in Negotiation and returns
 * a clear, retryable message. Redirects are treated as FAILURE via
 * `redirect: "manual"` — a redirect to a login page must never be followed
 * into a false success.
 */
export const markWon = createServerFn({ method: "POST" })
  .validator((d: { dealId: string }) => d)
  .handler(async ({ data }): Promise<MarkWonResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const user = await readSession();
      if (!user) {
        return {
          ok: false,
          reason: "not-signed-in",
          message: "Your session expired. Please sign in again.",
        };
      }
      const db = sql();
      const row = await fetchOwnedDeal(db, user, data.dealId);
      if (!row) {
        return { ok: false, reason: "forbidden", message: "You don't have permission to do that." };
      }
      if (String(row.stage) !== "Negotiation") {
        return {
          ok: false,
          reason: "not-negotiation",
          message: "Only deals in Negotiation can be marked won.",
        };
      }

      const plan = isPlan(row.plan) ? row.plan : "Founder";
      const customerName = (
        row.contact_name == null ? String(row.company) : String(row.contact_name)
      ).trim();

      // Prefer the linked contact's live email, else the deal's snapshot —
      // mirrors what the deal drawer shows as the customer email.
      let customerEmail: string | null =
        row.contact_email == null ? null : String(row.contact_email).trim();
      if (row.contact_id != null) {
        const cRows = await db`select email from contacts where id = ${row.contact_id} limit 1`;
        if (cRows.length > 0 && cRows[0].email != null) {
          customerEmail = String(cRows[0].email).trim();
        }
      }
      if (!customerEmail) {
        return {
          ok: false,
          reason: "no-email",
          message: "This deal has no customer email — add a contact email before closing.",
        };
      }

      const apiKey = process.env.OPERION_API_KEY;
      if (!apiKey) {
        console.error("[operion-crm] markWon: OPERION_API_KEY is not configured");
        return {
          ok: false,
          reason: "operion-error",
          message: "The payment link service is not configured — contact the owner.",
        };
      }

      // POST the handoff. `redirect: "manual"` makes a redirect (e.g. to
      // Operion's login page) surface as a non-2xx failure, never a success.
      let res: Response;
      try {
        res = await fetch(OPERION_PAYMENT_LINK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({ customerEmail, customerName, plan }),
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        console.error("[operion-crm] markWon: payment-link request failed:", err);
        return {
          ok: false,
          reason: "operion-error",
          message:
            "Operion could not be reached — the payment link was not sent. Try again.",
        };
      }

      if (res.type === "opaqueredirect" || res.status === 0) {
        console.error("[operion-crm] markWon: Operion redirected (auth wall) — treated as failure");
        return {
          ok: false,
          reason: "operion-error",
          message: "Operion could not send the payment link (redirected — try again).",
        };
      }
      if (res.status < 200 || res.status >= 300) {
        console.error(`[operion-crm] markWon: Operion returned HTTP ${res.status}`);
        return {
          ok: false,
          reason: "operion-error",
          message: `Operion could not send the payment link (${res.status} — try again).`,
        };
      }

      // Operion accepted — the payment link email is on its way. Close the deal
      // and stamp the close date (drives "closed this month / quarter" MRR).
      await db`
        update deals
        set stage = 'Closed Won', last_activity_at = now(), updated_at = now(),
            closed_at = coalesce(closed_at, now())
        where id = ${data.dealId}
      `;
      // The Mark Won path persists Closed Won itself (not via updateDeal /
      // moveDealStage), so fire the deal-closed webhook explicitly here. It
      // always is a transition (the deal was in Negotiation). Non-blocking —
      // the close already succeeded; a webhook failure is logged, never thrown.
      await fireDealClosedWebhook({
        ...dealClosedPayload(data.dealId, "Closed Won", row),
        customerEmail,
      });
      try {
        await db`
          insert into activities (deal_id, type, summary, author_id)
          values (${data.dealId}, 'stage', ${`Closed Won — payment link sent to ${customerEmail}`}, ${user.id})
        `;
      } catch (err) {
        // Non-fatal: the close itself already succeeded.
        console.error("[operion-crm] markWon: activity insert failed (non-fatal):", err);
      }
      const dealRows = await db`
        select d.*, u.name as owner_name
        from deals d left join users u on u.id = d.owner_id
        where d.id = ${data.dealId}
        limit 1
      `;
      return { ok: true, deal: coerceDeal(dealRows[0] as Record<string, unknown>) };
    } catch (err) {
      console.error("[operion-crm] markWon failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  });

/* ------------------------------------------------------------------ */
/* Commission tracking (25% of the collected setup fee per Closed Won) */
/* ------------------------------------------------------------------ */

export type MarkSetupFeeResult =
  | { ok: true; deal: Deal }
  | { ok: false; reason: DbStatus | "not-won"; message: string };

/**
 * Mark a Closed Won deal's setup fee as collected. The deal owner (agent) marks
 * their own deal once they collect payment from the customer; the owner can
 * mark any deal. Commission is 25% of the setup fee — computed from the plan in
 * code, never typed. Returns the updated deal (with the new collection state).
 */
export const markSetupFeeCollected = createServerFn({ method: "POST" })
  .validator((d: { dealId: string }) => d)
  .handler(async ({ data }): Promise<MarkSetupFeeResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const user = await readSession();
      if (!user) {
        return {
          ok: false,
          reason: "not-signed-in",
          message: "Your session expired. Please sign in again.",
        };
      }
      const db = sql();
      const row = await fetchOwnedDeal(db, user, data.dealId);
      if (!row) {
        return { ok: false, reason: "forbidden", message: "You don't have permission to do that." };
      }
      if (String(row.stage) !== "Closed Won") {
        return {
          ok: false,
          reason: "not-won",
          message: "Only Closed Won deals earn commission — move the deal to Closed Won first.",
        };
      }

      await db`
        update deals
        set setup_fee_collected = true, setup_fee_collected_at = now(), updated_at = now()
        where id = ${data.dealId}
      `;
      const dealRows = await db`
        select d.*, u.name as owner_name
        from deals d left join users u on u.id = d.owner_id
        where d.id = ${data.dealId}
        limit 1
      `;
      return { ok: true, deal: coerceDeal(dealRows[0] as Record<string, unknown>) };
    } catch (err) {
      console.error("[operion-crm] markSetupFeeCollected failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  });

export type UnmarkSetupFeeResult =
  | { ok: true; deal: Deal }
  | { ok: false; reason: DbStatus | "not-won" | "owner-only"; message: string };

/**
 * Undo a setup-fee collection mark. OWNER-ONLY: agents get a clear "only the
 * owner can undo this" error. Resets both fields (collected flag + timestamp).
 */
export const unmarkSetupFeeCollected = createServerFn({ method: "POST" })
  .validator((d: { dealId: string }) => d)
  .handler(async ({ data }): Promise<UnmarkSetupFeeResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const user = await readSession();
      if (!user) {
        return {
          ok: false,
          reason: "not-signed-in",
          message: "Your session expired. Please sign in again.",
        };
      }
      if (user.role !== "owner") {
        return {
          ok: false,
          reason: "owner-only",
          message: "Only the owner can undo a collected mark.",
        };
      }
      const db = sql();
      const row = await fetchOwnedDeal(db, user, data.dealId);
      if (!row) {
        return { ok: false, reason: "forbidden", message: "You don't have permission to do that." };
      }

      await db`
        update deals
        set setup_fee_collected = false, setup_fee_collected_at = null, updated_at = now()
        where id = ${data.dealId}
      `;
      const dealRows = await db`
        select d.*, u.name as owner_name
        from deals d left join users u on u.id = d.owner_id
        where d.id = ${data.dealId}
        limit 1
      `;
      return { ok: true, deal: coerceDeal(dealRows[0] as Record<string, unknown>) };
    } catch (err) {
      console.error("[operion-crm] unmarkSetupFeeCollected failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  });

/* ------------------------------------------------------------------ */
/* Manual activity logging (call / email / meeting / note)             */
/* ------------------------------------------------------------------ */

/**
 * Types a USER may log manually. System-generated entries use other types
 * (`stage` from markWon; `assignment` from reassignDeal / owner edits) — those
 * are read-only and never selectable here, but the timeline renders them via
 * ACTIVITY_META.
 */
export const ACTIVITY_TYPES = ["call", "email", "meeting", "note"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

const ACTIVITY_TYPE_SET = new Set<string>(ACTIVITY_TYPES);
/** Matches the text column — summaries longer than this are rejected. */
const ACTIVITY_SUMMARY_MAX = 1000;

export type CreateActivityResult =
  | { ok: true; activity: Activity }
  | { ok: false; reason: DbStatus; message: string };

/**
 * Log a manual activity against a deal. Agents may only log on deals assigned
 * to them; the owner on any deal (same guard as every other deal mutation —
 * `fetchOwnedDeal`). Validates the type against the user-entered vocabulary and
 * the summary (trimmed, non-empty, ≤ 1000 chars), inserts with the current user
 * as author, bumps the deal's `last_activity_at` so the board chip stays
 * honest, and returns the new activity shaped exactly like `Activity` (author
 * name joined).
 */
export const createActivity = createServerFn({ method: "POST" })
  .validator((d: { dealId: string; type: string; summary: string }) => d)
  .handler(async ({ data }): Promise<CreateActivityResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const user = await readSession();
      if (!user) {
        return {
          ok: false,
          reason: "not-signed-in",
          message: "Your session expired. Please sign in again.",
        };
      }
      const type = (data.type ?? "").trim() as ActivityType;
      if (!ACTIVITY_TYPE_SET.has(type)) {
        return { ok: false, reason: "invalid", message: "Choose a valid activity type." };
      }
      const summary = (data.summary ?? "").trim();
      if (!summary) {
        return { ok: false, reason: "invalid", message: "Add a short summary for this activity." };
      }
      if (summary.length > ACTIVITY_SUMMARY_MAX) {
        return {
          ok: false,
          reason: "invalid",
          message: `Keep the summary under ${ACTIVITY_SUMMARY_MAX.toLocaleString()} characters.`,
        };
      }
      const db = sql();
      const owned = await fetchOwnedDeal(db, user, data.dealId);
      if (!owned) {
        return { ok: false, reason: "forbidden", message: "You don't have permission to do that." };
      }

      const rows = await db`
        insert into activities (deal_id, type, summary, author_id)
        values (${data.dealId}, ${type}, ${summary}, ${user.id})
        returning id, deal_id, type, summary, created_at
      `;
      // Keep the board's "last activity" chip in sync with the timeline.
      await db`
        update deals
        set last_activity_at = now(), updated_at = now()
        where id = ${data.dealId}
      `;
      const a = rows[0];
      return {
        ok: true,
        activity: {
          id: String(a.id),
          deal_id: String(a.deal_id),
          type: String(a.type),
          summary: a.summary == null ? null : String(a.summary),
          author_name: user.name,
          created_at: new Date(a.created_at as Date).toISOString(),
        },
      };
    } catch (err) {
      console.error("[operion-crm] createActivity failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  });

/** One commission ledger row (Closed Won deals only). */
export interface CommissionRow {
  dealId: string;
  company: string;
  plan: Plan;
  setupFee: number;
  /** 25% of the setup fee — computed from the plan, never stored. */
  commission: number;
  collected: boolean;
  collectedAt: string | null;
  ownerId: string;
  ownerName: string;
}

/** Per-agent (or per-user) commission totals. */
export interface CommissionTotals {
  pendingCommission: number;
  earnedCommission: number;
  dealCount: number;
}

/** Per-agent commission summary card data (owner view). */
export interface AgentCommissionSummary {
  id: string;
  name: string;
  totals: CommissionTotals;
}

export type CommissionSummaryResult =
  | {
      ok: true;
      rows: CommissionRow[];
      /** Overall totals: owner sees the whole team, agents see only their own. */
      totals: CommissionTotals;
      /** Per-agent summaries (role = 'agent', zeros included) — owner only. */
      agents: AgentCommissionSummary[] | null;
    }
  | { ok: false; reason: DbStatus };

/**
 * Commission ledger for the current user. Commissions are the agents' ledger:
 * an agent sees only their own Closed Won deals; the OWNER sees only AGENTS'
 * deals — the owner's own commission rows are hidden (the owner watches MRR,
 * not their own commissions). Commission is 25% of the plan's setup fee,
 * computed here from pricing — never typed. Rows order: collected deals first
 * (newest collection), then uncollected by recency.
 */
export const commissionSummary = createServerFn({ method: "POST" }).handler(
  async (): Promise<CommissionSummaryResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();
      let rows = await db`
        select d.id as deal_id, d.company, d.plan, d.owner_id, d.setup_fee_collected,
               d.setup_fee_collected_at, d.updated_at, u.name as owner_name
        from deals d left join users u on u.id = d.owner_id
        where d.stage = 'Closed Won'
          and (${user.role} = 'owner' or d.owner_id = ${user.id})
        order by d.setup_fee_collected_at desc nulls last, d.updated_at desc
      `;
      if (user.role === "owner") {
        // Commissions are the agents' ledger — the owner's own rows (and any
        // unassigned rows) are hidden from the owner's view.
        rows = rows.filter(
          (r) => r.owner_id != null && String(r.owner_id) !== user.id,
        );
      }

      const ledger: CommissionRow[] = rows.map((r) => {
        const plan = isPlan(r.plan) ? r.plan : "Founder";
        const collected = r.setup_fee_collected === true || r.setup_fee_collected === "true";
        return {
          dealId: String(r.deal_id),
          company: String(r.company),
          plan,
          setupFee: PLAN_PRICING[plan].setupFee,
          commission: commissionFor(plan),
          collected,
          collectedAt:
            r.setup_fee_collected_at == null
              ? null
              : new Date(r.setup_fee_collected_at as Date).toISOString(),
          ownerId: r.owner_id == null ? "" : String(r.owner_id),
          ownerName: r.owner_name == null ? "Unassigned" : String(r.owner_name),
        };
      });

      const totals: CommissionTotals = ledger.reduce(
        (acc, row) => {
          if (row.collected) acc.earnedCommission += row.commission;
          else acc.pendingCommission += row.commission;
          acc.dealCount += 1;
          return acc;
        },
        { pendingCommission: 0, earnedCommission: 0, dealCount: 0 },
      );

      // Owner view: per-agent summaries. Every role='agent' user appears (zeros
      // included); a Closed Won deal owned by the owner themselves is shown under
      // the owner's name, not an agent.
      let agents: AgentCommissionSummary[] | null = null;
      if (user.role === "owner") {
        const userRows = await db`select id, name, role from users order by name asc`;
        const byOwner = new Map<string, CommissionTotals>();
        for (const row of ledger) {
          const key = row.ownerId || "unassigned";
          const cur = byOwner.get(key) ?? { pendingCommission: 0, earnedCommission: 0, dealCount: 0 };
          if (row.collected) cur.earnedCommission += row.commission;
          else cur.pendingCommission += row.commission;
          cur.dealCount += 1;
          byOwner.set(key, cur);
        }
        agents = userRows
          .filter((u) => String(u.role) === "agent")
          .map((u) => ({
            id: String(u.id),
            name: String(u.name),
            totals: byOwner.get(String(u.id)) ?? {
              pendingCommission: 0,
              earnedCommission: 0,
              dealCount: 0,
            },
          }));
      }

      return { ok: true, rows: ledger, totals, agents: agents ?? null };
    } catch (err) {
      console.error("[operion-crm] commissionSummary failed:", err);
      return { ok: false, reason: "db-error" };
    }
  },
);

/* ------------------------------------------------------------------ */
/* MRR reporting (owner's business view on the Commissions tab)        */
/* ------------------------------------------------------------------ */

/** One per-agent row of the MRR breakdown table. */
export interface AgentMrrRow {
  id: string;
  name: string;
  /** Sum of MRR across the agent's open deals (not Closed Won/Lost). */
  openMrr: number;
  /** Sum of open-deal MRR × stage probability (forecast). */
  weightedMrr: number;
  /** Sum of MRR across the agent's Closed Won deals (actual). */
  closedWonMrr: number;
  /** Total deals owned (any stage). */
  dealCount: number;
}

export interface SummaryMetrics {
  /** Sum of MRR across open deals (not Closed Won/Lost). FORECAST input. */
  totalPipelineMrr: number;
  /** Sum of open-deal MRR × stage probability. FORECAST. */
  weightedPipelineMrr: number;
  /** MRR of Closed Won deals closed in the current calendar month (actual). */
  closedWonMrrThisMonth: number;
  /** MRR of Closed Won deals closed in the current calendar quarter (actual). */
  closedWonMrrThisQuarter: number;
  /** Mean MRR of Closed Won deals, all time (actual). */
  avgDealSize: number;
  /** Closed Won ÷ (Closed Won + Closed Lost) as a percentage, 0 when none. */
  winRate: number;
  openDealCount: number;
  closedWonCount: number;
  closedLostCount: number;
}

export type ReportsSummaryResult =
  | { ok: true; metrics: SummaryMetrics; agents: AgentMrrRow[] | null }
  | { ok: false; reason: DbStatus };

const OPEN_STAGE_SET = new Set<string>([
  "Lead",
  "Contacted",
  "Meeting",
  "Proposal",
  "Negotiation",
]);

/** Round money to cents so displayed totals never carry float noise. */
function roundMoney(v: number): number {
  return Math.round(v * 100) / 100;
}

/** True when `d` (UTC) falls in the calendar month containing `now` (UTC). */
function inCurrentMonthUtc(d: Date, now: Date): boolean {
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth()
  );
}

/** [start, end) bounds of the calendar quarter (UTC) containing `now`. */
function currentQuarterBoundsUtc(now: Date): { start: Date; end: Date } {
  const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), qStartMonth, 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), qStartMonth + 3, 1)),
  };
}

/**
 * MRR summary for the Commissions tab (the owner's business view). Session
 * scoped: the owner sees team-wide numbers (all deals), an agent sees only
 * their own deals. All figures are computed from deal rows + the pricing
 * constants (PLAN_PRICING / STAGE_PROBABILITY) — nothing is stored or typed.
 *
 * Calendar buckets (month/quarter) use UTC on the close date (closed_at), the
 * same clock the server and the DB timestamps run on.
 */
export const reportsSummary = createServerFn({ method: "POST" }).handler(
  async (): Promise<ReportsSummaryResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();
      // dealQueryScope: owner → every deal; agent → only their own.
      const scope = dealQueryScope(user);
      const rows = await runDynamicQuery(db, scope.sql, scope.args);
      const deals = rows.map((r) => coerceDeal(r as Record<string, unknown>));

      const now = new Date();
      const { start: qStart, end: qEnd } = currentQuarterBoundsUtc(now);

      let totalPipelineMrr = 0;
      let weightedPipelineMrr = 0;
      let closedWonMrrThisMonth = 0;
      let closedWonMrrThisQuarter = 0;
      let closedWonMrrAll = 0;
      let openDealCount = 0;
      let closedWonCount = 0;
      let closedLostCount = 0;

      for (const d of deals) {
        if (d.stage === "Closed Won") {
          closedWonCount += 1;
          closedWonMrrAll += d.mrr;
          if (d.closed_at) {
            const closed = new Date(d.closed_at);
            if (inCurrentMonthUtc(closed, now)) closedWonMrrThisMonth += d.mrr;
            if (closed >= qStart && closed < qEnd) closedWonMrrThisQuarter += d.mrr;
          }
        } else if (d.stage === "Closed Lost") {
          closedLostCount += 1;
        } else if (OPEN_STAGE_SET.has(d.stage)) {
          openDealCount += 1;
          totalPipelineMrr += d.mrr;
          weightedPipelineMrr += d.mrr * (STAGE_PROBABILITY[d.stage] ?? 0);
        }
      }

      const wonPlusLost = closedWonCount + closedLostCount;
      const winRate = wonPlusLost > 0 ? (closedWonCount / wonPlusLost) * 100 : 0;
      const metrics: SummaryMetrics = {
        totalPipelineMrr: roundMoney(totalPipelineMrr),
        weightedPipelineMrr: roundMoney(weightedPipelineMrr),
        closedWonMrrThisMonth: roundMoney(closedWonMrrThisMonth),
        closedWonMrrThisQuarter: roundMoney(closedWonMrrThisQuarter),
        avgDealSize: roundMoney(closedWonCount > 0 ? closedWonMrrAll / closedWonCount : 0),
        winRate: Math.round(winRate * 10) / 10,
        openDealCount,
        closedWonCount,
        closedLostCount,
      };

      // Per-agent breakdown (MRR only — commissions live in the ledger below).
      // Owner: every role='agent' user, zeros included. Agent: their own row.
      const byOwner = new Map<
        string,
        { openMrr: number; weightedMrr: number; closedWonMrr: number; dealCount: number }
      >();
      for (const d of deals) {
        if (!d.owner_id) continue; // unassigned deals count in team metrics only
        const cur =
          byOwner.get(d.owner_id) ??
          { openMrr: 0, weightedMrr: 0, closedWonMrr: 0, dealCount: 0 };
        cur.dealCount += 1;
        if (d.stage === "Closed Won") {
          cur.closedWonMrr += d.mrr;
        } else if (d.stage !== "Closed Lost") {
          cur.openMrr += d.mrr;
          cur.weightedMrr += d.mrr * (STAGE_PROBABILITY[d.stage] ?? 0);
        }
        byOwner.set(d.owner_id, cur);
      }

      let agents: AgentMrrRow[] | null = null;
      if (user.role === "owner") {
        const userRows = await db`select id, name, role from users order by name asc`;
        agents = userRows
          .filter((u) => String(u.role) === "agent")
          .map((u) => {
            const mine = byOwner.get(String(u.id)) ?? {
              openMrr: 0,
              weightedMrr: 0,
              closedWonMrr: 0,
              dealCount: 0,
            };
            return {
              id: String(u.id),
              name: String(u.name),
              openMrr: roundMoney(mine.openMrr),
              weightedMrr: roundMoney(mine.weightedMrr),
              closedWonMrr: roundMoney(mine.closedWonMrr),
              dealCount: mine.dealCount,
            };
          });
      } else {
        const mine = byOwner.get(user.id) ?? {
          openMrr: 0,
          weightedMrr: 0,
          closedWonMrr: 0,
          dealCount: 0,
        };
        agents = [
          {
            id: user.id,
            name: user.name,
            openMrr: roundMoney(mine.openMrr),
            weightedMrr: roundMoney(mine.weightedMrr),
            closedWonMrr: roundMoney(mine.closedWonMrr),
            dealCount: mine.dealCount,
          },
        ];
      }

      return { ok: true, metrics, agents };
    } catch (err) {
      console.error("[operion-crm] reportsSummary failed:", err);
      return { ok: false, reason: "db-error" };
    }
  },
);
