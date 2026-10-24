// SPDX-License-Identifier: LicenseRef-Proprietary

// The one start line about the operator API: whether it is on. It names the variable and, for a token that is set
// but unusable, the rule it breaks; it never contains a token. An instance that never set the variable gets the
// "off" line and nothing else changes for it.
import "server-only";
import { configuredOperatorToken, operatorTokenProblem } from "./token.ts";

export function operatorApiStateLine(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const problem = operatorTokenProblem(env);
  if (problem !== null)
    return `[operator-api] off: OPERATOR_API_TOKEN ${problem}.`;
  return configuredOperatorToken(env) === undefined
    ? "[operator-api] off: OPERATOR_API_TOKEN is not set."
    : "[operator-api] on.";
}

export function logOperatorApiState(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.info(line),
): void {
  log(operatorApiStateLine(env));
}
