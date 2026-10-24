// SPDX-License-Identifier: LicenseRef-Proprietary

// A small reader for SPDX license expressions, as found in package metadata:
//   MIT    (MIT OR Apache-2.0)    Apache-2.0 AND LGPL-3.0-or-later    Apache-2.0 WITH LLVM-exception
// It reads the grammar (OR binds weaker than AND, parentheses group, WITH ties an exception to one
// license) and answers one question: is the expression satisfied by a set of allowed licenses?
// OR needs one allowed choice, AND needs every part allowed. No dependency: the data is tiny and
// the rules are fixed.
//
// Node runs this file as it is (type stripping), see cli.ts: relative imports with the .ts
// extension and no TypeScript-only runtime syntax.

export const INVALID_SPDX_EXPRESSION = "INVALID_SPDX_EXPRESSION" as const;

export type Expression =
  { kind: "license"; id: string } | { kind: "and" | "or"; terms: Expression[] };

function fail(text: string): never {
  throw new Error(`${INVALID_SPDX_EXPRESSION}: ${JSON.stringify(text)}`);
}

function tokenize(text: string): string[] {
  return text.match(/\(|\)|[^\s()]+/g) ?? [];
}

const isOperator = (token: string | undefined, name: string): boolean =>
  token !== undefined && token.toUpperCase() === name;

export function parseExpression(text: string): Expression {
  const tokens = tokenize(text);
  let position = 0;

  function atom(): Expression {
    const token = tokens[position];
    if (token === undefined) return fail(text);
    if (token === "(") {
      position += 1;
      const inner = or();
      if (tokens[position] !== ")") return fail(text);
      position += 1;
      return inner;
    }
    if (token === ")" || isOperator(token, "AND") || isOperator(token, "OR")) {
      return fail(text);
    }
    position += 1;
    if (isOperator(tokens[position], "WITH")) {
      const exception = tokens[position + 1];
      if (
        exception === undefined ||
        exception === "(" ||
        exception === ")" ||
        isOperator(exception, "AND") ||
        isOperator(exception, "OR")
      ) {
        return fail(text);
      }
      position += 2;
      return { kind: "license", id: `${token} WITH ${exception}` };
    }
    return { kind: "license", id: token };
  }

  function chain(kind: "and" | "or", next: () => Expression): Expression {
    const terms = [next()];
    while (isOperator(tokens[position], kind.toUpperCase())) {
      position += 1;
      terms.push(next());
    }
    const [only] = terms;
    return terms.length === 1 && only ? only : { kind, terms };
  }

  const and = (): Expression => chain("and", atom);
  const or = (): Expression => chain("or", and);

  const expression = or();
  if (position !== tokens.length) return fail(text);
  return expression;
}

/** Every license id in the expression, in reading order. */
export function licenseIds(expression: Expression): string[] {
  if (expression.kind === "license") return [expression.id];
  return expression.terms.flatMap(licenseIds);
}

/** True when the allowed licenses are enough: one choice of every OR, all parts of every AND. */
export function satisfies(
  expression: Expression,
  isAllowed: (id: string) => boolean,
): boolean {
  if (expression.kind === "license") return isAllowed(expression.id);
  if (expression.kind === "or") {
    return expression.terms.some((term) => satisfies(term, isAllowed));
  }
  return expression.terms.every((term) => satisfies(term, isAllowed));
}
