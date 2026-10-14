// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the color mode: the system setting applies until the person makes a choice (nothing
// stored, or something unusable, means no attribute on the page and the stylesheet follows the
// system), a valid stored choice is applied and wins over the system (the stylesheet pins
// color-scheme for it), and a browser without usable storage never causes an error. The inline script that applies the choice before
// the first paint is held to the same rules, so a reload shows the same mode the toggle showed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  applyThemeChoice,
  initialThemeScript,
  loadThemeChoice,
  saveThemeChoice,
  type ThemeStorage,
} from "./theme.ts";

function memoryStorage(initial: Record<string, string> = {}): ThemeStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const brokenStorage: ThemeStorage = {
  getItem: () => {
    throw new Error("storage is blocked");
  },
  setItem: () => {
    throw new Error("storage is blocked");
  },
  removeItem: () => {
    throw new Error("storage is blocked");
  },
};

describe("loading the stored choice", () => {
  // CR-36-T08
  it("is the system when nothing is stored", () => {
    expect(loadThemeChoice(memoryStorage())).toBe("system");
  });

  // CR-36-T08
  it.each(["dark", "light"])("reads the stored choice %s", (choice) => {
    expect(
      loadThemeChoice(memoryStorage({ [THEME_STORAGE_KEY]: choice })),
    ).toBe(choice);
  });

  // CR-36-T08
  it.each(["blue", "", "DARK", "null", "undefined", "{}"])(
    "ignores the stored value %j and follows the system",
    (value) => {
      expect(
        loadThemeChoice(memoryStorage({ [THEME_STORAGE_KEY]: value })),
      ).toBe("system");
    },
  );

  // CR-36-T08
  it("follows the system without an error when the browser storage is not available", () => {
    expect(loadThemeChoice(brokenStorage)).toBe("system");
    expect(loadThemeChoice(null)).toBe("system");
  });
});

describe("saving a choice", () => {
  it("stores light and dark and removes the entry for the system choice", () => {
    const storage = memoryStorage();

    saveThemeChoice(storage, "dark");
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("dark");
    saveThemeChoice(storage, "light");
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("light");
    saveThemeChoice(storage, "system");

    expect(storage.values.has(THEME_STORAGE_KEY)).toBe(false);
  });

  // CR-36-T08
  it("does not throw when the browser storage is not available", () => {
    expect(() => saveThemeChoice(brokenStorage, "dark")).not.toThrow();
    expect(() => saveThemeChoice(null, "dark")).not.toThrow();
  });
});

describe("applying a choice to the page", () => {
  it("sets the attribute for light and dark and clears it for the system choice", () => {
    const root = document.createElement("html");

    applyThemeChoice(root, "dark");
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    applyThemeChoice(root, "light");
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    applyThemeChoice(root, "system");

    expect(root.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });
});

describe("the script that runs before the first paint", () => {
  function run(storage: ThemeStorage | "throws on access") {
    const root = document.createElement("html");
    const fakeWindow = {
      get localStorage(): ThemeStorage {
        if (storage === "throws on access") throw new Error("blocked");
        return storage;
      },
    };
    new Function("document", "window", initialThemeScript())(
      { documentElement: root },
      fakeWindow,
    );
    return root;
  }

  // CR-36-T08
  it("applies a stored dark or light choice", () => {
    expect(
      run(memoryStorage({ [THEME_STORAGE_KEY]: "dark" })).getAttribute(
        THEME_ATTRIBUTE,
      ),
    ).toBe("dark");
    expect(
      run(memoryStorage({ [THEME_STORAGE_KEY]: "light" })).getAttribute(
        THEME_ATTRIBUTE,
      ),
    ).toBe("light");
  });

  // CR-36-T08
  it("leaves the page to the system when nothing or something unusable is stored", () => {
    expect(run(memoryStorage()).hasAttribute(THEME_ATTRIBUTE)).toBe(false);
    expect(
      run(memoryStorage({ [THEME_STORAGE_KEY]: "purple" })).hasAttribute(
        THEME_ATTRIBUTE,
      ),
    ).toBe(false);
  });

  // CR-36-T08
  it("does not throw when reading the browser storage fails", () => {
    expect(() => run("throws on access")).not.toThrow();
    expect(() => run(brokenStorage)).not.toThrow();
    expect(run(brokenStorage).hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });
});

describe("the theme stylesheet", () => {
  const css = readFileSync(
    join(import.meta.dirname, "..", "app", "theme.css"),
    "utf8",
  );

  // CR-36-T08
  it("follows the system by default and pins the mode for a stored choice", () => {
    expect(css).toMatch(/:root\s*{[^}]*color-scheme:\s*light dark;/);
    expect(css).toMatch(
      /:root\[data-theme="light"\]\s*{\s*color-scheme:\s*light;\s*}/,
    );
    expect(css).toMatch(
      /:root\[data-theme="dark"\]\s*{\s*color-scheme:\s*dark;\s*}/,
    );
  });

  // #185: the base element rules live in `@layer base`, so a Tailwind utility wins over them (the
  // rule the deleted `globals-layers.test.ts` guarded while the legacy stylesheet still existed).
  it("keeps the element-level rules in a layer so a utility wins over them", () => {
    const base = css.slice(css.indexOf("@layer base {"));
    expect(base).toMatch(/body\s*{/);
    expect(base).toMatch(/:focus-visible\s*{/);
    expect(base).not.toMatch(/\.(btn|card|page-header)\b/);
  });

  // #185 (review): a link in running text is underlined by default, so colour is not the only cue.
  it("underlines links in the base layer", () => {
    const base = css.slice(css.indexOf("@layer base {"));
    expect(base).toMatch(/a\s*{[^}]*text-decoration:\s*underline;/);
  });
});

describe("the Tailwind theme", () => {
  const theme = readFileSync(
    join(import.meta.dirname, "..", "app", "theme.css"),
    "utf8",
  );

  // #166-T05
  it("wires the dark variant to the data-theme attribute and follows the system setting", () => {
    // The `dark:` variant reacts to the attribute `theme.ts` writes, not to shadcn's `.dark` class.
    expect(theme).toMatch(/@custom-variant dark/);
    expect(theme).toMatch(/\[data-theme="dark"\]/);
    // The system state (no attribute) changes the tokens through the media query, and the explicit
    // dark choice pins them, so a stored choice and no choice both end up with the right values.
    expect(theme).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(theme).toMatch(/:root:not\(\[data-theme\]\)/);
    expect(theme).toMatch(/:root\[data-theme="dark"\]\s*{/);
  });
});
