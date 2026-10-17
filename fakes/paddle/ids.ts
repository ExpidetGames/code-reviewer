// SPDX-License-Identifier: Apache-2.0

// Made-up Paddle ids in the shape of the real ones (`pri_01gsz8x8sawmvhz1pv30nge1ke`: a prefix, then 26
// lowercase letters and digits). The `fake` marker makes them impossible to mistake for a real entity.
let counter = 0;

/** A new id with this prefix, unique in the process: `pri_01fake` plus a zero padded counter. */
export function fakeId(prefix: string): string {
  counter += 1;
  return `${prefix}_01fake${String(counter).padStart(20, "0")}`;
}
