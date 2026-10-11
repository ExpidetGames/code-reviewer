// Pins down what the synchronization does on an instance whose first-run setup has not run: it puts a
// connection that is new to the instance into no workspace (the setup decides whether there is one),
// reports that under a stable code with a sentence an operator can act on, and works as soon as the
// instance is set up. A webhook about a new installation then answers 503, so GitHub's "Redeliver"
// handles it later.
import { describe, expect, it } from "vitest";
import { createIntegrationDirectory } from "../../db/repositories/integration-directory-repository.ts";
import { fakeIntegrationProvider } from "../../test-support/fake-integration-provider.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { markInstanceSetUp } from "../../test-support/workspaces.ts";
import { createIntegrationRegistry } from "../registry.ts";
import { createIntegrationSync } from "./service.ts";

async function fixture() {
  const { db } = await createTestDatabase();
  const base = fakeIntegrationProvider();
  const provider = {
    ...base,
    async discoverConnections() {
      return [
        {
          externalId: "4242",
          displayName: "acme",
          config: { accountLogin: "acme", accountId: 5 },
          suspended: false,
        },
      ];
    },
    async findConnection(externalId: string) {
      return {
        externalId,
        displayName: "acme",
        config: { accountLogin: "acme", accountId: 5 },
        suspended: false,
      };
    },
  };
  const lines: string[] = [];
  const sync = createIntegrationSync({
    db,
    registry: createIntegrationRegistry({ github_app: provider }),
    log: (line) => lines.push(line),
  });
  return { db, sync, lines };
}

describe("synchronizing before the first-run setup", () => {
  // #97-NOT-SET-UP
  it("creates no workspace and no connection, and says that the setup has to be finished", async () => {
    const { db, sync, lines } = await fixture();

    const summary = await sync.syncAll();

    expect(summary.integrations.created).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({
      code: "WORKSPACE_NOT_AVAILABLE",
    });
    expect(summary.errors[0]?.message).toContain("first-run setup");
    expect(lines.join("\n")).toContain("WORKSPACE_NOT_AVAILABLE");
    expect(await db.selectFrom("workspaces").select("id").execute()).toEqual(
      [],
    );
    expect(await db.selectFrom("integrations").select("id").execute()).toEqual(
      [],
    );
  });

  // #97-NOT-SET-UP
  it("fails the handling of an installation delivery, so that the webhook answers 503 and the delivery can be redelivered", async () => {
    const { sync } = await fixture();

    const result = await sync.handleInstallationChange({
      type: "github_app",
      externalId: "4242",
      action: "created",
    });

    expect(result.outcome).toBe("failed");
    expect(result.summary.errors.map((error) => error.code)).toEqual([
      "WORKSPACE_NOT_AVAILABLE",
    ]);
  });

  // #97-NOT-SET-UP
  it("creates the connection in the default workspace once the instance is set up", async () => {
    const { db, sync } = await fixture();
    await sync.syncAll();
    const workspaceId = await markInstanceSetUp(db);

    const summary = await sync.syncAll();

    expect(summary.errors).toEqual([]);
    expect(summary.integrations.created).toBe(1);
    expect(
      (
        await createIntegrationDirectory(db).findByExternalId(
          "github_app",
          "4242",
        )
      )?.workspaceId,
    ).toBe(workspaceId);
  });
});
