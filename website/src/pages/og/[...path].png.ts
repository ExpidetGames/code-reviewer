// SPDX-License-Identifier: LicenseRef-Proprietary

import type { APIContext } from "astro";
import { blogIsLive, getPosts } from "../../lib/blog";
import { renderOgImage } from "../../lib/og";

// Preview images (1200×630) for the pages, made at build time with the layout of src/lib/og.ts. The home page has the
// headline of the product; the other pages carry their own title. The blog and its articles only when it is live.
export async function getStaticPaths() {
  const live = await blogIsLive();
  const posts = live ? await getPosts() : [];
  const pages = [
    { path: "index", title: "Simple code reviews for every GitHub pull request", kicker: "" },
    { path: "pricing", title: "Pay for the reviews you actually run", kicker: "Pricing" },
    { path: "about", title: "We build the tools we were missing", kicker: "About us" },
    { path: "imprint", title: "Imprint (Impressum)", kicker: "Legal" },
    { path: "privacy", title: "Privacy policy", kicker: "Legal" },
    { path: "terms", title: "Terms of service", kicker: "Legal" },
    ...(live ? [{ path: "blog", title: "Blog", kicker: "" }] : []),
    ...posts.map((p) => ({ path: `blog/${p.id}`, title: p.data.title, kicker: "Blog" })),
  ];
  return pages.map(({ path, ...props }) => ({ params: { path }, props }));
}

export async function GET({ props }: APIContext) {
  const png = await renderOgImage(props.title as string, props.kicker as string);
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
}
