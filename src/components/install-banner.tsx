import { useEffect, useState } from "react";

/**
 * PWA install prompt — "Install Operion CRM" banner.
 *
 * Holds the `beforeinstallprompt` event and shows a small dismissible glass
 * banner in the app shell (visible to every role). On click it calls
 * `prompt()`; it hides on `appinstalled`, on dismiss, or if the event never
 * fires (unsupported browser / already installed) — so no banner in normal
 * desktop browsing, only where installation is actually available.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function InstallBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Already installed (standalone window) — nothing to offer.
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    }
    function onAppInstalled() {
      setDeferred(null);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  if (!deferred || dismissed) return null;

  async function handleInstall() {
    const evt = deferred;
    if (!evt) return;
    setDeferred(null); // hide immediately; Chrome dismisses its own UI after prompt()
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      if (choice.outcome !== "accepted") setDismissed(true);
    } catch {
      setDismissed(true);
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div
        role="dialog"
        aria-label="Install Operion CRM"
        className="glass flex w-full max-w-sm items-center gap-3 rounded-2xl p-3 pr-2 shadow-[0_24px_70px_-28px_rgba(124,58,237,0.5)]"
      >
        <div className="icon-tile-sm shrink-0 overflow-hidden">
          <img src="/icons/icon-192.png" alt="" className="h-7 w-7 object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg">Install Operion CRM</p>
          <p className="text-[11px] leading-snug text-muted">
            Add it to your home screen for one-tap access.
          </p>
        </div>
        <button
          type="button"
          onClick={handleInstall}
          className="h-9 shrink-0 rounded-full bg-white px-4 text-[13px] font-medium text-black transition-all duration-300 hover:shadow-[0_0_30px_rgba(255,255,255,0.35)]"
        >
          Install
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss install prompt"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
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
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
