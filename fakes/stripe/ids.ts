// SPDX-License-Identifier: Apache-2.0

// Made-up Stripe ids in the shape of the real ones (`cus_Qabc123`: a prefix, an underscore, letters and digits). The
// `Fake` marker makes them impossible to mistake for a real object, and a counter per fake makes a run the same every
// time: the first customer of every fake is `cus_Fake00000001`.
export function createIds() {
  const counters = new Map<string, number>();
  return {
    next(prefix: string): string {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_Fake${String(n).padStart(8, "0")}`;
    },
    reset(): void {
      counters.clear();
    },
  };
}
export type Ids = ReturnType<typeof createIds>;
