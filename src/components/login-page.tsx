import { useState, type FormEvent } from "react";
import { login } from "~/lib/auth";

/**
 * Operion-styled sign-in card. Rendered at both "/" and "/login".
 * Renders fine with no database connected — the server function returns a
 * clean "database not connected" error instead of crashing.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await login({ data: { email, password } });
      if (result.ok) {
        // Full navigation so the app shell is server-rendered with the new
        // session cookie — no client/server session race.
        window.location.assign("/app");
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
                <img src="/logo.png" alt="" className="h-7 w-7 object-contain" />
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
    </div>
  );
}
