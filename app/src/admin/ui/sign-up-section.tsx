// SPDX-License-Identifier: Apache-2.0

// The body of Setup → Sign-up (#181): the notice of a sign-up rule that cannot work yet (one owner,
// `notices.tsx`, rendered through the shared `NeedsAttention`), and nothing above the form while the
// rule works. Split from the page so both cases are unit-tested.
import { NeedsAttention } from "../../components/needs-attention.tsx";
import type { AdminSettingsView } from "../service.ts";
import { failClosedAttention } from "./notices.tsx";
import { SignUpRuleForm } from "./sign-up-form.tsx";

export function SignUpSection({ settings }: { settings: AdminSettingsView }) {
  return (
    <>
      {settings.signUpRuleState.failClosed ? (
        <NeedsAttention notices={[failClosedAttention()]} />
      ) : null}
      <SignUpRuleForm settings={settings} />
    </>
  );
}
