// A secret that was read out of the store (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.7: never returned by an API, never logged, never in an error message). The value is a
// private field that `reveal()` hands out on purpose; everything that happens by accident (a string,
// JSON, `console.log`, an object dumped into an error) shows a placeholder instead.
import { inspect } from "node:util";

const PLACEHOLDER = "[secret]";

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The value. Call it where the value is used (a mail login, a signature), nowhere else. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return PLACEHOLDER;
  }

  toJSON(): string {
    return PLACEHOLDER;
  }

  [inspect.custom](): string {
    return PLACEHOLDER;
  }
}
