// SPDX-License-Identifier: Apache-2.0

// Names shared by the snapshot pipeline and the snapshot steps of the deployment (#403). A module of its own with no
// import, so that the step that writes to Infisical (ops-cli.ts) does not load the pipeline and its dependencies.

/** The name prefix of the builder VMs of the golden snapshot pipeline: how a cleanup finds them. */
export const BUILDER_PREFIX = "code-reviewer-golden-builder-";
