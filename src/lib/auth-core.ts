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
import { RESOURCE_SEEDS } from "./resource-seeds";

export type Role = "owner" | "agent";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export const SESSION_COOKIE = "ocrm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_TTL_S = 30 * 24 * 60 * 60;

/** Seed credential — created once, on first schema init (see `seedIfNeeded`).
 *  The owner account is the ONLY seeded account; the CRM starts with empty
 *  deals/contacts tables and no agents (agents are added later via the admin). */
const SEED_OWNER_EMAIL = "owner@operioncrm.com";
/** Randomly generated throwaway password (override via env before first seed). */
const SEED_OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "cl4P84S384Yi9XLE";

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

/**
 * Bump SCHEMA_VERSION whenever SCHEMA_SQL changes. The login fast path
 * (schemaIsCurrent) reads this marker from schema_meta and skips ALL DDL and
 * seeding when it matches, so warm logins cost one read-only round trip.
 * Existing databases are upgraded exactly once: the first run that sees a
 * stale/missing marker runs the full ensure and then writes the new version.
 */
export const SCHEMA_VERSION = "5";

export const SCHEMA_SQL = `
  -- Schema version marker row (key = 'schema_version'). schemaIsCurrent reads
  -- it on login and skips all DDL and seeding when it matches SCHEMA_VERSION
  CREATE TABLE IF NOT EXISTS schema_meta (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

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

  -- v5: companies — Lead OS integration. Upserted by normalized domain (see
  -- src/lib/crm-api.ts) — the fields jsonb holds Fit Score, recommended buyer,
  -- research summary, provenance and any custom keys (top-level merged on update).
  CREATE TABLE IF NOT EXISTS companies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text,
    domain text UNIQUE,
    website text,
    notes text,
    fields jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- v5: contacts gain the Lead OS columns — company link (ON DELETE SET NULL —
  -- the legacy "company" text column stays for migration safety, do NOT drop),
  -- a fields jsonb (same merge semantics as companies) and updated_at (the
  -- notes endpoint bumps it). All idempotent so they upgrade existing DBs.
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS fields jsonb NOT NULL DEFAULT '{}';
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

  -- One contact can have many deals. Idempotent so it also upgrades databases
  -- created before this column existed. ON DELETE SET NULL keeps the deal row
  -- (with its denormalized contact_name/email/phone) when a contact is deleted.
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;

  -- Plan-based subscription pricing - the plan is the only pricing input a user sets.
  -- Derived numbers (setup fee, MRR, annual, first-year) are computed in code from
  -- src/lib/pricing.ts. The legacy value column stays in place (unused) for migration
  -- safety - do NOT drop it.
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'Founder' CHECK (plan IN ('Founder','Studio'));

  -- Commission tracking on Closed Won deals - 25% of the COLLECTED setup fee.
  -- The deal owner marks the setup fee collected once they collect it from the
  -- customer - the owner can mark any deal and can undo any mark (agents cannot
  -- undo). Idempotent so it also upgrades databases created before these columns.
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS setup_fee_collected boolean NOT NULL DEFAULT false;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS setup_fee_collected_at timestamptz;

  -- MRR reporting needs a reliable close date on closed deals. Idempotent so it
  -- upgrades databases created before this column existed. Closed Won rows that
  -- predate the column are backfilled from updated_at (their last write) on the
  -- next schema run - the backfill is safe to re-run because it only fills NULLs
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS closed_at timestamptz;
  UPDATE deals SET closed_at = updated_at WHERE closed_at IS NULL AND stage = 'Closed Won';

  -- Resource library - real sales collateral (pricing sheet, playbooks, decks)
  -- stored in the database so documents display INSIDE the CRM. file_data is
  -- the raw file bytes (bytea) and text/markdown resources render in the in-app
  -- reader, everything else downloads. uploaded_by is null for the seeded
  -- team documents (shown as Operion team)
  CREATE TABLE IF NOT EXISTS resources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    category text NOT NULL,
    description text NOT NULL DEFAULT '',
    file_name text NOT NULL,
    file_type text NOT NULL,
    file_size bigint NOT NULL,
    file_data bytea NOT NULL,
    uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- v3 migration: the original placeholder resources table (name/category/url
  -- columns only, never populated) is upgraded in place to the library shape
  -- above. Every statement is idempotent, so re-runs and fresh databases are
  -- safe - the final SET NOT NULL only succeeds once category has no nulls
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_name text NOT NULL DEFAULT '';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_type text NOT NULL DEFAULT 'application/octet-stream';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_size bigint NOT NULL DEFAULT 0;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_data bytea NOT NULL DEFAULT ''::bytea;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE resources DROP COLUMN IF EXISTS name;
  ALTER TABLE resources DROP COLUMN IF EXISTS url;
  UPDATE resources SET category = 'Pricing' WHERE category IS NULL;
  ALTER TABLE resources ALTER COLUMN category SET NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_resources_created_at ON resources (created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals (owner_id);
  CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals (stage);
  CREATE INDEX IF NOT EXISTS idx_deals_contact_id ON deals (contact_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
  CREATE INDEX IF NOT EXISTS idx_activities_deal_id ON activities (deal_id);
  -- v5: Lead OS lookups — contacts by company and by normalized email.
  -- (companies.domain is already indexed by its UNIQUE constraint.)
  CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts (company_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_email_lower ON contacts (lower(email));

  -- AI morning briefing - one generated summary per user per day, cached here
  -- so OpenAI is called at most once per user per day (see src/lib/briefing.ts).
  -- ai_generated is false when the summary fell back to the static DB-only
  -- rundown (missing key or API failure) - the UI shows an "AI unavailable"
  -- note in that case. UNIQUE (user_id, briefing_date) enforces the daily cap.
  CREATE TABLE IF NOT EXISTS briefings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    briefing_date date NOT NULL,
    content text NOT NULL,
    ai_generated boolean NOT NULL DEFAULT true,
    generated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, briefing_date)
  );
`;

export async function seedIfNeeded(db: ReturnType<typeof sql>): Promise<void> {
  const [{ count }] = await db`select count(*)::int as count from users`;
  if (count > 0) return; // seed only when the tables are first created

  try {
    await seedOwner(db);
  } catch (err) {
    // A concurrent warmer (startup kick racing the first login on a brand-new
    // database) can seed between our count check and the insert. Re-check
    // before surfacing so the loser treats it as already-seeded instead of
    // failing a login that should succeed.
    const [{ count: c2 }] = await db`select count(*)::int as count from users`;
    if (c2 > 0) return;
    throw err;
  }
}

async function seedOwner(db: ReturnType<typeof sql>): Promise<void> {
  const [ownerRow] = await db`
    insert into users (name, email, password_hash, role) values
      ('Owner', ${SEED_OWNER_EMAIL}, ${hashPassword(SEED_OWNER_PASSWORD)}, 'owner')
    returning id, role
  `;
  if (!ownerRow) throw new Error("[operion-crm] seed failed: owner row missing");

  const message = `[operion-crm] Seeded owner account (change this in the admin area):
  owner -> ${SEED_OWNER_EMAIL} / ${SEED_OWNER_PASSWORD}`;
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
  token?: string;
  user?: SessionUser;
  error?: string;
}

/** Runs the schema DDL. Neon's `unsafe()` silently no-ops and a plain function
 *  call throws; splitting into statements and running each as a tagged-template
 *  call is the reliable path (one statement per HTTP query). */
export async function ensureSchemaCore(db: ReturnType<typeof sql>): Promise<void> {
  for (const statement of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    const template = Object.assign([statement], { raw: [statement] }) as unknown as TemplateStringsArray;
    await db(template);
  }
}

/**
 * Fast-path schema check — ONE read-only round trip. Returns true only when
 * schema_meta exists AND its schema_version equals SCHEMA_VERSION AND the
 * users table exists. Tolerant: if schema_meta is missing (fresh database) or
 * the query fails for any reason, returns false so the caller runs the full
 * ensure (login still works, just slower that once).
 */
export async function schemaIsCurrent(db: ReturnType<typeof sql>): Promise<boolean> {
  try {
    const rows = await db`
      select
        (select value from schema_meta where key = 'schema_version') as version,
        to_regclass('public.users') as users_table
    `;
    const r = rows[0];
    return !!r && r.version === SCHEMA_VERSION && r.users_table != null;
  } catch {
    return false; // schema_meta missing (fresh DB) or DB hiccup → full ensure
  }
}

/** Persist the current SCHEMA_VERSION marker. Runs only after DDL + seed succeeded. */
export async function markSchemaCurrent(db: ReturnType<typeof sql>): Promise<void> {
  await db`
    insert into schema_meta (key, value) values ('schema_version', ${SCHEMA_VERSION})
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

/**
 * First-run seeding for the resource library: inserts the canonical team
 * documents (pricing sheet, sales playbook, objection guide) as text/markdown
 * resources with uploader NULL. Runs only when the resources table is empty,
 * so it fires once on the v3 upgrade (or a brand-new database) and never
 * again — deleting a resource later does not resurrect it, because the schema
 * version marker is already current by then.
 */
export async function seedResourcesIfNeeded(db: ReturnType<typeof sql>): Promise<void> {
  const [{ count }] = await db`select count(*)::int as count from resources`;
  if (count > 0) return;
  for (const seed of RESOURCE_SEEDS) {
    const bytes = Buffer.from(seed.content, "utf8");
    await db`
      insert into resources (title, category, description, file_name, file_type, file_size, file_data, uploaded_by)
      values (${seed.title}, ${seed.category}, ${seed.description}, ${seed.fileName}, ${seed.fileType}, ${bytes.length}, ${bytes}, null)
    `;
  }
  console.log(`[operion-crm] seeded ${RESOURCE_SEEDS.length} resource documents`);
}

/** Full ensure: idempotent DDL + first-run owner seed + version marker. */
export async function ensureSchemaFull(db: ReturnType<typeof sql>): Promise<void> {
  const t0 = Date.now();
  await ensureSchemaCore(db);
  await seedIfNeeded(db);
  await seedResourcesIfNeeded(db);
  await markSchemaCurrent(db);
  console.log(`[operion-crm] schema ensured (v${SCHEMA_VERSION}) in ${Date.now() - t0}ms`);
}

/**
 * Startup schema warm — fire-and-forget at boot (serve.ts / vite.config) so the
 * first login only pays a single read-only version check. Never throws; on
 * failure the login path re-runs the full ensure as a fallback.
 */
export async function warmSchemaNow(): Promise<void> {
  if (!process.env.DATABASE_URL) return; // no DB connected yet — nothing to warm
  const t0 = Date.now();
  try {
    const db = sql();
    if (await schemaIsCurrent(db)) {
      console.log(`[operion-crm] schema warm: up to date (${Date.now() - t0}ms)`);
      return;
    }
    await ensureSchemaFull(db);
    console.log(`[operion-crm] schema warm: ensured v${SCHEMA_VERSION} in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error("[operion-crm] schema warm failed (login will re-ensure):", err);
  }
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
  if (!(await schemaIsCurrent(db))) {
    const t0 = Date.now();
    await ensureSchemaFull(db);
    console.log(`[operion-crm] login: schema stale/missing — full ensure took ${Date.now() - t0}ms`);
  }

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
    token,
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

/* ------------------------------------------------------------------ */
/* Change password core                                                */
/* ------------------------------------------------------------------ */

export type ChangePasswordReason =
  | "db-not-connected"
  | "not-signed-in"
  | "current-password-incorrect"
  | "new-password-too-short"
  | "db-error";

export type ChangePasswordCoreResult =
  | { ok: true }
  | { ok: false; reason: ChangePasswordReason; message: string }

/**
 * Self-service password change for the signed-in user (owner or agent — anyone
 * with an active session). Verifies the current password against the stored
 * scrypt hash (timing-safe `verifyPassword`), enforces an 8-char minimum on the
 * new password, updates ONLY the session user's row, then revokes every OTHER
 * session for that user so a leaked session dies on password change — the
 * current session stays alive. Password values are never logged.
 */
export async function changePasswordCore(
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordCoreResult> {
  if (!process.env.DATABASE_URL) {
    return {
      ok: false,
      reason: "db-not-connected",
      message: "Database is not connected yet. Please try again shortly.",
    };
  }
  const session = await readSession();
  if (!session) {
    return {
      ok: false,
      reason: "not-signed-in",
      message: "Your session expired. Please sign in again.",
    };
  }
  const current = currentPassword ?? "";
  const next = newPassword ?? "";
  if (!current) {
    return {
      ok: false,
      reason: "current-password-incorrect",
      message: "Current password is incorrect.",
    };
  }
  if (next.length < 8) {
    return {
      ok: false,
      reason: "new-password-too-short",
      message: "New password must be at least 8 characters.",
    };
  }

  const db = sql();
  const rows = await db`
    select password_hash from users where id = ${session.id} limit 1
  `;
  if (rows.length === 0) {
    // Session user vanished (shouldn't happen — sessions cascade on delete).
    return { ok: false, reason: "not-signed-in", message: "Your session expired. Please sign in again." };
  }
  if (!verifyPassword(current, String(rows[0].password_hash))) {
    return {
      ok: false,
      reason: "current-password-incorrect",
      message: "Current password is incorrect.",
    };
  }

  // Update the hash first, then revoke the user's OTHER sessions. The current
  // session is kept alive by excluding its token hash.
  await db`update users set password_hash = ${hashPassword(next)} where id = ${session.id}`;
  const currentToken = getCookie(SESSION_COOKIE);
  const currentTokenHash = currentToken ? hashToken(currentToken) : null;
  if (currentTokenHash) {
    try {
      await db`
        delete from sessions
        where user_id = ${session.id} and token_hash != ${currentTokenHash}
      `;
    } catch (err) {
      // Non-fatal hygiene step — the password itself is already updated.
      console.error("[operion-crm] changePassword: session revoke failed (non-fatal):", err);
    }
  }
  return { ok: true };
}
