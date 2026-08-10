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
import { PLAN_PRICING, annualValue, firstYearValue, isPlan, type Plan } from "./pricing";

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
  /** Computed from the plan (setup + annual) — never stored. */
  firstYear: number;
  stage: Stage;
  owner_id: string | null;
  owner_name: string | null;
  next_step: string | null;
  notes: string | null;
  last_activity_at: string | null;
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
    stage: String(r.stage) as Stage,
    owner_id: r.owner_id == null ? null : String(r.owner_id),
    owner_name: r.owner_name == null ? null : String(r.owner_name),
    next_step: r.next_step == null ? null : String(r.next_step),
    notes: r.notes == null ? null : String(r.notes),
    last_activity_at:
      r.last_activity_at == null ? null : new Date(r.last_activity_at as Date).toISOString(),
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
    extra.push(`owner_id = ${next()}`);
    extraArgs.push(f.agentId);
  }
  if (f.stage) {
    extra.push(`stage = ${next()}`);
    extraArgs.push(f.stage);
  }
  if (f.plan) {
    extra.push(`plan = ${next()}`);
    extraArgs.push(f.plan);
  }
  // MRR is derived from the plan in code (not a column), so match it with a
  // CASE expression over the plan constants — Founder 249 / Studio 499.
  const mrrExpr = `case plan when 'Founder' then ${PLAN_PRICING.Founder.mrr} else ${PLAN_PRICING.Studio.mrr} end`;
  if (f.minMrr != null && Number.isFinite(f.minMrr)) {
    extra.push(`${mrrExpr} >= ${next()}`);
    extraArgs.push(f.minMrr);
  }
  if (f.maxMrr != null && Number.isFinite(f.maxMrr)) {
    extra.push(`${mrrExpr} <= ${next()}`);
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
      const rows = await db.query(q.sql, q.args);
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

      sets.push(`updated_at = ${args.length + 1}`);
      args.push(new Date());
      await db.query(
        `update deals set ${sets.join(", ")} where id = ${args.length + 1}`,
        [...args, data.dealId],
      );
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
      await db`
        update deals set stage = ${data.stage}, updated_at = now()
        where id = ${data.dealId}
      `;
      return { ok: true };
    } catch (err) {
      console.error("[operion-crm] moveDealStage failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });
