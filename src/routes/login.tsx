import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSession } from "~/lib/auth";
import LoginPage from "~/components/login-page";

export const Route = createFileRoute("/login")({
  loader: async () => {
    const session = await getSession();
    if (session) throw redirect({ to: "/app" });
    return null;
  },
  component: LoginPage,
});
