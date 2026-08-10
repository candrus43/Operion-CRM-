import { Navigate, createFileRoute } from "@tanstack/react-router";

/**
 * Reports moved into the Commissions tab (MRR business overview + per-agent
 * breakdown live on /app/commissions). Keep this route as a redirect so stale
 * links and bookmarks don't 404.
 */
export const Route = createFileRoute("/app/reports")({
  component: ReportsRedirect,
});

function ReportsRedirect() {
  return <Navigate to="/app/commissions" replace />;
}
