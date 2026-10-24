// SPDX-License-Identifier: LicenseRef-Proprietary

// The app's own 404 (#633): every address the app does not know, and every page that says it is not
// there for this person (a workspace they are not a member of, the admin portal for anybody but the
// instance admin). It says the same in both cases, so it never tells that something exists.
import Link from "next/link";
import { Button } from "@/components/button";
import {
  BigNumber,
  NOT_FOUND_COPY,
  SystemPage,
} from "@/components/system-page";

export default function NotFound() {
  return (
    <SystemPage
      mark={<BigNumber>404</BigNumber>}
      title={NOT_FOUND_COPY.title}
      description={NOT_FOUND_COPY.description}
    >
      <Button asChild>
        <Link href="/">{NOT_FOUND_COPY.back}</Link>
      </Button>
    </SystemPage>
  );
}
