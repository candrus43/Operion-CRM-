import type { ReactNode } from "react";

/**
 * Operion-styled placeholder page for app sections that arrive in later build
 * steps (pipeline, contacts, resources, reports).
 */
export default function PlaceholderPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="rise-in">
      <div className="mb-8">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-accent-light">
          {eyebrow}
        </p>
        <h1 className="text-3xl font-semibold tracking-[-0.045em] text-gradient-violet sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
          {description}
        </p>
      </div>

      <div className="glass ring-gradient grain relative overflow-hidden rounded-3xl p-10">
        <div className="sheen-overlay" aria-hidden="true" />
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <div className="icon-tile">
            <span className="h-5 w-5 animate-breathe rounded-full bg-gradient-to-br from-accent to-accent-blue opacity-80" />
          </div>
          <p className="text-sm font-medium text-fg">Coming in the next build step</p>
          <p className="max-w-sm text-[13px] leading-relaxed text-muted">
            This section is part of the Operion CRM roadmap. The foundation —
            design system, sign-in, and the app shell — is live now.
          </p>
        </div>
      </div>

      {children}
    </div>
  );
}
