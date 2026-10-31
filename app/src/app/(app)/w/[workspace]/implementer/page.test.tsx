// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// The page of the Implementer form (#756): outside the capability `implementer` it is the platform's 404 before the session or the
// workspace is looked at (the second wall behind the access proxy, #756-T09), and in the factory it hands the form the workspace of
// the address and the operator's maximum, and nothing else.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
  requireWorkspace: vi.fn(async () => ({
    workspace: { id: "workspace-1", slug: "acme" },
    role: "member",
    user: { isInstanceAdmin: false },
  })),
}));
vi.mock("@/workspaces/access-runtime", () => ({
  requireWorkspace: access.requireWorkspace,
}));
vi.mock("@/db/startup", () => ({ getDatabase: () => ({}) }));
vi.mock("@/review-settings/operator-cost-limit-source", () => ({
  operatorCostLimitCentsFrom: () => async () => 750,
}));

import ImplementerPage from "./page.tsx";

afterEach(() => {
  vi.unstubAllEnvs();
  access.requireWorkspace.mockClear();
});

const params = () => ({
  params: Promise.resolve({ workspace: "acme" }),
  searchParams: Promise.resolve({}),
});
const FACTORY_WITH_IMPLEMENTER = {
  PRODUCT_ID: "factory",
  PRODUCT_CAPABILITIES: "review,dynamic-review,implementer",
};

function stub(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

/** The elements below a node, depth first. */
function elementsOf(node: ReactNode): ReactElement[] {
  if (!isValidElement(node))
    return Array.isArray(node) ? node.flatMap(elementsOf) : [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elementsOf(props.children)];
}

describe("the Implementer page", () => {
  // #756-T09
  it.each([
    ["code-review.com", { PRODUCT_ID: "code-review-com" }],
    [
      "the factory without the capability",
      { PRODUCT_ID: "factory", PRODUCT_CAPABILITIES: "review,dynamic-review" },
    ],
  ])(
    "is the platform's 404 in %s, before the workspace is looked at",
    async (_name, env) => {
      stub(env);

      await expect(ImplementerPage(params())).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
      expect(access.requireWorkspace).not.toHaveBeenCalled();
    },
  );

  // #756-T09
  it("renders the form of the workspace in the address, with the operator's maximum, in the factory with the capability", async () => {
    stub(FACTORY_WITH_IMPLEMENTER);

    const page = await ImplementerPage(params());
    const content = elementsOf(page).find(
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "ImplementerContent",
    );
    expect(content).toBeDefined();
    const form = await (
      content?.type as (props: unknown) => Promise<ReactElement>
    )(content?.props);
    expect(form.props).toEqual({
      workspaceSlug: "acme",
      operatorMaximumCents: 750,
    });
    expect(access.requireWorkspace).toHaveBeenCalledWith("acme");
  });
});
