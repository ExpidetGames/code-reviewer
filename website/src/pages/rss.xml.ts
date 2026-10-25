// SPDX-License-Identifier: LicenseRef-Proprietary

import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getPosts, postPath } from "../lib/blog";
import { DESCRIPTION, LANG, NAME } from "../site";

export async function GET(context: APIContext) {
  const posts = await getPosts();
  return rss({
    title: `${NAME} Blog`,
    description: DESCRIPTION,
    site: context.site!,
    trailingSlash: true,
    customData: `<language>${LANG}</language>`,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: postPath(post),
      categories: post.data.tags,
    })),
  });
}
