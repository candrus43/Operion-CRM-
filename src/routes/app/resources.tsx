import { createFileRoute } from "@tanstack/react-router";
import PlaceholderPage from "~/components/placeholder-page";

export const Route = createFileRoute("/app/resources")({
  component: ResourcesPage,
});

function ResourcesPage() {
  return (
    <PlaceholderPage
      eyebrow="Resources"
      title="Resource library"
      description="Pitch decks, pricing sheets, and playbooks — one place for the sales team. Coming after contacts."
    />
  );
}
