// SPDX-License-Identifier: LicenseRef-Proprietary

import { getCollection, type CollectionEntry } from "astro:content";
import { DEFAULT_AUTHOR } from "../site";

export type Post = CollectionEntry<"blog">;

/** All published articles, newest first. */
export async function getPosts(): Promise<Post[]> {
  // Without a single article, getCollection would warn on every call; there is nothing to load then.
  if (Object.keys(import.meta.glob("/src/content/blog/**/*.{md,mdx}")).length === 0) return [];
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime());
}

export const postPath = (post: Post) => `/blog/${post.id}/`;
export const ogPath = (path: string) => `/og${path === "/" ? "/index" : path.replace(/\/$/, "")}.png`;
export const authorOf = (post: Post) => post.data.author ?? DEFAULT_AUTHOR;

/** Reading time in minutes (200 words per minute). */
export const readingTime = (post: Post) =>
  Math.max(1, Math.round((post.body ?? "").split(/\s+/).filter(Boolean).length / 200));

/** Up to `count` articles with the most tags in common, then the newest. */
export function related(post: Post, posts: Post[], count = 3): Post[] {
  const tags = new Set(post.data.tags);
  return posts
    .filter((p) => p.id !== post.id)
    .map((p) => ({ p, shared: p.data.tags.filter((t) => tags.has(t)).length }))
    .sort((a, b) => b.shared - a.shared || b.p.data.pubDate.getTime() - a.p.data.pubDate.getTime())
    .slice(0, count)
    .map(({ p }) => p);
}

export const formatDate = (date: Date) =>
  new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);

/**
 * Whether the blog is live. There are no articles yet, and an empty blog must not show up: no /blog/ page, no
 * link in the navigation, footer or RSS link, nothing in the sitemap. It all appears with the first article in
 * src/content/blog/.
 */
export const blogIsLive = async () => (await getPosts()).length > 0;
