// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  isPublicAddress,
  isPublicHttpsUrl,
  normalizedAddress,
} from "./public-url.ts";

describe("the address Stripe posts its events to", () => {
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

describe("the address in the form webhook endpoints are compared in", () => {
  // #437-T05
  it.each([
    ["https://Reviews.Example.COM/hook", "https://reviews.example.com/hook"],
    [
      "https://reviews.example.com:443/hook/",
      "https://reviews.example.com/hook",
    ],
    ["https://reviews.example.com//", "https://reviews.example.com"],
    [
      "https://reviews.example.com:8443/base/",
      "https://reviews.example.com:8443/base",
    ],
    ["not a url/", "not a url"],
  ])("turns %s into %s", (given, expected) => {
    expect(normalizedAddress(given)).toBe(expected);
  });
});

describe("a resolved address", () => {
  // #548-T07
  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])(
    "is public: %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  // #548-T07
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "not an address",
    "",
  ])("is not public: %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  // #548-T07
  it.each([
    ["192.0.0.0", "IETF protocol assignments /24, first"],
    ["192.0.0.170", "NAT64 discovery name"],
    ["192.0.0.255", "IETF protocol assignments /24, last"],
    ["192.0.2.1", "documentation TEST-NET-1"],
    ["198.51.100.7", "documentation TEST-NET-2"],
    ["203.0.113.9", "documentation TEST-NET-3"],
    ["192.88.99.1", "6to4 relay anycast"],
    ["198.18.0.0", "benchmarking /15, first"],
    ["198.19.255.255", "benchmarking /15, last"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("is not public (IPv4 special-purpose): %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  // #548-T07
  it.each([
    "192.0.1.1",
    "192.0.3.1",
    "198.17.255.255",
    "198.20.0.1",
    "198.51.99.1",
    "198.51.101.1",
    "203.0.112.1",
    "203.0.114.1",
    "192.88.98.1",
    "192.88.100.1",
    "223.255.255.255",
  ])("stays public next to a special-purpose range: %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  // #548-T07
  it.each([
    ["64:ff9b::7f00:1", "NAT64 of 127.0.0.1"],
    ["64:ff9b::a00:1", "NAT64 of 10.0.0.1"],
    ["64:ff9b::a9fe:a9fe", "NAT64 of 169.254.169.254"],
    ["64:ff9b::c0a8:101", "NAT64 of 192.168.1.1"],
    ["64:ff9b::c000:2aa", "NAT64 of 192.0.2.170"],
    ["64:ff9b:1::1", "local-use NAT64 prefix"],
    ["64:ff9b:1:ffff::1", "local-use NAT64 prefix, last block"],
    ["2002:7f00:1::1", "6to4 of 127.0.0.1"],
    ["2002:a00:1::", "6to4 of 10.0.0.1"],
    ["2002:a9fe:a9fe::1", "6to4 of 169.254.169.254"],
    ["2002:c0a8:101::1", "6to4 of 192.168.1.1"],
    ["2001::1", "Teredo (IETF protocol assignments /23)"],
    ["2001:1ff:ffff::1", "IETF protocol assignments /23, last"],
    ["2001:db8::1", "documentation"],
    ["3fff::1", "documentation (3fff::/20)"],
    ["3fff:fff:ffff::1", "documentation (3fff::/20), last"],
    ["100::1", "discard-only"],
    ["fec0::1", "site-local, deprecated"],
    ["64:ff9a::1", "reserved ::/8, next to the NAT64 prefix"],
    ["64:ff9c::1", "reserved ::/8, next to the NAT64 prefix"],
    ["64:ff9b::1:0:0", "64:ff9b::/96 only, not the rest of 64:ff9b::/32"],
    ["5f00::1", "SRv6 segment identifiers"],
    ["::ffff:192.0.0.170", "mapped IETF protocol address"],
    ["::ffff:198.18.0.1", "mapped benchmarking address"],
  ])("is not public (IPv6 special-purpose): %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  // #548-T07
  it.each([
    ["64:ff9b::808:808", "NAT64 of 8.8.8.8, a public address behind a DNS64"],
    ["2002:808:808::1", "6to4 of 8.8.8.8"],
    ["2001:4860:4860::8888", "outside 2001::/23"],
    ["2001:200::1", "just above 2001::/23"],
    ["2a00:1450:4001::1", "an ordinary global address"],
    ["3ffe::1", "just below 3fff::/20"],
    ["4000::1", "above 3fff::/20"],
    ["5e00::1", "just below 5f00::/16"],
    ["5f01::1", "just above 5f00::/16"],
  ])("stays public (IPv6): %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("a special-purpose address in a URL", () => {
  // #548-T07
  it.each([
    "https://192.0.0.1",
    "https://198.18.0.1",
    "https://203.0.113.5",
    "https://[64:ff9b::7f00:1]",
    "https://[64:ff9b:1::5]",
    "https://[2002:7f00:1::1]",
    "https://[2001:db8::1]",
  ])("is refused: %s", (url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });
});
