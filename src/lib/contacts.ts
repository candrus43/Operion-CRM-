/**
 * Operion CRM — contacts server functions (client-safe surface).
 *
 * Mirrors the pattern in `~/lib/pipeline`: all database/authorization code is
 * referenced only from inside `createServerFn` handler bodies, so it is
 * tree-shaken out of client bundles. Every handler:
 *   1. degrades to a clean `db-not-connected` result when DATABASE_URL is unset,
 *   2. re-reads the session (never trusts the client),
 *   3. never crashes — unexpected errors become `db-error`.
 *
 * Contacts are team-shared: every authenticated user (owner AND agents) sees
 * and edits the full contact list. Deals keep their owner-based scoping, so an
 * agent only ever sees their own deals on a contact's detail page.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "~/db";
import { readSession } from "./auth-core";
import type { DbStatus, Stage } from "./pipeline";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface Contact {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
}

export interface ContactWithCount extends Contact {
  deal_count: number;
}

export interface ContactDeal {
  id: string;
  company: string;
  stage: Stage;
  value: number | null;
  owner_id: string | null;
  owner_name: string | null;
  updated_at: string;
}

export interface ContactInput {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export type ContactsResult =
  | { ok: true; contacts: ContactWithCount[] }
  | { ok: false; reason: DbStatus };

export type ContactDetailResult =
  | { ok: true; contact: Contact; deals: ContactDeal[] }
  | { ok: false; reason: DbStatus };

export type ContactWriteResult =
  | { ok: true; contactId?: string }
  | { ok: false; reason: DbStatus };

/* ------------------------------------------------------------------ */
/* Shared coercion helpers (server-only)                               */
/* ------------------------------------------------------------------ */

function coerceContact(r: Record<string, unknown>): Contact {
  return {
    id: String(r.id),
    name: String(r.name),
    company: r.company == null ? null : String(r.company),
    email: r.email == null ? null : String(r.email),
    phone: r.phone == null ? null : String(r.phone),
    notes: r.notes == null ? null : String(r.notes),
    created_at: new Date(r.created_at as Date).toISOString(),
  };
}

function coerceContactWithCount(r: Record<string, unknown>): ContactWithCount {
  return { ...coerceContact(r), deal_count: Number(r.deal_count ?? 0) };
}

function coerceContactDeal(r: Record<string, unknown>): ContactDeal {
  return {
    id: String(r.id),
    company: String(r.company),
    stage: String(r.stage) as Stage,
    value: r.value == null ? null : Number(r.value),
    owner_id: r.owner_id == null ? null : String(r.owner_id),
    owner_name: r.owner_name == null ? null : String(r.owner_name),
    updated_at: new Date(r.updated_at as Date).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Server functions                                                    */
/* ------------------------------------------------------------------ */

/** The full team-shared contact list, with a per-contact deal count. */
export const listContacts = createServerFn({ method: "GET" }).handler(
  async (): Promise<ContactsResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();
      const rows = await db`
        select c.*,
          (select count(*) from deals d where d.contact_id = c.id)::int as deal_count
        from contacts c
        order by c.name asc
      `;
      return {
        ok: true,
        contacts: rows.map((r) => coerceContactWithCount(r as Record<string, unknown>)),
      };
    } catch (err) {
      console.error("[operion-crm] listContacts failed:", err);
      return { ok: false, reason: "db-error" };
    }
  },
);

/**
 * One contact + its linked deals (company, stage, value, owner). Deals keep
 * owner-based scoping: owners see every deal on the contact, agents only their
 * own — a shared contact never leaks another agent's pipeline.
 */
export const getContactDetail = createServerFn({ method: "POST" })
  .validator((d: { contactId: string }) => d)
  .handler(async ({ data }): Promise<ContactDetailResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();
      const cRows = await db`
        select id, name, company, email, phone, notes, created_at
        from contacts
        where id = ${data.contactId}
        limit 1
      `;
      if (cRows.length === 0) return { ok: false, reason: "invalid" };

      const where =
        user.role === "owner"
          ? "where d.contact_id = $1"
          : "where d.contact_id = $1 and d.owner_id = $2";
      const args = user.role === "owner" ? [data.contactId] : [data.contactId, user.id];
      const dealRows = await db.query(
        `select d.id, d.company, d.stage, d.value, d.owner_id, u.name as owner_name, d.updated_at
         from deals d left join users u on u.id = d.owner_id
         ${where}
         order by d.updated_at desc`,
        args,
      );

      return {
        ok: true,
        contact: coerceContact(cRows[0] as Record<string, unknown>),
        deals: dealRows.map((r) => coerceContactDeal(r as Record<string, unknown>)),
      };
    } catch (err) {
      console.error("[operion-crm] getContactDetail failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });

/** Create a contact (name required; company/email/phone/notes optional). */
export const createContact = createServerFn({ method: "POST" })
  .validator((d: ContactInput) => d)
  .handler(async ({ data }): Promise<ContactWriteResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const name = (data.name ?? "").trim();
      if (!name) return { ok: false, reason: "invalid" };
      const db = sql();
      const rows = await db`
        insert into contacts (name, company, email, phone, notes)
        values (
          ${name},
          ${data.company?.trim() || null},
          ${data.email?.trim() || null},
          ${data.phone?.trim() || null},
          ${data.notes?.trim() || null}
        )
        returning id
      `;
      return { ok: true, contactId: String(rows[0].id) };
    } catch (err) {
      console.error("[operion-crm] createContact failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });

export type UpdateContactInput = { contactId: string } & Partial<ContactInput>;

/** Edit a contact (partial update). Any signed-in user may edit any contact. */
export const updateContact = createServerFn({ method: "POST" })
  .validator((d: UpdateContactInput) => d)
  .handler(async ({ data }): Promise<ContactWriteResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();

      const sets: string[] = [];
      const args: unknown[] = [];
      const push = (col: string, val: unknown) => {
        sets.push(`${col} = $${args.length + 1}`);
        args.push(val);
      };
      if (data.name !== undefined) {
        const n = (data.name ?? "").trim();
        if (!n) return { ok: false, reason: "invalid" };
        push("name", n);
      }
      if (data.company !== undefined) push("company", data.company?.trim() || null);
      if (data.email !== undefined) push("email", data.email?.trim() || null);
      if (data.phone !== undefined) push("phone", data.phone?.trim() || null);
      if (data.notes !== undefined) push("notes", data.notes?.trim() || null);
      if (sets.length === 0) return { ok: true };

      await db.query(
        `update contacts set ${sets.join(", ")} where id = $${args.length + 1}`,
        [...args, data.contactId],
      );
      return { ok: true };
    } catch (err) {
      console.error("[operion-crm] updateContact failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });

/**
 * Delete a contact. The row is simply removed; linked deals keep their
 * denormalized contact_name/email/phone snapshot. The link is severed first so
 * deletion works even against a FK without ON DELETE SET NULL.
 */
export const deleteContact = createServerFn({ method: "POST" })
  .validator((d: { contactId: string }) => d)
  .handler(async ({ data }): Promise<ContactWriteResult> => {
    if (!process.env.DATABASE_URL) return { ok: false, reason: "db-not-connected" };
    try {
      const user = await readSession();
      if (!user) return { ok: false, reason: "not-signed-in" };
      const db = sql();
      await db`update deals set contact_id = null where contact_id = ${data.contactId}`;
      await db`delete from contacts where id = ${data.contactId}`;
      return { ok: true };
    } catch (err) {
      console.error("[operion-crm] deleteContact failed:", err);
      return { ok: false, reason: "db-error" };
    }
  });
