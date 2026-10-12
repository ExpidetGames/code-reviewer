// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Which project runs a file is decided here, not by the file's location:
//   unit         *.test.ts(x), except *.integration.test.ts(x)
//   integration  *.integration.test.ts(x)
// E2E specs (*.e2e.ts) are run by Playwright and never matched by Vitest.
// `server-only` throws unless the "react-server" condition is set, which Next.js sets for server
// code. Tests are server code, so it resolves to nothing there.
const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  "server-only": fileURLToPath(
    new URL("./src/test-support/empty.ts", import.meta.url),
  ),
};
const setupFiles = [
  "./src/test-support/network-guard.setup.ts",
  "./src/test-support/dom-shims.setup.ts",
];
const maxWorkers = Number(process.env.TEST_MAX_WORKERS) || 4;

export default defineConfig({
  test: {
    maxWorkers,
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.integration.test.{ts,tsx}"],
          setupFiles,
          clearMocks: true,
          restoreMocks: true,
          testTimeout: 10_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: [
            "src/**/*.integration.test.{ts,tsx}",
            "integration-tests/**/*.integration.test.{ts,tsx}",
          ],
          setupFiles,
          globalSetup: ["./src/test-support/db-template.global-setup.ts"],
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
