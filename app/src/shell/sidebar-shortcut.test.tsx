// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the Ctrl+B shortcut of the sidebar: only the provider whose sidebar is rendered on the
// page registers it. An admin page mounts two providers (the shell's, which renders no workspace
// sidebar there, and the admin's), so exactly one may listen; a workspace page has only the shell's.
// Without this, one press toggled both sidebars and a later client-side navigation to a workspace
// showed its sidebar collapsed.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/admin" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import {
  SidebarProvider,
  SidebarShortcut,
  useSidebar,
} from "@/components/ui/sidebar";
import { AdminNav } from "@/admin/ui/admin-nav.tsx";
import { AppShell } from "./app-shell.tsx";
import { getProductIdentity } from "../product-identity/current.ts";

afterEach(() => {
  cleanup();
  navigation.pathname = "/admin";
});

/** Reads its provider's state so a test can tell which provider the shortcut reached. */
function ProviderState({ name }: { name: string }) {
  const { state } = useSidebar();
  return <span data-testid={name}>{state}</span>;
}

function pressShortcut() {
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
}

describe("the sidebar keyboard shortcut", () => {
  // #168-T01
  it("toggles only the admin sidebar on an admin page, where two providers are mounted", () => {
    navigation.pathname = "/admin";
    render(
      <AppShell product={getProductIdentity()} userMenu={<span>user</span>}>
        <ProviderState name="shell" />
        <SidebarProvider>
          <AdminNav />
          <SidebarShortcut />
          <ProviderState name="admin" />
        </SidebarProvider>
      </AppShell>,
    );

    expect(screen.getByTestId("shell").textContent).toBe("expanded");
    expect(screen.getByTestId("admin").textContent).toBe("expanded");

    pressShortcut();

    expect(screen.getByTestId("admin").textContent).toBe("collapsed");
    expect(screen.getByTestId("shell").textContent).toBe("expanded");
  });

  // #168-T01
  it("toggles the workspace sidebar on a workspace page", () => {
    navigation.pathname = "/w/acme/projects";
    render(
      <AppShell product={getProductIdentity()} userMenu={<span>user</span>}>
        <ProviderState name="shell" />
      </AppShell>,
    );

    expect(screen.getByTestId("shell").textContent).toBe("expanded");

    pressShortcut();

    expect(screen.getByTestId("shell").textContent).toBe("collapsed");
  });
});
