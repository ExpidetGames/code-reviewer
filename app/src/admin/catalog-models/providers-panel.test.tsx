// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The providers whose address needs a decision (#554): the old and the new address side by side as text, a confirmation
// that names the address the admin saw and asks first, no confirmation for an address that was refused, nothing from
// models.dev as a link unless it is plain https, and a refusal as a sentence.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import { provider } from "../../test-support/catalog-models-fixtures.ts";
import type { CatalogModelsApi, ProviderChanged } from "./api.ts";
import { ProvidersPanel } from "./providers-panel.tsx";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

const MOVED = "https://api.deepseek.moved.example/v1";
const changed = provider({
  url: {
    state: "url_changed",
    trustedUrl: "https://api.deepseek.com",
    pendingUrl: MOVED,
    problem: null,
  },
  models: 4,
});

function fakeApi(answer?: RequestResult<ProviderChanged>) {
  const confirmUrl = vi.fn(() =>
    Promise.resolve(
      answer ?? {
        ok: true as const,
        data: { ok: true as const, provider: provider() },
      },
    ),
  );
  return { confirmUrl } as unknown as CatalogModelsApi & {
    confirmUrl: typeof confirmUrl;
  };
}

describe("a provider whose address changed", () => {
  // #554-T06
  it("shows the old and the new address next to each other, the state and how many models are blocked", () => {
    render(<ProvidersPanel providers={[changed]} api={fakeApi()} />);

    const item = within(
      screen.getByRole("listitem", { name: "Address of DeepSeek" }),
    );
    expect(item.getByText("Address changed")).toBeTruthy();
    expect(item.getByText("4 model(s) blocked")).toBeTruthy();
    expect(
      item.getByText("Trusted address").nextElementSibling?.textContent,
    ).toBe("https://api.deepseek.com");
    expect(item.getByText("New address").nextElementSibling?.textContent).toBe(
      MOVED,
    );
  });

  // #554-T06
  it("asks before it trusts the new address, names it, and sends exactly the address that was shown", async () => {
    const api = fakeApi();
    render(<ProvidersPanel providers={[changed]} api={api} />);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Confirm the new address of DeepSeek",
      }),
    );
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByText(MOVED)).toBeTruthy();
    expect(dialog.getByText(/keys of DeepSeek will be sent to/)).toBeTruthy();
    expect(api.confirmUrl).not.toHaveBeenCalled();
    await userEvent.click(
      dialog.getByRole("button", { name: "Trust the new address" }),
    );

    await waitFor(() =>
      expect(api.confirmUrl).toHaveBeenCalledWith({
        providerId: "deepseek",
        pendingUrl: MOVED,
      }),
    );
    expect(await screen.findByText("The new address is trusted.")).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #554-T06
  it("keeps the provider blocked when the admin does not confirm", async () => {
    const api = fakeApi();
    render(<ProvidersPanel providers={[changed]} api={api} />);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Confirm the new address of DeepSeek",
      }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Keep it blocked",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.confirmUrl).not.toHaveBeenCalled();
  });

  // #554-T04
  it("says the address changed again when the route refuses a confirmation of an address that is gone, and reloads", async () => {
    const api = fakeApi({
      ok: false,
      status: 409,
      code: "url_changed_again",
      issues: [],
    });
    render(<ProvidersPanel providers={[changed]} api={api} />);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Confirm the new address of DeepSeek",
      }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Trust the new address",
      }),
    );

    expect(
      await screen.findByText(
        /new address changed while you were looking at it/,
      ),
    ).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
    expect(screen.queryByText("The new address is trusted.")).toBeNull();
  });

  // #554-T04
  it("tells the person to try again when the daily fetch holds the catalog", async () => {
    const api = fakeApi({
      ok: false,
      status: 409,
      code: "fetch_in_progress",
      issues: [],
    });
    render(<ProvidersPanel providers={[changed]} api={api} />);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Confirm the new address of DeepSeek",
      }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Trust the new address",
      }),
    );

    expect(await screen.findByText(/Try again in a moment/)).toBeTruthy();
  });
});

describe("a provider whose address was refused", () => {
  const raw = "http://169.254.169.254/latest/<img src=x onerror=alert(1)>";
  const refusedProvider = provider({
    id: "evil",
    name: "Evil",
    url: {
      state: "url_changed",
      trustedUrl: "https://api.evil.example/v1",
      pendingUrl: raw,
      problem: "not_https",
    },
  });

  // #548 review round: a refused address has no confirm
  it("has no confirm button, says why in a sentence and shows the raw text escaped", () => {
    const { container } = render(
      <ProvidersPanel providers={[refusedProvider]} api={fakeApi()} />,
    );

    expect(
      screen.queryByRole("button", { name: /Confirm the new address/ }),
    ).toBeNull();
    expect(
      screen.getByText(/It does not use https\. It cannot be confirmed\./),
    ).toBeTruthy();
    expect(
      screen.getByText("Address models.dev states (refused)"),
    ).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector('a[href^="http:"]')).toBeNull();
  });

  // #548 review round: a refused address has no confirm
  it("has no confirm button for a provider that never had a trusted address", () => {
    const never = provider({
      id: "new",
      name: "Never",
      url: {
        state: "rejected",
        trustedUrl: null,
        pendingUrl: "https://x.example:8443/v1",
        problem: "port_not_allowed",
      },
    });
    render(<ProvidersPanel providers={[never]} api={fakeApi()} />);

    expect(screen.getByText("Address refused")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/It names a port other than 443/)).toBeTruthy();
  });
});

describe("an address that can be confirmed is shown whole", () => {
  // 23 + (63 × 3 + 2 dots) + 16 = 230 characters: a look-alike host that a cut at 200 would hide behind api.openai.com
  const LONG = `https://api.openai.com.${["a", "b", "c"].map((c) => c.repeat(63)).join(".")}.attacker.net/v1`;
  const lookAlike = provider({
    id: "openai",
    name: "OpenAI",
    url: {
      state: "url_changed",
      trustedUrl: "https://api.openai.com/v1",
      pendingUrl: LONG,
      problem: null,
    },
  });

  // #554-T06
  it("shows a 230 character address in full in the table and in the dialog, and confirms exactly that", async () => {
    expect(LONG).toHaveLength(230);
    const api = fakeApi();
    render(<ProvidersPanel providers={[lookAlike]} api={api} />);

    const item = within(
      screen.getByRole("listitem", { name: "Address of OpenAI" }),
    );
    const shown = item.getByText("New address").nextElementSibling;
    expect(shown?.textContent).toBe(LONG);
    expect(shown?.querySelector("code")?.className).toContain("break-all");

    await userEvent.click(
      screen.getByRole("button", { name: /Confirm the new address of OpenAI/ }),
    );
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByText(LONG).className).toContain("break-all");
    await userEvent.click(
      dialog.getByRole("button", { name: "Trust the new address" }),
    );
    await waitFor(() =>
      expect(api.confirmUrl).toHaveBeenCalledWith({
        providerId: "openai",
        pendingUrl: LONG,
      }),
    );
  });

  // #554-T06
  it("shows the longest address the check accepts in full too", () => {
    const longest = `https://${"a".repeat(60)}.example/${"p".repeat(2048 - 8 - 60 - 9)}`;
    expect(longest).toHaveLength(2048);
    render(
      <ProvidersPanel
        providers={[
          provider({
            ...lookAlike,
            url: { ...lookAlike.url, pendingUrl: longest },
          }),
        ]}
        api={fakeApi()}
      />,
    );

    expect(
      screen.getByText("New address").nextElementSibling?.textContent,
    ).toBe(longest);
  });

  // #554-T06
  it("makes a format or control character in a confirmable address visible instead of dropping it", async () => {
    const tricky = "https://api.example.com/v1/\u202Efoo\u200Bbar";
    const api = fakeApi();
    render(
      <ProvidersPanel
        providers={[
          provider({
            ...lookAlike,
            url: { ...lookAlike.url, pendingUrl: tricky },
          }),
        ]}
        api={api}
      />,
    );

    const shown = screen.getByText("New address").nextElementSibling;
    expect(shown?.textContent).toBe(
      "https://api.example.com/v1/\\u{202E}foo\\u{200B}bar",
    );
    expect(shown?.textContent).not.toMatch(/[\u202E\u200B]/u);
    await userEvent.click(
      screen.getByRole("button", { name: /Confirm the new address of OpenAI/ }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Trust the new address",
      }),
    );
    await waitFor(() =>
      expect(api.confirmUrl).toHaveBeenCalledWith({
        providerId: "openai",
        pendingUrl: tricky,
      }),
    );
  });

  // #554-T07
  it("shows a refused address without its format and control characters", () => {
    const refused = provider({
      url: {
        state: "rejected",
        trustedUrl: null,
        pendingUrl: "http://evil.example/\u202Epath\u200B\u0007\u2028x",
        problem: "not_https",
      },
    });
    const { container } = render(
      <ProvidersPanel providers={[refused]} api={fakeApi()} />,
    );

    const code = container.querySelector("dd code");
    expect(code?.textContent).toBe("http://evil.example/pathx");
    expect(container.textContent).not.toMatch(/[\u202E\u200B\u0007\u2028]/u);
  });
});

describe("links from models.dev", () => {
  // #554-T07
  it("links the trusted address when it is plain https, with no opener and no referrer", () => {
    render(<ProvidersPanel providers={[changed]} api={fakeApi()} />);

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://api.deepseek.com/");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  // #554-T07
  it("never makes a link of an address that is not https, whatever state the row is in", () => {
    const hostile = provider({
      url: {
        state: "url_changed",
        trustedUrl: "javascript:alert(document.cookie)",
        pendingUrl: "data:text/html,<script>alert(1)</script>",
        problem: "invalid_url",
      },
    });
    const { container } = render(
      <ProvidersPanel providers={[hostile]} api={fakeApi()} />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain(
      "javascript:alert(document.cookie)",
    );
  });

  // #554-T07
  it("cuts an absurdly long address where it is shown", () => {
    const long = provider({
      url: {
        state: "rejected",
        trustedUrl: null,
        pendingUrl: `https://${"a".repeat(3000)}.example/`,
        problem: "too_long",
      },
    });
    const { container } = render(
      <ProvidersPanel providers={[long]} api={fakeApi()} />,
    );

    const code = container.querySelector("dd code");
    expect(code?.textContent?.length).toBeLessThanOrEqual(200);
    expect(code?.textContent?.endsWith("…")).toBe(true);
  });

  // #554-T06
  it("renders nothing while every address is trusted", () => {
    const { container } = render(
      <ProvidersPanel providers={[]} api={fakeApi()} />,
    );

    expect(container.textContent).toBe("");
  });

  // #554-T06
  it("lists at most 50 providers and says how many more are blocked", () => {
    const many = Array.from({ length: 53 }, (_, i) =>
      provider({ ...changed, id: `p${String(i)}`, name: `P${String(i)}` }),
    );
    render(<ProvidersPanel providers={many} api={fakeApi()} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getByText("3 more providers are blocked.")).toBeTruthy();
  });
});
