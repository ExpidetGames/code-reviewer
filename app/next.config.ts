// SPDX-License-Identifier: Apache-2.0

import type { NextConfig } from "next";
import { MISSING_PATH, PORTAL_DENIED_HEADER } from "./src/admin/paths.ts";

const nextConfig: NextConfig = {
  // A self-contained server (`.next/standalone/server.js`) with only the files it needs, for the
  // Docker image (app/Dockerfile).
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  async rewrites() {
    return {
      // A request for the files of the admin portal by their own address is marked by the proxy
      // (src/admin/paths.ts). Next.js answers it as a path that does not exist, the same as any other,
      // with nothing of the portal in the answer.
      beforeFiles: [
        {
          source: "/:path*",
          has: [{ type: "header", key: PORTAL_DENIED_HEADER }],
          destination: MISSING_PATH,
        },
      ],
      afterFiles: [],
      // Every path that is no route gets to the same place, so the answer of a marked request and the
      // answer of a path that was never there are made the same way. On an RSC request Next.js adds
      // `x-nextjs-rewritten-path` to the answer of any rewrite; if only the marked request were rewritten,
      // that header would tell it from a missing path. (Next.js's own files keep their own answer.)
      fallback: [{ source: "/:path((?!_next/).*)", destination: MISSING_PATH }],
    };
  },
};

export default nextConfig;
