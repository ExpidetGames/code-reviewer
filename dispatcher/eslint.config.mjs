// SPDX-License-Identifier: Apache-2.0

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.test.ts"],
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
    },
  },
  {
    // The core is platform-free (#327): no Node module and no platform SDK, so it runs the same in a
    // serverless function and in a Node process. A test (src/core/platform-free.test.ts) checks the same rule.
    files: ["src/core/**/*.ts"],
    ignores: ["src/core/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*"], message: "The core uses no Node module." },
            {
              group: ["@vercel/*", "@hono/*"],
              message: "The core uses no platform SDK.",
            },
          ],
        },
      ],
    },
  },
  {
    // Plain Node scripts run by CI, not part of the TypeScript sources (#416).
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Request: "readonly",
      },
    },
  },
  // `.vercel/` is what `vercel build` writes (the emitted function, generated code).
  globalIgnores(["dist/**", "coverage/**", "node_modules/**", ".vercel/**"]),
]);
