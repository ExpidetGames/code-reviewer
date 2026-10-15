// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

// Which project runs a file is decided here, not by the file's location (the same rule as the app):
//   unit         *.test.ts, except *.integration.test.ts
//   integration  *.integration.test.ts
const setupFiles = ["./src/test-support/network-guard.setup.ts"];
const maxWorkers = Number(process.env.TEST_MAX_WORKERS) || 4;

export default defineConfig({
  test: {
    maxWorkers,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
          setupFiles,
          clearMocks: true,
          restoreMocks: true,
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
          setupFiles,
          pool: "forks",
          clearMocks: true,
          restoreMocks: true,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
