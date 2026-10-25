// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The round picture next to the name: the GitHub avatar, or the initials when there is none or it
// does not load. It never renders a broken image. The user menu shows the signed in person; the rows of
// the Members and Connections pages show a member or the account of an installation (#638) at `lg`.
import { useEffect, useRef, useState } from "react";
import { initials, safeAvatarUrl, type ShellUser } from "./user-display.ts";

const FRAME =
  "inline-grid shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-raised font-semibold text-foreground";

const SIZE = {
  default: { frame: "size-8 text-xs", pixels: 32 },
  lg: { frame: "size-10 text-sm", pixels: 40 },
} as const;

export function UserAvatar({
  user,
  size = "default",
}: {
  user: Pick<ShellUser, "name" | "login" | "avatarUrl">;
  size?: keyof typeof SIZE;
}) {
  const { frame, pixels } = SIZE[size];
  const url = safeAvatarUrl(user.avatarUrl);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // The server-rendered image can fail before React has attached onError (a slow script, a
  // blocked host). A finished load without any pixels is the same failure.
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth === 0) setFailedUrl(url);
  }, [url]);

  if (url === null || failedUrl === url) {
    return (
      <span className={`${FRAME} ${frame}`} aria-hidden="true">
        {initials(user)}
      </span>
    );
  }
  return (
    <span className={`${FRAME} ${frame}`} aria-hidden="true">
      {/* A plain img: the address comes from the GitHub profile and next/image would need every
          avatar host configured. It is https on GitHub's avatar host only (safeAvatarUrl) and sent
          without a referrer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imageRef}
        src={url}
        alt=""
        width={pixels}
        height={pixels}
        className="block size-full object-cover"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(url)}
      />
    </span>
  );
}
