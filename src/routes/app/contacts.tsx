import { createFileRoute } from "@tanstack/react-router";
import PlaceholderPage from "~/components/placeholder-page";

export const Route = createFileRoute("/app/contacts")({
  component: ContactsPage,
});

function ContactsPage() {
  return (
    <PlaceholderPage
      eyebrow="Contacts"
      title="Contacts"
      description="Every person you talk to — companies, emails, phone numbers, and notes. Contact management arrives after the pipeline is solid."
    />
  );
}
