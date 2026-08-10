/**
 * Operion CRM — server-only auth internals.
 *
 * ⚠️ SERVER-ONLY. This module imports node builtins (`node:crypto`),
 * `@tanstack/react-start/server` (request/cookie access) and the database
 * helper. It must NEVER be imported from client code or from module scope of
 * a file that ships to the client — import it only from inside `createServerFn`
 * handler bodies so it is tree-shaken out of client bundles.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getCookie, getRequestProtocol, setCookie } from "@tanstack/react-start/server";
import { sql } from "~/db";

export type Role = "owner" | "agent";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export const SESSION_COOKIE = "operion_crm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_TTL_S = 30 * 24 * 60 * 60;

/** Seed credentials — created once, on first schema init (see `seedIfNeeded`). */
const SEED_OWNER_EMAIL = "owner@operioncrm.com";
const SEED_AGENT_EMAIL = "agent@operioncrm.com";
/** Randomly generated throwaway passwords (override via env before first seed). */
const SEED_OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "cl4P84S384Yi9XLE";
const SEED_AGENT_PASSWORD = process.env.SEED_AGENT_PASSWORD ?? "uFGRZvzbpduDqcTE";

/* ------------------------------------------------------------------ */
/* Password hashing (Node built-in scrypt — no bcrypt dependency)      */
/* ------------------------------------------------------------------ */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/* ------------------------------------------------------------------ */
/* Session tokens                                                      */
/* ------------------------------------------------------------------ */

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Store only the SHA-256 of the token in the DB; the raw token lives in the cookie. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieOptions(expires: Date | null): Record<string, unknown> {
  return {
    httpOnly: true,
    secure: getRequestProtocol() === "https", // Secure on the deployed https sites
    sameSite: "lax",
    path: "/",
    ...(expires ? { expires, maxAge: SESSION_TTL_S } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Schema + seed                                                       */
/* ------------------------------------------------------------------ */

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'agent')),
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company text NOT NULL,
    contact_name text,
    contact_email text,
    contact_phone text,
    value numeric,
    stage text NOT NULL DEFAULT 'Lead'
      CHECK (stage IN ('Lead', 'Contacted', 'Meeting', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost')),
    owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
    next_step text,
    notes text,
    last_activity_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    company text,
    email text,
    phone text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    type text NOT NULL,
    summary text,
    author_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS resources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    category text,
    url text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals (owner_id);
  CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals (stage);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
  CREATE INDEX IF NOT EXISTS idx_activities_deal_id ON activities (deal_id);
`;

export async function seedIfNeeded(db: ReturnType<typeof sql>): Promise<void> {
  const [{ count }] = await db`select count(*)::int as count from users`;
  if (count > 0) return; // seed only when the tables are first created

  await db`
    insert into users (name, email, password_hash, role) values
      ('Owner',        ${SEED_OWNER_EMAIL}, ${hashPassword(SEED_OWNER_PASSWORD)}, 'owner'),
      ('Demo Agent',   ${SEED_AGENT_EMAIL}, ${hashPassword(SEED_AGENT_PASSWORD)}, 'agent')
  `;

  const message = `[operion-crm] Seeded initial accounts (change these in the admin area):
  owner  -> ${SEED_OWNER_EMAIL} / ${SEED_OWNER_PASSWORD}
  agent  -> ${SEED_AGENT_EMAIL} / ${SEED_AGENT_PASSWORD}`;
  console.log(message);
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(".run", { recursive: true });
    await writeFile(".run/seed-credentials.txt", `${message}\n`, "utf8");
  } catch {
    /* non-fatal — the server log above is the source of truth */
  }
}

/* ------------------------------------------------------------------ */
/* Session read                                                        */
/* ------------------------------------------------------------------ */

export async function readSession(): Promise<SessionUser | null> {
  const token = getCookie(SESSION_COOKIE);
  if (!token) return null;
  const db = sql();
  const rows = await db`
    select u.id, u.name, u.email, u.role
    from sessions s
    join users u on u.id = s.user_id
    where s.token_hash = ${hashToken(token)}
      and s.expires_at > now()
    limit 1
  `;
  if (rows.length === 0) return null;
  const u = rows[0];
  return { id: String(u.id), name: String(u.name), email: String(u.email), role: u.role as Role };
}

/* ------------------------------------------------------------------ */
/* Login core                                                          */
/* ------------------------------------------------------------------ */

export interface LoginCoreResult {
  ok: boolean;
  user?: SessionUser;
  error?: string;
}

export async function loginCore(emailInput: string, passwordInput: string): Promise<LoginCoreResult> {
  if (!process.env.DATABASE_URL) {
    return {
      ok: false,
      error:
        "Database is not connected yet. Connect the database from the dashboard, then sign in again.",
    };
  }
  const email = (emailInput ?? "").trim().toLowerCase();
  const password = passwordInput ?? "";
  if (!email || !password) {
    return { ok: false, error: "Enter your email and password." };
  }

  const db = sql();
  await db.unsafe(SCHEMA_SQL);
  await seedIfNeeded(db);

  const rows = await db`
    select id, name, email, password_hash, role
    from users
    where email = ${email}
    limit 1
  `;
  if (rows.length === 0) {
    return { ok: false, error: "Invalid email or password." };
  }
  const user = rows[0];
  if (!verifyPassword(password, String(user.password_hash))) {
    return { ok: false, error: "Invalid email or password." };
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db`
    insert into sessions (token_hash, user_id, expires_at)
    values (${hashToken(token)}, ${user.id}, ${expiresAt})
  `;

  setCookie(SESSION_COOKIE, token, cookieOptions(expiresAt));

  return {
    ok: true,
    user: { id: String(user.id), name: String(user.name), email: String(user.email), role: user.role as Role },
  };
}

export async function logoutCore(): Promise<void> {
  const token = getCookie(SESSION_COOKIE);
  if (token) {
    try {
      if (process.env.DATABASE_URL) {
        await sql()`delete from sessions where token_hash = ${hashToken(token)}`;
      }
    } catch {
      /* ignore cleanup failures — the cookie is cleared regardless */
    }
  }
}
