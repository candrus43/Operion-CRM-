/**
 * Operion Lead OS → CRM lead ingestion (external inbound API).
 *
 * ⚠️ SERVER-ONLY. Raw HTTP handler (NOT a TanStack server function — those are
 * same-origin/CSRF guarded and would 403 external callers). Wired into both
 * servers:
 *   - dev:  a Vite middleware in `vite.config.ts` intercepts
 *           POST /api/crm/leads before the SSR handler.
 *   - prod: `serve.ts` (the Bun server) intercepts the same path before
 *           delegating to the built SSR fetch handler.
 *
 * Contract (documented for Operion Lead OS):
 *   POST /api/crm/leads
 *   Header:  x-api-key: <CRM_API_KEY from .env>
 *   Body:    { customerName: string (required),
 *              customerEmail: string (required),
 *              company?: string, phone?: string,
 *              plan?: "Founder" | "Studio" (default "Founder"),
 *              source?: string (default "Operion Lead OS") }
 *   200 → { ok: true, dealId, created, duplicate }
 *   400 → { ok: false, error }   (bad/missing body fields)
 *   401 → { ok: false, error: "Unauthorized" }  (missing/mismatched key)
 *   500 → { ok: false, error }   (db / no-owner failure)
 *
 * Dedupe: normalized email (trim + lowercase) → one contact; one OPEN deal
 * (stage not in Closed Won/Lost) per contact. Re-posting an existing open deal
 * is idempotent: returns the same dealId with duplicate: true and creates
 * nothing.
 *
 * All queries go through the Neon tagged-template driver (`db`...`) — never
 * db.unsafe(), never string-concatenated SQL.
 */
import { sql } from "~/db";
import { isPlan, type Plan } from "./pricing";

/** Default source label stamped into the activity when the body omits `source`. */
export const LEAD_SOURCE_DEFAULT = "Operion Lead OS";

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handles a single POST /api/crm/leads request. Returns a JSON Response with
 * the correct status code; never throws.
 */
export async function handleLeadIngest(req: Request): Promise<Response> {
  // 1. API key auth — the owner pastes this key into Operion's "Send to CRM"
  // settings. Compare against the env var read at process start.
  const expected = process.env.CRM_API_KEY;
  if (!expected) {
    console.error("[operion-crm] lead-ingest: CRM_API_KEY is not configured");
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  const supplied = req.headers.get("x-api-key");
  if (!supplied || supplied !== expected) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  // 2. Parse + validate the body. Everything except customerName/customerEmail
  // is optional; plan defaults to Founder, source defaults to "Operion Lead OS".
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const b = (raw ?? {}) as Record<string, unknown>;

  const customerName = typeof b.customerName === "string" ? b.customerName.trim() : "";
  const customerEmailRaw = typeof b.customerEmail === "string" ? b.customerEmail : "";
  if (!customerName || !customerEmailRaw.trim()) {
    return json({ ok: false, error: "customerName and customerEmail are required" }, 400);
  }
  const email = customerEmailRaw.trim().toLowerCase();
  const company = typeof b.company === "string" && b.company.trim() ? b.company.trim() : null;
  const phone = typeof b.phone === "string" && b.phone.trim() ? b.phone.trim() : null;
  let plan: Plan = "Founder";
  if (b.plan !== undefined && b.plan !== null && b.plan !== "") {
    if (!isPlan(b.plan)) {
      return json({ ok: false, error: "plan must be 'Founder' or 'Studio'" }, 400);
    }
    plan = b.plan;
  }
  const source =
    typeof b.source === "string" && b.source.trim() ? b.source.trim() : LEAD_SOURCE_DEFAULT;

  // 3. Persist: contact dedupe → open-deal dedupe → new deal + activity.
  if (!process.env.DATABASE_URL) {
    return json({ ok: false, error: "Database is not connected" }, 500);
  }
  try {
    const db = sql();

    // 3a. Reuse the contact by normalized email; backfill company/phone ONLY
    // when currently empty (null or ''). Create it when no match exists.
    const contactRows = await db`
      select id from contacts
      where email is not null and lower(email) = ${email}
      limit 1
    `;
    let contactId: string;
    if (contactRows.length > 0) {
      contactId = String(contactRows[0].id);
      await db`
        update contacts
        set company = case when company is null or company = '' then ${company} else company end,
            phone = case when phone is null or phone = '' then ${phone} else phone end
        where id = ${contactId}
      `;
    } else {
      const newContact = await db`
        insert into contacts (name, company, email, phone)
        values (${customerName}, ${company}, ${email}, ${phone})
        returning id
      `;
      contactId = String(newContact[0].id);
    }

    // 3b. Idempotency: one OPEN deal per contact. A closed deal doesn't block a
    // fresh one — the lead is genuinely new.
    const openRows = await db`
      select id from deals
      where contact_id = ${contactId}
        and stage not in ('Closed Won', 'Closed Lost')
      limit 1
    `;
    if (openRows.length > 0) {
      return json(
        { ok: true, dealId: String(openRows[0].id), created: false, duplicate: true },
        200,
      );
    }

    // 3c. New deals are assigned to the owner (the whole team sees them).
    const ownerRows = await db`
      select id from users where role = 'owner' order by created_at asc limit 1
    `;
    if (ownerRows.length === 0) {
      console.error("[operion-crm] lead-ingest: no owner user exists");
      return json({ ok: false, error: "No owner user found" }, 500);
    }
    const ownerId = String(ownerRows[0].id);

    // 3d. Create the deal. deals.company is NOT NULL — when the body omits the
    // company, fall back to the customer name so the board always has a label.
    const dealRows = await db`
      insert into deals (company, contact_id, contact_name, contact_email, contact_phone, plan, stage, owner_id)
      values (
        ${company ?? customerName},
        ${contactId},
        ${customerName},
        ${email},
        ${phone},
        ${plan},
        'Lead',
        ${ownerId}
      )
      returning id
    `;
    const dealId = String(dealRows[0].id);

    // 3e. Activity on the timeline ("Lead transferred from Operion Lead OS" —
    // or the custom source) authored by the owner, and bump last_activity_at so
    // the board chip reflects it. Activity insert failure is non-fatal (mirrors
    // markWon): the deal itself is already created and re-posting is idempotent.
    const summary = `Lead transferred from ${source}`;
    try {
      await db`
        insert into activities (deal_id, type, summary, author_id)
        values (${dealId}, 'note', ${summary}, ${ownerId})
      `;
    } catch (err) {
      console.error("[operion-crm] lead-ingest: activity insert failed (non-fatal):", err);
    }
    await db`
      update deals set last_activity_at = now(), updated_at = now() where id = ${dealId}
    `;

    return json({ ok: true, dealId, created: true, duplicate: false }, 200);
  } catch (err) {
    console.error("[operion-crm] lead-ingest failed:", err);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
}
