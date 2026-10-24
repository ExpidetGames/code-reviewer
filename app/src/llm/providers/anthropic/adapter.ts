// SPDX-License-Identifier: LicenseRef-Proprietary

// The complete Anthropic (Claude API, direct) adapter: its descriptor and the two calls the server makes. Server
// code only (it is listed in ../server.ts); a client component imports the descriptor.
import "server-only";
import type { LlmProviderAdapter } from "../types.ts";
import { checkModelCapabilities } from "./capabilities.ts";
import { anthropicDescriptor } from "./descriptor.ts";
import { testKey } from "./key-test.ts";

export const anthropicAdapter = {
  ...anthropicDescriptor,
  testKey,
  checkModelCapabilities,
} as const satisfies LlmProviderAdapter;
