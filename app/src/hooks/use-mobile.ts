// SPDX-License-Identifier: Apache-2.0

// Tells the shadcn Sidebar whether the viewport is narrow enough for the mobile Sheet drawer.
// Adapted from shadcn/ui (https://ui.shadcn.com), whose `use-mobile` hook this follows. It stays
// Apache-2.0: it is a short generic media-query hook, not one of the copied components under
// `src/components/ui/` (app/AGENTS.md, "shadcn/ui").
import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const mediaQuery = window.matchMedia(QUERY);
  mediaQuery.addEventListener("change", onChange);
  return () => mediaQuery.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
