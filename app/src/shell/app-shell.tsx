// SPDX-License-Identifier: Apache-2.0

"use client";
// The frame around every signed in page: skip link, header with the brand, the main navigation and
// the user menu, and the main landmark for the page. On a narrow screen the navigation sits behind
// a "Menu" button (a disclosure, see globals.css for the breakpoint); it closes after a place is
// chosen and with Escape. The user menu arrives as a slot: it needs the session, so the layout
// renders it on the server and the frame itself stays static.
import Link from "next/link";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CurrentNavLinks, NavLinks } from "./nav-links.tsx";

export function AppShell({
  userMenu,
  workspaceSwitcher,
  children,
}: {
  userMenu: ReactNode;
  /** The workspaces of the signed in person; it needs the session, so it arrives as a slot too. */
  workspaceSwitcher?: ReactNode;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navId = useId();
  const mainId = useId();
  const navRef = useRef<HTMLElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // A press anywhere but on the navigation and its button closes the open menu (also on the user
  // menu next to it, so the two panels never overlap on a phone).
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (navRef.current?.contains(target)) return;
      if (menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  return (
    <div className="app-shell">
      <a className="skip-link" href={`#${mainId}`}>
        Skip to content
      </a>
      <header
        className="app-header"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !menuOpen) return;
          setMenuOpen(false);
          menuButtonRef.current?.focus();
        }}
      >
        <div className="app-header-inner">
          <button
            ref={menuButtonRef}
            type="button"
            className="menu-button"
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="menu-icon" aria-hidden="true" />
            Menu
          </button>
          <Link href="/" className="brand" onClick={closeMenu}>
            Code Reviewer
          </Link>
          <nav
            ref={navRef}
            id={navId}
            className="main-nav"
            aria-label="Main"
            data-open={menuOpen ? "true" : "false"}
          >
            <Suspense
              fallback={<NavLinks pathname={null} onNavigate={closeMenu} />}
            >
              <CurrentNavLinks onNavigate={closeMenu} />
            </Suspense>
          </nav>
          <div className="header-end">
            {workspaceSwitcher}
            {userMenu}
          </div>
        </div>
      </header>
      <main id={mainId} className="app-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
