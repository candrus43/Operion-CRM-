/**
 * Operion CRM — AI morning briefing + stale-deal nudges.
 *
 * One generated summary per user per day, cached in the `briefings` table
 * (schema v4), so OpenAI is called AT MOST once per user per day. Every later
 * request for the same user on the same day short-circuits on the cached row —
 * a "Refresh" re-serves it, never burns another model call.
 *
 * Graceful degradation: when OPENAI_API_KEY is missing or the model call
 * fails, the briefing is built purely from the DB (recent activity + stale/
 * stuck/follow-up lists) with `aiGenerated: false` so the UI can show a small
 * "AI summary unavailable" note. The panel never errors and never crashes the
 * board.
 *
 * Client-safe surface: the pure helpers (STALE_DEAL_DAYS, isDealStale, …) are
 * imported by the pipeline board for the amber "Stale" badge. All server-only
 * imports (sql, readSession) are referenced ONLY inside the createServerFn
 * handler body, so they are tree-shaken out of client bundles — the same
 * pattern as ~/lib/pipeline.
 *
 * Neon driver quirks (critical): only literal tagged-template queries
 * (db`…`). No db.unsafe(), no db("string"), no transactions — multi-statement
 * work is sequential awaits.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "~/db";
import { readSession } from "./auth-core";
import { PLAN_PRICING, isPlan, type Plan } from "./pricing";
import type { DbStatus } from "./pipeline";

/* ------------------------------------------------------------------ */
/* Constants (shared with the board)                                   */
/* ------------------------------------------------------------------ */

/** A deal is "stale" when its effective last touch is this old (days). */
export const STALE_DEAL_DAYS = 7;
/** Proposal/Negotiation deals that haven't moved in this many days need attention. */
export const STUCK_DEAL_DAYS = 3;
/** "What changed" window — activity/new-deal horizon (hours). */
export const ACTIVITY_WINDOW_HOURS = 24;
/** Long activity histories are truncated to this many before summarization. */
export const ACTIVITY_TRUNCATE = 30;

const OPEN_STAGE_SET = new Set(["Lead", "Contacted", "Meeting", "Proposal", "Negotiation"]);
const STUCK_STAGE_SET = new Set(["Proposal", "Negotiation"]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Activities whose summary mentions "follow up" or "call" (case-insensitive). */
const FOLLOW_UP_RE = /follow[\s-]?up|\bcall\w*/i;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface BriefDeal {
  id: string;
  company: string;
  plan: Plan;
  stage: string;
  contact_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BriefActivity {
  id: string;
  deal_id: string;
  deal_company: string;
  type: string;
  summary: string | null;
  author_name: string | null;
  created_at: string;
}

/** Everything the briefing derives from, pre-computed for the prompt/fallback. */
export interface BriefingContext {
  deals: BriefDeal[];
  /** Activities in the last ACTIVITY_WINDOW_HOURS, newest first. */
  activities: BriefActivity[];
  newDeals: BriefDeal[];
  movedDeals: BriefDeal[];
  staleDeals: BriefDeal[];
  stuckDeals: BriefDeal[];
  followUps: BriefActivity[];
}

export type BriefingResult =
  | {
      ok: true;
      content: string;
      /** False when the summary fell back to the static DB-only rundown. */
      aiGenerated: boolean;
      /** True when the row already existed for today (no new model call). */
      cached: boolean;
      generatedAt: string;
      /** Live counts (not from the model) for the card's summary line. */
      staleCount: number;
      recentActivityCount: number;
      dealCount: number;
    }
  | { ok: false; reason: DbStatus };

/* ------------------------------------------------------------------ */
/* Pure staleness helpers (client-safe — used by the board's badge)    */
/* ------------------------------------------------------------------ */

/** Effective "last touched" time — last_activity_at, falling back to created_at. */
export function dealLastTouch(deal: Pick<BriefDeal, "last_activity_at" | "created_at">): Date {
  return new Date(deal.last_activity_at ?? deal.created_at);
}

/**
 * True when an OPEN deal's effective last touch (last_activity_at, else
 * created_at) is STALE_DEAL_DAYS or more in the past. Closed deals are never
 * stale — a closed deal no longer needs attention, so it never wears the amber
 * badge and never appears in the briefing's needs-attention list.
 */
export function isDealStale(deal: BriefDeal, now: Date = new Date()): boolean {
  if (!OPEN_STAGE_SET.has(deal.stage)) return false;
  const t = dealLastTouch(deal).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t >= STALE_DEAL_DAYS * MS_PER_DAY;
}

/** True when a Proposal/Negotiation deal hasn't moved (updated_at) in STUCK_DEAL_DAYS. */
export function isDealStuck(deal: BriefDeal, now: Date = new Date()): boolean {
  if (!STUCK_STAGE_SET.has(deal.stage)) return false;
  const t = new Date(deal.updated_at).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t >= STUCK_DEAL_DAYS * MS_PER_DAY;
}

/* ------------------------------------------------------------------ */
/* Context assembly (pure)                                             */
/* ------------------------------------------------------------------ */

function toBriefDeal(r: Record<string, unknown>): BriefDeal {
  const plan = isPlan(r.plan) ? r.plan : "Founder";
  return {
    id: String(r.id),
    company: String(r.company),
    plan,
    stage: String(r.stage),
    contact_name: r.contact_name == null ? null : String(r.contact_name),
    owner_id: r.owner_id == null ? null : String(r.owner_id),
    owner_name: r.owner_name == null ? null : String(r.owner_name),
    last_activity_at:
      r.last_activity_at == null ? null : new Date(r.last_activity_at as Date).toISOString(),
    created_at: new Date(r.created_at as Date).toISOString(),
    updated_at: new Date(r.updated_at as Date).toISOString(),
  };
}

function toBriefActivity(r: Record<string, unknown>): BriefActivity {
  return {
    id: String(r.id),
    deal_id: String(r.deal_id),
    deal_company: String(r.deal_company),
    type: String(r.type),
    summary: r.summary == null ? null : String(r.summary),
    author_name: r.author_name == null ? null : String(r.author_name),
    created_at: new Date(r.created_at as Date).toISOString(),
  };
}

export function buildBriefingContext(
  deals: BriefDeal[],
  activities: BriefActivity[],
  now: Date = new Date(),
): BriefingContext {
  const win = now.getTime() - ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000;
  const recent = activities
    .filter((a) => new Date(a.created_at).getTime() >= win)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const newDeals = deals
    .filter((d) => OPEN_STAGE_SET.has(d.stage) && new Date(d.created_at).getTime() >= win)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const newIds = new Set(newDeals.map((d) => d.id));
  const movedDeals = deals
    .filter(
      (d) =>
        OPEN_STAGE_SET.has(d.stage) &&
        !newIds.has(d.id) &&
        new Date(d.updated_at).getTime() >= win,
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const staleDeals = deals
    .filter((d) => isDealStale(d, now))
    .sort((a, b) => dealLastTouch(a).getTime() - dealLastTouch(b).getTime());
  const stuckDeals = deals
    .filter((d) => isDealStuck(d, now))
    .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
  const followUps = recent.filter((a) => a.summary != null && FOLLOW_UP_RE.test(a.summary));
  return {
    deals,
    activities: recent,
    newDeals,
    movedDeals,
    staleDeals,
    stuckDeals,
    followUps,
  };
}

/* ------------------------------------------------------------------ */
/* Human-ish time labels (shared by the prompt context + fallback)     */
/* ------------------------------------------------------------------ */

function hoursAgoLabel(iso: string, now: Date): string {
  const h = Math.max(1, Math.floor((now.getTime() - new Date(iso).getTime()) / 3_600_000));
  return h < 24 ? `${h}h ago` : daysAgoLabel(iso, now);
}

function daysAgoLabel(iso: string, now: Date): string {
  const d = Math.max(1, Math.floor((now.getTime() - new Date(iso).getTime()) / MS_PER_DAY));
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

function truncate(s: string | null, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function dealLine(d: BriefDeal): string {
  return `${d.company} | ${d.plan} | ${d.stage}`;
}

/* ------------------------------------------------------------------ */
/* Model prompt + fallback content                                     */
/* ------------------------------------------------------------------ */

const OPENAI_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `You are the sales operations assistant for Operion CRM, a small sales team that sells Operion subscriptions (Founder $249/mo, Studio $499/mo). Write the user's morning briefing from the CRM data below. Summarize ONLY what the data shows — never invent companies, names, dates, amounts, or facts, and never add advice the data doesn't support.

STRICT OUTPUT FORMAT — plain text only, exactly two sections. Every item is a bullet that starts with "- ":

## What changed in the last 24h
- one short sentence per item
## Needs attention
- one short sentence per item

Style rules:
- 150-250 words total. Short, specific sentences a salesperson can act on.
- Rewrite the data in your own words — do NOT copy or echo the raw "|" lines from the input, and never paste the input back.
- "What changed" covers new deals, deals updated in the last 24h (stage moves, edits, or logged activity), and logged activities. Name the company, plan, stage, and person when the data provides them.
- "Needs attention" covers stale deals (no activity for 7+ days), deals stuck in Proposal/Negotiation (no movement for 3+ days), and activities from the last 24h that mention "follow up" or "call".
- If a section has nothing in it, write exactly: - Nothing to flag.
- No other sections, no markdown bold/italics, no asterisks, no raw data dumps.

Example of the expected tone (not your data):
## What changed in the last 24h
- Acme Corp moved to Negotiation (Studio, $499/mo) — updated 2h ago by Dana.
- Dana logged a call on Acme Corp: "Follow up on pricing".
## Needs attention
- Stale Corp has had no activity for 10 days (Negotiation, Studio).
- Old Corp has been sitting in Proposal for 5 days without movement.`;

/** Compact CRM state fed to the model — long activity lists truncated. */
export function buildModelContext(ctx: BriefingContext, now: Date = new Date()): string {
  const parts: string[] = [];
  const dealLines = (ds: BriefDeal[], fmt: (d: BriefDeal) => string) =>
    ds.length === 0 ? "- none" : ds.map((d) => `- ${fmt(d)}`).join("\n");

  parts.push("NEW DEALS (created in the last 24h):");
  parts.push(dealLines(ctx.newDeals, (d) => `${dealLine(d)} | created ${hoursAgoLabel(d.created_at, now)}`));
  parts.push("");
  parts.push("DEALS UPDATED IN THE LAST 24H (stage move, edit, or logged activity):");
  parts.push(dealLines(ctx.movedDeals, (d) => `${dealLine(d)} | updated ${hoursAgoLabel(d.updated_at, now)}`));
  parts.push("");
  parts.push(`ACTIVITIES (last 24h, newest first — latest ${ACTIVITY_TRUNCATE} shown):`);
  parts.push(
    ctx.activities.length === 0
      ? "- none"
      : ctx.activities
          .slice(0, ACTIVITY_TRUNCATE)
          .map(
            (a) =>
              `- [${a.type}] ${a.deal_company}${a.author_name ? ` by ${a.author_name}` : ""} — "${truncate(a.summary, 160)}" | ${hoursAgoLabel(a.created_at, now)}`,
          )
          .join("\n"),
  );
  parts.push("");
  parts.push("STALE DEALS (open, no activity for 7+ days):");
  parts.push(
    dealLines(ctx.staleDeals, (d) => `${dealLine(d)} | last touch ${daysAgoLabel(dealLastTouch(d).toISOString(), now)}`),
  );
  parts.push("");
  parts.push("STUCK DEALS (Proposal/Negotiation, no movement for 3+ days):");
  parts.push(dealLines(ctx.stuckDeals, (d) => `${dealLine(d)} | updated ${daysAgoLabel(d.updated_at, now)}`));
  parts.push("");
  parts.push("FOLLOW-UP FLAGGED (activity in last 24h mentioning 'follow up' or 'call'):");
  parts.push(
    ctx.followUps.length === 0
      ? "- none"
      : ctx.followUps
          .map(
            (a) =>
              `- ${a.deal_company} — "${truncate(a.summary, 160)}"${a.author_name ? ` (${a.author_name}` : " (unknown"}, ${hoursAgoLabel(a.created_at, now)})`,
          )
          .join("\n"),
  );
  return parts.join("\n");
}

/** Static fallback — built purely from the DB, same section format as the model. */
export function buildFallbackContent(ctx: BriefingContext, now: Date = new Date()): string {
  const changed: string[] = [];
  for (const d of ctx.newDeals) {
    changed.push(
      `New deal: ${d.company} — ${d.plan} ($${PLAN_PRICING[d.plan].mrr}/mo), ${d.stage}, added ${hoursAgoLabel(d.created_at, now)}`,
    );
  }
  for (const d of ctx.movedDeals) {
    changed.push(`Updated: ${d.company} — now in ${d.stage} (${hoursAgoLabel(d.updated_at, now)})`);
  }
  for (const a of ctx.activities.slice(0, 8)) {
    changed.push(
      `Activity: ${a.type} on ${a.deal_company}${a.author_name ? ` by ${a.author_name}` : ""} — "${truncate(a.summary, 90)}" (${hoursAgoLabel(a.created_at, now)})`,
    );
  }

  const attention: string[] = [];
  for (const d of ctx.staleDeals) {
    attention.push(
      `Stale: ${d.company} — no activity for ${daysAgoLabel(dealLastTouch(d).toISOString(), now)} (${d.stage})`,
    );
  }
  for (const d of ctx.stuckDeals) {
    attention.push(
      `Stuck: ${d.company} — in ${d.stage}, no movement for ${daysAgoLabel(d.updated_at, now)}`,
    );
  }
  for (const a of ctx.followUps) {
    attention.push(
      `Follow-up flagged: ${a.deal_company} — "${truncate(a.summary, 90)}" (${a.author_name ?? "unknown"}, ${hoursAgoLabel(a.created_at, now)})`,
    );
  }

  return [
    "## What changed in the last 24h",
    ...(changed.length === 0 ? ["- Nothing changed in the last 24h."] : changed.map((c) => `- ${c}`)),
    "## Needs attention",
    ...(attention.length === 0
      ? ["- Nothing needs attention right now."]
      : attention.map((a) => `- ${a}`)),
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* OpenAI (server-only)                                                */
/* ------------------------------------------------------------------ */

async function callOpenAI(ctx: BriefingContext, now: Date): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.3,
      max_tokens: 450,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildModelContext(ctx, now) },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI returned empty content");
  }
  return content.trim();
}

/* ------------------------------------------------------------------ */
/* Data access (server-only, ownership-scoped)                         */
/* ------------------------------------------------------------------ */

async function fetchBriefingData(
  db: ReturnType<typeof sql>,
  userId: string,
  role: string,
): Promise<{ deals: BriefDeal[]; activities: BriefActivity[] }> {
  // Two fully-literal variants (owner vs agent) — Neon's driver only accepts
  // literal tagged-template queries; SQL text can never be spliced in via
  // interpolation (interpolated strings become bind parameters). The agent
  // variant pins `d.owner_id = ${userId}` — the same ownership guard
  // dealQueryScope uses; the owner sees every deal.
  const deals =
    role === "owner"
      ? await db`
          select d.id, d.company, d.plan, d.stage, d.contact_name, d.owner_id,
                 u.name as owner_name, d.last_activity_at, d.created_at, d.updated_at
          from deals d left join users u on u.id = d.owner_id
          order by d.updated_at desc
        `
      : await db`
          select d.id, d.company, d.plan, d.stage, d.contact_name, d.owner_id,
                 u.name as owner_name, d.last_activity_at, d.created_at, d.updated_at
          from deals d left join users u on u.id = d.owner_id
          where d.owner_id = ${userId}
          order by d.updated_at desc
        `;
  const activities =
    role === "owner"
      ? await db`
          select a.id, a.deal_id, a.type, a.summary, a.created_at,
                 u.name as author_name, d.company as deal_company
          from activities a
          join deals d on d.id = a.deal_id
          left join users u on u.id = a.author_id
          where a.created_at > now() - interval '24 hours'
          order by a.created_at desc
        `
      : await db`
          select a.id, a.deal_id, a.type, a.summary, a.created_at,
                 u.name as author_name, d.company as deal_company
          from activities a
          join deals d on d.id = a.deal_id
          left join users u on u.id = a.author_id
          where a.created_at > now() - interval '24 hours'
            and d.owner_id = ${userId}
          order by a.created_at desc
        `;
  return {
    deals: deals.map((r) => toBriefDeal(r as Record<string, unknown>)),
    activities: activities.map((r) => toBriefActivity(r as Record<string, unknown>)),
  };
}

/* ------------------------------------------------------------------ */
/* Server function                                                     */
/* ------------------------------------------------------------------ */

/**
 * Today's morning briefing for the signed-in user (owner sees all deals,
 * agents only their own). Cached per user per day in `briefings` — one OpenAI
 * call per user per day, ever; a cached row is re-served (cached: true) with
 * zero model calls. Generation falls back to the static DB-only rundown when
 * the key is missing or the model call fails, so this never throws to the UI.
 */
export const getBriefing = createServerFn({ method: "GET" }).handler(
  async (): Promise<BriefingResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();
      const { deals, activities } = await fetchBriefingData(db, user.id, user.role);
      const now = new Date();
      const ctx = buildBriefingContext(deals, activities, now);

      const today = now.toISOString().slice(0, 10); // UTC calendar date
      const cached = await db`
        select content, ai_generated, generated_at
        from briefings
        where user_id = ${user.id} and briefing_date = ${today}
        limit 1
      `;
      if (cached.length > 0) {
        return {
          ok: true,
          content: String(cached[0].content),
          aiGenerated:
            cached[0].ai_generated === true || cached[0].ai_generated === "true",
          cached: true,
          generatedAt: new Date(cached[0].generated_at as Date).toISOString(),
          staleCount: ctx.staleDeals.length,
          recentActivityCount: ctx.activities.length,
          dealCount: ctx.deals.length,
        };
      }

      // No row for today — generate (this is the day's single regen).
      let content = buildFallbackContent(ctx, now);
      let aiGenerated = false;
      if (process.env.OPENAI_API_KEY) {
        try {
          content = await callOpenAI(ctx, now);
          aiGenerated = true;
          console.log(`[operion-crm] briefing: OpenAI summary generated for ${user.email}`);
        } catch (err) {
          console.error(
            "[operion-crm] briefing: AI generation failed — serving static rundown:",
            err,
          );
        }
      }

      await db`
        insert into briefings (user_id, briefing_date, content, ai_generated)
        values (${user.id}, ${today}, ${content}, ${aiGenerated})
        on conflict (user_id, briefing_date)
        do update set content = excluded.content, ai_generated = excluded.ai_generated,
                      generated_at = now()
      `;

      return {
        ok: true,
        content,
        aiGenerated,
        cached: false,
        generatedAt: now.toISOString(),
        staleCount: ctx.staleDeals.length,
        recentActivityCount: ctx.activities.length,
        dealCount: ctx.deals.length,
      };
    } catch (err) {
      console.error("[operion-crm] getBriefing failed:", err);
      return { ok: false, reason: "db-error" };
    }
  },
);
