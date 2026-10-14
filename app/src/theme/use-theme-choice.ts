// SPDX-License-Identifier: Apache-2.0

"use client";
// The color mode as a hook for the user menu's theme entries: System (the default), Light or Dark.
// The page itself is the source of truth: whatever `data-theme` is on <html> is shown, so the choice
// always matches the page, also when it came from the inline script or from another tab.
import { useSyncExternalStore } from "react";
import {
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  applyThemeChoice,
  browserStorage,
  saveThemeChoice,
  type ThemeChoice,
} from "./theme.ts";

export const THEME_CHOICE_LABELS: Record<ThemeChoice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });
  return () => observer.disconnect();
}

function currentChoice(): ThemeChoice {
  const value = document.documentElement.getAttribute(THEME_ATTRIBUTE);
  return value === "light" || value === "dark" ? value : "system";
}

// The server cannot know the choice; the first client render uses it and React corrects the
// buttons right after hydration without a mismatch error.
function serverChoice(): ThemeChoice {
  return "system";
}

export function useThemeChoice(): {
  choice: ThemeChoice;
  /** The choices in menu order (System, Light, Dark). */
  choices: readonly ThemeChoice[];
  choose: (next: ThemeChoice) => void;
} {
  const choice = useSyncExternalStore(subscribe, currentChoice, serverChoice);

  function choose(next: ThemeChoice) {
    saveThemeChoice(browserStorage(), next);
    applyThemeChoice(document.documentElement, next);
  }

  return { choice, choices: THEME_CHOICES, choose };
}
