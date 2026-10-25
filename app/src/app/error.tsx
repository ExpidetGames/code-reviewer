// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The app's own error page (#633): what a page shows when it fails while it renders. It never shows
// the error itself (in production the message of a server error is a generic one anyway); "Try again"
// fetches and renders the page once more, the link leads back to the start page.
import { WarningIcon } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/button";
import { ERROR_COPY, SystemPage } from "@/components/system-page";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // The browser console of the person is where a developer looks; the server has logged it already.
    console.error(error);
  }, [error]);

  return (
    <SystemPage
      mark={
        <WarningIcon
          aria-hidden="true"
          className="size-12 text-muted-foreground"
        />
      }
      title={ERROR_COPY.title}
      description={ERROR_COPY.description}
    >
      <Button onClick={() => retry()}>{ERROR_COPY.retry}</Button>
      <Button asChild variant="secondary">
        <Link href="/">{ERROR_COPY.back}</Link>
      </Button>
    </SystemPage>
  );
}
