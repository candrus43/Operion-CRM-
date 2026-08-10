import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import type { SessionUser } from "~/lib/auth";
import {
  RESOURCE_CATEGORIES,
  createResource,
  deleteResource,
  getResource,
  isTextResource,
  listResources,
  type ResourceDetail,
  type ResourceMeta,
} from "~/lib/resources";
import { renderMarkdown } from "~/lib/markdown";

export const Route = createFileRoute("/app/resources")({
  component: ResourcesPage,
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
  upload: (
    <Svg className="h-4 w-4">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </Svg>
  ),
  download: (
    <Svg className="h-3.5 w-3.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </Svg>
  ),
  trash: (
    <Svg className="h-3.5 w-3.5">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Svg>
  ),
  x: (
    <Svg className="h-4 w-4">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  ),
  book: (
    <Svg className="h-4 w-4">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </Svg>
  ),
  fileText: (
    <Svg className="h-5 w-5">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
      <path d="M10 9H8" />
    </Svg>
  ),
  fileCode: (
    <Svg className="h-5 w-5">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="m10 13-2 2 2 2" />
      <path d="m14 13 2 2-2 2" />
    </Svg>
  ),
  filePdf: (
    <Svg className="h-5 w-5">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h1.5a1.5 1.5 0 0 1 0 3H8z" />
      <path d="M12 13v3" />
      <path d="M15.5 13H17a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-1.5z" />
    </Svg>
  ),
  fileImage: (
    <Svg className="h-5 w-5">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <circle cx="9" cy="13" r="1.5" />
      <path d="m7 18 3.5-3.5 2.5 2.5 2-2L18 18" />
    </Svg>
  ),
  fileSlides: (
    <Svg className="h-5 w-5">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </Svg>
  ),
  file: (
    <Svg className="h-5 w-5">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </Svg>
  ),
  folder: (
    <Svg className="h-5 w-5">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
    </Svg>
  ),
  check: (
    <Svg className="h-3.5 w-3.5">
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  ),
  spinner: (
    <span
      aria-hidden="true"
      className="h-4 w-4 animate-spin rounded-full border-2 border-white/15 border-t-accent-light"
    />
  ),
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Client-side twin of the server helper — decides Read vs Download per card. */
function isTextLike(r: ResourceMeta): boolean {
  return isTextResource(r.file_type, r.file_name);
}

function fileIconFor(r: ResourceMeta): React.ReactNode {
  const name = r.file_name.toLowerCase();
  const type = r.file_type.toLowerCase();
  if (/\.(md|markdown|txt)$/.test(name) || type.startsWith("text/")) return Icons.fileCode;
  if (name.endsWith(".pdf") || type === "application/pdf") return Icons.filePdf;
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(name) || type.startsWith("image/")) return Icons.fileImage;
  if (/\.(ppt|pptx|key)$/.test(name) || /presentation/.test(type)) return Icons.fileSlides;
  if (/\.(doc|docx|rtf|odt)$/.test(name) || /word/.test(type)) return Icons.fileText;
  if (/\.(xls|xlsx|csv|ods)$/.test(name) || /spreadsheet|excel/.test(type)) return Icons.fileText;
  if (/\.(md|markdown)$/.test(name)) return Icons.fileCode;
  return Icons.file;
}

const CATEGORY_BADGE: Record<string, string> = {
  Pricing: "bg-sky-400/10 text-sky-300 ring-1 ring-inset ring-sky-400/20",
  Playbooks: "bg-violet-400/10 text-violet-300 ring-1 ring-inset ring-violet-400/20",
  "Case studies": "bg-emerald-400/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20",
  "Contract templates": "bg-amber-400/10 text-amber-300 ring-1 ring-inset ring-amber-400/20",
  Competitors: "bg-rose-400/10 text-rose-300 ring-1 ring-inset ring-rose-400/20",
};

function CategoryBadge({ category }: { category: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
        CATEGORY_BADGE[category] ?? "bg-white/[0.06] text-white/50 ring-1 ring-inset ring-white/10"
      }`}
    >
      {category}
    </span>
  );
}

function base64ToBlob(b64: string, type: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: type || "application/octet-stream" });
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ------------------------------------------------------------------ */
/* Upload modal                                                         */
/* ------------------------------------------------------------------ */

interface UploadForm {
  title: string;
  category: string;
  description: string;
  file: File | null;
}

const EMPTY_UPLOAD: UploadForm = { title: "", category: RESOURCE_CATEGORIES[0], description: "", file: null };

function UploadModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const [form, setForm] = useState<UploadForm>(EMPTY_UPLOAD);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const set = (patch: Partial<UploadForm>) => setForm((f) => ({ ...f, ...patch }));
  const canSubmit = form.title.trim() && form.category && form.file;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (uploading || !form.file) return;
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("title", form.title.trim());
      fd.append("category", form.category);
      fd.append("description", form.description.trim());
      fd.append("file", form.file);
      const res = await createResource({ data: fd });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      onUploaded();
      onClose();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  const fieldLabel = "text-[12px] font-medium text-white/70";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close upload dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="glass ring-gradient grain relative w-full max-w-lg overflow-hidden rounded-3xl p-6 sm:p-7">
        <div className="sheen-overlay" aria-hidden="true" />
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
              Resource library
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-[-0.045em] text-fg">
              Upload a resource
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            {Icons.x}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="grid gap-4">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Title</span>
            <input
              autoFocus
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="e.g. Founder one-pager"
              className="input-dark"
              aria-label="Resource title"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Category</span>
              <select
                value={form.category}
                onChange={(e) => set({ category: e.target.value })}
                className="select-dark"
                aria-label="Category"
              >
                {RESOURCE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1.5">
              <span className={fieldLabel}>File</span>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                aria-label="Choose file"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > 5 * 1024 * 1024) {
                    setError("Files must be 5 MB or smaller.");
                    set({ file: null });
                    e.target.value = "";
                    return;
                  }
                  setError(null);
                  set({ file: f });
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="input-dark flex h-[46px] items-center justify-between gap-2 text-left"
              >
                <span className={`truncate text-[13px] ${form.file ? "text-fg" : "text-white/30"}`}>
                  {form.file ? form.file.name : "Choose a file…"}
                </span>
                {form.file ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-white/40">
                    {formatSize(form.file.size)}
                  </span>
                ) : (
                  <span className="shrink-0 text-white/40">{Icons.upload}</span>
                )}
              </button>
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Description</span>
            <textarea
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="What is this document for? (shown on the card)"
              rows={3}
              className="input-dark resize-none"
              aria-label="Description"
            />
          </label>

          <div className="flex items-center gap-3 pt-1">
            <button type="submit" disabled={uploading || !canSubmit} className="btn-primary min-w-40">
              {uploading ? (
                <>
                  {Icons.spinner}
                  Uploading…
                </>
              ) : (
                <>
                  {Icons.upload}
                  Upload resource
                </>
              )}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300"
            >
              {error}
            </p>
          ) : null}
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* In-app reader (markdown documents)                                   */
/* ------------------------------------------------------------------ */

function ReaderModal({
  resourceId,
  onClose,
  onDownload,
}: {
  resourceId: string;
  onClose: () => void;
  onDownload: (detail: ResourceDetail) => void;
}) {
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    getResource({ data: { id: resourceId } })
      .then((res) => {
        if (!alive) return;
        if (!res.ok) {
          setError(res.message);
          return;
        }
        setDetail(res.resource);
      })
      .catch(() => {
        if (alive) setError("Couldn't load the document. Please try again.");
      });
    return () => {
      alive = false;
    };
  }, [resourceId]);

  async function handleDownload() {
    if (!detail || downloading) return;
    setDownloading(true);
    try {
      onDownload(detail);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <button
        type="button"
        aria-label="Close reader"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <div className="glass-deep relative flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl">
        {/* Reader header */}
        <div className="flex items-start gap-4 border-b border-white/[0.06] p-5 sm:p-6">
          <div className="min-w-0 flex-1">
            {detail ? (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <CategoryBadge category={detail.category} />
                  <span className="text-[11px] text-white/35">
                    {formatSize(detail.file_size)} · {detail.uploader_name ?? "Operion team"} ·{" "}
                    {formatDate(detail.created_at)}
                  </span>
                </div>
                <h2 className="truncate text-xl font-semibold tracking-[-0.045em] text-gradient-violet">
                  {detail.title}
                </h2>
                {detail.description ? (
                  <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted">
                    {detail.description}
                  </p>
                ) : null}
              </>
            ) : (
              <h2 className="text-xl font-semibold tracking-[-0.045em] text-fg">Document</h2>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {detail ? (
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={downloading}
                className="btn-ghost h-9 border border-white/[0.08] px-3 text-[12px]"
              >
                {Icons.download}
                Download
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Close reader"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              {Icons.x}
            </button>
          </div>
        </div>

        {/* Reader body */}
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-6 sm:px-10 sm:py-8">
          {error ? (
            <div className="flex min-h-[220px] flex-col items-center justify-center text-center">
              <div className="icon-tile mb-4 text-white/35">{Icons.file}</div>
              <p className="text-sm font-medium text-fg">Couldn't open this document</p>
              <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-muted">{error}</p>
            </div>
          ) : !detail ? (
            <div className="flex min-h-[220px] items-center justify-center">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
            </div>
          ) : (
            <article className="doc-reader mx-auto max-w-prose">
              {/* renderMarkdown escapes the source before parsing — the HTML is
                  safe by construction (see src/lib/markdown.ts). */}
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.text) }} />
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Resource card                                                       */
/* ------------------------------------------------------------------ */

function ResourceCard({
  resource,
  isOwner,
  confirmingDelete,
  onDelete,
  onRead,
  onDownload,
}: {
  resource: ResourceMeta;
  isOwner: boolean;
  confirmingDelete: boolean;
  onDelete: () => void;
  onRead: () => void;
  onDownload: () => void;
}) {
  const textLike = isTextLike(resource);
  return (
    <div className="glass-deep lift-sm flex flex-col overflow-hidden rounded-2xl p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="icon-tile text-accent-light">{fileIconFor(resource)}</div>
        <CategoryBadge category={resource.category} />
      </div>

      <h3 className="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg" title={resource.title}>
        {resource.title}
      </h3>
      <p className="mt-1 line-clamp-2 min-h-[2.4rem] text-[13px] leading-relaxed text-muted">
        {resource.description || "No description."}
      </p>

      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-white/35">
        <span className="shrink-0 tabular-nums">{formatSize(resource.file_size)}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">{resource.uploader_name ?? "Operion team"}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0 tabular-nums">{formatDate(resource.created_at)}</span>
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-white/[0.05] pt-4">
        {textLike ? (
          <button type="button" onClick={onRead} className="btn-ghost h-8 flex-1 justify-center border border-white/[0.08] px-3 text-[12px]">
            {Icons.book}
            Read
          </button>
        ) : (
          <button type="button" onClick={onDownload} className="btn-ghost h-8 flex-1 justify-center border border-white/[0.08] px-3 text-[12px]">
            {Icons.download}
            Download
          </button>
        )}
        {isOwner ? (
          <button
            type="button"
            onClick={onDelete}
            aria-label={confirmingDelete ? "Confirm delete" : `Delete ${resource.title}`}
            className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors duration-300 ${
              confirmingDelete
                ? "border border-red-400/30 bg-red-500/15 text-red-300"
                : "text-white/40 hover:bg-red-500/10 hover:text-red-300"
            }`}
          >
            {confirmingDelete ? (
              <>
                {Icons.check}
                Confirm
              </>
            ) : (
              Icons.trash
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

function ResourcesPage() {
  const session = useLoaderData({ from: "/app" }) as SessionUser;
  const isOwner = session.role === "owner";

  const [resources, setResources] = useState<ResourceMeta[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [filter, setFilter] = useState<string>("All");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [readerId, setReaderId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listResources();
      if (!res.ok) {
        if (res.reason === "not-signed-in") window.location.assign("/");
        setStatus("error");
        return;
      }
      setResources(res.resources);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Auto-clear the two-step delete confirm if the user looks away.
  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 4000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  const categories = ["All", ...RESOURCE_CATEGORIES];
  const visible = resources
    ? filter === "All"
      ? resources
      : resources.filter((r) => r.category === filter)
    : [];

  async function handleDelete(id: string) {
    setActionError(null);
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    try {
      const res = await deleteResource({ data: { id } });
      if (!res.ok) {
        setActionError(res.message);
        return;
      }
      setResources((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    } catch {
      setActionError("Something went wrong. Please try again.");
    }
  }

  async function downloadDetail(detail: ResourceDetail) {
    try {
      const blob = base64ToBlob(detail.dataBase64, detail.file_type);
      triggerDownload(blob, detail.file_name);
    } catch {
      setActionError("Couldn't download the file. Please try again.");
    }
  }

  async function handleCardDownload(id: string) {
    setActionError(null);
    try {
      const res = await getResource({ data: { id } });
      if (!res.ok) {
        setActionError(res.message);
        return;
      }
      await downloadDetail(res.resource);
    } catch {
      setActionError("Something went wrong. Please try again.");
    }
  }

  return (
    <div className="rise-in">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
            Library
          </p>
          <h1 className="text-3xl font-semibold tracking-[-0.045em] text-gradient-violet sm:text-4xl">
            Resource library
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            Pricing sheets, playbooks and templates for the whole sales team. Markdown documents
            open in the built-in reader; everything else downloads.
          </p>
        </div>
        <button type="button" onClick={() => setUploadOpen(true)} className="btn-primary min-w-44">
          {Icons.upload}
          Upload resource
        </button>
      </div>

      {actionError ? (
        <p
          role="alert"
          className="mb-5 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300"
        >
          {actionError}
        </p>
      ) : null}

      {/* Category filter chips — wrap into rows on small screens so every
          category is visible; keep the horizontal scroll on desktop. */}
      <div className="scroll-thin mb-6 flex flex-wrap gap-2 pb-1 sm:flex-nowrap sm:overflow-x-auto">
        {categories.map((c) => {
          const count = c === "All" ? (resources?.length ?? 0) : (resources?.filter((r) => r.category === c).length ?? 0);
          const active = filter === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setFilter(c)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all duration-300 ${
                active
                  ? "bg-white text-black"
                  : "border border-white/[0.08] text-white/55 hover:border-white/[0.16] hover:text-white"
              }`}
            >
              {c}
              <span className={`tabular-nums ${active ? "text-black/50" : "text-white/30"}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* List / states */}
      {status === "loading" && resources === null ? (
        <div className="glass-deep flex min-h-[220px] items-center justify-center rounded-2xl px-6 py-10">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
        </div>
      ) : status === "error" && resources === null ? (
        <div className="glass-deep flex min-h-[200px] flex-col items-center justify-center rounded-2xl px-6 py-10 text-center">
          <div className="icon-tile mb-4 text-white/35">{Icons.folder}</div>
          <p className="text-sm font-medium text-fg">Couldn't load the library</p>
          <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-muted">
            Something went wrong while fetching resources.
          </p>
          <button type="button" onClick={() => void load()} className="btn-ghost mt-4 h-9 px-4">
            Try again
          </button>
        </div>
      ) : resources !== null && resources.length === 0 ? (
        <div className="glass-deep flex min-h-[240px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] px-6 py-12 text-center">
          <div className="icon-tile mb-4 text-white/35">{Icons.folder}</div>
          <p className="text-sm font-medium text-fg">No resources yet</p>
          <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted">
            Upload pricing sheets, playbooks and templates so the team has one place to find
            everything they need.
          </p>
          <button type="button" onClick={() => setUploadOpen(true)} className="btn-ghost mt-4 h-9 px-4">
            {Icons.upload}
            Upload the first resource
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="glass-deep flex min-h-[180px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] px-6 py-10 text-center">
          <p className="text-sm font-medium text-fg">Nothing in {filter} yet</p>
          <p className="mt-1 text-[13px] text-muted">Upload a resource to add it to this category.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((r) => (
            <ResourceCard
              key={r.id}
              resource={r}
              isOwner={isOwner}
              confirmingDelete={confirmDeleteId === r.id}
              onDelete={() => void handleDelete(r.id)}
              onRead={() => setReaderId(r.id)}
              onDownload={() => void handleCardDownload(r.id)}
            />
          ))}
        </div>
      )}

      {uploadOpen ? (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onUploaded={() => void load()}
        />
      ) : null}
      {readerId ? (
        <ReaderModal
          resourceId={readerId}
          onClose={() => setReaderId(null)}
          onDownload={(detail) => void downloadDetail(detail)}
        />
      ) : null}
    </div>
  );
}
