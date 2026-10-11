// The wiring of the running server: the real database and the hooks other modules plug in. The one
// place that decides what happens when a project is deactivated: the job queue cancels the waiting
// jobs of the repository.
import "server-only";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createJobProjectHooks } from "../jobs/project-hooks.ts";
import type { ProjectHooks } from "./hooks.ts";
import { createProjectService, type ProjectService } from "./service.ts";

/** What other modules do when a project is switched off: the job queue cancels its waiting jobs. */
export function getProjectHooks(): ProjectHooks {
  return createJobProjectHooks();
}

/** The project service for the current request. */
export function getProjectService(): ProjectService {
  return createProjectService({
    projects: createProjectsRepository(getDatabase()),
    hooks: getProjectHooks(),
  });
}
