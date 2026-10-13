// SPDX-License-Identifier: Apache-2.0

// The copy of the tenancy question, shared by the first-run wizard and the admin Setup → Instance
// page (#181). Both asked the same question with different words; the words live here once, like the
// sign-up rule copy next door (#169). The extra line a surface adds (for example the number of
// workspaces the portal knows) is not part of the shared strings.

export type TenancyKind = "single" | "multi";

/** The two answers, in the order they are offered, with the sentence under each title. */
export const TENANCY_OPTIONS: ReadonlyArray<{
  value: TenancyKind;
  title: string;
  text: string;
}> = [
  {
    value: "single",
    title: "Single-tenant",
    text: "One team. The instance has one workspace, and you are its owner; it can only stay single-tenant while the instance has at most one.",
  },
  {
    value: "multi",
    title: "Multi-tenant",
    text: "Several unrelated teams. Everyone who can sign up creates a workspace of their own; the workspaces and members that exist stay as they are.",
  },
];
