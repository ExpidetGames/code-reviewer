// SPDX-License-Identifier: Apache-2.0

// Helpers for the settings form with its four sections (#656): a section is a tab, a provider or a model a dropdown.
import { expect, type Page } from "@playwright/test";

export type SettingsSection = "Review" | "LLM" | "Trigger" | "Limits";

/** Opens a section of the settings form the way a person does: by its tab. */
export async function openSection(
  page: Page,
  section: SettingsSection,
): Promise<void> {
  // Next keeps a page that was left mounted, hidden: only the tab that can be seen counts.
  const tab = page
    .getByRole("tab", {
      name: new RegExp(`^${section}( \\(has a problem\\))?$`),
    })
    .filter({ visible: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** Chooses one option of a dropdown (a provider or a model) by the dropdown's label and the option's name. */
export async function chooseOption(
  page: Page,
  dropdown: string,
  option: string | RegExp,
): Promise<void> {
  await page.getByRole("combobox", { name: dropdown, exact: true }).click();
  await page.getByRole("option", { name: option }).click();
}
