// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isPublicHttpsUrl } from "./public-url.ts";

describe("the address Paddle posts its events to", () => {
  // #437-T05
  it.each([
    "https://reviews.example.com",
    "https://reviews.example.com/",
    "https://reviews.example.com:8443/base",
    "https://app.example.test",
    "https://8.8.8.8",
    "https://[2606:4700:4700::1111]",
  ])("accepts %s", (url) => {
    expect(isPublicHttpsUrl(url)).toBe(true);
  });

  // #437-T05
  it.each([
    ["http://reviews.example.com", "not https"],
    ["http://localhost:3000", "http, loopback"],
    ["https://localhost", "loopback name"],
    ["https://LOCALHOST.", "loopback name with a root dot"],
    ["https://app.localhost", "loopback domain"],
    ["https://127.0.0.1", "loopback"],
    ["https://127.8.8.8", "loopback range"],
    ["https://0.0.0.0", "unspecified"],
    ["https://10.1.2.3", "private"],
    ["https://172.16.0.1", "private"],
    ["https://172.31.255.255", "private"],
    ["https://192.168.1.10", "private"],
    ["https://169.254.169.254", "link-local"],
    ["https://100.64.0.1", "shared address space"],
    ["https://[::1]", "loopback v6"],
    ["https://[::]", "unspecified v6"],
    ["https://[fe80::1]", "link-local v6"],
    ["https://[fd00::1]", "unique local v6"],
    ["https://[::ffff:127.0.0.1]", "mapped loopback"],
    ["https://[::ffff:10.0.0.1]", "mapped private"],
    ["https://0x7f.1", "numeric host form of loopback"],
    ["https://2130706433", "decimal form of loopback"],
    ["https://printer.local", "mDNS name"],
    ["https://intranet", "single-label host"],
    ["ftp://reviews.example.com", "not http"],
    ["not a url", "not a URL"],
    ["", "empty"],
    ["https://user:pass@reviews.example.com", "credentials in the address"],
  ])("refuses %s (%s)", (url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });
});
