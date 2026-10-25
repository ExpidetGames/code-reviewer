// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import vitest from "@vitest/eslint-plugin";
import playwright from "eslint-plugin-playwright";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.test.{ts,tsx}"],
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
    },
  },
  {
    ...playwright.configs["flat/recommended"],
    files: ["e2e/**/*.ts"],
    rules: {
      ...playwright.configs["flat/recommended"].rules,
      "playwright/no-focused-test": "error",
      "playwright/no-skipped-test": "error",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
