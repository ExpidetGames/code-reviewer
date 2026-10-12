// SPDX-License-Identifier: Apache-2.0

"use client";
// Development only (the root layout renders it only outside production). React Strict Mode remounts
// the root in `next dev` and drops attributes it does not manage, which removes the `data-theme`
// the inline script set. This puts the stored choice back before paint. Production never needs it:
// there the inline script in <head> is enough and nothing resets <html>.
import { useLayoutEffect } from "react";
import { applyThemeChoice, browserStorage, loadThemeChoice } from "./theme.ts";

export function ThemeSync() {
  useLayoutEffect(() => {
    applyThemeChoice(
      document.documentElement,
      loadThemeChoice(browserStorage()),
    );
  }, []);
  return null;
}
