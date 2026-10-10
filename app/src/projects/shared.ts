// The wiring of the running server: the real database and the hooks other modules plug in. The one
// place that decides what happens when a project is deactivated; the jobs ticket (CR-27) replaces
// `getProjectHooks` to discard waiting jobs, and nothing else changes.
import "server-only";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { noopProjectHooks, type ProjectHooks } from "./hooks.ts";
import { createProjectService, type ProjectService } from "./service.ts";

/** What other modules do when a project is switched off. Nothing until the jobs table exists (CR-27). */
export function getProjectHooks(): ProjectHooks {
  return noopProjectHooks;
}

/** The project service for the current request. */
export function getProjectService(): ProjectService {
  return createProjectService({
    projects: createProjectsRepository(getDatabase()),
    hooks: getProjectHooks(),
  });
}
