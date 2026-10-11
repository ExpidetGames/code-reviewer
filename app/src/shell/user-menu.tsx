"use client";
// The user menu in the header: a button with the avatar and the name that opens a small panel with
// the person, the color theme and "Sign out". It is a disclosure (a button that shows and hides a
// panel), so it works with plain Tab and Enter: Escape closes it and puts the focus back on the
// button, and so does a click or the focus moving outside.
import { useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "../ui/button.tsx";
import { ThemeToggle } from "../theme/theme-toggle.tsx";
import { UserAvatar } from "./user-avatar.tsx";
import { displayName, type ShellUser } from "./user-display.ts";

export function UserMenu({
  user,
  signOutAction,
}: {
  user: ShellUser;
  /** The server action that ends the session; it redirects to the login page. */
  signOutAction: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const name = displayName(user);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="user-menu"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (open && next instanceof Node && !rootRef.current?.contains(next))
          setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="user-menu-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <UserAvatar user={user} />
        <span className="user-menu-name">{name}</span>
      </button>
      {open && (
        <div id={panelId} className="user-menu-panel">
          <div className="user-menu-person">
            <strong>{name}</strong>
            <span>@{user.login}</span>
          </div>
          <div className="user-menu-section">
            <span className="user-menu-label">Theme</span>
            <ThemeToggle />
          </div>
          <form action={signOutAction}>
            <SignOutButton />
          </form>
        </div>
      )}
    </div>
  );
}

// Disabled while the action runs: a second press would end an already ended session.
function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="secondary"
      className="btn-block"
      disabled={pending}
    >
      Sign out
    </Button>
  );
}
