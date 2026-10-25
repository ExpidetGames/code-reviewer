// SPDX-License-Identifier: LicenseRef-Proprietary

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAME, SITE_URL } from "../site";

// The licenses of the third-party code that this website sends to the browser, as one plain text file made at build
// time from node_modules, so the notices always match the versions that were built. The BSD and Apache licenses ask
// for their text and copyright line to travel with the code; the SIL Open Font License asks the same for the fonts.
//
// SHIPPED lists the packages whose code or files are in the build output (checked against the bundles of a build with
// analytics on: klaro and posthog-js are the only npm packages in the JavaScript; the CSS carries the Tailwind
// banner; the font files are Geist and Geist Mono). scripts/check-export.mjs fails when a dependency of package.json is neither here
// nor in its list of build-time packages, so a new package that ships cannot be forgotten.
const SHIPPED = [
  {
    name: "klaro",
    use: "Consent banner (JavaScript and CSS).",
  },
  {
    name: "posthog-js",
    use: "Analytics, loaded only after consent or in cookieless counting mode. Its LICENSE file also holds the notices of the third-party code bundled in it (web-vitals and others). The recorder and survey scripts that posthog-js loads at run time through /ingest/static come from the same package.",
  },
  {
    name: "tailwindcss",
    use: "The CSS of every page is generated with it (utility classes).",
  },
  {
    name: "@tailwindcss/typography",
    use: "Generates the styles of the long texts (privacy policy, terms) into the same CSS.",
  },
  {
    name: "@fontsource-variable/geist",
    use: "The Geist typeface (font files served from this site).",
  },
  {
    name: "@fontsource-variable/geist-mono",
    use: "The Geist Mono typeface (font files served from this site).",
  },
] as const;

function readPackage(name: string): { version: string; license: string; text: string } {
  const dir = join(process.cwd(), "node_modules", name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string };
  const file = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!file) throw new Error(`No license file in node_modules/${name}: add it by hand to src/pages/licenses.txt.ts.`);
  return { version: manifest.version, license: (manifest.license ?? "see below").replace(/^\((.*)\)$/, "$1"), text: readFileSync(file, "utf8").trim() };
}

export function GET() {
  const rule = "=".repeat(78);
  const entries = SHIPPED.map((pkg) => {
    const { version, license, text } = readPackage(pkg.name);
    return [rule, `${pkg.name} ${version}, license: ${license}`, pkg.use, rule, "", text, ""].join("\n");
  });
  const body = [
    `${NAME}: licenses of the third-party software in the browser`,
    "",
    `This file lists the open source packages whose code or files ${SITE_URL} sends to your browser, with their license`,
    "texts and copyright notices. The website itself, and the service behind it, is proprietary software of Itegro GmbH.",
    "",
    ...entries,
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
