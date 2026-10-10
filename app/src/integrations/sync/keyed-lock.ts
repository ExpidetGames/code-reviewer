// Runs jobs one after the other per key, in the order they were asked for. Two syncs of the same
// installation (a start-up sync and a webhook, say) must not interleave: each reads GitHub's current
// list inside the lock, so the one that runs last also saw the newest list.

export type KeyedLock = {
  run<T>(key: string, job: () => Promise<T>): Promise<T>;
};

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(key, job) {
      const previous = tails.get(key) ?? Promise.resolve();
      // A failed job must not block the next one.
      const result = previous.then(job, job);
      const tail = result.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}
