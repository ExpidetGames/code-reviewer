// SPDX-License-Identifier: Apache-2.0

// Pins down the redirects of the split setup (#181): the old `/admin/setup` and `/admin/limits`
// addresses keep working and lead to the instance section. The pages are what the proxy's rewrite
// serves (src/admin/paths.ts); the request asks for `/admin/...`, the page answers with the redirect.
// An instance admin is mocked here so the guard does not turn the redirect into the 404 first; the
// guard itself is proven in session.test.ts and guard.integration.test.ts.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/admin/session", () => ({
  requireAdmin: () =>
    Promise.resolve({ id: "admin", isInstanceAdmin: true } as never),
}));

async function redirectTarget(file: string): Promise<string | undefined> {
  const page = (await import(/* @vite-ignore */ file)) as {
    default: () => Promise<unknown>;
  };
  const error = await page.default().then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return (error as { digest?: string } | null)?.digest;
}

describe("the old setup addresses", () => {
  // #181-T01
  it("send /admin/setup to the instance section", async () => {
    expect(
      await redirectTarget("../app/(app)/instance-portal/setup/page.tsx"),
    ).toMatch(/^NEXT_REDIRECT;[a-z]+;\/admin\/setup\/instance;/);
  });

  // #181-T03
  it("send /admin/limits to the instance section", async () => {
    expect(
      await redirectTarget("../app/(app)/instance-portal/limits/page.tsx"),
    ).toMatch(/^NEXT_REDIRECT;[a-z]+;\/admin\/setup\/instance;/);
  });
});
