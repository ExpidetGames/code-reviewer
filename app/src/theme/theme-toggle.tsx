"use client";
// The control for the color mode: System (the default), Light or Dark. The page itself is the
// source of truth: whatever `data-theme` is on <html> is what is shown, so the buttons always match
// the page, also when the choice came from the inline script or from another tab.
import { useSyncExternalStore } from "react";
import {
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  applyThemeChoice,
  browserStorage,
  saveThemeChoice,
  type ThemeChoice,
} from "./theme.ts";

const LABELS: Record<ThemeChoice, string> = {
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

export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, currentChoice, serverChoice);

  function choose(next: ThemeChoice) {
    saveThemeChoice(browserStorage(), next);
    applyThemeChoice(document.documentElement, next);
  }

  return (
    <div role="group" aria-label="Color theme" className="theme-toggle">
      {THEME_CHOICES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={choice === option}
          onClick={() => choose(option)}
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
