"use client";
// Re-applies the stored choice after React has reset <html>. The inline script in <head> does the
// work in production; this only matters in development, where React Strict Mode remounts the root
// and drops attributes it does not manage. It also follows a choice made in another tab.
import { useLayoutEffect } from "react";
import {
  THEME_STORAGE_KEY,
  applyThemeChoice,
  browserStorage,
  loadThemeChoice,
} from "./theme.ts";

export function ThemeSync() {
  useLayoutEffect(() => {
    const apply = () =>
      applyThemeChoice(
        document.documentElement,
        loadThemeChoice(browserStorage()),
      );
    apply();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === THEME_STORAGE_KEY) apply();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return null;
}
