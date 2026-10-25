// SPDX-License-Identifier: LicenseRef-Proprietary

// Helpers for titles, absolute URLs and structured data (JSON-LD). Every page goes through Base.astro.
import { DESCRIPTION, LANG, NAME, ORGANIZATION, SITE_URL } from "../site";

/** Absolute URL of a path of the site. */
export const absolute = (path: string) => new URL(path, `${SITE_URL}/`).toString();

/** "Page title | NAME", only the page title if it already contains the name. */
export function pageTitle(title: string | undefined): string {
  if (!title) return NAME;
  return title.includes(NAME) ? title : `${title} | ${NAME}`;
}

const ORG_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;

/** Publisher and website, on every page. */
export function siteGraph() {
  return [
    {
      "@type": "Organization",
      "@id": ORG_ID,
      name: ORGANIZATION.name,
      url: ORGANIZATION.url,
      email: ORGANIZATION.email,
      telephone: ORGANIZATION.telephone,
      address: { "@type": "PostalAddress", ...ORGANIZATION.address },
      founder: ORGANIZATION.founders.map((name) => ({ "@type": "Person", name })),
      ...(ORGANIZATION.sameAs.length ? { sameAs: ORGANIZATION.sameAs } : {}),
    },
    {
      "@type": "WebSite",
      "@id": WEBSITE_ID,
      url: `${SITE_URL}/`,
      name: NAME,
      description: DESCRIPTION,
      inLanguage: LANG,
      publisher: { "@id": ORG_ID },
    },
  ];
}

export function breadcrumbs(items: { name: string; path: string }[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: absolute(item.path),
    })),
  };
}

export function faqPage(faq: { q: string; a: string }[]) {
  return {
    "@type": "FAQPage",
    mainEntity: faq.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a.replaceAll("`", "") },
    })),
  };
}

export function blogPosting(post: {
  path: string;
  title: string;
  description: string;
  image: string;
  author: string;
  pubDate: Date;
  updatedDate?: Date;
}) {
  return {
    "@type": "BlogPosting",
    "@id": `${absolute(post.path)}#article`,
    mainEntityOfPage: absolute(post.path),
    headline: post.title,
    description: post.description,
    image: absolute(post.image),
    inLanguage: LANG,
    datePublished: post.pubDate.toISOString(),
    dateModified: (post.updatedDate ?? post.pubDate).toISOString(),
    author: post.author === ORGANIZATION.name ? { "@id": ORG_ID } : { "@type": "Person", name: post.author },
    publisher: { "@id": ORG_ID },
    isPartOf: { "@id": WEBSITE_ID },
  };
}

/** Embeds JSON safely in a <script type="application/ld+json">. */
export const jsonLd = (graph: object[]) =>
  JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
