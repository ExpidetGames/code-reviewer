// SPDX-License-Identifier: LicenseRef-Proprietary

// The billing helpers of the running server in a deployment without the `billing` capability (#731): none of them opens the
// database, builds a billing service or schedules work.
import { afterEach, describe, expect, it, vi } from "vitest";

const getDatabase = vi.hoisted(() => vi.fn());
const runAfterResponse = vi.hoisted(() => vi.fn());
vi.mock("../db/startup.ts", () => ({ getDatabase }));
vi.mock("../dispatch/shared.ts", () => ({ runAfterResponse }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));

const billing = await import("./shared.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  getDatabase.mockClear();
  runAfterResponse.mockClear();
});

describe("the billing helpers without the billing capability", () => {
  // #731-T03
  it("count, read, link and bring nothing, and never open the database or schedule work", async () => {
    vi.stubEnv("PRODUCT_CAPABILITIES", "review,dynamic-review");

    expect(await billing.countOpenBillingReviews()).toBe(0);
    expect(await billing.readIncompleteBilling()).toEqual([]);
    expect(await billing.billingPageLinkedFor()).toBe(false);
    expect(
      await billing.balanceBannerFor({ id: "w", slug: "acme" }, "owner"),
    ).toBeNull();
    expect(await billing.deliverDueBalanceMailsNow()).toEqual({
      delivered: 0,
      failed: 0,
    });
    billing.deliverBalanceMails();
    billing.recordWallClocks(["job-1"]);

    expect(getDatabase).not.toHaveBeenCalled();
    expect(runAfterResponse).not.toHaveBeenCalled();
  });

  // #731-T01
  it("still ask the database where the capability exists, as before", async () => {
    getDatabase.mockImplementation(() => {
      throw new Error("asked");
    });

    expect(await billing.countOpenBillingReviews()).toBe(0);
    billing.recordWallClocks(["job-1"]);

    expect(getDatabase).toHaveBeenCalled();
  });
});
