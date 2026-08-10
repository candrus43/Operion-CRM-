/**
 * Operion CRM — resource library server functions.
 *
 * The library stores real sales collateral (pricing sheet, playbooks, decks)
 * as raw file bytes in Postgres (`resources.file_data bytea`) so documents can
 * be viewed INSIDE the CRM, not just downloaded. Text/markdown resources open
 * in the in-app reader; everything else downloads with the original bytes.
 *
 * Conventions follow `~/lib/pipeline` / `~/lib/agents`: every handler re-reads
 * the session server-side (never trusts the client), any logged-in user can
 * list/read/upload, and ONLY the owner can delete. Results are
 * `{ ok: true, ... }` / `{ ok: false, reason, message }` with a human-readable
 * message ready for inline display.
 *
 * Uploads arrive as multipart FormData (TanStack Start passes the parsed
 * FormData to the handler untouched — validated as a plain function, no
 * serialization), and the file bytes are read from the FormData `File` in the
 * server function. Bytes are passed to the Neon driver as a Buffer/Uint8Array,
 * which binds correctly as a bytea parameter.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "~/db";
import { readSession } from "./auth-core";
import type { DbStatus } from "./pipeline";

/** The categories the library organizes resources into (mirrors the UI select). */
export const RESOURCE_CATEGORIES = [
  "Pricing",
  "Playbooks",
  "Case studies",
  "Contract templates",
  "Competitors",
] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(RESOURCE_CATEGORIES);

/** Upload cap — 5 MB of raw file bytes (keeps Neon bytea payloads sane). */
export const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;

export type ResourceErrorReason =
  | DbStatus
  | "owner-only"
  | "not-found"
  | "file-too-large"
  | "missing-file"
  | "invalid";

/** A resource row without the file bytes (safe for list views). */
export interface ResourceMeta {
  id: string;
  title: string;
  category: string;
  description: string;
  file_name: string;
  file_type: string;
  file_size: number;
  /** Uploader display name; null for the seeded team documents. */
  uploader_name: string | null;
  created_at: string;
}

/** A resource with its file bytes (base64) — returned only by getResource. */
export interface ResourceDetail extends ResourceMeta {
  dataBase64: string;
  /** UTF-8 text for text-like resources (text/* or .md/.txt); null for binaries. */
  text: string | null;
}

/** Returns the current user, or the standard not-signed-in error result. */
async function requireUser(): Promise<
  { user: NonNullable<Awaited<ReturnType<typeof readSession>>> } | { error: { ok: false; reason: DbStatus; message: string } }
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
  return { user };
}

/** True when a resource is text-like and should open in the in-app reader. */
export function isTextResource(fileType: string, fileName: string): boolean {
  const type = (fileType ?? "").toLowerCase();
  const name = (fileName ?? "").toLowerCase();
  return (
    type.startsWith("text/") ||
    /\.(md|markdown|txt)$/.test(name)
  );
}

/**
 * Strip anything dangerous or noisy out of an uploaded file name: path
 * separators (the browser sends a bare name, but never trust the client),
 * control characters, and characters that are illegal in most file systems.
 */
export function sanitizeFileName(input: string): string {
  let name = (input ?? "")
    .trim()
    .replace(/^.*[\\/]/, "") // strip any path prefix
    .replace(/[\u0000-\u001f\u007f]/g, "") // strip control chars
    .replace(/[<>:"|?*]/g, "_"); // strip filesystem-hostile chars
  if (name.length > 120) {
    const ext = /(\.[A-Za-z0-9]{1,10})$/.exec(name)?.[1] ?? "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || "upload.bin";
}

/* ------------------------------------------------------------------ */
/* Server functions                                                    */
/* ------------------------------------------------------------------ */

export type ListResourcesResult =
  | { ok: true; resources: ResourceMeta[] }
  | { ok: false; reason: ResourceErrorReason; message: string };

/** Every resource's metadata (no file bytes), newest first. Any logged-in user. */
export const listResources = createServerFn({ method: "GET" }).handler(
  async (): Promise<ListResourcesResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const guard = await requireUser();
      if ("error" in guard) return guard.error;
      const db = sql();
      const rows = await db`
        select r.id, r.title, r.category, r.description, r.file_name, r.file_type,
               r.file_size, r.created_at, u.name as uploader_name
        from resources r
        left join users u on u.id = r.uploaded_by
        order by r.created_at desc
      `;
      return {
        ok: true,
        resources: rows.map((r) => ({
          id: String(r.id),
          title: String(r.title),
          category: String(r.category),
          description: String(r.description),
          file_name: String(r.file_name),
          file_type: String(r.file_type),
          file_size: Number(r.file_size),
          uploader_name: r.uploader_name == null ? null : String(r.uploader_name),
          created_at: new Date(r.created_at as Date).toISOString(),
        })),
      };
    } catch (err) {
      console.error("[operion-crm] listResources failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  },
);

export type CreateResourceResult =
  | { ok: true; resource: ResourceMeta }
  | { ok: false; reason: ResourceErrorReason; message: string };

/**
 * Upload a resource. Any logged-in user (agents may upload — the library is
 * team-shared). Receives multipart FormData: title, category, description
 * fields plus a `file` File entry. Validates required fields, the category
 * allow-list and the 5 MB cap, sanitizes the file name, and stores the raw
 * bytes as bytea. Returns the new row's metadata.
 */
export const createResource = createServerFn({ method: "POST" })
  .validator((d: FormData) => d)
  .handler(async ({ data }): Promise<CreateResourceResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const guard = await requireUser();
      if ("error" in guard) return guard.error;

      const title = String(data.get("title") ?? "").trim();
      const category = String(data.get("category") ?? "").trim();
      const description = String(data.get("description") ?? "").trim();
      const file = data.get("file");

      if (!title) return { ok: false, reason: "invalid", message: "Enter a title for the resource." };
      if (!CATEGORY_SET.has(category)) {
        return { ok: false, reason: "invalid", message: "Pick a category from the list." };
      }
      if (!(file instanceof File)) {
        return { ok: false, reason: "missing-file", message: "Choose a file to upload." };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length === 0) {
        return { ok: false, reason: "missing-file", message: "That file is empty — choose a file with content." };
      }
      if (bytes.length > MAX_RESOURCE_BYTES) {
        return {
          ok: false,
          reason: "file-too-large",
          message: "Files must be 5 MB or smaller.",
        };
      }

      const fileType = (file.type || "application/octet-stream").slice(0, 120);
      const fileName = sanitizeFileName(file.name);

      const db = sql();
      const insertRows = await db`
        insert into resources (title, category, description, file_name, file_type, file_size, file_data, uploaded_by)
        values (${title}, ${category}, ${description}, ${fileName}, ${fileType}, ${bytes.length}, ${bytes}, ${guard.user.id})
        returning id
      `;
      const metaRows = await db`
        select r.id, r.title, r.category, r.description, r.file_name, r.file_type,
               r.file_size, r.created_at, u.name as uploader_name
        from resources r
        left join users u on u.id = r.uploaded_by
        where r.id = ${insertRows[0].id}
        limit 1
      `;
      const m = metaRows[0];
      return {
        ok: true,
        resource: {
          id: String(m.id),
          title: String(m.title),
          category: String(m.category),
          description: String(m.description),
          file_name: String(m.file_name),
          file_type: String(m.file_type),
          file_size: Number(m.file_size),
          uploader_name: m.uploader_name == null ? null : String(m.uploader_name),
          created_at: new Date(m.created_at as Date).toISOString(),
        },
      };
    } catch (err) {
      console.error("[operion-crm] createResource failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  });

export type GetResourceResult =
  | { ok: true; resource: ResourceDetail }
  | { ok: false; reason: ResourceErrorReason; message: string };

/**
 * Full resource: metadata + file bytes (base64) + decoded text for text-like
 * files. Any logged-in user. Used by the in-app reader and by downloads.
 */
export const getResource = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }): Promise<GetResourceResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const guard = await requireUser();
      if ("error" in guard) return guard.error;
      const db = sql();
      const rows = await db`
        select r.*, u.name as uploader_name
        from resources r
        left join users u on u.id = r.uploaded_by
        where r.id = ${data.id}
        limit 1
      `;
      if (rows.length === 0) {
        return { ok: false, reason: "not-found", message: "That resource no longer exists." };
      }
      const r = rows[0];
      const bytes = Buffer.from(r.file_data as Uint8Array);
      const fileName = String(r.file_name);
      const fileType = String(r.file_type);
      const textLike = isTextResource(fileType, fileName);
      return {
        ok: true,
        resource: {
          id: String(r.id),
          title: String(r.title),
          category: String(r.category),
          description: String(r.description),
          file_name: fileName,
          file_type: fileType,
          file_size: Number(r.file_size),
          uploader_name: r.uploader_name == null ? null : String(r.uploader_name),
          created_at: new Date(r.created_at as Date).toISOString(),
          dataBase64: bytes.toString("base64"),
          text: textLike ? bytes.toString("utf8") : null,
        },
      };
    } catch (err) {
      console.error("[operion-crm] getResource failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  });

export type DeleteResourceResult =
  | { ok: true; id: string }
  | { ok: false; reason: ResourceErrorReason; message: string };

/** Remove a resource. OWNER-ONLY — agents get a clear error. */
export const deleteResource = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }): Promise<DeleteResourceResult> => {
    if (!process.env.DATABASE_URL) {
      return { ok: false, reason: "db-not-connected", message: "Database is not connected yet." };
    }
    try {
      const guard = await requireUser();
      if ("error" in guard) return guard.error;
      if (guard.user.role !== "owner") {
        return {
          ok: false,
          reason: "owner-only",
          message: "Only the owner can delete resources.",
        };
      }
      const db = sql();
      const rows = await db`select id from resources where id = ${data.id} limit 1`;
      if (rows.length === 0) {
        return { ok: false, reason: "not-found", message: "That resource no longer exists." };
      }
      await db`delete from resources where id = ${data.id}`;
      return { ok: true, id: data.id };
    } catch (err) {
      console.error("[operion-crm] deleteResource failed:", err);
      return { ok: false, reason: "db-error", message: "Something went wrong. Please try again." };
    }
  });
