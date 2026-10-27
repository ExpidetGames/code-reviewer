// SPDX-License-Identifier: LicenseRef-Proprietary

// The scheduled check of the journal (#626; go-live item of #510, epic #489). `verify()` of the journal repository compares, for one
// workspace, the cached balance and the cached reserved money with what the journal adds up to, and counts the holds of jobs that
// ended without a release (#591). Until now only tests called it. This runs it for every workspace that has a journal, once a day while
// billing is on, so a drift between the cache and the journal (or a stranded hold) is found by the instance and not by a customer.
//
// - Bounded cost. A run takes the workspaces in the order of their ids, `JOURNAL_CHECK_BATCH` at a time, and stops when its time budget
//   (`JOURNAL_CHECK_BUDGET_MS`) is used up; the position is stored after every batch (`run.after`), and the next run (the next minute
//   of the cron sweep, the next hour of a server's timer) continues from there. A pass over the whole instance therefore costs a few
//   seconds of a run at a time and never one long transaction. `verify()` reads one workspace in one statement.
// - Daily. A pass starts when the last one finished more than a day ago (`JOURNAL_CHECK_INTERVAL_MS`); in between a run reads the
//   stored state and nothing else. A pass that was left under way for more than three days (billing was off) is started again.
// - The result. A finished pass is recorded as `last` in the instance setting `billing_journal_check`: when, ok or inconsistent, how many
//   workspaces were checked and how many were not consistent. The admin billing page shows it (`readJournalCheck`). The result of the
//   last finished pass stays while the next one is under way.
// - The log. A workspace that is not consistent is one line with a stable code (`BILLING_JOURNAL_INCONSISTENT`), its id and which of the
//   three checks failed; no amount, no name, no address. A pass ends with one line (`BILLING_JOURNAL_CHECK_DONE`). A workspace that
//   shows a difference is looked at a second time before it counts: `verify()` reads in one snapshot, but a write that lands between
//   the cache and the journal of a busy workspace is not what this is for.
// - Billing off. `runJournalCheckWhileBillingOn` reads the switch and nothing else (no billing table, no write); the pass resumes
//   when billing is on again.
//
// Two runs at once (the cron sweep and a server's timer) are kept apart by a lock that is tried, not waited for (try-lock.ts).
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../db/codecs.ts";
import {
  createBillingJournalRepository,
  type JournalVerification,
} from "../db/repositories/billing-journal-repository.ts";
import { createBillingJournalDirectory } from "../db/repositories/billing-journal-directory-repository.ts";
import { createInstanceSettingsStore } from "../db/repositories/instance-settings-store.ts";
import type { Database } from "../db/schema.ts";
import { JOURNAL_CHECK_LOCK, tryWithLock } from "../db/try-lock.ts";
import type { JournalCheckView } from "../admin/ui/billing-view.ts";
import { isBillingOn } from "./enabled.ts";

/** Stable codes of the log lines of this module. */
export const JOURNAL_INCONSISTENT_LOG_CODE = "BILLING_JOURNAL_INCONSISTENT";
export const JOURNAL_CHECK_DONE_LOG_CODE = "BILLING_JOURNAL_CHECK_DONE";

/** How long after a finished pass the next one starts. */
export const JOURNAL_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A pass under way for longer than this is started again: its first part is too old to say anything about the whole. */
export const JOURNAL_CHECK_RUN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** How many workspaces one step reads. */
export const JOURNAL_CHECK_BATCH = 100;
/** How long one run goes on with further steps: a run of the cron sweep has minutes, the other steps of it a few seconds. */
export const JOURNAL_CHECK_BUDGET_MS = 20_000;

export type JournalCheckResult = "ok" | "inconsistent";

/** The stored state (instance setting `billing_journal_check`). */
export type StoredJournalCheck = {
  /** The last pass that was finished. */
  last?: {
    /** When it finished (ISO 8601 UTC). */
    at: string;
    result: JournalCheckResult;
    workspaces: number;
    inconsistent: number;
  };
  /** The pass under way: when it started, the last workspace id it checked and the counts so far. */
  run?: {
    startedAt: string;
    after: string;
    checked: number;
    inconsistent: number;
  };
};

export type JournalCheckRun = {
  /** Why nothing was checked: billing is off, another run holds the lock, or the last pass is less than a day old. */
  skipped: "off" | "locked" | "not_due" | null;
  /** How many workspaces this run checked. */
  checked: number;
  /** The pass over every workspace ended in this run. */
  finished: boolean;
};

export type JournalCheckOptions = {
  now?: () => Date;
  log?: Pick<Console, "info" | "error">;
  /** Workspaces per step. */
  batch?: number;
  /** Time after which the run takes no further step. */
  budgetMs?: number;
  /** `verify()` of a workspace; the journal repository's unless a test stands in. */
  verify?: (workspaceId: string) => Promise<JournalVerification>;
};

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  ISO_TIMESTAMP.test(value) &&
  !Number.isNaN(Date.parse(value));

/** The stored value as a state; a part that is not of the shape reads as not there. */
function readState(stored: unknown): StoredJournalCheck {
  if (!isRecord(stored)) return {};
  const state: StoredJournalCheck = {};
  const { last, run } = stored;
  if (
    isRecord(last) &&
    isTimestamp(last.at) &&
    (last.result === "ok" || last.result === "inconsistent") &&
    isCount(last.workspaces) &&
    isCount(last.inconsistent)
  )
    state.last = {
      at: last.at,
      result: last.result,
      workspaces: last.workspaces,
      inconsistent: last.inconsistent,
    };
  if (
    isRecord(run) &&
    isTimestamp(run.startedAt) &&
    typeof run.after === "string" &&
    isCount(run.checked) &&
    isCount(run.inconsistent)
  )
    state.run = {
      startedAt: run.startedAt,
      after: run.after,
      checked: run.checked,
      inconsistent: run.inconsistent,
    };
  return state;
}

/** The instance setting that holds the state (`instance_settings`, key `billing_journal_check`). */
type JournalCheckValues = { billing_journal_check: StoredJournalCheck };

async function readStored(db: Kysely<Database>): Promise<StoredJournalCheck> {
  try {
    return readState(
      await createInstanceSettingsStore<JournalCheckValues>(db).get(
        "billing_journal_check",
      ),
    );
  } catch (error) {
    // Text that is no JSON is damaged data like any other: no check made. A lost connection is not, and goes on.
    if (error instanceof Error && error.cause instanceof SyntaxError) return {};
    throw error;
  }
}

/** The result of the last finished pass, for the admin billing page. Reads one instance setting. */
export async function readJournalCheck(
  db: Kysely<Database>,
): Promise<JournalCheckView> {
  const { last } = await readStored(db);
  if (last === undefined)
    return {
      state: "never",
      checkedAt: null,
      workspaces: 0,
      inconsistentWorkspaces: 0,
    };
  return {
    state: last.result,
    checkedAt: last.at,
    workspaces: last.workspaces,
    inconsistentWorkspaces: last.inconsistent,
  };
}

/** Which of the three checks of `verify()` failed, as the numbers of the log line (0 or 1, and a count of holds). */
function inconsistencyLine(
  workspaceId: string,
  verification: JournalVerification,
): string {
  const flag = (difference: number) => (difference === 0 ? 0 : 1);
  return `[billing] ${JOURNAL_INCONSISTENT_LOG_CODE} workspace=${workspaceId} balance_drift=${String(flag(verification.differenceMicroUsd))} reserved_drift=${String(flag(verification.reservedDifferenceMicroUsd))} stranded_holds=${String(verification.strandedHoldCount)}`;
}

/** At most this many inconsistent workspaces are named in the log of one step; the count of the pass has them all. */
const LOGGED_PER_STEP = 20;

/**
 * Checks the next workspaces of the pass that is due or under way, within the budget. Does not ask whether billing is on
 * (`runJournalCheckWhileBillingOn` does).
 */
export async function runJournalCheck(
  db: Kysely<Database>,
  options: JournalCheckOptions = {},
): Promise<JournalCheckRun> {
  const now = options.now ?? (() => new Date());
  // Most runs find nothing due: they read the stored state and stop, without the lock (which holds a connection of its own).
  if (!isDue(await readStored(db), now().getTime()))
    return { skipped: "not_due", checked: 0, finished: false };
  const locked = await tryWithLock(db, JOURNAL_CHECK_LOCK, () =>
    runLocked(db, options),
  );
  return locked.acquired
    ? locked.value
    : { skipped: "locked", checked: 0, finished: false };
}

/** A pass is under way (and not too old to continue), or the last one finished more than a day ago, or none ever did. */
function isDue(state: StoredJournalCheck, nowMs: number): boolean {
  if (state.run !== undefined && !isTooOld(state.run.startedAt, nowMs))
    return true;
  if (state.last === undefined) return true;
  return nowMs - Date.parse(state.last.at) >= JOURNAL_CHECK_INTERVAL_MS;
}

const isTooOld = (startedAt: string, nowMs: number) =>
  nowMs - Date.parse(startedAt) > JOURNAL_CHECK_RUN_MAX_AGE_MS;

async function runLocked(
  db: Kysely<Database>,
  {
    now = () => new Date(),
    log = console,
    batch = JOURNAL_CHECK_BATCH,
    budgetMs = JOURNAL_CHECK_BUDGET_MS,
    verify = (workspaceId) =>
      createBillingJournalRepository(db, workspaceId, now).verify(),
  }: JournalCheckOptions,
): Promise<JournalCheckRun> {
  const settings = createInstanceSettingsStore<JournalCheckValues>(db, now);
  const directory = createBillingJournalDirectory(db);
  const state = await readStored(db);
  const started = now().getTime();

  // The state is read again under the lock: another run may have finished the pass since the first look.
  if (!isDue(state, started))
    return { skipped: "not_due", checked: 0, finished: false };
  let run =
    state.run !== undefined && !isTooOld(state.run.startedAt, started)
      ? state.run
      : undefined;
  if (run === undefined) {
    run = {
      startedAt: formatTimestamp(new Date(started)),
      after: "",
      checked: 0,
      inconsistent: 0,
    };
  }

  let checked = 0;
  for (;;) {
    const ids = await directory.workspaceIdsAfter(run.after, batch);
    let logged = 0;
    for (const workspaceId of ids) {
      let verification = await verify(workspaceId);
      // A second look at one that shows a difference.
      if (!verification.consistent) verification = await verify(workspaceId);
      if (!verification.consistent) {
        run.inconsistent += 1;
        if (logged < LOGGED_PER_STEP) {
          log.error(inconsistencyLine(workspaceId, verification));
          logged += 1;
        }
      }
    }
    checked += ids.length;
    run.checked += ids.length;
    const lastId = ids.at(-1);
    if (lastId !== undefined) run.after = lastId;

    if (ids.length < batch) {
      const result: JournalCheckResult =
        run.inconsistent === 0 ? "ok" : "inconsistent";
      await settings.set(
        "billing_journal_check",
        {
          last: {
            at: formatTimestamp(now()),
            result,
            workspaces: run.checked,
            inconsistent: run.inconsistent,
          },
        },
        null,
      );
      log.info(
        `[billing] ${JOURNAL_CHECK_DONE_LOG_CODE} result=${result} workspaces=${String(run.checked)} inconsistent=${String(run.inconsistent)}`,
      );
      return { skipped: null, checked, finished: true };
    }

    // The position is kept after every step: a run that is stopped (the budget, a crash) loses nothing it has done.
    await settings.set(
      "billing_journal_check",
      { ...(state.last === undefined ? {} : { last: state.last }), run },
      null,
    );
    if (now().getTime() - started >= budgetMs)
      return { skipped: null, checked, finished: false };
  }
}

/** The step of the sweep and of the timer: the same while billing is on, and nothing but the switch is read while it is off. */
export async function runJournalCheckWhileBillingOn(
  db: Kysely<Database>,
  options: JournalCheckOptions = {},
): Promise<JournalCheckRun> {
  if (!(await isBillingOn(db)))
    return { skipped: "off", checked: 0, finished: false };
  return runJournalCheck(db, options);
}
