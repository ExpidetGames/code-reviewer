// SPDX-License-Identifier: LicenseRef-Proprietary

// Every secret the server keeps, as the admin portal lists them (#715, cut 8): the fixed names of the application and the
// operator's LLM key of each provider, in alphabetical order. A provider key name that is a fixed name, or that another
// provider already uses, would put two secrets under one row id: that stops the portal at start (`SecretNamesError`).
import { OPERATOR_LLM_KEY_NAMES } from "../llm/secret-names.ts";
import { FIXED_SECRET_NAMES } from "../secret-names/names.ts";
import { composeSecretNames } from "../secrets/names.ts";

export const SECRET_NAMES = composeSecretNames(
  FIXED_SECRET_NAMES,
  OPERATOR_LLM_KEY_NAMES,
);
export type SecretName = (typeof SECRET_NAMES)[number];
