// SPDX-License-Identifier: LicenseRef-Proprietary

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
