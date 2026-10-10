// Remembers, in memory only, which LLM key was handed to the runner with the claim of a job. The key
// can be rotated while a job runs, and the runner's log may then hold the old key: to mask it in the
// result the app needs the key of the claim as well as the current one. Nothing is stored in the
// database (a key is never persisted); a restart of the app forgets the keys, and masking falls back
// to the current key and to the shape of a credential (`redact.ts`).
//
// The list is capped, oldest first, so it cannot grow without bound. A key is not forgotten when its
// job completes: a repeated completion is compared on the stored form and must be masked the same way.

/** More claims than a single instance serves within the life of its jobs. */
const DEFAULT_LIMIT = 1000;

export type ClaimedKeys = {
  /** Remembers the key a runner got for `jobId` (a later claim of the same job replaces it). */
  remember(jobId: string, apiKey: string): void;
  /** The key handed out with the last claim of the job, as a list (empty if unknown). */
  keysOf(jobId: string): string[];
};

export function createClaimedKeys(limit: number = DEFAULT_LIMIT): ClaimedKeys {
  const keys = new Map<string, string>();
  return {
    remember(jobId, apiKey) {
      keys.delete(jobId);
      keys.set(jobId, apiKey);
      while (keys.size > limit) {
        const oldest = keys.keys().next();
        if (oldest.done === true) break;
        keys.delete(oldest.value);
      }
    },
    keysOf(jobId) {
      const key = keys.get(jobId);
      return key === undefined ? [] : [key];
    },
  };
}
