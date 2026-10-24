// SPDX-License-Identifier: LicenseRef-Proprietary

// The limit on the workspaces one user may own (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.3, "Instance limits"). The admin sets it on the Limits page; nothing saved means the default.
export const DEFAULT_MAX_WORKSPACES_PER_USER = 10;
export const MIN_WORKSPACES_PER_USER = 1;
export const MAX_WORKSPACES_PER_USER = 1000;
