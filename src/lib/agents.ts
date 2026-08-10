/**
 * Operion CRM — agent management server functions (owner admin).
 *
 * Owner-only surface for onboarding real agents: create agent accounts, list the
 * roster with deal counts, and reassign deals between users. Every handler
 * re-reads the session server-side (never trusts the client) and returns a clear
 * "owner only" error when an agent calls in — agents keep seeing only their own
 * deals; the existing deal scoping (`dealQueryScope`) is untouched.
 *
 * Result shapes follow the `~/lib/pipeline` convention: `{ ok: true, ... }` on
 * success, `{ ok: false, reason, message }` on failure with a human-readable
 * message ready for inline display.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "~/db";
import { hashPassword, readSession } from "./auth-core";
import type { DbStatus } from "./pipeline";

/** One roster row — a role='agent' user with their deal counts. */
export interface AgentInfo {
  id: string;
  name: string;
  email: string;
  created_at: string;
  /** Deals in an open stage (not Closed Won / Closed Lost). */
  openDeals: number;
  /** All deals owned, any stage. */
  totalDeals: number;
}

export type AgentErrorReason =
  | DbStatus
  | "owner-only"
  | "invalid-email"
  | "short-password"
  | "duplicate-email"
  | "not-found";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Returns the current user, or the standard not-signed-in error result. */
async function requireOwner(): Promise<
  | { user: NonNullable<Awaited<ReturnType<typeof readSession>>> }
  | { error: { ok: false; reason: DbStatus | "owner-only"; message: string } }
> {
  const user = await readSession();
  if (!user) {
    return {
      error: {
        ok: false,
        reason: "not-signed-in",
        message: "Your session expired. Please sign in again.",
      },
    };
  }
  if (user.role !== "owner") {
    return { error: { ok: false, reason: "owner-only", message: "Only the owner can manage agents." } };
  }
  return { user };
}

/* ------------------------------------------------------------------ */
/* Server functions                                                    */
/* ------------------------------------------------------------------ */

export type CreateAgentResult =
  | { ok: true; agent: { id: string; name: string; email: string } }
  | { ok: false; reason: AgentErrorReason; message: string };

/**
 * Create an agent account. OWNER-ONLY. Validates email format + password length
 * (min 8), rejects duplicate emails with a clear message, hashes the password
 * with the shared scrypt `hashPassword`, and inserts a role='agent' user.
 * Returns only { id, name, email } — the password hash never leaves the server.
 */
export const createAgent = createServerFn({ method: "POST" })
  .validator((d: { name: string; email: string; password: string }) => d)
  .handler(async ({ data }): Promise<CreateAgentResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    const name = (data.name ?? "").trim();
    const email = (data.email ?? "").trim().toLowerCase();
    const password = data.password ?? "";
    try {
      const guard = await requireOwner();
      if ("error" in guard) return guard.error;

      if (!name) return { ok: false, reason: "invalid", message: "Enter the agent's name." };
      if (!EMAIL_RE.test(email)) {
        return { ok: false, reason: "invalid-email", message: "Enter a valid email address." };
      }
      if (password.length < 8) {
        return {
          ok: false,
          reason: "short-password",
          message: "Password must be at least 8 characters.",
        };
      }

      const db = sql();
      const existing = await db`select id from users where email = ${email} limit 1`;
      if (existing.length > 0) {
        return {
          ok: false,
          reason: "duplicate-email",
          message: `An account with ${email} already exists.`,
        };
      }
      const rows = await db`
        insert into users (name, email, password_hash, role)
        values (${name}, ${email}, ${hashPassword(password)}, 'agent')
        returning id, name, email
      `;
      const a = rows[0];
      return {
        ok: true,
        agent: { id: String(a.id), name: String(a.name), email: String(a.email) },
      };
    } catch (err) {
      // Unique-violation race (two creates in flight) — same clear message as the pre-check.
      if ((err as { code?: string }).code === "23505") {
        return {
          ok: false,
          reason: "duplicate-email",
          message: `An account with ${email} already exists.`,
        };
      }
      console.error("[operion-crm] createAgent failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  });

export type ListAgentsResult =
  | { ok: true; agents: AgentInfo[] }
  | { ok: false; reason: AgentErrorReason; message: string };

/**
 * Roster of all role='agent' users with their open + total deal counts.
 * OWNER-ONLY — agents get a clear error instead of a roster.
 */
export const listAgents = createServerFn({ method: "GET" }).handler(
  async (): Promise<ListAgentsResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const guard = await requireOwner();
      if ("error" in guard) return guard.error;

      const db = sql();
      const rows = await db`
        select u.id, u.name, u.email, u.created_at,
          count(d.id) filter (where d.stage not in ('Closed Won', 'Closed Lost')) as open_deals,
          count(d.id) as total_deals
        from users u
        left join deals d on d.owner_id = u.id
        where u.role = 'agent'
        group by u.id
        order by u.name asc
      `;
      return {
        ok: true,
        agents: rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          email: String(r.email),
          created_at: new Date(r.created_at as Date).toISOString(),
          openDeals: Number(r.open_deals),
          totalDeals: Number(r.total_deals),
        })),
      };
    } catch (err) {
      console.error("[operion-crm] listAgents failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  },
);

export type ReassignDealResult =
  | { ok: true; dealId: string; ownerId: string }
  | { ok: false; reason: AgentErrorReason; message: string };

/**
 * Move a deal to another user (agent or owner). OWNER-ONLY — agents get a clear
 * error. Validates that both the deal and the target user exist, updates the
 * deal's owner, and records a non-fatal activity note on the deal timeline.
 */
export const reassignDeal = createServerFn({ method: "POST" })
  .validator((d: { dealId: string; newOwnerId: string }) => d)
  .handler(async ({ data }): Promise<ReassignDealResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const guard = await requireOwner();
      if ("error" in guard) return guard.error;

      const db = sql();
      const dealRows = await db`select id from deals where id = ${data.dealId} limit 1`;
      if (dealRows.length === 0) {
        return { ok: false, reason: "not-found", message: "That deal no longer exists." };
      }
      const userRows = await db`select id, name from users where id = ${data.newOwnerId} limit 1`;
      if (userRows.length === 0) {
        return { ok: false, reason: "not-found", message: "That user no longer exists." };
      }

      await db`
        update deals
        set owner_id = ${data.newOwnerId}, updated_at = now()
        where id = ${data.dealId}
      `;
      try {
        await db`
          insert into activities (deal_id, type, summary, author_id)
          values (${data.dealId}, 'note', ${`Assigned to ${String(userRows[0].name)}`}, ${guard.user.id})
        `;
      } catch (err) {
        // Non-fatal: the reassignment itself already succeeded.
        console.error("[operion-crm] reassignDeal: activity insert failed (non-fatal):", err);
      }
      return { ok: true, dealId: data.dealId, ownerId: data.newOwnerId };
    } catch (err) {
      console.error("[operion-crm] reassignDeal failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  });
