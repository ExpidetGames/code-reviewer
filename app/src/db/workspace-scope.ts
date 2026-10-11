// SPDX-License-Identifier: Apache-2.0

// The one vocabulary of workspace scoping (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.7). A repository that reads or writes customer data is created for ONE workspace:
// its factory takes `workspaceId` as a required parameter and every query it runs filters or sets
// `workspace_id`. A row of another workspace is simply not there for it: fetching, changing or
// deleting it by id behaves exactly like a missing id.
//
// What is not scoped (and why) is listed in `repositories/scoping.test.ts`, which fails when a
// repository is neither scoped nor on that list, and when an exported function of a scoped one has no
// `workspaceId` parameter.
export type WorkspaceId = string;
