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
import type { Plan } from "./pricing";

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

/**
 * Bump SCHEMA_VERSION whenever SCHEMA_SQL changes. The login fast path
 * (schemaIsCurrent) reads this marker from schema_meta and skips ALL DDL and
 * seeding when it matches, so warm logins cost one read-only round trip.
 * Existing databases are upgraded exactly once: the first run that sees a
 * stale/missing marker runs the full ensure and then writes the new version.
 */
export const SCHEMA_VERSION = "1";

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

  CREATE TABLE IF NOT EXISTS resources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    category text,
    url text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals (owner_id);
  CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals (stage);
  CREATE INDEX IF NOT EXISTS idx_deals_contact_id ON deals (contact_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
  CREATE INDEX IF NOT EXISTS idx_activities_deal_id ON activities (deal_id);
`;

export async function seedIfNeeded(db: ReturnType<typeof sql>): Promise<void> {
  const [{ count }] = await db`select count(*)::int as count from users`;
  if (count > 0) return; // seed only when the tables are first created

  try {
    await seedAccountsAndDemoData(db);
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

async function seedAccountsAndDemoData(db: ReturnType<typeof sql>): Promise<void> {
  const seeded = await db`
    insert into users (name, email, password_hash, role) values
      ('Owner',        ${SEED_OWNER_EMAIL}, ${hashPassword(SEED_OWNER_PASSWORD)}, 'owner'),
      ('Demo Agent',   ${SEED_AGENT_EMAIL}, ${hashPassword(SEED_AGENT_PASSWORD)}, 'agent')
    returning id, role
  `;
  const ownerRow = seeded.find((u) => u.role === "owner");
  const agentRow = seeded.find((u) => u.role === "agent");
  if (!ownerRow || !agentRow) throw new Error("[operion-crm] seed failed: owner/agent row missing");
  const ownerId = String(ownerRow.id);
  const agentId = String(agentRow.id);

  await seedDemoDeals(db, ownerId, agentId);

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
/* Contacts backfill (idempotent, live-DB safe)                        */
/* ------------------------------------------------------------------ */

/**
 * Upgrades existing databases (where users already exist, so the first-run
 * seed never runs): when the contacts table is still empty AND no deal has a
 * contact_id yet, create a contact row for each demo deal's contact and link
 * deals to contacts by matching contact_email. Safe to re-run — once any
 * contact exists or any deal is linked, it does nothing.
 */
export async function backfillDemoContactsIfNeeded(
  db: ReturnType<typeof sql>,
): Promise<void> {
  try {
    const [{ c }] = await db`select count(*)::int as c from contacts`;
    if (c > 0) return;
    const [{ n }] = await db`select count(*)::int as n from deals where contact_id is not null`;
    if (n > 0) return;

    for (const d of DEMO_DEALS) {
      await db`
        insert into contacts (name, company, email, phone, notes)
        values (${d.contact}, ${d.company}, ${d.email}, ${d.phone}, ${d.notes})
      `;
    }
    await db`
      update deals d
      set contact_id = c.id
      from contacts c
      where c.email = d.contact_email and d.contact_email is not null
    `;
    console.log("[operion-crm] Backfilled demo contacts + linked demo deals by email.");
  } catch (err) {
    // Never block login/schema-ensure — log and move on.
    console.error("[operion-crm] backfillDemoContactsIfNeeded failed:", err);
  }
}

/* ------------------------------------------------------------------ */
/* Demo seed data (deals + activities)                                 */
/* ------------------------------------------------------------------ */

interface DemoDeal {
  key: string;
  company: string;
  contact: string;
  email: string;
  phone: string;
  plan: Plan;
  stage: string;
  owner: "owner" | "agent";
  nextStep: string;
  notes: string;
  createdDaysAgo: number;
  /** When a closed deal actually closed (won/lost) — drives its activity timestamps. */
  closedDaysAgo?: number;
}

/**
 * Owner-specified demo prospects. Every deal is an Operion subscription sale:
 * `plan` is the only pricing field, and all values are computed from it in
 * src/lib/pricing.ts (never stored, never typed).
 */
const DEMO_DEALS: DemoDeal[] = [
  {
    key: "hudson",
    company: "Hudson Properties",
    contact: "Daniel Hudson",
    email: "daniel@hudsonprops.com",
    phone: "+1 (312) 555-0147",
    plan: "Studio",
    stage: "Negotiation",
    owner: "owner",
    nextStep: "Circulate revised MSA — annual Studio terms at $499/mo",
    notes: "Owner of 4 commercial properties; wants one CRM for tenant and lease relationships. Negotiating on onboarding scope.",
    createdDaysAgo: 18,
  },
  {
    key: "bridgewater",
    company: "Bridgewater Holdings",
    contact: "Vivian Liu",
    email: "vivian@bridgewaterholdings.com",
    phone: "+1 (212) 555-0163",
    plan: "Studio",
    stage: "Proposal",
    owner: "agent",
    nextStep: "Follow up on proposal sent Tuesday",
    notes: "Family office managing 3 LLCs — consolidating entity contacts and deal flow. Proposal v1 includes onboarding and priority support.",
    createdDaysAgo: 12,
  },
  {
    key: "sarah-chen",
    company: "Sarah Chen",
    contact: "Sarah Chen",
    email: "sarah@chenstudios.co",
    phone: "+1 (415) 555-0129",
    plan: "Founder",
    stage: "Meeting",
    owner: "agent",
    nextStep: "Run product demo for both e-commerce brands",
    notes: "Solo entrepreneur running 2 e-commerce brands; wants pipeline and contacts in one place. Founder fits her volume.",
    createdDaysAgo: 8,
  },
  {
    key: "meridian",
    company: "Meridian Group",
    contact: "Robert Okafor",
    email: "robert@meridiangroup.io",
    phone: "+1 (646) 555-0174",
    plan: "Studio",
    stage: "Contacted",
    owner: "owner",
    nextStep: "Book intro call for next week",
    notes: "PE-backed operator with 5 portfolio companies. Interested in per-entity pipelines under one account.",
    createdDaysAgo: 6,
  },
  {
    key: "ortega",
    company: "James Ortega",
    contact: "James Ortega",
    email: "james@ortegaconsulting.com",
    phone: "+1 (305) 555-0136",
    plan: "Founder",
    stage: "Lead",
    owner: "owner",
    nextStep: "Send intro deck and discovery questions",
    notes: "Independent consultant managing multiple client entities. Referred by a mutual contact.",
    createdDaysAgo: 3,
  },
  {
    key: "bluebird",
    company: "Bluebird Bookkeeping",
    contact: "Priya Raman",
    email: "priya@bluebirdbookkeeping.com",
    phone: "+1 (206) 555-0158",
    plan: "Founder",
    stage: "Closed Won",
    owner: "agent",
    nextStep: "Send welcome kit and schedule onboarding",
    notes: "Signed Founder (12-month agreement). Setup fee invoiced, first month billed. Closed this month.",
    createdDaysAgo: 20,
    closedDaysAgo: 7,
  },
  {
    key: "summit",
    company: "Summit Capital Partners",
    contact: "Theodore Vance",
    email: "tvance@summitcapital.partners",
    phone: "+1 (617) 555-0119",
    plan: "Studio",
    stage: "Closed Lost",
    owner: "owner",
    nextStep: "",
    notes: "Went with a competitor on price. Worth revisiting next quarter with a different packaging angle.",
    createdDaysAgo: 26,
    closedDaysAgo: 20,
  },
];

/** Timestamps for the demo data, relative to seed time so the board never looks stale. */
function daysAgo(days: number, hours = 0): string {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();
}

/** First-run demo data: 7 Operion prospects across every stage + activities on most of them. */
async function seedDemoDeals(
  db: ReturnType<typeof sql>,
  ownerId: string,
  agentId: string,
): Promise<void> {
  const ids: Record<string, string> = {};
  for (const d of DEMO_DEALS) {
    const owner = d.owner === "owner" ? ownerId : agentId;
    // Closed deals get a real close date (won/lost) so MRR reporting's
    // "closed this month / this quarter" buckets work from the first run.
    const closedAt =
      d.stage === "Closed Won" || d.stage === "Closed Lost"
        ? daysAgo(d.closedDaysAgo ?? d.createdDaysAgo)
        : null;
    const [row] = await db`
      insert into deals (
        company, contact_name, contact_email, contact_phone, plan, stage,
        owner_id, next_step, notes, created_at, updated_at, closed_at
      ) values (
        ${d.company}, ${d.contact}, ${d.email}, ${d.phone}, ${d.plan}, ${d.stage},
        ${owner}, ${d.nextStep || null}, ${d.notes}, ${daysAgo(d.createdDaysAgo)},
        ${daysAgo(d.createdDaysAgo)}, ${closedAt}
      )
      returning id
    `;
    ids[d.key] = String(row.id);
  }

  await db`
    insert into activities (deal_id, type, summary, author_id, created_at) values
      (${ids.hudson},    'stage',   'Moved to Negotiation',                    ${ownerId}, ${daysAgo(8)}),
      (${ids.hudson},    'meeting', 'Negotiation call — annual Studio terms at $499/mo', ${ownerId}, ${daysAgo(1, 4)}),
      (${ids.bridgewater}, 'email', 'Sent proposal with onboarding + priority support', ${agentId}, ${daysAgo(3, 6)}),
      (${ids.bridgewater}, 'call',  'Discovery call — 30 min, went well',      ${agentId}, ${daysAgo(2, 3)}),
      (${ids["sarah-chen"]}, 'meeting', 'Demo scheduled for this week',         ${agentId}, ${daysAgo(1, 2)}),
      (${ids.meridian},  'email',  'Sent intro email and company overview',    ${ownerId}, ${daysAgo(2, 5)}),
      (${ids.ortega},    'note',   'Deal created from referral',               ${ownerId}, ${daysAgo(1)}),
      (${ids.bluebird},  'email',  'Sent 12-month Founder agreement',          ${agentId}, ${daysAgo(12)}),
      (${ids.bluebird},  'stage',  'Closed Won — contract signed',             ${agentId}, ${daysAgo(7)}),
      (${ids.summit},    'note',   'Lost to competitor on price',              ${ownerId}, ${daysAgo(20)}),
      (${ids.summit},    'stage',  'Closed Lost',                              ${ownerId}, ${daysAgo(20, 1)})
  `;

  // Demo commission: Bluebird (Closed Won, Founder) already collected its setup
  // fee 3 days ago, so fresh installs show one earned commission ($625).
  await db`
    update deals set setup_fee_collected = true, setup_fee_collected_at = ${daysAgo(3)}
    where id = ${ids.bluebird}
  `;

  // Keep last_activity_at in sync with each deal's most recent activity.
  await db`
    update deals d set last_activity_at = a.max_at
    from (
      select deal_id, max(created_at) as max_at from activities group by deal_id
    ) a
    where a.deal_id = d.id
  `;
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

/** Full ensure: idempotent DDL + first-run seed + contacts backfill + version marker. */
export async function ensureSchemaFull(db: ReturnType<typeof sql>): Promise<void> {
  const t0 = Date.now();
  await ensureSchemaCore(db);
  await seedIfNeeded(db);
  await backfillDemoContactsIfNeeded(db);
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
