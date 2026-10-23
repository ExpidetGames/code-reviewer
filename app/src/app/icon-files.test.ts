// SPDX-License-Identifier: Apache-2.0

// #650: the app's icons are the code-review.com icon, not the create-next-app default. The files
// are served by Next.js as they are (file conventions favicon, icon, apple-icon), so the test reads
// them from disk.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe("the app icons", () => {
  // #650-T02
  it("serve the code-review.com icon as icon.svg: the tile with brackets and check mark", () => {
    const svg = readFileSync(join(here, "icon.svg"), "utf8");

    expect(svg).toContain('<rect class="tile"');
    expect(svg).toContain("M10.5 10 6 16l4.5 6");
    expect(svg).toContain("M21.5 10 26 16l-4.5 6");
    expect(svg).toContain("m12.5 16.5 2.5 2.5 4.5-5.5");
  });

  // #650-T02
  it("hold a favicon.ico of 16, 32 and 48 px PNG images, not the create-next-app default", () => {
    const ico = readFileSync(join(here, "favicon.ico"));

    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const count = ico.readUInt16LE(4);
    const entries = Array.from({ length: count }, (_, index) => {
      const at = 6 + index * 16;
      const size = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      return {
        width: ico[at],
        height: ico[at + 1],
        png: ico.subarray(offset, offset + 8).equals(PNG_SIGNATURE),
        size,
      };
    });
    // The default icon is bitmap based (BMP entries); ours are rendered PNG entries.
    expect(entries.map(({ width, height }) => [width, height])).toEqual([
      [16, 16],
      [32, 32],
      [48, 48],
    ]);
    expect(entries.every(({ png }) => png)).toBe(true);
  });

  // #650-T02
  it("hold an apple-icon.png of 180 px", () => {
    const png = readFileSync(join(here, "apple-icon.png"));

    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });
});
