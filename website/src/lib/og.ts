// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import satori from "satori";
import sharp from "sharp";

// Makes a preview image (Open Graph, 1200×630) with the layout of the former Next.js site: flat black background,
// the mark and the name at the top, the title in white (Satori cannot clip a gradient to text), the line below in grey.
// Colours and layout can be changed here.
const require = createRequire(import.meta.url);
const font = (weight: number) => readFile(require.resolve(`@fontsource/geist/files/geist-latin-${weight}-normal.woff`));
const fonts = Promise.all([font(400), font(600)]);

const mark = {
  type: "svg",
  props: {
    width: 48,
    height: 48,
    viewBox: "0 0 32 32",
    children: [
      { type: "rect", props: { width: 32, height: 32, rx: 8, fill: "#ffffff" } },
      {
        type: "g",
        props: {
          fill: "none",
          stroke: "#000000",
          strokeWidth: 2.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          children: [
            { type: "path", props: { d: "M10.5 10 6 16l4.5 6" } },
            { type: "path", props: { d: "M21.5 10 26 16l-4.5 6" } },
            { type: "path", props: { d: "m12.5 16.5 2.5 2.5 4.5-5.5" } },
          ],
        },
      },
    ],
  },
};

export async function renderOgImage(title: string, kicker: string): Promise<Buffer> {
  const [regular, semibold] = await fonts;
  const svg = await satori(
    {
      type: "div",
      props: {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: "#000000",
          color: "#ffffff",
          fontFamily: "Geist",
        },
        children: [
          {
            type: "div",
            props: {
              style: { display: "flex", alignItems: "center", gap: 16, fontSize: 32, fontWeight: 600 },
              children: [mark, "code-review.com"],
            },
          },
          {
            type: "div",
            props: {
              style: { display: "flex", flexDirection: "column", gap: 24 },
              children: [
                {
                  type: "div",
                  props: {
                    style: { width: 1040, fontSize: title.length > 50 ? 64 : 72, fontWeight: 600, lineHeight: 1.05, letterSpacing: -2 },
                    children: title,
                  },
                },
                {
                  type: "div",
                  props: {
                    style: { fontSize: 30, color: "#a3a3a3", fontWeight: 400 },
                    children: kicker || "Built on PR-Agent and OpenCode · Made in Germany",
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Geist", data: regular, weight: 400, style: "normal" },
        { name: "Geist", data: semibold, weight: 600, style: "normal" },
      ],
    },
  );
  return sharp(Buffer.from(svg)).png().toBuffer();
}
