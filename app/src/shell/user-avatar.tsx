// SPDX-License-Identifier: Apache-2.0

"use client";
// The round picture next to the name: the GitHub avatar, or the initials when there is none or it
// does not load. It never renders a broken image.
import { useEffect, useRef, useState } from "react";
import { initials, safeAvatarUrl, type ShellUser } from "./user-display.ts";

export function UserAvatar({ user }: { user: ShellUser }) {
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
      <span className="avatar" aria-hidden="true">
        {initials(user)}
      </span>
    );
  }
  return (
    <span className="avatar" aria-hidden="true">
      {/* A plain img: the address comes from the GitHub profile and next/image would need every
          avatar host configured. It is https only (safeAvatarUrl) and sent without a referrer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imageRef}
        src={url}
        alt=""
        width={32}
        height={32}
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(url)}
      />
    </span>
  );
}
