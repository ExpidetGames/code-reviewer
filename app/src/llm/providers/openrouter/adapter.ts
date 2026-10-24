// SPDX-License-Identifier: LicenseRef-Proprietary

// The complete OpenRouter adapter: its descriptor and the two calls the server makes to it. Server code only
// (it is listed in ../server.ts); a client component imports the descriptor.
import "server-only";
import type { LlmProviderAdapter } from "../types.ts";
import { checkModelCapabilities } from "./capabilities.ts";
import { openrouterDescriptor } from "./descriptor.ts";
import { testKey } from "./key-test.ts";

export const openrouterAdapter = {
  ...openrouterDescriptor,
  testKey,
  checkModelCapabilities,
} as const satisfies LlmProviderAdapter;
