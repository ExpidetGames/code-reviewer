"use client";
// Keeps a page's data fresh without a reload: the server renders the first snapshot, the browser asks
// for newer ones while something can still change. Three rules make it safe with Cache Components,
// which keeps a page that was left mounted (hidden) instead of dropping it:
//
// - The snapshot the server rendered is the truth; a snapshot fetched later is shown only while the
//   server's one is the same object it was fetched next to. When the page is rendered again with new
//   data (a filter, `router.refresh()`), the new server data wins and the fetched one is dropped.
// - Polling lives in an effect, and a hidden page runs the cleanup: it stops while the page is not
//   shown and starts again (with one request at once) when it is shown.
// - A failed request keeps the last data on screen and only sets `failed`; the next attempt runs on
//   the normal schedule.
import { useEffect, useRef, useState } from "react";
import type { RequestResult } from "./json-request.ts";

export type LiveSnapshotOptions<T> = {
  /** What the server rendered. A new object means new server data. */
  initial: T;
  fetchLatest: () => Promise<RequestResult<T>>;
  /** True when nothing is going to change any more (no run waiting or running). */
  isSettled: (data: T) => boolean;
  /** The wait between requests while something can still change. */
  activeIntervalMs: number;
  /** The wait between requests once everything is settled; null stops polling then. */
  idleIntervalMs: number | null;
};

export type LiveSnapshot<T> = {
  data: T;
  /** The last request failed; the data on screen is the one before it. */
  failed: boolean;
};

export function useLiveSnapshot<T>(
  options: LiveSnapshotOptions<T>,
): LiveSnapshot<T> {
  const { initial, fetchLatest, isSettled, activeIntervalMs, idleIntervalMs } =
    options;
  const [live, setLive] = useState<{ from: T; data: T } | null>(null);
  const [failed, setFailed] = useState(false);
  const data = live !== null && live.from === initial ? live.data : initial;

  // The effect reads the newest data and callbacks without being restarted by every change.
  const dataRef = useRef(data);
  const callbacks = useRef({ fetchLatest, isSettled });
  useEffect(() => {
    dataRef.current = data;
    callbacks.current = { fetchLatest, isSettled };
  });

  // True once polling has started at least once: a later start is a page that is shown again or one
  // with new server data, and it asks at once instead of waiting a whole interval.
  const startedBefore = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    function delayNow(): number | null {
      return callbacks.current.isSettled(dataRef.current)
        ? idleIntervalMs
        : activeIntervalMs;
    }

    function schedule() {
      if (stopped) return;
      clearTimeout(timer);
      const delay = delayNow();
      if (delay === null) return;
      timer = setTimeout(() => void poll(), delay);
    }

    async function poll() {
      // A page nobody looks at (another tab) does not ask; it asks as soon as it is shown again.
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return;
      }
      if (inFlight) return;
      inFlight = true;
      const result = await callbacks.current.fetchLatest();
      inFlight = false;
      if (stopped) return;
      if (result.ok) {
        dataRef.current = result.data;
        setLive({ from: initial, data: result.data });
        setFailed(false);
      } else {
        setFailed(true);
      }
      schedule();
    }

    function onVisible() {
      if (document.hidden || stopped) return;
      if (delayNow() === null) return;
      clearTimeout(timer);
      void poll();
    }

    if (startedBefore.current && delayNow() !== null) void poll();
    else schedule();
    startedBefore.current = true;
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [initial, activeIntervalMs, idleIntervalMs]);

  return { data, failed };
}
