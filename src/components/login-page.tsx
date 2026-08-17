import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { login } from "~/lib/auth";

/**
 * Operion-styled sign-in card. Rendered at both "/" and "/login".
 * Renders fine with no database connected — the server function returns a
 * clean "database not connected" error instead of crashing.
 *
 * Sign-in speed: the login POST sets the session cookie before its response
 * resolves (same-origin, so the browser applies Set-Cookie immediately), so
 * the /app route guard sees the session with no client/server race and we
 * navigate client-side instead of reloading the whole app shell. While the
 * user types, the /app route chunks are prefetched; after a successful login
 * a brief on-brand "Preparing your workspace…" state covers the route swap
 * (and any cold-start wait) so nothing ever shows a blank screen.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const router = useRouter();
  const preloadStarted = useRef(false);

  // Prefetch the /app route chunks (shell + pipeline board) as soon as both
  // fields are filled, so the heavy modules are cached by the time Enter is
  // hit. Non-blocking and fire-and-forget — a failure just means the chunks
  // load during the post-login transition instead.
  useEffect(() => {
    if (preloadStarted.current) return;
    if (!email.trim() || !password) return;
    preloadStarted.current = true;
    void router.preloadRoute({ to: "/app" }).catch(() => {});
  }, [email, password, router]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting || preparing) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await login({ data: { email, password } });
      if (result.ok) {
        // Some hosting edges strip Set-Cookie from server-function responses,
        // so ALSO persist the session token client-side — the server-side
        // Set-Cookie (where delivered) and this write are the same token, so
        // subsequent getSession calls authenticate on every host. The cookie
        // stays non-httpOnly; acceptable for this internal tool.
        try {
          document.cookie = `operion_crm_session=${result.token}; path=/; max-age=${30 * 24 * 60 * 60}; SameSite=Lax; ${location.protocol === "https:" ? "Secure; " : ""}`;
        } catch {
          /* server-side Set-Cookie still covers hosts where it works */
        }
        // Session cookie is already set (see header comment) — swap to the
        // workspace without a full document load. Wait one frame so the
        // "Preparing your workspace…" state paints before the route changes.
        setPreparing(true);
        requestAnimationFrame(() => {
          void router.navigate({ to: "/app" }).catch(() => {
            setPreparing(false);
            setError("Something went wrong while opening your workspace. Please try again.");
          });
        });
      } else {
        setError(result.error);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-ink px-5 py-12">
      {/* Aurora backdrop */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="aurora-a absolute -left-[15%] top-[-18%] h-[46rem] w-[46rem] rounded-full bg-violet-600/[0.16] blur-[80px] md:blur-[150px]" />
        <div className="aurora-b absolute -right-[12%] top-[6%] h-[38rem] w-[38rem] rounded-full bg-indigo-500/[0.13] blur-[70px] md:blur-[140px]" />
        <div className="aurora-c absolute bottom-[-22%] left-[28%] h-[34rem] w-[34rem] rounded-full bg-sky-500/[0.09] blur-[60px] md:blur-[130px]" />
        <div className="absolute inset-0 grid-fade" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="rise-in relative">
          <div className="glass ring-gradient grain relative overflow-hidden rounded-3xl p-8 sm:p-10">
            {/* subtle sheen sweep */}
            <div className="sheen-overlay" aria-hidden="true" />

            {/* Wordmark */}
            <div className="mb-8 flex items-center gap-3">
              <div className="icon-tile relative shrink-0 overflow-hidden">
                <img src="/logo.png?v=2" alt="" className="h-7 w-7 object-contain" />
              </div>
              <div>
                <p className="text-[15px] font-medium tracking-[-0.02em] text-fg">
                  Operion
                </p>
                <p className="text-[11px] uppercase tracking-[0.18em] text-muted">
                  CRM
                </p>
              </div>
            </div>

            <h1 className="text-3xl font-semibold tracking-[-0.045em] text-gradient-violet sm:text-4xl">
              Welcome back
            </h1>
            <p className="mt-2 text-sm text-muted">
              Sign in to your sales workspace.
            </p>

            <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-white/70">
                  Email
                </span>
                <input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@operioncrm.com"
                  className="input-dark"
                />
              </label>

              <label className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-white/70">
                  Password
                </span>
                <input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="input-dark"
                />
              </label>

              {error ? (
                <p
                  role="alert"
                  className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[13px] leading-relaxed text-red-300"
                >
                  {error}
                </p>
              ) : null}

              <button type="submit" disabled={submitting} className="btn-primary mt-2 w-full">
                {submitting ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black"
                    />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </button>
            </form>

            <div className="hairline mt-8" />

            <p className="mt-5 text-center text-[12px] leading-relaxed text-white/30">
              Operion CRM — internal tool for the sales team.
              <br />
              Access is granted by your team administrator.
            </p>
          </div>
        </div>
      </div>

      {/* Full-screen "Preparing your workspace…" — appears instantly after a
          successful login (no blank flash), covers the client-side route swap
          + /app session check, and unmounts with this page when the workspace
          shell mounts. Sits OUTSIDE the rise-in wrapper so `fixed` anchors to
          the viewport. */}
      {preparing ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink"
        >
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="aurora-a absolute -left-[15%] top-[-18%] h-[46rem] w-[46rem] rounded-full bg-violet-600/[0.16] blur-[80px] md:blur-[150px]" />
            <div className="aurora-b absolute -right-[12%] top-[6%] h-[38rem] w-[38rem] rounded-full bg-indigo-500/[0.13] blur-[70px] md:blur-[140px]" />
            <div className="aurora-c absolute bottom-[-22%] left-[28%] h-[34rem] w-[34rem] rounded-full bg-sky-500/[0.09] blur-[60px] md:blur-[130px]" />
            <div className="absolute inset-0 grid-fade" />
          </div>
          <div className="rise-in glass ring-gradient grain relative rounded-3xl p-8 sm:p-10">
            <div className="sheen-overlay" aria-hidden="true" />
            <div className="flex flex-col items-center gap-4 text-center">
              <span
                aria-hidden="true"
                className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white"
              />
              <div>
                <p className="text-[15px] font-semibold tracking-[-0.02em] text-fg">
                  Preparing your workspace…
                </p>
                <p className="mt-1 text-[12px] text-muted">Loading your pipeline.</p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
