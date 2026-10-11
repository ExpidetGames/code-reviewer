import { redirect } from "next/navigation";

// The start page has no content of its own: the signed in app opens on its first place.
// Visitors without a session never get here, the proxy sends them to /login first.
export default function Home() {
  redirect("/projects");
}
