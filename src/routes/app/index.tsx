import { createFileRoute } from "@tanstack/react-router";
import PlaceholderPage from "~/components/placeholder-page";

export const Route = createFileRoute("/app/")({
  component: PipelinePage,
});

function PipelinePage() {
  return (
    <PlaceholderPage
      eyebrow="Pipeline"
      title="Deal pipeline"
      description="Your deals move through Lead → Contacted → Meeting → Proposal → Negotiation → Closed. The kanban board ships in the next build step."
    />
  );
}
