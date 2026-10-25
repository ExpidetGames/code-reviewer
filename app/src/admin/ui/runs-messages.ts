// SPDX-License-Identifier: LicenseRef-Proprietary

// What the job view of the admin portal says (#541): the headings of the list and of one run, and the notes
// for an empty list, a cut list and a run without a call trace. The table of the calls has its own copy
// (`runs/ui/call-trace-messages.ts`), shared with the Runs page of a workspace.

export const ADMIN_RUNS_COPY = {
  breadcrumbRoot: "Admin",
  listTitle: "Runs",
  listDescription:
    "The newest runs of every workspace. Open one to see what it consumed and what each call was.",
  empty: "No run has been made yet.",
  limited: "Only the newest runs are listed.",
  columns: {
    workspace: "Workspace",
    project: "Project",
    kind: "Kind",
    status: "Status",
    created: "Created",
    duration: "Duration",
    error: "Error code",
  },
  detailDescription: "What this run consumed and what each of its calls was.",
  summaryTitle: "Summary",
  noTrace:
    "This run has no call trace: it ran on a runner that does not record one, or it made no model call.",
} as const;
