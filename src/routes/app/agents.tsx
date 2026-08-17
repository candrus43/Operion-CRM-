import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import type { SessionUser } from "~/lib/auth";
import {
  createAgent,
  listAgents,
  updateAgent,
  type AgentInfo,
} from "~/lib/agents";

export const Route = createFileRoute("/app/agents")({
  component: AgentsPage,
});

/* ------------------------------------------------------------------ */
/* Icons                                                                */
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
  userPlus: (
    <Svg className="h-5 w-5">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6" />
      <path d="M22 11h-6" />
    </Svg>
  ),
  eye: (
    <Svg className="h-4 w-4">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  eyeOff: (
    <Svg className="h-4 w-4">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </Svg>
  ),
  shield: (
    <Svg className="h-5 w-5">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  ),
  check: (
    <Svg className="h-3.5 w-3.5">
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  ),
  users: (
    <Svg className="h-4 w-4">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  ),
  copy: (
    <Svg className="h-3.5 w-3.5">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  ),
  edit: (
    <Svg className="h-3.5 w-3.5">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </Svg>
  ),
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatUSD(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

/** "Jordan Lee" → "JL" — avatar initials. */
function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (non-secure context) — fall back to a temp
    // textarea so the copy affordance still works.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copyable credential row — label + value + copy button with "Copied" feedback. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.04] px-3.5 py-2.5 ring-1 ring-inset ring-white/[0.06]">
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-white/30">{label}</p>
        <p className="mt-0.5 truncate text-[13px] font-medium text-fg">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => {
          void copyText(value).then((ok) => {
            if (ok) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            }
          });
        }}
        className={`btn-ghost h-8 shrink-0 px-3 text-[11px] ${copied ? "text-emerald-300" : ""}`}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {copied ? (
          <>
            <span className="text-emerald-300">{Icons.check}</span>
            Copied
          </>
        ) : (
          <>
            <span className="text-white/40">{Icons.copy}</span>
            Copy
          </>
        )}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Owner-only guard                                                     */
/* ------------------------------------------------------------------ */

function OwnerOnlyState() {
  return (
    <div className="rise-in flex min-h-[55dvh] items-center justify-center">
      <div className="glass ring-gradient grain relative w-full max-w-md overflow-hidden rounded-3xl p-8 text-center sm:p-10">
        <div className="sheen-overlay" aria-hidden="true" />
        <div className="icon-tile mx-auto mb-5 text-white/50">{Icons.shield}</div>
        <h2 className="text-2xl font-semibold tracking-[-0.045em] text-fg">
          Owner access only
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Agent accounts are managed by the owner. If you need access, ask the owner to
          set up your account from this page.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create-agent form                                                    */
/* ------------------------------------------------------------------ */

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

const EMPTY_FORM = { name: "", email: "", password: "" };

/** Client-side validation mirrors the server rules (email format, ≥8 char
 *  password, duplicate email vs. the already-loaded roster) so the owner gets
 *  inline feedback before any network call. */
function validateCreate(
  values: typeof EMPTY_FORM,
  existing: AgentInfo[],
): FieldErrors {
  const errors: FieldErrors = {};
  const email = values.email.trim().toLowerCase();
  if (!values.name.trim()) errors.name = "Enter the agent's name.";
  if (!EMAIL_RE.test(email)) {
    errors.email = "Enter a valid email address.";
  } else if (existing.some((a) => a.email.toLowerCase() === email)) {
    errors.email = `An account with ${email} already exists.`;
  }
  if (values.password.length < 8) errors.password = "At least 8 characters.";
  return errors;
}

function CreateAgentForm({
  agents,
  onCreated,
}: {
  agents: AgentInfo[] | null;
  onCreated: () => void;
}) {
  const [values, setValues] = useState(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const set = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    const existing = agents ?? [];
    const errs = validateCreate(values, existing);
    setErrors(errs);
    setServerError(null);
    if (Object.keys(errs).length > 0) return;
    setCreating(true);
    try {
      const res = await createAgent({ data: values });
      if (!res.ok) {
        if (res.reason === "duplicate-email") setErrors({ email: res.message });
        else setServerError(res.message);
        return;
      }
      setValues(EMPTY_FORM);
      setShowPassword(false);
      setCreated({
        name: res.agent.name,
        email: res.agent.email,
        password: values.password,
      });
      onCreated();
    } catch {
      setServerError("Something went wrong. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  const fieldLabel = "text-[12px] font-medium text-white/70";
  const fieldError = (msg?: string) =>
    msg ? <p className="mt-1 text-[11px] leading-relaxed text-red-300">{msg}</p> : null;

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-3">
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Name</span>
        <input
          autoFocus
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Jordan Lee"
          className="input-dark"
          aria-label="Agent name"
          aria-invalid={errors.name ? true : undefined}
        />
        {fieldError(errors.name)}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Email</span>
        <input
          type="email"
          value={values.email}
          onChange={(e) => set({ email: e.target.value })}
          placeholder="jordan@operioncrm.com"
          className="input-dark"
          aria-label="Agent email"
          aria-invalid={errors.email ? true : undefined}
        />
        {fieldError(errors.email)}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Temporary password</span>
        <div className="relative">
          <input
            type={showPassword ? "text" : "password"}
            value={values.password}
            onChange={(e) => set({ password: e.target.value })}
            placeholder="At least 8 characters"
            className="input-dark pr-10"
            aria-label="Temporary password"
            aria-invalid={errors.password ? true : undefined}
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1.5 text-white/40 transition-colors hover:text-white/80"
          >
            {showPassword ? Icons.eyeOff : Icons.eye}
          </button>
        </div>
        {fieldError(errors.password)}
      </label>

      <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
        <button type="submit" disabled={creating} className="btn-primary min-w-36">
          {creating ? (
            <>
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black"
              />
              Creating…
            </>
          ) : (
            <>
              {Icons.userPlus}
              Create agent
            </>
          )}
        </button>
        <p className="text-[11px] leading-relaxed text-white/30">
          The agent signs in with this email and password, then sees only the deals
          assigned to them.
        </p>
      </div>

      {serverError ? (
        <p
          role="alert"
          className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300 sm:col-span-3"
        >
          {serverError}
        </p>
      ) : null}

      {/* Credentials — shown ONCE right after creation, with copy affordances. */}
      {created ? (
        <div
          role="status"
          className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] p-4 sm:col-span-3"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="flex items-center gap-2 text-[13px] leading-relaxed text-emerald-300">
              <span className="shrink-0">{Icons.check}</span>
              <span>
                <span className="font-medium text-fg">{created.name}</span> is on board — share
                these sign-in credentials with them.
              </span>
            </p>
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/80"
              aria-label="Dismiss credentials"
            >
              Dismiss
            </button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <CopyRow label="Email" value={created.email} />
            <CopyRow label="Password" value={created.password} />
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-emerald-200/60">
            Shown once — copy them now. They won&apos;t appear here again.
          </p>
        </div>
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Edit-agent modal                                                     */
/* ------------------------------------------------------------------ */

function EditAgentModal({
  agent,
  agents,
  onClose,
  onSaved,
}: {
  agent: AgentInfo;
  agents: AgentInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState({
    name: agent.name,
    email: agent.email,
    password: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const errs: FieldErrors = {};
    const email = values.email.trim().toLowerCase();
    if (!values.name.trim()) errs.name = "Enter the agent's name.";
    if (!EMAIL_RE.test(email)) {
      errs.email = "Enter a valid email address.";
    } else if (
      agents.some((a) => a.id !== agent.id && a.email.toLowerCase() === email)
    ) {
      errs.email = `An account with ${email} already exists.`;
    }
    if (values.password.length > 0 && values.password.length < 8) {
      errs.password = "At least 8 characters — or leave blank to keep the current one.";
    }
    setErrors(errs);
    setServerError(null);
    if (Object.keys(errs).length > 0) return;
    setSaving(true);
    try {
      const res = await updateAgent({
        data: { userId: agent.id, name: values.name, email: values.email, password: values.password || undefined },
      });
      if (!res.ok) {
        if (res.reason === "duplicate-email") setErrors({ email: res.message });
        else setServerError(res.message);
        return;
      }
      onSaved();
    } catch {
      setServerError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const fieldLabel = "text-[12px] font-medium text-white/70";
  const fieldError = (msg?: string) =>
    msg ? <p className="mt-1 text-[11px] leading-relaxed text-red-300">{msg}</p> : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <form
        onSubmit={handleSubmit}
        className="rise-in glass ring-gradient grain relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-3xl p-6 sm:p-7"
      >
        <div className="sheen-overlay" aria-hidden="true" />
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
              Edit agent
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.045em] text-gradient-violet">
              {agent.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div className="grid gap-4">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Name</span>
            <input
              autoFocus
              value={values.name}
              onChange={(e) => set({ name: e.target.value })}
              className="input-dark"
              aria-label="Agent name"
              aria-invalid={errors.name ? true : undefined}
            />
            {fieldError(errors.name)}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Email</span>
            <input
              type="email"
              value={values.email}
              onChange={(e) => set({ email: e.target.value })}
              className="input-dark"
              aria-label="Agent email"
              aria-invalid={errors.email ? true : undefined}
            />
            {fieldError(errors.email)}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Reset password</span>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={values.password}
                onChange={(e) => set({ password: e.target.value })}
                placeholder="Leave blank to keep the current one"
                className="input-dark pr-10"
                aria-label="New password"
                aria-invalid={errors.password ? true : undefined}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1.5 text-white/40 transition-colors hover:text-white/80"
              >
                {showPassword ? Icons.eyeOff : Icons.eye}
              </button>
            </div>
            {fieldError(errors.password)}
          </label>

          {serverError ? (
            <p
              role="alert"
              className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300"
            >
              {serverError}
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} disabled={saving} className="btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="btn-primary min-w-32">
            {saving ? (
              <>
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black"
                />
                Saving…
              </>
            ) : (
              "Save changes"
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Roster                                                               */
/* ------------------------------------------------------------------ */

function Stat({ label, value, accent = false, title }: { label: string; value: string; accent?: boolean; title?: string }) {
  return (
    <div
      title={title}
      className="rounded-xl bg-white/[0.03] px-3 py-2.5 ring-1 ring-inset ring-white/[0.05]"
    >
      <p className="truncate text-[10px] font-medium uppercase tracking-[0.12em] text-white/30">
        {label}
      </p>
      <p
        className={`mt-1 text-[15px] font-semibold tabular-nums ${
          accent ? "text-emerald-300" : "text-fg"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function AgentCard({ agent, onEdit }: { agent: AgentInfo; onEdit: (a: AgentInfo) => void }) {
  return (
    <div className="glass ring-gradient grain relative overflow-hidden rounded-2xl p-5">
      <div className="sheen-overlay" aria-hidden="true" />
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/70 to-blue-500/40 text-[13px] font-semibold text-white ring-1 ring-white/15">
            {initials(agent.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg">
              {agent.name}
            </p>
            <p className="mt-0.5 truncate text-[12px] text-muted">{agent.email}</p>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-white/60 ring-1 ring-inset ring-white/[0.08]">
          {agent.role === "agent" ? "Agent" : agent.role}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Stat label="Open deals" value={String(agent.openDeals)} title="Deals in an open stage" />
        <Stat label="Open MRR" value={`${formatUSD(agent.openMrr)}/mo`} title="Monthly recurring revenue on open deals" />
        <Stat label="Closed won" value={String(agent.wonDeals)} title="Closed Won deals" />
        <Stat
          label="Commission earned"
          value={formatUSD(agent.commissionEarned)}
          accent={agent.commissionEarned > 0}
          title="25% of setup fees collected on closed-won deals"
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3.5">
        <span className="truncate text-[11px] text-white/30">
          Joined {formatDate(agent.created_at)}
        </span>
        <button
          type="button"
          onClick={() => onEdit(agent)}
          className="btn-ghost h-8 shrink-0 px-3 text-[12px]"
        >
          <span className="text-white/40">{Icons.edit}</span>
          Edit
        </button>
      </div>
    </div>
  );
}

function RosterCards({
  agents,
  loading,
  onEdit,
}: {
  agents: AgentInfo[] | null;
  loading: boolean;
  onEdit: (a: AgentInfo) => void;
}) {
  if (loading && agents === null) {
    return (
      <div className="glass-deep flex min-h-[120px] items-center justify-center rounded-2xl px-6 py-8">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
      </div>
    );
  }
  if (agents !== null && agents.length === 0) {
    return (
      <div className="glass-deep flex min-h-[160px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] px-6 py-10 text-center">
        <div className="icon-tile mb-4 text-white/35">{Icons.users}</div>
        <p className="text-sm font-medium text-fg">No agents yet</p>
        <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-muted">
          Create your first agent above — they&apos;ll appear here with their deal counts.
        </p>
      </div>
    );
  }
  if (agents === null) {
    return (
      <div className="glass-deep flex min-h-[120px] items-center justify-center rounded-2xl px-6 py-8">
        <p className="text-[13px] text-muted">Couldn&apos;t load the roster.</p>
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {agents.map((a) => (
        <AgentCard key={a.id} agent={a} onEdit={onEdit} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

function AgentsAdmin() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listAgents();
      if (!res.ok) {
        if (res.reason === "not-signed-in") window.location.assign("/");
        setStatus("error");
        return;
      }
      setAgents(res.agents);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="rise-in">
      {/* Header */}
      <div className="mb-6">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
          Admin
        </p>
        <h1 className="text-3xl font-semibold tracking-[-0.045em] text-gradient-violet sm:text-4xl">
          Agents
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
          Create accounts for your sales agents and keep an eye on who owns which
          deals. Agents see only the deals assigned to them.
        </p>
      </div>

      {/* Create form */}
      <div className="glass ring-gradient grain relative mb-6 overflow-hidden rounded-3xl p-6 sm:p-7">
        <div className="sheen-overlay" aria-hidden="true" />
        <div className="mb-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
            New agent
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-[-0.045em] text-fg">
            Add an agent to the team
          </h2>
        </div>
        <CreateAgentForm agents={agents} onCreated={() => void load()} />
      </div>

      {/* Page-level notice (e.g. edit feedback) */}
      {notice ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] px-4 py-3">
          <p role="status" className="flex items-center gap-2 text-[13px] leading-relaxed text-emerald-300">
            <span className="shrink-0">{Icons.check}</span>
            {notice}
          </p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/80"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Roster */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/35">
          Team roster
        </h2>
        {agents !== null ? (
          <span className="text-[11px] tabular-nums text-white/30">
            {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {status === "error" && agents === null ? (
        <div className="glass-deep flex min-h-[120px] items-center justify-center rounded-2xl px-6 py-8">
          <p className="text-[13px] text-muted">Couldn&apos;t load the roster.</p>
          <button type="button" onClick={() => void load()} className="btn-ghost ml-3 h-8 px-3 text-[12px]">
            Try again
          </button>
        </div>
      ) : (
        <RosterCards
          agents={agents}
          loading={status === "loading"}
          onEdit={(a) => {
            setNotice(null);
            setEditing(a);
          }}
        />
      )}

      {/* Edit modal */}
      {editing ? (
        <EditAgentModal
          agent={editing}
          agents={agents ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            const name = editing.name;
            setEditing(null);
            setNotice(`${name} updated.`);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function AgentsPage() {
  const session = useLoaderData({ from: "/app" }) as SessionUser;
  if (session.role !== "owner") return <OwnerOnlyState />;
  return <AgentsAdmin />;
}
