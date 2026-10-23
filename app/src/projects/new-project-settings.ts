// SPDX-License-Identifier: Apache-2.0

// What a project starts with (#656): Dynamic Review, the review kind new projects default to. Only where the instance has
// turned Dynamic Review on (the #195 gate): with it off a Dynamic project's reviews fail, so the project starts with no
// kind and keeps the built-in one (Diff Review). Only a row that is being created is given these; a project that exists
// keeps what it has, so switching the default never changes the reviews of a project that was set up before.
import type { NewProjectSettings } from "../db/repositories/projects-repository.ts";
import type { ProjectSettings } from "../db/repositories/projects-repository.ts";
import { isDynamicReviewEnabled } from "../jobs/dynamic-review-gate.ts";

export const newProjectSettings: NewProjectSettings = async (executor) => {
  const settings: ProjectSettings = {};
  if (await isDynamicReviewEnabled(executor)) settings.reviewKind = "dynamic";
  return settings;
};
