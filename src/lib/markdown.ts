/**
 * Operion CRM — safe markdown rendering for the in-app document reader.
 *
 * Security model (defense in depth):
 *   1. The raw source is HTML-escaped BEFORE parsing, so any markup a document
 *      contains becomes inert text — it can never reach the DOM as HTML.
 *   2. marked's `html` renderer is overridden to escape whatever it is given,
 *      so even a hypothetical bypass renders as text, never markup.
 *   3. Link hrefs are sanitized to safe schemes (http/https/mailto/tel and
 *      relative URLs) — `javascript:`/`data:`/`vbscript:` become dead "#".
 *   4. The source is length-capped (150 KB) so one giant document can't
 *      balloon the page.
 *
 * The output is rendered with dangerouslySetInnerHTML by the reader, which is
 * safe ONLY because the pipeline above guarantees the string contains no
 * unescaped HTML. Never change the ordering (escape first, then parse).
 */
import { marked } from "marked";

/** Sanity cap on how much markdown a document may render. */
export const MAX_RENDER_CHARS = 150_000;

/** Escape the five HTML-sensitive characters, in one pass. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Allow only safe URL schemes (and relative URLs); anything else becomes "#". */
function sanitizeHref(href: string): string {
  const h = (href ?? "").trim();
  if (
    /^(https?:|mailto:|tel:)/i.test(h) ||
    h.startsWith("/") ||
    h.startsWith("#") ||
    h.startsWith("./") ||
    h.startsWith("../")
  ) {
    return h;
  }
  return "#";
}

marked.use({
  renderer: {
    // Defense in depth: since input is escaped first, the html tokenizer never
    // fires for document content — but if it ever does, render as escaped text.
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
    link({ href, tokens }: { href: string; tokens: import("marked").Tokens.Generic[] }) {
      const safe = sanitizeHref(href);
      const label = this.parser?.parseInline(tokens) ?? escapeHtml(href);
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ href, text }: { href: string; text: string }) {
      // No remote images in a sales library — render the alt text instead.
      return escapeHtml(text || href);
    },
  },
});

/**
 * Render markdown to safe HTML. The input is escaped before parsing, so the
 * result contains no raw HTML from the document. Returns "" for empty input.
 */
export function renderMarkdown(source: string | null | undefined): string {
  const raw = (source ?? "").slice(0, MAX_RENDER_CHARS);
  if (!raw.trim()) return "";
  return marked.parse(escapeHtml(raw), { async: false });
}
