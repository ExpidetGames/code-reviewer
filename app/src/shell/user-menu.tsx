// SPDX-License-Identifier: Apache-2.0

"use client";
// The user menu in the header: a DropdownMenu with the person (name and login), the pages that
// always belong to them (Account), the admin portal for the instance admin only, the color theme
// (System, Light, Dark) and Sign out. Radix handles the keyboard, Escape, the click outside and the
// focus return, so the menu works without a mouse.
import Link from "next/link";
import { useFormStatus } from "react-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  THEME_CHOICE_LABELS,
  useThemeChoice,
} from "../theme/use-theme-choice.ts";
import type { ThemeChoice } from "../theme/theme.ts";
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
  const name = displayName(user);
  const { choice, choices, choose } = useThemeChoice();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-11 min-w-11 cursor-pointer items-center gap-2 rounded-full border-0 bg-transparent p-1 pr-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <UserAvatar user={user} />
          <span className="max-w-40 truncate text-sm font-medium text-foreground">
            {name}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <span className="block truncate font-medium text-foreground">
            {name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            @{user.login}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account" className="text-foreground no-underline">
            Account
          </Link>
        </DropdownMenuItem>
        {user.isInstanceAdmin === true ? (
          <DropdownMenuItem asChild>
            <Link href="/admin" className="text-foreground no-underline">
              Admin
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={choice}
          onValueChange={(value) => choose(value as ThemeChoice)}
        >
          {choices.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {THEME_CHOICE_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <form action={signOutAction}>
          <SignOutMenuItem />
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Disabled while the action runs: a second press would end an already ended session. The item keeps
// the menu open while the action is pending (`onSelect` prevents the default close), so the guard is
// visible; the redirect replaces the page when the action finishes.
function SignOutMenuItem() {
  const { pending } = useFormStatus();
  return (
    <DropdownMenuItem
      asChild
      disabled={pending}
      onSelect={(event) => event.preventDefault()}
    >
      <button
        type="submit"
        disabled={pending}
        className="w-full appearance-none border-0 bg-transparent text-left font-medium text-foreground"
      >
        Sign out
      </button>
    </DropdownMenuItem>
  );
}
