// SPDX-License-Identifier: Apache-2.0

// The models.dev catalog in the admin portal, from the first fetch to a price that moved (#554-T10), on an app of its own
// that fetches from the fake models.dev (`fakes/models-dev`, no network): the admin fetches the empty catalog, a new model
// appears after the next fetch, they enable it, confirm its price as shown, see the price go stale when models.dev moves
// it, confirm it again, correct it with a reason, and decide on the address of a provider that changed. The addresses in
// the fake body are public IP literals, so the app resolves no name.
//   - The page is the admin's alone (the portal journey checks the answer for everybody else).
//   - Nothing is typed or clicked outside the page: every change goes through the real routes.
// Not in this journey: naming the entry a member sees (#555) and the release guard that needs the slug-to-models.dev map
// (#553/#555); the data routes and the screens' states are tested at their own level.
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";

const NEW_MODEL = "mistralai/mistral-new-1";
const OLD_ADDRESS = "https://93.184.216.34/v1";
const NEW_ADDRESS = "https://93.184.216.35/v1";

type Provider = {
  api?: string;
  models: Record<
    string,
    { cost?: Record<string, number> } & Record<string, unknown>
  >;
} & Record<string, unknown>;

const FAKE = `http://127.0.0.1:${String(e2eEnv.modelsDevFakePort)}/__fake`;

/** The fixture reduced to two providers with public IP addresses, and the changes a step of the journey makes. */
async function bodyOf(
  changes: {
    newModel?: boolean;
    newModelInput?: number;
    deepseekApi?: string;
  } = {},
): Promise<Record<string, Provider>> {
  const fixture = (await (await fetch(`${FAKE}/fixture`)).json()) as Record<
    string,
    Provider
  >;
  const openrouter = fixture.openrouter as Provider;
  const deepseek = fixture.deepseek as Provider;
  const saba = openrouter.models[
    "mistralai/mistral-saba"
  ] as Provider["models"][string];
  const body: Record<string, Provider> = {
    openrouter: {
      ...openrouter,
      api: OLD_ADDRESS,
      models: { ...openrouter.models },
    },
    deepseek: {
      ...deepseek,
      api: changes.deepseekApi ?? OLD_ADDRESS,
      models: {
        "deepseek-v4-pro": deepseek.models[
          "deepseek-v4-pro"
        ] as Provider["models"][string],
      },
    },
  };
  if (changes.newModel === true)
    body.openrouter!.models[NEW_MODEL] = {
      ...saba,
      id: NEW_MODEL,
      name: "Mistral New 1",
      cost: {
        input: changes.newModelInput ?? 0.2,
        output: 0.6,
        cache_read: 0.02,
      },
    };
  return body;
}

/** Scripts the fake: what it answers from now on. */
async function respondWith(body: unknown): Promise<void> {
  const response = await fetch(`${FAKE}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(204);
}

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}

async function fetchNow(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Fetch now" }).click();
  await expect(page.getByText("The catalog was fetched.")).toBeVisible();
}

const rowOf = (page: Page, modelId: string) =>
  page.getByRole("row").filter({ hasText: modelId });

test.describe("the models.dev catalog in the admin portal", () => {
  test.beforeAll(async () => {
    await respondWith(await bodyOf());
  });

  test("the admin fetches the catalog, enables a new model, confirms its price, sees it go stale and confirms it again", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    await test.step("the catalog is empty until the first fetch", async () => {
      await page.goto("/admin/catalog");
      await expect(
        page.getByRole("heading", { level: 1, name: "models.dev catalog" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "The catalog is empty. It is filled by the first fetch.",
        ),
      ).toBeVisible();
      await fetchNow(page);
      await expect(
        page.getByRole("table", { name: "Catalog models" }),
      ).toBeVisible();
      await expect(rowOf(page, "deepseek-v4-pro")).toBeVisible();
      // The models of the first fetch are the starting catalog, not news.
      await expect(
        page.getByRole("link", { name: /New models/ }),
      ).toContainText("0");
      await expect(page.getByText("Showing 1–3 of 3 models")).toBeVisible();
    });

    await test.step("a model that appears with the next fetch is new, and the count says so", async () => {
      await respondWith(await bodyOf({ newModel: true }));
      await fetchNow(page);
      await expect(
        page.getByRole("link", { name: /New models/ }),
      ).toContainText("1");
      await page.getByRole("link", { name: /New models/ }).click();
      await expect(page).toHaveURL(/state=new/);
      const row = rowOf(page, NEW_MODEL);
      await expect(row).toHaveCount(1);
      await expect(row.getByText("New", { exact: true })).toBeVisible();
      await expect(row.getByText("Unconfirmed")).toBeVisible();
    });

    await test.step("enabling a model does not make it usable until its price is confirmed", async () => {
      await page.goto("/admin/catalog?q=Mistral%20New");
      const row = rowOf(page, NEW_MODEL);
      await row.getByRole("button", { name: "Enable Mistral New 1" }).click();
      await expect(row.getByText("Enabled", { exact: true })).toBeVisible();
      await expect(
        row.getByText(
          "Not usable on the managed key: The price is not confirmed.",
        ),
      ).toBeVisible();
    });

    await test.step("the admin confirms the price exactly as shown", async () => {
      const row = rowOf(page, NEW_MODEL);
      await row
        .getByRole("button", { name: "Review the price of Mistral New 1" })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Price of Mistral New 1",
      });
      await expect(
        dialog.getByRole("table", { name: "Price now" }),
      ).toContainText("$0.20");
      await dialog
        .getByRole("button", { name: "Confirm price as shown" })
        .click();
      await expect(dialog.getByText("Price confirmed.")).toBeVisible();
      await dialog
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .click();
      await expect(row.getByText("Confirmed", { exact: true })).toBeVisible();
      await expect(row.getByText("Usable on the managed key")).toBeVisible();
    });

    await test.step("a price that models.dev moves makes the confirmation stale and the model unusable", async () => {
      await respondWith(await bodyOf({ newModel: true, newModelInput: 0.25 }));
      await fetchNow(page);
      const row = rowOf(page, NEW_MODEL);
      await expect(row.getByText("Stale", { exact: true })).toBeVisible();
      await expect(row).toContainText("You confirmed:");
      await expect(row).toContainText("Input $0.20");
      await expect(row).toContainText("Input $0.25");
      await expect(
        row.getByText(
          "Not usable on the managed key: The price is not confirmed.",
        ),
      ).toBeVisible();
    });

    await test.step("the admin sees both prices and confirms the new one", async () => {
      const row = rowOf(page, NEW_MODEL);
      await row
        .getByRole("button", { name: "Review the price of Mistral New 1" })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Price of Mistral New 1",
      });
      await expect(
        dialog.getByRole("table", { name: "Price now" }),
      ).toContainText("$0.25");
      await expect(
        dialog.getByRole("table", { name: "Price confirmed before" }),
      ).toContainText("$0.20");
      await dialog
        .getByRole("button", { name: "Confirm price as shown" })
        .click();
      await expect(dialog.getByText("Price confirmed.")).toBeVisible();
      await dialog
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .click();
      await expect(row.getByText("Confirmed", { exact: true })).toBeVisible();
      await expect(row.getByText("Usable on the managed key")).toBeVisible();
    });

    await test.step("the admin corrects the price with a reason and the correction is the source", async () => {
      const row = rowOf(page, NEW_MODEL);
      await row
        .getByRole("button", { name: "Review the price of Mistral New 1" })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Price of Mistral New 1",
      });
      await dialog.getByRole("button", { name: "Correct price" }).click();
      const input = dialog.getByLabel("Input (USD per million tokens)", {
        exact: true,
      });
      await input.fill("0.3");
      // A correction without a reason is refused before anything is sent.
      await dialog
        .getByRole("button", { name: "Save corrected price" })
        .click();
      await expect(
        dialog.getByText(/Enter a reason of 1 to 500 characters/),
      ).toBeVisible();
      await dialog
        .getByLabel("Reason", { exact: true })
        .fill("Invoice of October.");
      await dialog
        .getByRole("button", { name: "Save corrected price" })
        .click();
      await expect(
        dialog.getByText("Price corrected and confirmed."),
      ).toBeVisible();
      const confirmed = dialog.getByRole("table", { name: "Confirmed price" });
      await expect(confirmed).toContainText("$0.30");
      await expect(confirmed).toContainText("Your correction");
      await dialog
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .click();
      await expect(row).toContainText("Input $0.30");
      await expect(row.getByText("Usable on the managed key")).toBeVisible();
    });

    await test.step("a provider whose address changed is blocked until the admin trusts the new one", async () => {
      await respondWith(
        await bodyOf({
          newModel: true,
          newModelInput: 0.25,
          deepseekApi: NEW_ADDRESS,
        }),
      );
      await fetchNow(page);
      const panel = page.getByRole("region", {
        name: "Provider addresses that need you",
      });
      const provider = panel.getByRole("listitem", {
        name: "Address of DeepSeek",
      });
      await expect(provider).toContainText(OLD_ADDRESS);
      await expect(provider).toContainText(NEW_ADDRESS);
      await page.goto("/admin/catalog?provider=deepseek");
      await expect(
        rowOf(page, "deepseek-v4-pro").getByText("Address blocked"),
      ).toBeVisible();

      await page
        .getByRole("button", { name: "Confirm the new address of DeepSeek" })
        .click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Trust the new address" })
        .click();
      await expect(page.getByText("The new address is trusted.")).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Provider addresses that need you" }),
      ).toHaveCount(0);
      await page.reload();
      await expect(
        rowOf(page, "deepseek-v4-pro").getByText("Address blocked"),
      ).toHaveCount(0);
    });
  });
});
