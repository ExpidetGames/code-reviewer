// SPDX-License-Identifier: LicenseRef-Proprietary

// The shapes of the instance settings that the first-run wizard, the sign-up rule and the repository of the whole
// instance (`instance-settings-repository.ts`) all state (#715, cut 2). A leaf without imports: the wizard
// input (src/setup/input.ts) needs them and is itself imported by the settings of other domains.

/** `single`: one workspace for the whole instance. `multi`: users create workspaces. */
export type Tenancy = "single" | "multi";

/** Who may sign up. The entries are lower case. */
export type SignUpRule =
  | { kind: "everyone" }
  | { kind: "emails"; entries: string[] }
  | { kind: "domains"; entries: string[] };
