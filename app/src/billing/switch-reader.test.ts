// SPDX-License-Identifier: Apache-2.0

// There is one reader of the billing switch (#504-T15, #491-T10): `enabled.ts` reads the stored setting and decides whether
// billing is on. The files that read the stored setting for another purpose are named here, so a new one is noticed: the
// settings store (the read-modify-write of every writer) and the rates service through it. Everything else asks `isBillingOn`.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sources = readdirSync(import.meta.dirname).filter(
  (name) => /\.tsx?$/.test(name) && !/\.test\./.test(name),
);
const text = (file: string) =>
  readFileSync(join(import.meta.dirname, file), "utf8");
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the reader of the billing switch", () => {
  // #504-T15
  it("is the only module that decides from the stored setting whether billing is on", () => {
    const deciders = sources.filter((file) =>
      /\bisBillingOn\b|\breadBillingSwitch\b/.test(withoutComments(text(file))),
    );

    // The module itself, the wiring that hands it to the routes, the sweep step that asks it, the page's view that shows its
    // answer, the first line of every billing route, and the claim, which tells "off" from "set, but not ready" (#498), and the release of stranded holds, whose sweep entry point does nothing while billing is off (#591), and the start credit, whose one function does nothing while billing is off (#507), and the balance notifications (#506): the decision, the delivery of the mails and the banner, which do nothing while billing is off and read the low-balance threshold next to the switch, and the scheduled check of the journal, whose sweep entry point does nothing while billing is off (#626).
    expect(deciders.sort()).toEqual([
      "admin-service.ts",
      "balance-banner.ts",
      "balance-mail.ts",
      "balance-notifications.ts",
      "claim-billing.ts",
      "enabled.ts",
      "journal-check.ts",
      "shared.ts",
      "start-credit.ts",
      "stranded-holds.ts",
      "wall-clock.ts",
    ]);
  });

  // #504-T15
  it("is the only module that reads the stored setting as it is, the settings store being the one other reader (to write it) and `settings.ts` defining the function", () => {
    const readers = sources.filter((file) =>
      /readBillingSettings\(/.test(withoutComments(text(file))),
    );

    expect(readers.sort()).toEqual([
      "enabled.ts",
      "settings-store.ts",
      "settings.ts",
    ]);
  });
});
