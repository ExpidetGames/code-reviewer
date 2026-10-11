// Makes overlapping full syncs share one run. A full sync reads every installation and repository
// from GitHub; a person with two tabs, a double click on two pages or the start-up sync meeting the
// button would otherwise start one run each. The second caller gets the run that is already going
// (and its summary), and a call after it has finished starts a new one. The keyed lock still
// serializes the work per installation; this only saves the duplicate reads.
import type { IntegrationSyncService } from "./service.ts";

export function coalesceSyncAll(
  service: IntegrationSyncService,
): IntegrationSyncService {
  let running: ReturnType<IntegrationSyncService["syncAll"]> | undefined;
  return {
    ...service,
    syncAll() {
      if (running !== undefined) return running;
      const run = service.syncAll();
      running = run;
      const done = () => {
        if (running === run) running = undefined;
      };
      // Whatever the outcome, the next call starts fresh; the caller still sees the rejection.
      run.then(done, done);
      return run;
    },
  };
}
