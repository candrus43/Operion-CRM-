import { createFileRoute } from "@tanstack/react-router";
import PlaceholderPage from "~/components/placeholder-page";

export const Route = createFileRoute("/app/reports")({
  component: ReportsPage,
});

function ReportsPage() {
  return (
    <PlaceholderPage
      eyebrow="Reports"
      title="Reports"
      description="Win rates, pipeline value, and activity — for the owner's eyes. Reporting lands after the pipeline ships."
    />
  );
}
