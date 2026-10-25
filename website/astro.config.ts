// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { LEGAL_READY, SITE_URL } from "./src/site";

// Änderungsdatum je Blogartikel für die Sitemap (updatedDate, sonst pubDate aus dem Frontmatter).
const BLOG_DIR = new URL("./src/content/blog/", import.meta.url);
const lastmod = new Map<string, string>();
for (const file of readdirSync(BLOG_DIR).filter((f) => /\.mdx?$/.test(f))) {
  const front = readFileSync(new URL(file, BLOG_DIR), "utf8").split(/^---$/m)[1] ?? "";
  const date = front.match(/^updatedDate:\s*(.+)$/m)?.[1] ?? front.match(/^pubDate:\s*(.+)$/m)?.[1];
  if (date) lastmod.set(`${SITE_URL}/blog/${file.replace(/\.mdx?$/, "")}/`, new Date(date.trim()).toISOString());
}

// Änderungsdatum der festen Seiten: der letzte Commit, der ihren Inhalt berührt (echte Änderungsdaten, keine Build-Zeit).
// In einem flachen Klon (zum Beispiel ein Build mit `git clone --depth 1`) gibt es diese Daten nicht; dann bleibt lastmod
// weg, statt ein falsches Datum zu nennen.
const PAGE_SOURCES: Record<string, string[]> = {
  "/": ["src/pages/index.astro", "src/content/home.ts", "src/content/faq.ts"],
  "/pricing/": ["src/pages/pricing.astro", "src/content/pricing.ts"],
  "/about/": ["src/pages/about.astro", "src/content/about.ts", "src/assets/founders.webp"],
  "/imprint/": ["src/pages/imprint.astro", "src/content/company.ts"],
  "/privacy/": ["src/pages/privacy.astro", "src/content/privacy.ts"],
  "/terms/": ["src/pages/terms.astro", "src/content/terms.ts"],
};
function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: new URL(".", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
if (git("rev-parse", "--is-shallow-repository") !== "true") {
  for (const [path, sources] of Object.entries(PAGE_SOURCES)) {
    const date = git("log", "-1", "--format=%cI", "--", ...sources);
    if (date) lastmod.set(`${SITE_URL}${path}`, new Date(date).toISOString());
  }
}

export default defineConfig({
  site: SITE_URL,
  output: "static",
  trailingSlash: "always",
  build: {
    format: "directory",
    // Kein CSS inline: hält die Content-Security-Policy einfach.
    inlineStylesheets: "never",
  },
  vite: {
    plugins: [tailwindcss()],
    // Keine Skripte inline ins HTML: Die CSP erlaubt nur Skripte von der eigenen Domain (script-src 'self').
    build: { assetsInlineLimit: 0 },
  },
  integrations: [
    sitemap({
      filter: (page) => LEGAL_READY || !/\/(imprint|privacy|terms)\/$/.test(page),
      serialize: (item) => ({ ...item, lastmod: lastmod.get(item.url) ?? item.lastmod }),
    }),
  ],
});
