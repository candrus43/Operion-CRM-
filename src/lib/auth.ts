/**
 * Operion CRM — authentication & authorization (client-safe surface).
 *
 * Exports TanStack Start server functions (client-safe RPC fetchers) plus the
 * pure data-scoping helper. All server-only code (crypto, cookies, database)
 * lives in `~/lib/auth-core` and is referenced ONLY from inside handler
 * bodies, so it is tree-shaken out of client bundles — the client never
 * receives node builtins or database code.
 *
 * Database access goes exclusively through the `sql()` helper from `~/db`,
 * which throws a clear "DATABASE_URL is not set" error when the database has
 * not been connected yet. Every handler catches that and degrades gracefully —
 * the login page renders fine and shows a "database not connected" message;
 * nothing ever crashes the server.
 */
import { createServerFn } from "@tanstack/react-start";
import { deleteCookie } from "@tanstack/react-start/server";
import { sql } from "~/db";

export type { Role, SessionUser } from "./auth-core";
import {
  changePasswordCore,
  ensureSchemaFull,
  loginCore,
  logoutCore,
  readSession,
  type ChangePasswordReason,
  type SessionUser,
} from "./auth-core";

/* ------------------------------------------------------------------ */
/* Server functions                                                    */
/* ------------------------------------------------------------------ */

/** Idempotent schema creation + first-run seeding. Returns the db status. */
export const ensureSchema = createServerFn({ method: "GET" }).handler(async () => {
  if (!process.env.DATABASE_URL) {
    return { ok: false as const, reason: "db-not-connected" };
  }
  try {
    await ensureSchemaFull(sql());
    return { ok: true as const };
  } catch (err) {
    console.error("[operion-crm] ensureSchema failed:", err);
    return { ok: false as const, reason: "db-error" };
  }
});

type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: string };

export const login = createServerFn({ method: "POST" }).handler(
  async ({ data }: { data: { email: string; password: string } }): Promise<LoginResult> => {
    try {
      return await loginCore(data.email, data.password);
    } catch (err) {
      console.error("[operion-crm] login failed:", err);
      return { ok: false, error: "Something went wrong while signing in. Please try again." };
    }
  },
);

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  await logoutCore();
  deleteCookie("operion_crm_session", { path: "/" });
  return { ok: true };
});

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: ChangePasswordReason; message: string };

/**
 * Self-service password change for the signed-in user (owner or agent).
 * Requires an active session; verifies the current password, enforces an 8-char
 * minimum on the new password, updates ONLY the session user's row, and revokes
 * their OTHER sessions (the current one stays alive). Password values are never
 * logged — the core never echoes them and the catch below logs only the error.
 */
export const changePassword = createServerFn({ method: "POST" })
  .validator((d: { currentPassword: string; newPassword: string }) => d)
  .handler(async ({ data }): Promise<ChangePasswordResult> => {
    try {
      return await changePasswordCore(data.currentPassword, data.newPassword);
    } catch (err) {
      console.error("[operion-crm] changePassword failed:", err);
      return {
        ok: false,
        reason: "db-error",
        message: "Something went wrong while changing your password. Please try again.",
      };
    }
  });

/** Current user or null. Safe to call with no database connected (returns null). */
export const getSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUser | null> => {
    if (!process.env.DATABASE_URL) return null;
    try {
      return await readSession();
    } catch (err) {
      console.error("[operion-crm] getSession failed:", err);
      return null;
    }
  },
);

/** Guard for owner-only server functions. Returns { user } or { error }. */
export const requireOwner = createServerFn({ method: "GET" }).handler(async () => {
  if (!process.env.DATABASE_URL) {
    return { user: null as SessionUser | null, error: "Database is not connected yet." };
  }
  try {
    const user = await readSession();
    if (!user) return { user: null, error: "Not signed in." };
    if (user.role !== "owner") return { user: null, error: "Owner access required." };
    return { user, error: null as string | null };
  } catch (err) {
    console.error("[operion-crm] requireOwner failed:", err);
    return { user: null, error: "Something went wrong." };
  }
});

/* ------------------------------------------------------------------ */
/* Data scoping                                                        */
/* ------------------------------------------------------------------ */

export interface DealQueryScope {
  /** Full SELECT statement for the current user's deal visibility. */
  sql: string;
  /** Bind parameters, in order. */
  args: unknown[];
}

/**
 * Data-scoping helper for deals. Owners see every deal; agents see only the
 * deals they own. Use it from server functions with `db.query(scope.sql,
 * scope.args)` (Neon's HTTP driver):
 *
 *   const scope = dealQueryScope(user);
 *   const rows = await db.query(scope.sql, scope.args);
 */
export function dealQueryScope(user: SessionUser): DealQueryScope {
  if (user.role === "owner") {
    return { sql: "select * from deals order by updated_at desc", args: [] };
  }
  return {
    sql: "select * from deals where owner_id = $1 order by updated_at desc",
    args: [user.id],
  };
}
