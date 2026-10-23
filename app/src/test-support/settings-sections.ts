// SPDX-License-Identifier: Apache-2.0

// Test helpers for the settings form with its four sections (#656): a section is a tab, and a dropdown is a Radix select.
import { screen } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

export type SectionName = "Review" | "LLM" | "Trigger" | "Limits";

/** Opens a section of the form, the way a person clicks its tab (its name may say "(has a problem)" after a refused save). */
export async function openSection(user: User, name: SectionName) {
  await user.click(
    screen.getByRole("tab", {
      name: new RegExp(`^${name}( \\(has a problem\\))?$`),
    }),
  );
}

/** Opens a dropdown and chooses one option by its name. */
export async function chooseOption(
  user: User,
  dropdown: HTMLElement,
  option: string | RegExp,
) {
  await user.click(dropdown);
  await user.click(await screen.findByRole("option", { name: option }));
}
