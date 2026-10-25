// SPDX-License-Identifier: LicenseRef-Proprietary

import { blogIsLive, getPosts, postPath } from "../lib/blog";
import { absolute } from "../lib/seo";
import { DESCRIPTION, NAME } from "../site";

// Overview for AI assistants (llmstxt.org): what the site is and which content there is.
export async function GET() {
  const live = await blogIsLive();
  const posts = live ? await getPosts() : [];
  const lines = [
    `# ${NAME}`,
    "",
    `> ${DESCRIPTION}`,
    "",
    "## Pages",
    "",
    `- [Home](${absolute("/")}): what code-review.com is, how it works and the FAQ`,
    `- [Pricing](${absolute("/pricing/")}): prepaid credit in US dollars, no subscription`,
    `- [About us](${absolute("/about/")}): Itegro GmbH, the team behind code-review.com`,
    `- [Terms of service](${absolute("/terms/")})`,
    `- [Privacy policy](${absolute("/privacy/")})`,
    `- [Imprint](${absolute("/imprint/")})`,
    ...(live ? [`- [Blog](${absolute("/blog/")})`] : []),
    ...(live ? ["", "## Articles", "", ...posts.map((p) => `- [${p.data.title}](${absolute(postPath(p))}): ${p.data.description}`)] : []),
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
