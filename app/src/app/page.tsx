import { Suspense } from "react";
import { signOut } from "@/auth/actions";
import { requireUser } from "@/auth/session";

// The start page is a placeholder until the UI epic replaces it. It already proves the session:
// it greets the signed in person and offers the sign out.
export default function Home() {
  return (
    <main>
      <h1>Code Reviewer</h1>
      {/* The user comes from the session cookie, so it is read at request time, behind a boundary. */}
      <Suspense fallback={null}>
        <CurrentUser />
      </Suspense>
    </main>
  );
}

async function CurrentUser() {
  const user = await requireUser();
  return (
    <>
      <p>
        Signed in as <strong>{user.name}</strong> (@{user.githubLogin})
      </p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}
