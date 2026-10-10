// @vitest-environment jsdom
// Pins down the polling rules: the shown data follows the answers, polling stops when nothing can
// change any more, a failed request keeps the last data and the next one runs on time, and new server
// data wins over what was fetched before.
import { act, cleanup, render } from "@testing-library/react";
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "./json-request.ts";
import { useLiveSnapshot } from "./use-live-snapshot.ts";

type Snapshot = { state: "waiting" | "running" | "done"; n: number };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ok = (data: Snapshot): RequestResult<Snapshot> => ({ ok: true, data });
const broken: RequestResult<Snapshot> = {
  ok: false,
  status: 500,
  code: "UNEXPECTED_RESPONSE",
  issues: [],
};

const refused = (code: string): RequestResult<Snapshot> => ({
  ok: false,
  status: 401,
  code,
  issues: [],
});

function Probe({
  initial,
  fetchLatest,
  idleIntervalMs = null,
}: {
  initial: Snapshot;
  fetchLatest: () => Promise<RequestResult<Snapshot>>;
  idleIntervalMs?: number | null;
}) {
  const { data, failed, failureCode, stopped } = useLiveSnapshot({
    initial,
    fetchLatest,
    isSettled: (value) => value.state === "done",
    activeIntervalMs: 3000,
    idleIntervalMs,
  });
  return (
    <p>
      {data.state}:{data.n}
      {failed ? " (update failed)" : ""}
      {stopped ? ` (stopped: ${failureCode})` : ""}
    </p>
  );
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("polling for fresh data", () => {
  // CR-35-T11
  it("moves from waiting to running to done without a reload and then stops asking", async () => {
    const answers = [
      ok({ state: "running", n: 1 }),
      ok({ state: "done", n: 2 }),
    ];
    const fetchLatest = vi.fn(async () => answers.shift() ?? broken);
    const { container } = render(
      <Probe initial={{ state: "waiting", n: 0 }} fetchLatest={fetchLatest} />,
    );
    expect(container.textContent).toBe("waiting:0");
    expect(fetchLatest).not.toHaveBeenCalled();

    await pass(3000);
    expect(container.textContent).toBe("running:1");

    await pass(3000);
    expect(container.textContent).toBe("done:2");
    expect(fetchLatest).toHaveBeenCalledTimes(2);

    await pass(60_000);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("keeps asking at the idle interval when it was given one, so new runs show up", async () => {
    const fetchLatest = vi.fn(async () => ok({ state: "done", n: 5 }));
    const { container } = render(
      <Probe
        initial={{ state: "done", n: 0 }}
        fetchLatest={fetchLatest}
        idleIntervalMs={10_000}
      />,
    );

    await pass(9_999);
    expect(fetchLatest).not.toHaveBeenCalled();
    await pass(1);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("done:5");
    await pass(10_000);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  // CR-35-T12
  it("keeps the last data on a failed request, says so, and tries again on time", async () => {
    const answers = [
      ok({ state: "running", n: 1 }),
      broken,
      ok({ state: "done", n: 3 }),
    ];
    const fetchLatest = vi.fn(async () => answers.shift() ?? broken);
    const { container } = render(
      <Probe initial={{ state: "waiting", n: 0 }} fetchLatest={fetchLatest} />,
    );

    await pass(3000);
    expect(container.textContent).toBe("running:1");

    await pass(3000);
    expect(container.textContent).toBe("running:1 (update failed)");

    await pass(3000);
    expect(container.textContent).toBe("done:3");
    expect(fetchLatest).toHaveBeenCalledTimes(3);
  });

  it("shows the notice from the first failed request on", async () => {
    const fetchLatest = vi.fn(
      async (): Promise<RequestResult<Snapshot>> => broken,
    );
    const { container } = render(
      <Probe initial={{ state: "running", n: 0 }} fetchLatest={fetchLatest} />,
    );

    await pass(3000);

    expect(container.textContent).toBe("running:0 (update failed)");
  });

  it("prefers new server data over what it fetched before", async () => {
    const fetchLatest = vi.fn(async () => ok({ state: "running", n: 1 }));
    const first = { state: "waiting", n: 0 } as const;
    const { container, rerender } = render(
      <Probe initial={first} fetchLatest={fetchLatest} />,
    );
    await pass(3000);
    expect(container.textContent).toBe("running:1");

    rerender(
      <Probe initial={{ state: "done", n: 9 }} fetchLatest={fetchLatest} />,
    );

    expect(container.textContent).toBe("done:9");
    const calls = fetchLatest.mock.calls.length;
    await pass(60_000);
    expect(fetchLatest).toHaveBeenCalledTimes(calls);
  });

  it("stops asking when the page is hidden and asks at once when it is shown again", async () => {
    const fetchLatest = vi.fn(async () => ok({ state: "running", n: 1 }));
    const { container, unmount } = render(
      <Probe initial={{ state: "running", n: 0 }} fetchLatest={fetchLatest} />,
    );
    const hidden = vi.spyOn(document, "hidden", "get");

    hidden.mockReturnValue(true);
    await pass(9000);
    expect(fetchLatest).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("running:1");

    unmount();
    await pass(60_000);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("stops while Next.js keeps the page mounted but hidden and asks at once when it is shown again", async () => {
    const fetchLatest = vi.fn(async () => ok({ state: "running", n: 1 }));
    const page = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <Probe initial={{ state: "running", n: 0 }} fetchLatest={fetchLatest} />
      </Activity>
    );
    const { container, rerender } = render(page("visible"));
    await pass(3000);
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    rerender(page("hidden"));
    await pass(30_000);
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    rerender(page("visible"));
    await pass(0);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("running:1");
  });

  it("stops for good when the failure cannot get better by asking again", async () => {
    for (const code of ["UNAUTHENTICATED", "ACCESS_DENIED", "RUN_NOT_FOUND"]) {
      const fetchLatest = vi.fn(async () => refused(code));
      const { container, unmount } = render(
        <Probe
          initial={{ state: "running", n: 0 }}
          fetchLatest={fetchLatest}
        />,
      );

      await pass(3000);
      expect(container.textContent).toContain(`(stopped: ${code})`);
      await pass(600_000);

      expect(fetchLatest).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("waits twice as long after each further failure in a row, up to a minute, and starts over after an answer", async () => {
    const answers = [broken, broken, broken, ok({ state: "running", n: 4 })];
    const fetchLatest = vi.fn(async () => answers.shift() ?? broken);
    render(
      <Probe initial={{ state: "running", n: 0 }} fetchLatest={fetchLatest} />,
    );

    await pass(3000); // first failure: the next try is on schedule
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await pass(2999);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await pass(1); // 3000 later
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    await pass(5999); // second failure: twice as long
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    await pass(1);
    expect(fetchLatest).toHaveBeenCalledTimes(3);
    await pass(11_999); // third failure: four times
    expect(fetchLatest).toHaveBeenCalledTimes(3);
    await pass(1);
    expect(fetchLatest).toHaveBeenCalledTimes(4);

    // An answer ends the backoff.
    await pass(3000);
    expect(fetchLatest).toHaveBeenCalledTimes(5);

    answers.push(broken, broken, broken, broken, broken, broken);
    for (let i = 0; i < 6; i += 1) await pass(60_000);
    const calls = fetchLatest.mock.calls.length;
    await pass(60_000);
    expect(fetchLatest.mock.calls.length - calls).toBe(1);
  });

  it("drops the failure when the server renders new data", async () => {
    const fetchLatest = vi.fn(async () => refused("UNAUTHENTICATED"));
    const { container, rerender } = render(
      <Probe initial={{ state: "running", n: 0 }} fetchLatest={fetchLatest} />,
    );
    await pass(3000);
    expect(container.textContent).toContain("stopped");

    rerender(
      <Probe initial={{ state: "done", n: 1 }} fetchLatest={fetchLatest} />,
    );

    expect(container.textContent).toBe("done:1");
  });
});
