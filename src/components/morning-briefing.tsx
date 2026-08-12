/**
 * Operion CRM — "Morning briefing" panel (pipeline page, above the filters).
 *
 * Fetches today's briefing via `getBriefing` (server-side, cached once per
 * user per day in the `briefings` table). Renders the generated text
 * (## section headers + "- " bullets) in the Operion glass style with a
 * subtle aurora accent. Graceful degradation is a hard requirement: any
 * failure hides the panel entirely — it must never error or crash the board.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getBriefing } from "~/lib/briefing";

/* ------------------------------------------------------------------ */
/* Tiny renderer for the briefing text (## headers + - bullets)        */
/* ------------------------------------------------------------------ */

function renderBriefingText(content: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let key = 0;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(/^#{1,3}\s+(.+)$/) ?? line.match(/^\*\*(.+)\*\*$/);
    if (header) {
      out.push(
        <h3
          key={key++}
          className="mt-5 flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-accent-light uppercase first:mt-0"
        >
          {header[1]}
        </h3>,
      );
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      out.push(
        <li
          key={key++}
          className="flex items-start gap-2.5 text-[13px] leading-relaxed text-fg/90"
        >
          <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent-light/70" />
          <span>{bullet[1]}</span>
        </li>
      );
      continue;
    }
    out.push(
      <p key={key++} className="text-[13px] leading-relaxed text-fg/90">
        {line}
      </p>,
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

type PanelState =
  | { status: "loading" }
  | {
      status: "ready";
      content: string;
      aiGenerated: boolean;
      cached: boolean;
      staleCount: number;
      recentActivityCount: number;
      dealCount: number;
    }
  | { status: "hidden" };

const SparkleIcon = () => (
  <svg
    width={15}
    height={15}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3v3" />
    <path d="M12 18v3" />
    <path d="M3 12h3" />
    <path d="M18 12h3" />
    <path d="m5.6 5.6 2.1 2.1" />
    <path d="m16.3 16.3 2.1 2.1" />
    <path d="m5.6 18.4 2.1-2.1" />
    <path d="m16.3 7.7 2.1-2.1" />
  </svg>
);

const RefreshIcon = ({ spinning }: { spinning: boolean }) => (
  <svg
    width={13}
    height={13}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={spinning ? "animate-spin" : ""}
  >
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={`text-white/40 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export function MorningBriefing() {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await getBriefing();
      if (!mountedRef.current) return;
      if (!res.ok) {
        // db-not-connected / not-signed-in / db-error — the board shows its
        // own states; the briefing panel just stays out of the way.
        setState({ status: "hidden" });
        return;
      }
      setState({
        status: "ready",
        content: res.content,
        aiGenerated: res.aiGenerated,
        cached: res.cached,
        staleCount: res.staleCount,
        recentActivityCount: res.recentActivityCount,
        dealCount: res.dealCount,
      });
    } catch {
      if (mountedRef.current) setState({ status: "hidden" });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  if (state.status === "hidden") return null;
  if (state.status === "loading") {
    return (
      <div className="glass-deep mb-6 rounded-2xl p-5">
        <div className="flex items-center gap-3">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/15 border-t-accent-light" />
          <p className="text-[13px] text-muted">Preparing your briefing…</p>
        </div>
      </div>
    );
  }

  const todayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <section className="glass-deep ring-gradient grain relative mb-6 overflow-hidden rounded-2xl">
      {/* Aurora accent — subtle, matches the app's login-page treatment */}
      <div
        className="aurora-a pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-violet-600/[0.10] blur-[70px]"
        aria-hidden="true"
      />
      <div
        className="aurora-c pointer-events-none absolute -bottom-20 left-1/3 h-56 w-56 rounded-full bg-sky-500/[0.07] blur-[60px]"
        aria-hidden="true"
      />

      <div className="relative">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3.5 sm:px-6">
          <div className="icon-tile-sm shrink-0 text-accent-light">
            <SparkleIcon />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-fg">
                Morning briefing
              </h2>
              <span className="hidden text-[12px] text-white/35 sm:block">{todayLabel}</span>
            </div>
            <p className="mt-0.5 truncate text-[12px] text-white/40">
              {state.staleCount > 0
                ? `${state.staleCount} stale deal${state.staleCount === 1 ? "" : "s"} · ${state.recentActivityCount} activit${
                    state.recentActivityCount === 1 ? "y" : "ies"
                  } in 24h`
                : `${state.dealCount} deal${state.dealCount === 1 ? "" : "s"} in view · ${state.recentActivityCount} activit${
                    state.recentActivityCount === 1 ? "y" : "ies"
                  } in 24h`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy}
              title="Refresh today's briefing — regenerated once per day"
              aria-label="Refresh briefing"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-50"
            >
              <RefreshIcon spinning={busy} />
            </button>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={open ? "Collapse briefing" : "Expand briefing"}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
            >
              <ChevronIcon open={open} />
            </button>
          </div>
        </div>

        {/* Body */}
        {open ? (
          <div className="px-5 pb-5 sm:px-6">
            <div className="hairline mb-4" />
            {state.aiGenerated ? null : (
              <p className="mb-3.5 inline-flex items-center gap-1.5 rounded-full bg-amber-400/10 px-3 py-1 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/20">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                AI summary unavailable — plain rundown from your CRM data
              </p>
            )}
            <div className="scroll-thin max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
              <ul className="space-y-1.5">{renderBriefingText(state.content)}</ul>
            </div>
            <p className="mt-3.5 flex items-center gap-1.5 text-[11px] text-white/25">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${state.aiGenerated ? "bg-emerald-400/70" : "bg-amber-400/60"}`}
              />
              {state.cached
                ? "Generated once today — refresh re-serves today's briefing"
                : "Generated from today's CRM data"}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
