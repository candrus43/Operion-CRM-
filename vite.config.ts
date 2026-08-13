import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

// Warm the database schema at dev-server boot (fire-and-forget, never blocks
// serving). Runs through Vite's SSR loader so `~/` aliases resolve; the login
// fast path (schema version check) falls back to the full ensure if the warm
// hasn't finished or failed.
function crmSchemaWarm(): Plugin {
  return {
    name: "operion-crm-schema-warm",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        setTimeout(() => {
          server
            .ssrLoadModule("/src/lib/auth-core.ts")
            .then((m: Record<string, unknown>) => {
              const warm = m.warmSchemaNow as (() => Promise<void>) | undefined;
              if (warm) void warm();
            })
            .catch((err) => console.error("[operion-crm] dev schema warm failed:", err));
        }, 0);
      });
    },
  };
}

/**
 * External inbound API: /api/crm/* (Operion Lead OS → CRM).
 *
 * TanStack Start 1.168 has NO API-file-route support (createAPIFileRoute was
 * removed from the framework), so the endpoints are raw HTTP handlers
 * (src/lib/crm-api.ts — companies/contacts/notes/lookup — plus the original
 * /api/crm/leads in src/lib/lead-ingest.ts) wired into both servers. This
 * middleware intercepts the paths in dev BEFORE Vite's internal middlewares /
 * the SSR handler; the production server (serve.ts) intercepts them the same
 * way against the built app. Middleware added inside configureServer runs
 * before Vite's internal middlewares, so the SSR handler never sees these
 * requests.
 */
function crmInboundApi(): Plugin {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  return {
    name: "operion-crm-inbound-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/crm/")) return next();
        if (req.method !== "POST" && req.method !== "GET") return next();
        try {
          if (!handler) {
            const mod = (await server.ssrLoadModule("/src/lib/crm-api.ts")) as {
              handleCrmApi: (r: Request) => Promise<Response>;
            };
            handler = mod.handleCrmApi;
          }
          // Node IncomingMessage → web Request (body included; GET has none).
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (Array.isArray(value)) for (const v of value) headers.append(key, v);
            else if (value != null) headers.set(key, value);
          }
          const request = new Request(url, {
            method: req.method,
            headers,
            body: req.method === "GET" ? undefined : Buffer.concat(chunks),
          });
          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          console.error("[operion-crm] inbound-api middleware failed:", err);
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
    host: true,
    // The site is reverse-proxied behind <label>.<PUBLIC_SITE_DOMAIN>; the proxy
    // masks the Host to localhost:3000, but accept any host so a dev server never
    // rejects a proxied request with "Blocked request".
    allowedHosts: true,
    // The dev server is reachable through the TLS proxy, so the HMR websocket
    // must dial back on 443, not the dev port. If the socket can't connect,
    // pages still serve — hot reload degrades, never breaks.
    hmr: { clientPort: 443 },
    // The dev server can serve source files; never let it serve local secrets,
    // and never let it serve anything outside the site dir. Gotchas this list
    // encodes: a custom `deny` REPLACES Vite's defaults (so .git must be
    // restated), patterns containing "/" match the ABSOLUTE path (so dir
    // patterns need a leading **/), and `allow` left to its default widens to
    // the nearest workspace root — a stray .git or workspaces package.json in
    // /home/team/shared would expose the whole shared dir.
    fs: {
      strict: true,
      allow: [import.meta.dirname],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.run/**", "**/.git/**"],
    },
  },
  plugins: [
    crmSchemaWarm(),
    crmInboundApi(),
    tailwindcss(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart(),
    viteReact(),
  ],
});
