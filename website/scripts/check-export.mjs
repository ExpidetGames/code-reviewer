// SPDX-License-Identifier: LicenseRef-Proprietary

// Prüft den fertigen Build (dist/) auf SEO- und Technikfehler. Läuft nach `astro build` (pnpm check:export)
// (Teil von pnpm verify). Fehler brechen ab, Warnungen nur ausgeben.
//
// Geprüft wird je HTML-Seite: genau eine h1, Titel, Beschreibung (Länge), Canonical (absolut, eigene Domain,
// Slash am Ende), Vorschaubild vorhanden, keine doppelten Titel/Beschreibungen, interne Links und Bilder
// erreichbar, Bilder mit alt/width/height, strukturierte Daten gültiges JSON, keine Inline-Skripte (CSP),
// keine Platzhalter. Dazu: Sitemap enthält nur erreichbare, indexierbare Seiten.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "node-html-parser";
import sharp from "sharp";

const DIST = new URL("../dist/", import.meta.url).pathname;
const SITE_TS = readFileSync(new URL("../src/site.ts", import.meta.url), "utf8");
const SITE_URL = SITE_TS.match(/SITE_URL\s*=\s*"([^"]+)"/)?.[1];
const IS_TEMPLATE = SITE_URL === "https://example.com";

const errors = [];
const warnings = [];
const error = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

if (!SITE_URL) {
  console.error("SITE_URL in src/site.ts nicht gefunden.");
  process.exit(1);
}

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

/** Ob ein interner Pfad (ohne Query/Anker) im Build existiert. */
function exists(pathname) {
  const clean = decodeURI(pathname.split(/[?#]/)[0]);
  const target = join(DIST, clean);
  if (clean.endsWith("/")) return existsSync(join(target, "index.html"));
  return existsSync(target) && statSync(target).isFile();
}

const pages = files(DIST).filter((f) => f.endsWith(".html"));
const seenTitles = new Map();
const seenDescriptions = new Map();
const noindexUrls = new Set();

for (const file of pages) {
  const name = relative(DIST, file);
  const html = readFileSync(file, "utf8");
  const doc = parse(html);
  const is404 = name === "404.html";

  const h1 = doc.querySelectorAll("h1");
  if (h1.length !== 1) error(name, `${h1.length} h1-Überschriften, erwartet genau eine`);

  const title = doc.querySelector("title")?.text.trim();
  if (!title) error(name, "kein <title>");
  else if (title.length > 65) warn(name, `Titel ${title.length} Zeichen (über 65 wird oft abgeschnitten)`);

  const description = doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim();
  if (!description) error(name, "keine Meta-Description");
  else if (description.length < 70 || description.length > 160)
    warn(name, `Description ${description.length} Zeichen (empfohlen 70–160)`);

  const robots = doc.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "";
  const noindex = robots.includes("noindex");
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  if (!canonical) error(name, "kein Canonical");
  else {
    if (!canonical.startsWith(`${SITE_URL}/`)) error(name, `Canonical ${canonical} nicht auf ${SITE_URL}`);
    if (!is404 && !canonical.endsWith("/")) error(name, `Canonical ${canonical} ohne Slash am Ende`);
    if (noindex) noindexUrls.add(canonical);
  }

  if (!noindex && !is404) {
    for (const [value, seen, label] of [
      [title, seenTitles, "Titel"],
      [description, seenDescriptions, "Description"],
    ]) {
      if (!value) continue;
      if (seen.has(value)) error(name, `${label} doppelt (auch in ${seen.get(value)})`);
      else seen.set(value, name);
    }
  }

  const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  if (!ogImage) error(name, "kein og:image");
  else if (ogImage.startsWith(`${SITE_URL}/`) && !exists(new URL(ogImage).pathname))
    error(name, `og:image ${ogImage} existiert nicht im Build`);

  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || /^(mailto|tel):/.test(href)) continue;
    const internal = href.startsWith("/") ? href : href.startsWith(`${SITE_URL}/`) ? href.slice(SITE_URL.length) : null;
    if (internal && !exists(internal)) error(name, `Link auf ${href} führt ins Leere`);
    if (href === "#" || href === "") warn(name, `Link ohne Ziel („${a.text.trim()}“)`);
  }

  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (img.getAttribute("alt") === undefined) error(name, `Bild ${src} ohne alt-Attribut`);
    if (!img.getAttribute("width") || !img.getAttribute("height")) warn(name, `Bild ${src} ohne width/height`);
    if (src.startsWith("/") && !exists(src)) error(name, `Bild ${src} existiert nicht im Build`);
  }

  for (const script of doc.querySelectorAll("script")) {
    const type = script.getAttribute("type");
    if (type === "application/ld+json") {
      try {
        JSON.parse(script.text);
      } catch (e) {
        error(name, `strukturierte Daten kein gültiges JSON: ${e.message}`);
      }
    } else if (!script.getAttribute("src")) {
      error(name, "Inline-Skript gefunden: wird von der Content-Security-Policy blockiert");
    }
  }

  if (!IS_TEMPLATE && /PROJEKT|TODO:/.test(doc.querySelector("body")?.text ?? "")) {
    const legal = /^(imprint|privacy|terms)\//.test(name);
    (legal ? warn : error)(name, "Platzhalter (PROJEKT oder TODO:) im Text");
  }
}

// Sitemap: nur erreichbare, indexierbare Seiten.
const sitemaps = files(DIST).filter((f) => /sitemap-\d+\.xml$/.test(f));
if (!sitemaps.length) error("sitemap", "keine Sitemap im Build");
for (const file of sitemaps) {
  for (const [, loc] of readFileSync(file, "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)) {
    if (!loc.startsWith(`${SITE_URL}/`)) error("sitemap", `${loc} nicht auf ${SITE_URL}`);
    else if (!exists(new URL(loc).pathname)) error("sitemap", `${loc} existiert nicht im Build`);
    if (noindexUrls.has(loc)) error("sitemap", `${loc} steht auf noindex, ist aber in der Sitemap`);
  }
  // Änderungsdaten kommen aus der Git-Historie (astro.config.ts); in einem flachen Klon fehlen sie.
  const urls = [...readFileSync(file, "utf8").matchAll(/<url>([\s\S]*?)<\/url>/g)];
  for (const [, entry] of urls)
    if (!/<lastmod>\d{4}-\d{2}-\d{2}/.test(entry)) warn("sitemap", `${entry.match(/<loc>([^<]+)/)?.[1]} ohne lastmod (flacher Git-Klon?)`);
}

// Vorschaubilder (dist/og/*.png): 1200×630, und der Rand (die Hälfte des Innenabstands von src/lib/og.ts) bleibt schwarz.
// Läuft Text bis an den Rand, ist er abgeschnitten (so war es ohne box-sizing: border-box).
for (const file of files(DIST).filter((f) => /\/og\/.+\.png$/.test(f))) {
  const name = relative(DIST, file);
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 1200 || info.height !== 630) error(name, `${info.width}×${info.height}, erwartet 1200×630`);
  const MARGIN = 40;
  let touched = false;
  for (let y = 0; y < info.height && !touched; y += 1)
    for (let x = 0; x < info.width; x += 1) {
      if (x >= MARGIN && x < info.width - MARGIN && y >= MARGIN && y < info.height - MARGIN) {
        x = info.width - MARGIN - 1;
        continue;
      }
      const i = (y * info.width + x) * info.channels;
      if (data[i] > 24 || data[i + 1] > 24 || data[i + 2] > 24) {
        touched = true;
        break;
      }
    }
  if (touched) error(name, `Inhalt reicht in den ${MARGIN}-Pixel-Rand: Text abgeschnitten?`);
}

// Lizenzhinweise: licenses.txt nennt jedes Paket, dessen Code oder Dateien im Browser landen (src/pages/licenses.txt.ts),
// und jede Abhängigkeit aus package.json ist dort oder hier als reines Build-Werkzeug eingetragen.
const BUILD_ONLY = new Set(["astro", "@astrojs/rss", "@astrojs/sitemap", "@tailwindcss/vite"]);
const shippedSource = readFileSync(new URL("../src/pages/licenses.txt.ts", import.meta.url), "utf8");
const shipped = [...shippedSource.matchAll(/^\s+name: "([^"]+)",$/gm)].map((m) => m[1]);
const dependencies = Object.keys(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies ?? {});
for (const name of dependencies)
  if (!shipped.includes(name) && !BUILD_ONLY.has(name))
    error("licenses.txt", `Abhängigkeit ${name} steht weder in SHIPPED (src/pages/licenses.txt.ts) noch in BUILD_ONLY (scripts/check-export.mjs)`);
const licenses = existsSync(join(DIST, "licenses.txt")) ? readFileSync(join(DIST, "licenses.txt"), "utf8") : "";
if (!licenses) error("licenses.txt", "fehlt im Build");
for (const name of shipped) if (!licenses.includes(`${name} `)) error("licenses.txt", `${name} fehlt`);
if (licenses && !/Copyright/i.test(licenses)) error("licenses.txt", "kein Copyright-Hinweis");

for (const w of warnings) console.log(`Warnung: ${w}`);
for (const e of errors) console.log(`Fehler:  ${e}`);
console.log(`\n${pages.length} Seiten geprüft: ${errors.length} Fehler, ${warnings.length} Warnungen.`);
if (IS_TEMPLATE) console.log("Hinweis: SITE_URL ist noch example.com, Platzhalter werden nicht geprüft.");
process.exit(errors.length ? 1 : 0);
