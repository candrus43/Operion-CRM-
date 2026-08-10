import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, createFileRoute, useLoaderData } from "@tanstack/react-router";
import type { SessionUser } from "~/lib/auth";
import {
  createContact,
  deleteContact,
  getContactDetail,
  listContacts,
  updateContact,
  type Contact,
  type ContactDeal,
  type ContactWithCount,
  type DbStatus,
  type Stage,
} from "~/lib/contacts";

export const Route = createFileRoute("/app/contacts")({
  // The pipeline's deal drawer deep-links here: /app/contacts?contact=<id>
  validateSearch: (search: Record<string, unknown>) => {
    const contact =
      typeof search.contact === "string" && search.contact ? search.contact : null;
    return contact ? { contact } : {};
  },
  component: ContactsPage,
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const STAGE_BADGE: Record<Stage, string> = {
  Lead: "bg-white/[0.07] text-white/70",
  Contacted: "bg-sky-400/10 text-sky-300",
  Meeting: "bg-violet-400/10 text-violet-300",
  Proposal: "bg-indigo-400/10 text-indigo-300",
  Negotiation: "bg-amber-400/10 text-amber-300",
  "Closed Won": "bg-emerald-400/10 text-emerald-300",
  "Closed Lost": "bg-rose-400/10 text-rose-300",
};

function formatUSD(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function friendlyError(reason: DbStatus): string {
  switch (reason) {
    case "db-not-connected":
      return "Database is not connected yet.";
    case "not-signed-in":
      return "Your session expired. Please sign in again.";
    case "invalid":
      return "That contact no longer exists.";
    default:
      return "Something went wrong. Please try again.";
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

function Svg({
  children,
  className = "h-4 w-4",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const Icons = {
  plus: (
    <Svg>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  ),
  close: (
    <Svg className="h-4 w-4">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  ),
  mail: (
    <Svg>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </Svg>
  ),
  phone: (
    <Svg>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </Svg>
  ),
  edit: (
    <Svg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  ),
  trash: (
    <Svg>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Svg>
  ),
  search: (
    <Svg>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  ),
  chevron: (
    <Svg className="h-4 w-4">
      <path d="m9 18 6-6-6-6" />
    </Svg>
  ),
  users: (
    <Svg>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  ),
  arrow: (
    <Svg>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Svg>
  ),
  database: (
    <Svg className="h-5 w-5">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </Svg>
  ),
  building: (
    <Svg>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <path d="M10 6h4" />
      <path d="M10 10h4" />
      <path d="M10 14h4" />
      <path d="M10 18h4" />
    </Svg>
  ),
};

/* ------------------------------------------------------------------ */
/* Contact form modal                                                  */
/* ------------------------------------------------------------------ */

function ContactFormModal({
  contact,
  onClose,
  onSaved,
  notify,
}: {
  contact: Contact | null;
  onClose: () => void;
  onSaved: (contactId?: string) => void;
  notify: (msg: string) => void;
}) {
  const editing = contact !== null;
  const [values, setValues] = useState({
    name: contact?.name ?? "",
    company: contact?.company ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    notes: contact?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!values.name.trim()) {
      setError("Name is required.");
      return;
    }
    setError(null);
    setSaving(true);
    const payload = {
      name: values.name.trim(),
      company: values.company.trim() || null,
      email: values.email.trim() || null,
      phone: values.phone.trim() || null,
      notes: values.notes.trim() || null,
    };
    try {
      const res = editing
        ? await updateContact({ data: { contactId: contact.id, ...payload } })
        : await createContact({ data: payload });
      if (!res.ok) {
        setError(friendlyError(res.reason));
        return;
      }
      onSaved(res.contactId);
      notify(editing ? "Contact updated" : "Contact created");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const fieldLabel = "text-[12px] font-medium text-white/70";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="rise-in glass ring-gradient grain relative max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-3xl p-6 sm:p-7">
        <div className="sheen-overlay" aria-hidden="true" />
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
              {editing ? "Edit contact" : "New contact"}
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.045em] text-gradient-violet">
              {editing ? values.name : "Add someone to your contacts"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
          >
            {Icons.close}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Name *</span>
            <input
              required
              autoFocus
              value={values.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Dana Whitfield"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Company</span>
            <input
              value={values.company}
              onChange={(e) => set({ company: e.target.value })}
              placeholder="Acme Corp"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Email</span>
            <input
              type="email"
              value={values.email}
              onChange={(e) => set({ email: e.target.value })}
              placeholder="dana@acmecorp.com"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Phone</span>
            <input
              value={values.phone}
              onChange={(e) => set({ phone: e.target.value })}
              placeholder="+1 (415) 555-0142"
              className="input-dark"
            />
          </label>

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Notes</span>
            <textarea
              rows={3}
              value={values.notes}
              onChange={(e) => set({ notes: e.target.value })}
              placeholder="Context, preferences, how you know them…"
              className="input-dark resize-none"
            />
          </label>

          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300 sm:col-span-2"
            >
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-3 pt-1 sm:col-span-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary min-w-28">
              {saving ? (
                <>
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black"
                  />
                  Saving…
                </>
              ) : editing ? (
                "Save changes"
              ) : (
                "Create contact"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Contact detail drawer                                               */
/* ------------------------------------------------------------------ */

function ContactDetailDrawer({
  contactId,
  onClose,
  onEdit,
  onChanged,
  onDeleted,
  notify,
}: {
  contactId: string;
  onClose: () => void;
  onEdit: (contact: Contact) => void;
  onChanged: () => void;
  onDeleted: () => void;
  notify: (msg: string) => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; reason: DbStatus }
    | { status: "ready"; contact: Contact; deals: ContactDeal[] }
  >({ status: "loading" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setConfirmDelete(false);
    getContactDetail({ data: { contactId } }).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setState({ status: "error", reason: res.reason });
        return;
      }
      setState({ status: "ready", contact: res.contact, deals: res.deals });
    });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    const res = await deleteContact({ data: { contactId } });
    setDeleting(false);
    if (!res.ok) {
      notify(friendlyError(res.reason));
      return;
    }
    notify("Contact deleted");
    onDeleted();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <aside className="drawer-in glass-deep fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-r-0 border-y-0">
        <div className="scroll-thin flex-1 overflow-y-auto">
          {state.status === "loading" ? (
            <div className="flex h-64 items-center justify-center">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
            </div>
          ) : state.status === "error" ? (
            <div className="p-8 text-center">
              <p className="text-sm text-muted">{friendlyError(state.reason)}</p>
              <button type="button" className="btn-ghost mt-4" onClick={onClose}>
                Close
              </button>
            </div>
          ) : (
            <div className="p-6">
              {/* Header */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
                    Contact detail
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/70 to-blue-500/40 text-[13px] font-semibold text-white ring-1 ring-white/15">
                      {initials(state.contact.name)}
                    </div>
                    <h2 className="truncate text-2xl font-semibold tracking-[-0.045em] text-gradient-violet">
                      {state.contact.name}
                    </h2>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
                >
                  {Icons.close}
                </button>
              </div>

              {/* Company */}
              {state.contact.company ? (
                <div className="glass mt-6 flex items-start gap-2.5 rounded-2xl p-4">
                  <span className="mt-0.5 text-white/25">{Icons.building}</span>
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                      Company
                    </p>
                    <p className="mt-1 text-[13px] leading-relaxed text-fg">
                      {state.contact.company}
                    </p>
                  </div>
                </div>
              ) : null}

              {/* Contact details */}
              <div className="glass mt-3 rounded-2xl p-4">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                  Contact details
                </p>
                <div className="mt-2 space-y-2 text-[13px]">
                  {state.contact.email ? (
                    <a
                      href={`mailto:${state.contact.email}`}
                      className="flex items-center gap-2 text-muted transition-colors hover:text-accent-light"
                    >
                      <span className="text-white/25">{Icons.mail}</span>
                      <span className="truncate">{state.contact.email}</span>
                    </a>
                  ) : null}
                  {state.contact.phone ? (
                    <a
                      href={`tel:${state.contact.phone}`}
                      className="flex items-center gap-2 text-muted transition-colors hover:text-accent-light"
                    >
                      <span className="text-white/25">{Icons.phone}</span>
                      <span className="truncate">{state.contact.phone}</span>
                    </a>
                  ) : null}
                  {!state.contact.email && !state.contact.phone ? (
                    <p className="text-[12px] text-white/30">No contact details yet</p>
                  ) : null}
                </div>
              </div>

              {/* Notes */}
              {state.contact.notes ? (
                <div className="glass mt-3 flex items-start gap-2.5 rounded-2xl p-4">
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/30">
                      Notes
                    </p>
                    <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">
                      {state.contact.notes}
                    </p>
                  </div>
                </div>
              ) : null}

              {/* Linked deals */}
              <div className="mt-6 flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/35">
                  Linked deals
                </p>
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/60">
                  {state.deals.length}
                </span>
              </div>

              <div className="mt-3 space-y-2.5 pb-4">
                {state.deals.length === 0 ? (
                  <div className="glass flex min-h-[96px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] px-4 py-6 text-center">
                    <p className="text-[12px] text-white/30">
                      No deals linked yet — link this contact when you create or edit a deal.
                    </p>
                  </div>
                ) : (
                  state.deals.map((d) => (
                    <Link
                      key={d.id}
                      to="/app"
                      className="glass lift-sm group block rounded-2xl p-4 text-left transition-all duration-300"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-[14px] font-semibold tracking-[-0.045em] text-fg">
                          {d.company}
                        </p>
                        <span className="shrink-0 text-[13px] font-medium tabular-nums text-white/85">
                          {formatUSD(d.value)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${STAGE_BADGE[d.stage]}`}
                        >
                          {d.stage}
                        </span>
                        <span className="truncate text-[11px] text-white/35">
                          {d.owner_name || "Unassigned"}
                        </span>
                        <span className="ml-auto text-[11px] text-white/25">
                          {relTime(d.updated_at)}
                        </span>
                        <span className="text-white/25 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                          {Icons.arrow}
                        </span>
                      </div>
                    </Link>
                  ))
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 border-t border-white/[0.06] pt-4 pb-2">
                <button
                  type="button"
                  onClick={() => onEdit(state.contact)}
                  className="btn-ghost h-9 px-3 text-[12px]"
                >
                  <span className="text-white/40">{Icons.edit}</span>
                  Edit contact
                </button>
                {confirmDelete ? (
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="btn-ghost h-9 px-3 text-[12px]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full bg-red-500/15 px-4 text-[12px] font-medium text-red-300 transition-colors duration-300 hover:bg-red-500/25"
                    >
                      {Icons.trash}
                      {deleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="btn-ghost ml-auto h-9 px-3 text-[12px] hover:bg-red-500/10 hover:text-red-300"
                  >
                    <span className="text-white/40">{Icons.trash}</span>
                    Delete contact
                  </button>
                )}
              </div>
              {confirmDelete ? (
                <p className="text-[11px] leading-relaxed text-white/30">
                  Deleting this contact won&apos;t remove any linked deals — they keep their
                  contact details.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

function DbNotConnected({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[58dvh] items-center justify-center">
      <div className="rise-in w-full max-w-md">
        <div className="glass ring-gradient grain relative overflow-hidden rounded-3xl p-8 text-center sm:p-10">
          <div className="sheen-overlay" aria-hidden="true" />
          <div className="icon-tile mx-auto mb-5 text-white/50">{Icons.database}</div>
          <h2 className="text-2xl font-semibold tracking-[-0.045em] text-fg">
            Database is not connected yet
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Connect the database from the dashboard to start managing your contacts. Your
            contacts and their deals will show up here as soon as it&apos;s connected.
          </p>
          <button type="button" onClick={onRetry} className="btn-ghost mt-6">
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-[55dvh] items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
        <p className="text-[13px] text-muted">Loading contacts…</p>
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[55dvh] items-center justify-center">
      <div className="glass w-full max-w-md rounded-3xl p-8 text-center">
        <h2 className="text-xl font-semibold tracking-[-0.045em] text-fg">
          Couldn&apos;t load contacts
        </h2>
        <p className="mt-2 text-sm text-muted">
          Something went wrong while loading your contacts.
        </p>
        <button type="button" onClick={onRetry} className="btn-ghost mt-5">
          Try again
        </button>
      </div>
    </div>
  );
}

function Toast({ message }: { message: string }) {
  return (
    <div className="rise-in glass-deep fixed right-5 bottom-5 z-[70] flex items-center gap-2.5 rounded-xl px-4 py-3 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]">
      <span className="h-2 w-2 shrink-0 rounded-full bg-accent-light" />
      <p className="text-[13px] font-medium text-fg">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function ContactsPage() {
  const session = useLoaderData({ from: "/app" }) as SessionUser;
  const search = Route.useSearch();

  const [status, setStatus] = useState<"loading" | "ready" | "not-connected" | "error">(
    "loading",
  );
  const [contacts, setContacts] = useState<ContactWithCount[]>([]);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    const res = await listContacts();
    if (!res.ok) {
      if (res.reason === "db-not-connected") return setStatus("not-connected");
      if (res.reason === "not-signed-in") return window.location.assign("/");
      return setStatus("error");
    }
    setContacts(res.contacts);
    setStatus("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep link from the pipeline deal drawer: /app/contacts?contact=<id>
  useEffect(() => {
    if (search.contact) setDetailId(search.contact);
  }, [search.contact]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) =>
      [c.name, c.company, c.email, c.phone].filter(Boolean).some((v) =>
        String(v).toLowerCase().includes(q),
      ),
    );
  }, [contacts, query]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const openCreate = useCallback(() => {
    setEditingContact(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((contact: Contact) => {
    setEditingContact(contact);
    setFormOpen(true);
  }, []);

  const handleSaved = useCallback(
    (contactId?: string) => {
      setFormOpen(false);
      setEditingContact(null);
      void refresh();
      if (contactId) setDetailId(contactId);
    },
    [refresh],
  );

  const handleDeleted = useCallback(() => {
    setDetailId(null);
    void refresh();
  }, [refresh]);

  return (
    <div className="rise-in">
      {status === "not-connected" ? (
        <DbNotConnected onRetry={() => void load()} />
      ) : status === "error" ? (
        <ErrorState onRetry={() => void load()} />
      ) : status === "loading" ? (
        <LoadingState />
      ) : (
        <>
          {/* Header */}
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
                Contacts
              </p>
              <h1 className="text-3xl font-semibold tracking-[-0.045em] text-gradient-violet sm:text-4xl">
                Contacts
              </h1>
              <p className="mt-2 text-sm text-muted">
                The team&apos;s shared contact list — everyone you talk to, with the deals
                linked to each person.
              </p>
            </div>
            <button type="button" onClick={openCreate} className="btn-primary">
              {Icons.plus}
              New contact
            </button>
          </div>

          {/* Toolbar */}
          <div className="glass-deep mb-5 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
            <div className="relative min-w-52 flex-1 sm:max-w-xs">
              <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-white/30">
                {Icons.search}
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, company, email…"
                aria-label="Search contacts"
                className="input-dark h-9 py-0 pr-3 pl-10 text-[13px]"
              />
            </div>
            <p className="ml-auto text-[12px] tabular-nums text-muted">
              {filtered.length} contact{filtered.length === 1 ? "" : "s"}
            </p>
          </div>

          {/* List */}
          {contacts.length === 0 ? (
            <div className="glass ring-gradient grain relative overflow-hidden rounded-3xl p-10">
              <div className="sheen-overlay" aria-hidden="true" />
              <div className="flex flex-col items-center gap-4 py-10 text-center">
                <div className="icon-tile text-white/50">{Icons.users}</div>
                <p className="text-sm font-medium text-fg">No contacts yet</p>
                <p className="max-w-sm text-[13px] leading-relaxed text-muted">
                  Create your first contact — then link it to a deal from the pipeline so
                  everyone knows who you&apos;re talking to.
                </p>
                <button type="button" onClick={openCreate} className="btn-primary mt-2">
                  {Icons.plus}
                  Create your first contact
                </button>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="glass rounded-3xl p-10 text-center">
              <p className="text-sm text-muted">No contacts match your search.</p>
            </div>
          ) : (
            <div className="glass overflow-hidden rounded-3xl">
              <div className="scroll-thin overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-white/[0.06]">
                      {[
                        "Name",
                        "Company",
                        "Email",
                        "Phone",
                        "Notes",
                        "Deals",
                        "",
                      ].map((h, i) => (
                        <th
                          key={i}
                          className={`px-5 py-3.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white/30 ${
                            i === 0 ? "w-[22%]" : ""
                          } ${i >= 2 && i <= 4 ? "hidden md:table-cell" : ""} ${
                            i === 5 ? "w-20" : ""
                          } ${i === 6 ? "w-10" : ""}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr
                        key={c.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setDetailId(c.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setDetailId(c.id);
                          }
                        }}
                        className="group cursor-pointer border-b border-white/[0.04] transition-colors duration-200 outline-none last:border-b-0 hover:bg-white/[0.03] focus-visible:bg-white/[0.03]"
                      >
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/70 to-blue-500/40 text-[11px] font-semibold text-white ring-1 ring-white/15">
                              {initials(c.name)}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-[13px] font-medium text-fg">
                                {c.name}
                              </p>
                              <p className="mt-0.5 text-[11px] text-white/35">
                                Added {relTime(c.created_at)}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <p className="truncate text-[13px] text-muted">
                            {c.company || <span className="text-white/25">—</span>}
                          </p>
                        </td>
                        <td className="hidden px-5 py-4 md:table-cell">
                          {c.email ? (
                            <a
                              href={`mailto:${c.email}`}
                              onClick={(e) => e.stopPropagation()}
                              className="flex items-center gap-2 truncate text-[13px] text-muted transition-colors hover:text-accent-light"
                            >
                              <span className="shrink-0 text-white/25">{Icons.mail}</span>
                              <span className="truncate">{c.email}</span>
                            </a>
                          ) : (
                            <span className="text-[13px] text-white/25">—</span>
                          )}
                        </td>
                        <td className="hidden px-5 py-4 md:table-cell">
                          {c.phone ? (
                            <a
                              href={`tel:${c.phone}`}
                              onClick={(e) => e.stopPropagation()}
                              className="flex items-center gap-2 truncate text-[13px] text-muted transition-colors hover:text-accent-light"
                            >
                              <span className="shrink-0 text-white/25">{Icons.phone}</span>
                              <span className="truncate">{c.phone}</span>
                            </a>
                          ) : (
                            <span className="text-[13px] text-white/25">—</span>
                          )}
                        </td>
                        <td className="hidden max-w-56 px-5 py-4 md:table-cell">
                          <p className="truncate text-[13px] text-white/45">
                            {c.notes || <span className="text-white/25">—</span>}
                          </p>
                        </td>
                        <td className="px-5 py-4">
                          <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/60">
                            {c.deal_count}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <span className="text-white/20 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                            {Icons.chevron}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {formOpen ? (
        <ContactFormModal
          contact={editingContact}
          onClose={() => {
            setFormOpen(false);
            setEditingContact(null);
          }}
          onSaved={handleSaved}
          notify={notify}
        />
      ) : null}

      {detailId ? (
        <ContactDetailDrawer
          contactId={detailId}
          onClose={() => setDetailId(null)}
          onEdit={openEdit}
          onChanged={refresh}
          onDeleted={handleDeleted}
          notify={notify}
        />
      ) : null}

      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}
