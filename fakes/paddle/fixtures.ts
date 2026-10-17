// SPDX-License-Identifier: Apache-2.0

// The sample entities under fakes/fixtures/paddle (made-up ids and amounts, shaped like Paddle's responses).
// They define which fields a Paddle entity has for the fake and for the tests of the client's schemas.
import { readFileSync } from "node:fs";

export const PADDLE_FIXTURE_NAMES = [
  "product",
  "price",
  "transaction",
  "subscription",
  "portal-session",
  "notification-setting",
] as const;
export type PaddleFixtureName = (typeof PADDLE_FIXTURE_NAMES)[number];

/** A fresh copy of the fixture, so a test may change it. */
export function loadPaddleFixture(
  name: PaddleFixtureName,
): Record<string, unknown> {
  const url = new URL(`../fixtures/paddle/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}
