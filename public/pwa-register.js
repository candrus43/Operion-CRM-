/* Operion CRM — service-worker registration.
 *
 * Registered only where a service worker is useful and safe:
 *   - https origins (the live site and the -dev TLS preview), and
 *   - localhost / 127.0.0.1 (local dev, loopback is a secure context).
 * Never registers on other http origins (plain IPs, etc.). The fetch handler
 * in /sw.js only touches navigations and /assets/*, so local dev editing
 * (Vite HMR modules, source fetches) is never intercepted.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;

  var isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol !== "https:" && !isLocalhost) return;

  // Already running as an installed app — nothing to register (and even if we
  // did, the browser already has the SW from the first launch).
  if (window.matchMedia("(display-mode: standalone)").matches) return;

  function register() {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch(function (err) {
        console.warn("[operion-crm] service worker registration failed:", err);
      });
  }
  // Register as soon as the document is parsed. TanStack Start strips head
  // scripts from the DOM after hydration, so a plain "load" listener can be
  // removed before it ever fires; guard on readyState instead of relying on
  // the event alone.
  if (document.readyState === "complete" || document.readyState === "interactive") {
    register();
  } else {
    window.addEventListener("load", register);
  }
})();
