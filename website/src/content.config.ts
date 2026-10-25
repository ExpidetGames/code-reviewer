// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// Blogartikel und Ratgeber: eine Markdown-Datei pro Artikel in src/content/blog/, Dateiname = URL.
// Die Grenzen bei Titel und Beschreibung sorgen dafür, dass Google sie nicht abschneidet.
const blog = defineCollection({
  loader: glob({ base: "./src/content/blog", pattern: "**/*.{md,mdx}" }),
  schema: ({ image }) =>
    z.object({
      /** Überschrift (h1) des Artikels. */
      title: z.string().max(90),
      /** Titel für Google, falls kürzer als `title` nötig (ohne „| NAME“, das wird angehängt). */
      seoTitle: z.string().max(60).optional(),
      /** Meta-Description und Teaser, 70–160 Zeichen. */
      description: z.string().min(70).max(160),
      pubDate: z.coerce.date(),
      /** Bei jeder inhaltlichen Änderung setzen: Sitemap, RSS und strukturierte Daten nutzen es. */
      updatedDate: z.coerce.date().optional(),
      author: z.string().optional(),
      tags: z.array(z.string()).default([]),
      /** Optionales Titelbild, relativ zur Markdown-Datei. Wird optimiert ausgeliefert. */
      cover: image().optional(),
      coverAlt: z.string().optional(),
      /** Kurze Antwort oben im Artikel, gut für Suchmaschinen und KI-Antworten. */
      summary: z.string().optional(),
      /** Fragen und Antworten am Ende, erscheinen auch als FAQPage. */
      faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
      /** Quellen bzw. weiterführende Links. */
      sources: z.array(z.object({ title: z.string(), url: z.url() })).default([]),
      /** Entwürfe werden nicht gebaut. */
      draft: z.boolean().default(false),
    }),
});

export const collections = { blog };
