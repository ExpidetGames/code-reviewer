// SPDX-License-Identifier: LicenseRef-Proprietary

// The resolver of the privileged Dynamic e2e lane (#667). Name lookups of the lane used to go to the resolver of the
// runner (Azure's 168.63.129.16), out of the namespace, where the network guard counted them as a violation of the
// process that asked, on some runners and some runs only. The lane now has a resolver of its own on loopback that answers
// every name with "no such name" and writes down what was asked, so a lookup never leaves the namespace and the failure
// names the name instead of a number.
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  noSuchNameAnswer,
  readQuestion,
  startLaneResolver,
} from "../../e2e/helpers/lane-dns-stub.ts";

const NAMESPACE = readFileSync(
  fileURLToPath(
    new URL(
      "../../../runner/scripts/dynamic_e2e_namespace.sh",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** A DNS query for `name` (type A or AAAA), as a resolver library sends it. */
function query(name: string, type: number, id = 0x1234): Buffer {
  const labels = name
    .split(".")
    .map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]),
    );
  const header = Buffer.from([
    id >> 8,
    id & 0xff,
    0x01,
    0x00,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  return Buffer.concat([
    header,
    ...labels,
    Buffer.from([0, type >> 8, type & 0xff, 0, 1]),
  ]);
}

describe("the resolver of the Dynamic lane", () => {
  // #667-T01
  it("reads the name and the type of the question", () => {
    expect(readQuestion(query("api.example.com", 28))).toEqual({
      name: "api.example.com",
      type: "AAAA",
    });
    expect(readQuestion(query("localhost", 1))).toEqual({
      name: "localhost",
      type: "A",
    });
    expect(readQuestion(Buffer.from([1, 2, 3]))).toBeNull();
  });

  // #667-T01
  it("answers with the same id and the question, as a response with 'no such name'", () => {
    const asked = query("api.example.com", 1, 0xabcd);

    const answer = noSuchNameAnswer(asked);

    expect(answer.readUInt16BE(0)).toBe(0xabcd);
    // QR (response), RD and RA set; RCODE 3 (NXDOMAIN).
    expect(answer[2]! & 0x80).toBe(0x80);
    expect(answer[3]! & 0x0f).toBe(3);
    expect(answer.readUInt16BE(4)).toBe(1);
    expect(answer.readUInt16BE(6)).toBe(0);
    expect(answer.subarray(12).equals(asked.subarray(12))).toBe(true);
  });

  // #667-T01
  it("answers over UDP on loopback and writes down every name that was asked", async () => {
    const resolver = await startLaneResolver({ port: 0 });
    try {
      const client = createSocket("udp4");
      const answer = await new Promise<Buffer>((resolve, reject) => {
        client.once("message", resolve);
        client.once("error", reject);
        client.send(
          query("registry.example.org", 1),
          resolver.port,
          "127.0.0.1",
        );
      });
      client.close();

      expect(answer[3]! & 0x0f).toBe(3);
      expect(resolver.asked()).toEqual(["A registry.example.org"]);
    } finally {
      await resolver.close();
    }
  });

  // #667-T01
  it("is the resolver of the lane's mount namespace, started before anything else asks, and its log is printed at the end", () => {
    expect(NAMESPACE).toMatch(/nameserver 127\.0\.0\.1/);
    expect(NAMESPACE).toMatch(/\$STAGE\/resolv\.conf/);
    expect(NAMESPACE.indexOf("lane-dns-stub-command")).toBeLessThan(
      NAMESPACE.indexOf("dynamic-preflight-command"),
    );
    expect(NAMESPACE).toContain("Names the lane asked for");
  });
});
