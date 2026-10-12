// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { isBindingResultCode } from "@/installation-binding/errors";
import { describeResultCode } from "@/installation-binding/ui/messages";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Connect GitHub" };

// Where a flow of "Connect GitHub" ends when no workspace the person administers can be named (a state that
// has expired, a person who is not an Owner or Admin any more): the reason in words, and the way back. The code
// in the query is one of our own list; anything else says nothing.
export default async function GithubResultPage({
  searchParams,
}: PageProps<"/github/result">) {
  const { github } = await searchParams;
  const result =
    typeof github === "string" && isBindingResultCode(github)
      ? describeResultCode(github)
      : null;
  return (
    <>
      <PageHeader title="Connect GitHub" />
      <p
        role={result?.tone === "error" ? "alert" : "status"}
        className={`alert ${result?.tone === "success" ? "alert-success" : result?.tone === "error" ? "alert-error" : "alert-warning"}`}
      >
        {result?.text ?? "Nothing was connected."}
      </p>
      <p>
        <Link href="/">Back to your workspace</Link>
      </p>
    </>
  );
}
