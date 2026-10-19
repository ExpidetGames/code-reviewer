// SPDX-License-Identifier: Apache-2.0

// The scan for words that must never reach a member of a workspace that reviews on the operator's key: a model, a
// vendor, a price or a cost. The copy of the catalog chooser (`model-choice.ts`, #283, #433) is held to it by its test, and
// the description of a catalog entry (#425), which an operator types, is refused by it. Pure: no state, no flags.

/** Each pattern matches something a member's copy must not say. None is global or sticky, so `test` has no memory. */
export const MEMBER_COPY_FORBIDDEN: readonly RegExp[] = [
  /\bmodels?\b/i,
  /\bopenrouter\b|\bopenai\b|\banthropic\b|\bgoogle\b|\bgemini\b|\bclaude\b|\bgpt\b/i,
  /\bdeepseek\b|\bmeta\b|\bllama\b|\bmistral\b|\bqwen\b|\bhaiku\b|\bsonnet\b|\bopus\b/i,
  /[$€£]|\busd\b|\beur\b/i,
  /\bpric|\bcost|\bcheap|\bexpensive|\bfree\b|\bcredit|\btoken|\bbill|\bplan\b/i,
  // The shape of a provider's model id.
  /[a-z0-9-]+\/[a-z0-9][a-z0-9._:-]*/i,
];

/** True when the text says a model, a vendor, a price or a cost. */
export function mentionsModelOrPrice(text: string): boolean {
  return MEMBER_COPY_FORBIDDEN.some((pattern) => pattern.test(text));
}
