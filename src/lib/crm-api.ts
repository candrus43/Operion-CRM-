/**
 * Operion Lead OS → CRM integration API (external inbound endpoints).
 *
 * ⚠️ SERVER-ONLY. Raw HTTP handlers (NOT TanStack server functions — those are
 * same-origin/CSRF guarded and would 403 external callers). Wired into both
 * servers via the `/api/crm/*` dispatcher:
 *   - dev:  a Vite middleware in `vite.config.ts` intercepts /api/crm/* before
 *           the SSR handler.
 *   - prod: `serve.ts` (the Bun server) intercepts the same paths before
 *           delegating to the built SSR fetch handler.
 *
 * Contract (documented for Operion Lead OS — every endpoint requires the header
 * `x-api-key: <CRM_API_KEY from .env>` and returns JSON):
 *   POST /api/crm/companies — upsert company, dedupe by normalized domain
 *   POST /api/crm/contacts  — upsert contact by normalized email, linked to a
 *                             company (by id or find-or-create by domain)
 *   POST /api/crm/notes     — append notes / deep-merge fields on a company or
 *                             contact; optional activitySummary → open-deal timeline
 *   GET  /api/crm/lookup    — dedupe lookup by domain and/or email
 *   POST /api/crm/leads     — legacy lead ingestion (see ./lead-ingest.ts)
 *
 * All queries go through the Neon tagged-template driver (`db`...) — never
 * db.unsafe(), never string-concatenated SQL values, never identifier
 * interpolation inside a tagged template. Dynamic bind positions are emitted
 * with `$n` placeholders and executed through `runQuery` (split-at-marker, the
 * same technique as pipeline.ts's runDynamicQuery).
 */
import { sql } from "~/db";

export type Db = ReturnType<typeof sql>;

/* ------------------------------------------------------------------ */
/* Shared response + auth helpers                                      */
/* ------------------------------------------------------------------ */

export function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * API-key gate shared by every /api/crm/* endpoint. Returns a 401 Response when
 * the key is missing/wrong (or the server has no CRM_API_KEY configured), null
 * when the caller is authorized. Constant-time-ish compare via plain equality —
 * the existing /api/crm/leads behavior, unchanged.
 */
export function requireApiKey(req: Request): Response | null {
  const expected = process.env.CRM_API_KEY;
  if (!expected) {
    console.error("[operion-crm] crm-api: CRM_API_KEY is not configured");
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  const supplied = req.headers.get("x-api-key");
  if (!supplied || supplied !== expected) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Normalization helpers (single shared source — do not duplicate)     */
/* ------------------------------------------------------------------ */

/** "HTTPS://WWW.Acme.COM/" → "acme.com". Strips scheme + www., lowercases, trims trailing slashes. */
export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let d = raw.trim();
  if (!d) return "";
  d = d.replace(/^https?:\/\//i, "");
  d = d.replace(/^www\./i, "");
  d = d.toLowerCase();
  d = d.replace(/\/+$/, "");
  return d;
}

/** Trim + lowercase (contact email dedupe key). */
export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Optional string body field: absent/null → null (untouched), non-string → error. */
function optString(
  b: Record<string, unknown>,
  key: string,
): { value: string | null; error: string | null } {
  const v = b[key];
  if (v === undefined || v === null) return { value: null, error: null };
  if (typeof v !== "string") return { value: null, error: `${key} must be a string` };
  return { value: v.trim(), error: null };
}

/** Optional `fields` body field: absent/null → null, non-object → error. */
function parseFields(
  raw: unknown,
): { value: Record<string, unknown> | null; error: string | null } {
  if (raw === undefined || raw === null) return { value: null, error: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value: null, error: "fields must be a JSON object" };
  }
  return { value: raw as Record<string, unknown>, error: null };
}

/** Coerce whatever the driver returned for a jsonb column into a plain object. */
function toObj(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

/** Deep-merge at the TOP level only: provided keys overwrite, absent keys untouched. */
function mergeJsonb(prev: unknown, next: Record<string, unknown> | null): Record<string, unknown> {
  const base = toObj(prev);
  if (!next) return base;
  return { ...base, ...next };
}

/**
 * Append notes newline-separated. Skips when the new note duplicates any
 * existing line (trimmed comparison) — re-pushing the same note is a no-op.
 */
function appendNotes(existing: unknown, add: string): string {
  const prev = existing == null ? "" : String(existing);
  if (!add) return prev;
  if (!prev.trim()) return add;
  const lines = prev.split("\n").map((l) => l.trim());
  if (lines.includes(add.trim())) return prev;
  return prev.replace(/\s+$/, "") + "\n" + add;
}

async function readJsonBody(
  req: Request,
): Promise<{ body: Record<string, unknown> | null; error: string | null }> {
  try {
    const raw: unknown = await req.json();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { body: null, error: "Body must be a JSON object" };
    }
    return { body: raw as Record<string, unknown>, error: null };
  } catch {
    return { body: null, error: "Invalid JSON body" };
  }
}

/**
 * Runs a dynamic SQL string (with positional `$1..$n` placeholders) through the
 * Neon driver's tagged-template path — the only call form that works in every
 * runtime (mirrors pipeline.ts's runDynamicQuery). Values stay parameterized;
 * the SQL text is static (built from known identifiers/literals only).
 */
async function runQuery(
  db: Db,
  sqlText: string,
  args: unknown[],
): Promise<Record<string, unknown>[]> {
  const parts: string[] = [];
  let rest = sqlText;
  for (let i = 1; i <= args.length; i++) {
    const marker = "$" + i;
    const idx = rest.indexOf(marker);
    if (idx < 0) {
      throw new Error(`[operion-crm] runQuery: missing bind marker ${marker}`);
    }
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + marker.length);
  }
  parts.push(rest);
  const template = Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  const rows = await db(template, ...args);
  return rows as Record<string, unknown>[];
}

/* ------------------------------------------------------------------ */
/* Company / contact data helpers (shared by the endpoints)            */
/* ------------------------------------------------------------------ */

export interface CompanyRef {
  id: string;
  name: string | null;
}

async function findCompanyById(db: Db, id: string): Promise<CompanyRef | null> {
  const rows = await db`select id, name from companies where id = ${id} limit 1`;
  if (rows.length === 0) return null;
  return { id: String(rows[0].id), name: rows[0].name == null ? null : String(rows[0].name) };
}

async function findCompanyByDomain(db: Db, domain: string): Promise<CompanyRef | null> {
  const rows = await db`select id, name from companies where domain = ${domain} limit 1`;
  if (rows.length === 0) return null;
  return { id: String(rows[0].id), name: rows[0].name == null ? null : String(rows[0].name) };
}

/** Find-or-create a company by normalized domain (contacts/leads linkage). */
export async function findOrCreateCompanyByDomain(db: Db, domain: string): Promise<CompanyRef> {
  const existing = await findCompanyByDomain(db, domain);
  if (existing) return existing;
  const rows = await db`
    insert into companies (domain) values (${domain}) returning id
  `;
  return { id: String(rows[0].id), name: null };
}

export interface UpsertCompanyInput {
  domain: string;
  name?: string | null;
  website?: string | null;
  notes?: string | null;
  fields?: Record<string, unknown> | null;
}

/**
 * Upsert a company by normalized domain. On an existing row, provided fields
 * overwrite (top-level fields merge), absent fields stay untouched; updated_at
 * always bumps. Returns the companyId and whether it was created.
 */
async function upsertCompany(
  db: Db,
  input: UpsertCompanyInput,
): Promise<{ companyId: string; created: boolean }> {
  const existing = await db`
    select id, fields from companies where domain = ${input.domain} limit 1
  `;
  if (existing.length === 0) {
    const rows = await db`
      insert into companies (name, domain, website, notes, fields)
      values (${input.name ?? null}, ${input.domain}, ${input.website ?? null}, ${input.notes ?? null}, ${input.fields ?? {}})
      returning id
    `;
    return { companyId: String(rows[0].id), created: true };
  }
  const companyId = String(existing[0].id);
  const sets: string[] = [];
  const args: unknown[] = [];
  const next = () => args.length + 1;
  if (input.name !== undefined && input.name !== null) {
    sets.push(`name = $${next()}`);
    args.push(input.name);
  }
  if (input.website !== undefined && input.website !== null) {
    sets.push(`website = $${next()}`);
    args.push(input.website);
  }
  if (input.notes !== undefined && input.notes !== null) {
    sets.push(`notes = $${next()}`);
    args.push(input.notes);
  }
  if (input.fields) {
    sets.push(`fields = $${next()}`);
    args.push(mergeJsonb(existing[0].fields, input.fields));
  }
  sets.push("updated_at = now()");
  args.push(companyId);
  await runQuery(db, `update companies set ${sets.join(", ")} where id = $${args.length}`, args);
  return { companyId, created: false };
}

export interface UpsertContactInput {
  name: string;
  email: string;
  phone?: string | null;
  notes?: string | null;
  fields?: Record<string, unknown> | null;
  /** Link to a company (null = don't touch on update). */
  companyId?: string | null;
  /** Legacy `contacts.company` text backfill — set only when non-empty. */
  companyName?: string | null;
}

/**
 * Upsert a contact by normalized (case-insensitive) email. On an existing row,
 * provided fields overwrite (top-level fields merge), absent fields stay
 * untouched; updated_at always bumps. Returns the contactId and whether created.
 */
async function upsertContact(
  db: Db,
  input: UpsertContactInput,
): Promise<{ contactId: string; created: boolean }> {
  const existing = await db`
    select id, fields from contacts
    where email is not null and lower(email) = ${input.email}
    limit 1
  `;
  if (existing.length > 0) {
    const contactId = String(existing[0].id);
    const sets: string[] = [];
    const args: unknown[] = [];
    const next = () => args.length + 1;
    if (input.name !== undefined && input.name !== null) {
      sets.push(`name = $${next()}`);
      args.push(input.name);
    }
    if (input.phone !== undefined && input.phone !== null) {
      sets.push(`phone = $${next()}`);
      args.push(input.phone);
    }
    if (input.notes !== undefined && input.notes !== null) {
      sets.push(`notes = $${next()}`);
      args.push(input.notes);
    }
    if (input.fields) {
      sets.push(`fields = $${next()}`);
      args.push(mergeJsonb(existing[0].fields, input.fields));
    }
    if (input.companyId) {
      sets.push(`company_id = $${next()}`);
      args.push(input.companyId);
    }
    if (input.companyName) {
      sets.push(`company = $${next()}`);
      args.push(input.companyName);
    }
    sets.push("updated_at = now()");
    args.push(contactId);
    await runQuery(db, `update contacts set ${sets.join(", ")} where id = $${args.length}`, args);
    return { contactId, created: false };
  }
  const rows = await db`
    insert into contacts (name, email, phone, notes, fields, company_id, company)
    values (
      ${input.name},
      ${input.email},
      ${input.phone ?? null},
      ${input.notes ?? null},
      ${input.fields ?? {}},
      ${input.companyId ?? null},
      ${input.companyName ?? null}
    )
    returning id
  `;
  return { contactId: String(rows[0].id), created: true };
}

/* ------------------------------------------------------------------ */
/* POST /api/crm/companies — upsert company, dedupe by domain          */
/* ------------------------------------------------------------------ */

export async function handleCompanies(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth) return auth;
  const { body, error: bodyErr } = await readJsonBody(req);
  if (bodyErr) return json({ ok: false, error: bodyErr }, 400);
  const b = body ?? {};

  const domain = normalizeDomain(b.domain);
  if (!domain) return json({ ok: false, error: "domain is required" }, 400);
  const name = optString(b, "name");
  if (name.error) return json({ ok: false, error: name.error }, 400);
  const website = optString(b, "website");
  if (website.error) return json({ ok: false, error: website.error }, 400);
  const notes = optString(b, "notes");
  if (notes.error) return json({ ok: false, error: notes.error }, 400);
  const fields = parseFields(b.fields);
  if (fields.error) return json({ ok: false, error: fields.error }, 400);

  if (!process.env.DATABASE_URL) {
    return json({ ok: false, error: "Database is not connected" }, 500);
  }
  try {
    const db = sql();
    const { companyId, created } = await upsertCompany(db, {
      domain,
      name: name.value,
      website: website.value,
      notes: notes.value,
      fields: fields.value,
    });
    return json(
      created
        ? { ok: true, companyId, created: true }
        : { ok: true, companyId, created: false, updated: true },
      200,
    );
  } catch (err) {
    console.error("[operion-crm] /api/crm/companies failed:", err);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
}

/* ------------------------------------------------------------------ */
/* POST /api/crm/contacts — upsert contact by email, linked to company */
/* ------------------------------------------------------------------ */

export async function handleContacts(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth) return auth;
  const { body, error: bodyErr } = await readJsonBody(req);
  if (bodyErr) return json({ ok: false, error: bodyErr }, 400);
  const b = body ?? {};

  const email = normalizeEmail(b.email);
  if (!email) return json({ ok: false, error: "email is required" }, 400);
  const name = optString(b, "name");
  if (name.error) return json({ ok: false, error: name.error }, 400);
  if (!name.value) return json({ ok: false, error: "name is required" }, 400);
  const phone = optString(b, "phone");
  if (phone.error) return json({ ok: false, error: phone.error }, 400);
  const notes = optString(b, "notes");
  if (notes.error) return json({ ok: false, error: notes.error }, 400);
  const fields = parseFields(b.fields);
  if (fields.error) return json({ ok: false, error: fields.error }, 400);
  const companyIdRaw = optString(b, "companyId");
  if (companyIdRaw.error) return json({ ok: false, error: companyIdRaw.error }, 400);
  const companyDomainRaw = optString(b, "companyDomain");
  if (companyDomainRaw.error) return json({ ok: false, error: companyDomainRaw.error }, 400);

  if (!process.env.DATABASE_URL) {
    return json({ ok: false, error: "Database is not connected" }, 500);
  }
  try {
    const db = sql();

    // Company linkage: companyId directly, or companyDomain find-or-create
    // (reusing the same domain normalization). Both given and conflicting → 400.
    let company: CompanyRef | null = null;
    if (companyIdRaw.value) {
      company = await findCompanyById(db, companyIdRaw.value);
      if (!company) return json({ ok: false, error: "Company not found" }, 404);
    }
    if (companyDomainRaw.value) {
      const domain = normalizeDomain(companyDomainRaw.value);
      if (!domain) return json({ ok: false, error: "companyDomain is invalid" }, 400);
      const byDomain = await findOrCreateCompanyByDomain(db, domain);
      if (company && company.id !== byDomain.id) {
        return json({ ok: false, error: "companyId and companyDomain conflict" }, 400);
      }
      company = byDomain;
    }

    const { contactId, created } = await upsertContact(db, {
      name: name.value,
      email,
      phone: phone.value,
      notes: notes.value,
      fields: fields.value,
      companyId: company?.id ?? null,
      companyName: company?.name ?? null,
    });
    return json({ ok: true, contactId, created }, 200);
  } catch (err) {
    console.error("[operion-crm] /api/crm/contacts failed:", err);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
}

/* ------------------------------------------------------------------ */
/* POST /api/crm/notes — append notes / merge fields on one target     */
/* ------------------------------------------------------------------ */

/**
 * Appends notes (newline-separated, no dupes) and top-level-merges fields on a
 * company or contact row, bumping updated_at. `table` is a KNOWN literal
 * ("companies" | "contacts") passed as static SQL text — never user input.
 */
async function updateNotesAndFields(
  db: Db,
  table: "companies" | "contacts",
  id: string,
  notes: string | null,
  fields: Record<string, unknown> | null,
): Promise<void> {
  const rows = await runQuery(db, `select notes, fields from ${table} where id = $1`, [id]);
  const current = (rows[0] ?? {}) as { notes?: unknown; fields?: unknown };
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [];
  const next = () => args.length + 1;

  const nextNotes = notes ? appendNotes(current.notes, notes) : null;
  if (nextNotes !== null) {
    sets.push(`notes = $${next()}`);
    args.push(nextNotes);
  }
  if (fields) {
    sets.push(`fields = $${next()}`);
    args.push(mergeJsonb(current.fields, fields));
  }
  args.push(id);
  await runQuery(db, `update ${table} set ${sets.join(", ")} where id = $${args.length}`, args);
}

export async function handleNotes(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth) return auth;
  const { body, error: bodyErr } = await readJsonBody(req);
  if (bodyErr) return json({ ok: false, error: bodyErr }, 400);
  const b = body ?? {};

  const companyId = optString(b, "companyId");
  if (companyId.error) return json({ ok: false, error: companyId.error }, 400);
  const companyDomain = optString(b, "companyDomain");
  if (companyDomain.error) return json({ ok: false, error: companyDomain.error }, 400);
  const contactId = optString(b, "contactId");
  if (contactId.error) return json({ ok: false, error: contactId.error }, 400);
  const contactEmail = optString(b, "contactEmail");
  if (contactEmail.error) return json({ ok: false, error: contactEmail.error }, 400);
  const notes = optString(b, "notes");
  if (notes.error) return json({ ok: false, error: notes.error }, 400);
  const fields = parseFields(b.fields);
  if (fields.error) return json({ ok: false, error: fields.error }, 400);
  const activitySummary = optString(b, "activitySummary");
  if (activitySummary.error) return json({ ok: false, error: activitySummary.error }, 400);

  // Exactly one target: a company (companyId | companyDomain) XOR a contact
  // (contactId | contactEmail).
  const wantsCompany = Boolean(companyId.value || companyDomain.value);
  const wantsContact = Boolean(contactId.value || contactEmail.value);
  if (wantsCompany === wantsContact) {
    return json({ ok: false, error: "exactly one target required (company or contact)" }, 400);
  }
  if (!notes.value && !fields.value && !activitySummary.value) {
    return json({ ok: false, error: "nothing to update (provide notes, fields, or activitySummary)" }, 400);
  }

  if (!process.env.DATABASE_URL) {
    return json({ ok: false, error: "Database is not connected" }, 500);
  }
  try {
    const db = sql();

    if (wantsCompany) {
      // Resolve (NOT find-or-create — unresolved targets are 404).
      let company: CompanyRef | null = null;
      if (companyId.value) {
        company = await findCompanyById(db, companyId.value);
      }
      if (companyDomain.value) {
        const domain = normalizeDomain(companyDomain.value);
        if (!domain) return json({ ok: false, error: "companyDomain is invalid" }, 400);
        const byDomain = await findCompanyByDomain(db, domain);
        if (company && byDomain && company.id !== byDomain.id) {
          return json({ ok: false, error: "companyId and companyDomain conflict" }, 400);
        }
        company = byDomain;
      }
      if (!company) return json({ ok: false, error: "Company not found" }, 404);
      await updateNotesAndFields(db, "companies", company.id, notes.value, fields.value);
      return json({ ok: true, companyId: company.id }, 200);
    }

    // Contact target.
    let contact: { id: string } | null = null;
    if (contactId.value) {
      const rows = await db`select id from contacts where id = ${contactId.value} limit 1`;
      contact = rows.length > 0 ? { id: String(rows[0].id) } : null;
    }
    if (contactEmail.value) {
      const email = normalizeEmail(contactEmail.value);
      if (!email) return json({ ok: false, error: "contactEmail is invalid" }, 400);
      const rows = await db`
        select id from contacts where email is not null and lower(email) = ${email} limit 1
      `;
      const byEmail = rows.length > 0 ? { id: String(rows[0].id) } : null;
      if (contact && byEmail && contact.id !== byEmail.id) {
        return json({ ok: false, error: "contactId and contactEmail conflict" }, 400);
      }
      contact = byEmail;
    }
    if (!contact) return json({ ok: false, error: "Contact not found" }, 404);
    await updateNotesAndFields(db, "contacts", contact.id, notes.value, fields.value);

    // activitySummary → the contact's OPEN deals' timelines (type 'note',
    // author null). No open deal → silently skip (never an error).
    if (activitySummary.value) {
      try {
        const openDeals = await db`
          select id from deals
          where contact_id = ${contact.id} and stage not in ('Closed Won', 'Closed Lost')
        `;
        for (const d of openDeals) {
          await db`
            insert into activities (deal_id, type, summary, author_id)
            values (${String(d.id)}, 'note', ${activitySummary.value}, null)
          `;
          await db`
            update deals set last_activity_at = now(), updated_at = now()
            where id = ${String(d.id)}
          `;
        }
      } catch (err) {
        console.error("[operion-crm] /api/crm/notes: activity insert failed (non-fatal):", err);
      }
    }
    return json({ ok: true, contactId: contact.id }, 200);
  } catch (err) {
    console.error("[operion-crm] /api/crm/notes failed:", err);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
}

/* ------------------------------------------------------------------ */
/* GET /api/crm/lookup — dedupe lookup by domain and/or email          */
/* ------------------------------------------------------------------ */

function mapLookupContact(r: Record<string, unknown>): {
  contactId: string;
  name: string | null;
  email: string | null;
  companyId: string | null;
} {
  return {
    contactId: String(r.id),
    name: r.name == null ? null : String(r.name),
    email: r.email == null ? null : String(r.email),
    companyId: r.company_id == null ? null : String(r.company_id),
  };
}

export async function handleLookup(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth) return auth;
  const url = new URL(req.url);
  const domain = normalizeDomain(url.searchParams.get("domain"));
  const email = normalizeEmail(url.searchParams.get("email"));
  if (!domain && !email) {
    return json({ ok: false, error: "domain or email is required" }, 400);
  }

  if (!process.env.DATABASE_URL) {
    return json({ ok: false, error: "Database is not connected" }, 500);
  }
  try {
    const db = sql();

    // 1. Company by normalized domain (null when no domain or no match).
    let company: { companyId: string; name: string | null; domain: string } | null = null;
    if (domain) {
      const rows = await db`
        select id, name, domain from companies where domain = ${domain} limit 1
      `;
      if (rows.length > 0) {
        company = {
          companyId: String(rows[0].id),
          name: rows[0].name == null ? null : String(rows[0].name),
          domain: String(rows[0].domain),
        };
      }
    }

    // 2. Contacts: by normalized email, or by the matched company when only a
    // domain was given.
    const contacts: ReturnType<typeof mapLookupContact>[] = [];
    if (email) {
      const rows = await db`
        select id, name, email, company_id from contacts
        where email is not null and lower(email) = ${email}
        order by created_at
      `;
      for (const r of rows) contacts.push(mapLookupContact(r as Record<string, unknown>));
    } else if (company) {
      const rows = await db`
        select id, name, email, company_id from contacts
        where company_id = ${company.companyId}
        order by created_at
      `;
      for (const r of rows) contacts.push(mapLookupContact(r as Record<string, unknown>));
    }

    // 3. Open deals: for matched contacts, plus legacy rows whose contact_email
    // matches the lookup email. Stage not closed.
    const openDeals: {
      dealId: string;
      stage: string;
      plan: string;
      company: string;
      contactEmail: string | null;
    }[] = [];
    const clauses: string[] = [];
    const args: unknown[] = [];
    const next = () => args.length + 1;
    if (contacts.length > 0) {
      // Emit one marker per contact, pushing each id immediately so the next()
      // counter advances (deferring the push would emit $1 for every marker).
      const markers = contacts
        .map((c) => {
          const m = `$${next()}`;
          args.push(c.contactId);
          return m;
        })
        .join(", ");
      clauses.push(`contact_id in (${markers})`);
    }
    if (email) {
      clauses.push(`lower(contact_email) = $${next()}`);
      args.push(email);
    }
    if (clauses.length > 0) {
      const rows = await runQuery(
        db,
        `select id, stage, plan, company, contact_email from deals
         where stage not in ('Closed Won', 'Closed Lost') and (${clauses.join(" or ")})`,
        args,
      );
      for (const r of rows) {
        openDeals.push({
          dealId: String(r.id),
          stage: String(r.stage),
          plan: String(r.plan),
          company: String(r.company),
          contactEmail: r.contact_email == null ? null : String(r.contact_email),
        });
      }
    }

    return json({ ok: true, company, contacts, openDeals }, 200);
  } catch (err) {
    console.error("[operion-crm] /api/crm/lookup failed:", err);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
}

/* ------------------------------------------------------------------ */
/* Dispatcher — wired into vite.config.ts (dev) and serve.ts (prod)    */
/* ------------------------------------------------------------------ */

/**
 * Routes every /api/crm/* request to its handler. Unknown path/method → 404
 * JSON. lead-ingest is imported lazily to avoid a static import cycle
 * (lead-ingest.ts imports this module's shared helpers).
 */
export async function handleCrmApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "POST") {
    if (path === "/api/crm/leads") {
      const { handleLeadIngest } = await import("./lead-ingest");
      return handleLeadIngest(req);
    }
    if (path === "/api/crm/companies") return handleCompanies(req);
    if (path === "/api/crm/contacts") return handleContacts(req);
    if (path === "/api/crm/notes") return handleNotes(req);
  }
  if (req.method === "GET" && path === "/api/crm/lookup") return handleLookup(req);
  return json({ ok: false, error: "Not found" }, 404);
}
