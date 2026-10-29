// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the network guard of the privileged Dynamic e2e lane (#253): the nft rules that count and reject
// every connection that leaves the machine, and the reading of their counters that fails a test. The rules
// sit in the kernel of the lane's network namespace, so they see OpenCode, Git, `rg`, Node and any helper
// process alike, whatever language or runtime they are written in. Here the decision is proven on the
// counters nft prints; that the counters really move for each kind of process is proven by the lane itself
// (e2e/dynamic/network-guard.e2e.ts) and cannot be proven without root.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_PREFIX,
  GUARD_CHAIN,
  GUARD_TABLE,
  assertDnsQuiet,
  assertNoExternalAttempts,
  describeAttempts,
  describeDnsProblems,
  parseAskedNames,
  parseDestinations,
  parseDnsDestinations,
  parseDnsAllowlist,
  parseDns,
  parseGuard,
  readGuardDestinations,
  type GuardReading,
} from "../../e2e/helpers/dynamic-lane-guard.ts";

const TRACE = readFileSync(
  fileURLToPath(new URL("../../e2e/dynamic/guard-trace.nft", import.meta.url)),
  "utf8",
);
const NAMESPACE = readFileSync(
  fileURLToPath(
    new URL(
      "../../../runner/scripts/dynamic_e2e_namespace.sh",
      import.meta.url,
    ),
  ),
  "utf8",
);
const RULES = readFileSync(
  fileURLToPath(new URL("../../e2e/dynamic/guard.nft", import.meta.url)),
  "utf8",
);

/** What `nft -j list chain` prints for a rule: the expressions, with the counter, and the comment. */
function rule(comment: string, packets: number) {
  return {
    rule: {
      family: "inet",
      table: GUARD_TABLE,
      chain: GUARD_CHAIN,
      handle: 5,
      comment,
      expr: [
        { match: { op: "==", left: { meta: { key: "skuid" } }, right: 1 } },
        { counter: { packets, bytes: packets * 60 } },
        { reject: null },
      ],
    },
  };
}

function listing(counts: Record<string, number>) {
  return {
    nftables: [
      { metainfo: { version: "1.0.9", json_schema_version: 1 } },
      {
        chain: {
          family: "inet",
          table: GUARD_TABLE,
          name: GUARD_CHAIN,
          handle: 1,
        },
      },
      // The loopback rule has no counter and no comment: it is not one of the guard's counters.
      {
        rule: {
          family: "inet",
          table: GUARD_TABLE,
          chain: GUARD_CHAIN,
          handle: 4,
          expr: [{ accept: null }],
        },
      },
      ...Object.entries(counts).map(([comment, packets]) =>
        rule(comment, packets),
      ),
    ],
  };
}

const QUIET = {
  "control-engine": 0,
  "control-job": 0,
  "control-root": 0,
  "violation-engine": 0,
  "violation-job": 0,
  "violation-root": 0,
  "violation-other": 0,
};

/** Output of `nft -j` captured from the lane in CI (nft 1.0.9, run 40914162000), unchanged. */
function captured(name: "chain" | "seen4" | "seen6"): unknown {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`./fixtures/nft/lane-guard-${name}.json`, import.meta.url),
      ),
      "utf8",
    ),
  );
}

const DNS_QUIET = {
  "dns-control-engine": 0,
  "dns-control-delivered": 0,
  "dns-engine-delivered": 0,
  "dns-engine": 0,
  "dns-job": 0,
  "dns-root": 0,
  "dns-other": 0,
};
const ALLOWLIST = readFileSync(
  fileURLToPath(
    new URL("../../e2e/dynamic/dns-allowlist.txt", import.meta.url),
  ),
  "utf8",
);

describe("the network guard of the privileged Dynamic e2e lane", () => {
  // #253-G01
  it("reads the counters of the violations and of the controls apart", () => {
    const reading = parseGuard(
      listing({
        ...QUIET,
        "control-engine": 2,
        "violation-root": 3,
      }),
    );

    expect(reading).toEqual({
      violations: { engine: 0, job: 0, root: 3, other: 0 },
      controls: { engine: 2, job: 0, root: 0 },
    });
  });

  // #253-G02
  it.each([
    ["engine", "violation-engine", /OpenCode|engine/],
    ["job", "violation-job", /job/],
    ["root", "violation-root", /root/],
    ["other", "violation-other", /another user/],
  ] as const)(
    "fails when a process of the %s user reached anything but loopback, and says who",
    (_who, comment, description) => {
      const reading = parseGuard(listing({ ...QUIET, [comment]: 1 }));

      expect(() => {
        assertNoExternalAttempts(reading);
      }).toThrow(description);
      expect(describeAttempts(reading)).toHaveLength(1);
    },
  );

  // #253-G02
  it("passes when no process reached anything but loopback, controls or not", () => {
    const reading = parseGuard(
      listing({ ...QUIET, "control-engine": 4, "control-root": 1 }),
    );

    expect(() => {
      assertNoExternalAttempts(reading);
    }).not.toThrow();
  });

  // #253-G03
  it("refuses to read a ruleset that lacks a counter, because a guard that cannot see is not a guard", () => {
    const incomplete = Object.fromEntries(
      Object.entries(QUIET).filter(([name]) => name !== "violation-engine"),
    );

    expect(() => parseGuard(listing(incomplete))).toThrow(/violation-engine/);
    expect(() => parseGuard({ nftables: [] })).toThrow(/violation-engine/);
    expect(() => parseGuard("not nft output")).toThrow();
  });

  // #253-G04
  it("has a rule file that counts and rejects every destination of every kind of user, and nothing leaves through loopback", () => {
    const comments = [...RULES.matchAll(/comment "([a-z-]+)"/g)].map(
      (match) => match[1],
    );

    expect(comments.sort()).toEqual(
      [...Object.keys(QUIET), ...Object.keys(DNS_QUIET)].sort(),
    );
    expect(RULES).toContain(`table inet ${GUARD_TABLE}`);
    expect(RULES).toContain(`add chain inet ${GUARD_TABLE} ${GUARD_CHAIN}`);
    // Loopback is the only way out that is accepted; everything else is counted and rejected.
    expect(RULES).toMatch(/oifname "lo" accept/);
    expect(RULES).not.toMatch(/\bdrop\b/);
    // The documentation range the controls use is reserved and never routed.
    expect(RULES).toContain(CONTROL_PREFIX.ipv4);
  });

  // #253-G04
  it("counts the users of the lane by number, including the engine user of the Dynamic image", () => {
    expect(RULES).toMatch(/meta skuid 10101 .*violation-engine/);
    expect(RULES).toMatch(/meta skuid 10001 .*violation-job/);
    expect(RULES).toMatch(/meta skuid 0 .*violation-root/);
    expect(RULES).toMatch(
      /meta skuid != \{ 0, 10001, 10101 \} .*violation-other/,
    );
  });

  it("is the same reading whatever the order of the rules", () => {
    const entries = Object.entries({ ...QUIET, "violation-job": 1 });
    const forward = parseGuard(listing(Object.fromEntries(entries)));
    const backward = parseGuard(
      listing(Object.fromEntries([...entries].reverse())),
    );

    expect(backward).toEqual(forward as GuardReading);
  });

  // #667-T01
  it("names the destinations a violation went to, so a failure says what tried to leave the lane", () => {
    const reading = parseGuard(listing({ ...QUIET, "violation-root": 4 }));
    const destinations = parseDestinations({
      nftables: [
        { metainfo: { version: "1.0.9", json_schema_version: 1 } },
        {
          set: {
            family: "inet",
            table: GUARD_TABLE,
            name: "seen4",
            type: ["ipv4_addr", "inet_proto", "inet_service"],
            elem: [
              { elem: { val: { concat: ["168.63.129.16", "udp", 53] } } },
              { concat: ["10.255.255.2", "tcp", 443] },
            ],
          },
        },
      ],
    });

    expect(destinations).toEqual([
      "168.63.129.16:53/udp",
      "10.255.255.2:443/tcp",
    ]);
    expect(() => {
      assertNoExternalAttempts(reading, destinations);
    }).toThrow(/168\.63\.129\.16:53\/udp, 10\.255\.255\.2:443\/tcp/);
    // Without any recorded destination the message is the one it always was.
    expect(() => {
      assertNoExternalAttempts(reading);
    }).toThrow(/not on loopback\.$/);
  });

  // #667-T01
  it("reads no destination from a listing that has none, and an address of IPv6 with its port apart", () => {
    expect(parseDestinations({ nftables: [] })).toEqual([]);
    expect(parseDestinations("not nft output")).toEqual([]);
    expect(
      parseDestinations({
        nftables: [{ set: { elem: [{ concat: ["fd00:255::2", "udp", 53] }] } }],
      }),
    ).toEqual(["[fd00:255::2]:53/udp"]);
  });

  // #714-T03
  it("reads the sets and the chain as nft prints them in the lane (captured output, not a hand-written listing)", () => {
    expect(parseDestinations(captured("seen4"))).toEqual([
      "10.255.255.2:53/udp",
      "10.255.255.2:443/tcp",
    ]);
    expect(parseDestinations(captured("seen6"))).toEqual([
      "[ff02::16]:11266/ipv6-icmp",
      "[ff02::1:ff18:4370]:22555/ipv6-icmp",
      "[ff02::16]:43803/ipv6-icmp",
      "[ff02::16]:39756/ipv6-icmp",
      "[ff02::16]:44885/ipv6-icmp",
      "[ff02::1:ffb4:bd65]:48039/ipv6-icmp",
      "[fd00:255::2]:443/tcp",
      "[ff02::2]:28092/ipv6-icmp",
      "[ff02::2]:21701/ipv6-icmp",
    ]);
    // The chain was listed in a capture run that made three attempts on purpose; the guard had counted five as root.
    expect(parseGuard(captured("chain"))).toEqual({
      violations: { engine: 0, job: 0, root: 5, other: 0 },
      controls: { engine: 0, job: 0, root: 0 },
    });
  });

  // #714-T03
  it("reads the protocol of an element as a number as well as by name", () => {
    expect(
      parseDestinations({
        nftables: [
          {
            set: {
              elem: [
                { elem: { val: { concat: ["10.255.255.2", 6, 443] } } },
                { concat: ["10.255.255.2", 17, "53"] },
                { concat: ["fd00:255::2", 132, 9] },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      "10.255.255.2:443/tcp",
      "10.255.255.2:53/udp",
      "[fd00:255::2]:9/132",
    ]);
  });

  // #714-T03
  it("says so when the destinations cannot be read, instead of returning none silently", () => {
    // `nft` is not there, or not allowed to list the lane's table, outside the lane: either way the listing fails.
    const written = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(readGuardDestinations()).toEqual([]);
      expect(
        written.mock.calls.map((call) => String(call[0])).join(""),
      ).toMatch(/destinations unreadable: nft list set seen4 failed/);
    } finally {
      written.mockRestore();
    }
  });

  // #667-T01
  it("records the destinations in sets that the loopback and the controls never reach, and loads them without being able to break the guard", () => {
    expect(TRACE).toMatch(
      /add set inet cr_lane_guard seen4 \{[^}]*flags dynamic/,
    );
    expect(TRACE).toMatch(
      /add set inet cr_lane_guard seen6 \{[^}]*flags dynamic/,
    );
    // The rules sit in front of the counters and take no verdict: counting and rejecting stay the guard's.
    expect(TRACE).toMatch(
      /insert rule inet cr_lane_guard output oifname != "lo"/,
    );
    expect(TRACE).not.toMatch(/\b(accept|reject|drop)\b.*seen/);
    expect(NAMESPACE).toMatch(
      /nft -f "\$LANE_APP_DIR\/e2e\/dynamic\/guard-trace\.nft" \|\|/,
    );
    expect(NAMESPACE.indexOf("guard.nft")).toBeLessThan(
      NAMESPACE.indexOf("guard-trace.nft"),
    );
  });
});

describe("the name lookups on the lane's own resolver", () => {
  const FILE = parseDnsAllowlist(ALLOWLIST);
  const ALLOWED = parseDnsAllowlist("example.org # a name for the tests\n");
  const reading = (counts: Record<string, number>) =>
    parseDns(listing({ ...QUIET, ...DNS_QUIET, ...counts }));

  // #714-T02
  it("reads the DNS counters of each user, the engine's delivered packets and the controls, apart from the violations", () => {
    expect(
      reading({
        "dns-engine": 3,
        "dns-root": 2,
        "dns-engine-delivered": 1,
        "dns-control-engine": 4,
        "dns-control-delivered": 5,
      }),
    ).toEqual({
      queries: { engine: 3, job: 0, root: 2, other: 0 },
      engineDelivered: 1,
      controlEngine: 4,
      controlDelivered: 5,
    });
    // The loopback queries do not touch the counters that fail a test for leaving the machine.
    expect(() => {
      assertNoExternalAttempts(
        parseGuard(listing({ ...QUIET, ...DNS_QUIET, "dns-engine": 3 })),
      );
    }).not.toThrow();
  });

  // #714-T02
  it("refuses to read a ruleset without the DNS counters, because a guard that cannot see is not a guard", () => {
    expect(() => parseDns(listing(QUIET))).toThrow(/dns-/);
    expect(() =>
      parseDns(
        listing(
          Object.fromEntries(
            Object.entries({ ...QUIET, ...DNS_QUIET }).filter(
              ([name]) => name !== "dns-engine-delivered",
            ),
          ),
        ),
      ),
    ).toThrow(/dns-engine-delivered/);
    expect(() => parseDns({ nftables: [] })).toThrow(/dns-/);
    expect(() => parseDns("not nft output")).toThrow();
  });

  // #714-T02
  it("fails the lane when a query of the engine user got past the runner's rules, and names where it went", () => {
    const dns = reading({ "dns-engine": 1, "dns-engine-delivered": 1 });

    expect(() => {
      assertDnsQuiet(dns, ["example.org"], ALLOWED);
    }).toThrow(
      /1 DNS query packet.* engine user .* got past the runner's own network rules/,
    );
    expect(() => {
      assertDnsQuiet(dns, [], ALLOWED, ["uid 10101 → 127.0.0.1:53/udp"]);
    }).toThrow(/uid 10101 → 127\.0\.0\.1:53\/udp/);
  });

  // #714-T02
  it("passes the engine's attempts that the runner's rules rejected, they are reported by the lane and not failed (#739)", () => {
    const dns = reading({
      "dns-engine": 3,
      "dns-control-engine": 1,
      "dns-control-delivered": 1,
    });

    expect(describeDnsProblems(dns, [], ALLOWED)).toEqual([]);
  });

  // #714-T02
  it("fails the lane for a name that is not on the allowlist, and names it", () => {
    const dns = reading({ "dns-root": 2 });

    expect(() => {
      assertDnsQuiet(dns, ["example.org", "github.com", "evil.test"], ALLOWED);
    }).toThrow(/github\.com, evil\.test/);
    expect(
      describeDnsProblems(dns, ["example.org", "github.com"], ALLOWED),
    ).toHaveLength(1);
  });

  // #714-T02
  it("passes when only names of the allowlist were asked, however often, or none", () => {
    const dns = reading({ "dns-root": 4 });

    expect(
      describeDnsProblems(dns, ["example.org", "example.org"], ALLOWED),
    ).toEqual([]);
    expect(describeDnsProblems(dns, [], ALLOWED)).toEqual([]);
  });

  // #714-T02
  it("reads the names of the resolver's log and the allowlist the same way, whatever the type, case or root dot", () => {
    expect(
      parseAskedNames(
        "A example.org\nAAAA Example.ORG.\n\nMALFORMED (not a query)\n",
      ),
    ).toEqual(["example.org", "example.org", "(not a query)"]);
    expect(
      parseDnsAllowlist("# comment\n\nExample.org # why\n  other.test  \n"),
    ).toEqual(new Set(["example.org", "other.test"]));
    // A malformed query, or a packet that is no query, is not a name that can be on a list.
    for (const log of [
      "MALFORMED not a query with one question, 15 bytes 1234",
      "IGNORED an answer, 20 bytes 0000",
    ])
      expect(
        describeDnsProblems(reading({}), parseAskedNames(log), ALLOWED),
      ).toHaveLength(1);
  });

  // #714-T02
  it("names who sent the lookups and where, from the dns sets (the user as a number or as a name)", () => {
    expect(
      parseDnsDestinations({
        nftables: [
          {
            set: {
              elem: [
                { concat: [10101, "127.0.0.1", "udp", 53] },
                { concat: ["root", "127.0.0.1", "tcp", 53] },
                { elem: { val: { concat: [10101, "::1", 17, 53] } } },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      "uid 10101 → 127.0.0.1:53/udp",
      "root → 127.0.0.1:53/tcp",
      "uid 10101 → [::1]:53/udp",
    ]);
    expect(parseDnsDestinations({ nftables: [] })).toEqual([]);
  });

  // #714-T02
  it("has an allowlist with no name now, whose reasons point to the issues that explain the lookups", () => {
    expect([...FILE]).toEqual([]);
    expect(ALLOWLIST).toMatch(/#736/);
    expect(ALLOWLIST).toMatch(/#739/);
  });

  // #714-T02
  it("counts queries to port 53 on loopback per user before the loopback accept, and the engine's after the runner's table, with controls that do not fail the lane", () => {
    const lines = RULES.split("\n");
    const accept = lines.findIndex((line) => /oifname "lo" accept/.test(line));
    const dnsRules = lines.filter((line) =>
      / output oifname .*comment "dns-/.test(line),
    );
    const delivered = lines.filter((line) =>
      /output_after .*comment "dns-/.test(line),
    );

    expect(
      dnsRules.filter((line) =>
        /dns-(engine|job|root|other|control-engine)"/.test(line),
      ),
    ).toHaveLength(5);
    for (const line of dnsRules) {
      expect(lines.indexOf(line)).toBeLessThan(accept);
      expect(line).toMatch(/oifname "lo"/);
      expect(line).toMatch(/th dport 53/);
    }
    // The engine user's counter covers UDP and TCP and is not the control's.
    expect(RULES).toMatch(
      /meta l4proto \{ tcp, udp \} th dport 53 meta skuid 10101 counter comment "dns-engine"/,
    );
    expect(RULES).toMatch(/meta skuid 10001 counter comment "dns-job"/);
    expect(RULES).toMatch(/meta skuid 0 counter comment "dns-root"/);
    expect(RULES).toMatch(
      /meta skuid != \{ 0, 10001, 10101 \} counter comment "dns-other"/,
    );
    expect(RULES).toMatch(
      /output oifname "lo" ip daddr 127\.0\.0\.2 .*skuid 10101 counter accept comment "dns-control-engine"/,
    );
    // After the runner's table (priority 0 in netguard.py): the chain at priority 10 sees only what that table let pass.
    expect(RULES).toMatch(
      /add chain inet cr_lane_guard output_after \{ type filter hook output priority 10 ;/,
    );
    expect(delivered).toHaveLength(2);
    expect(RULES).toMatch(
      /output_after oifname "lo" ip daddr 127\.0\.0\.2 .*skuid 10001 counter accept comment "dns-control-delivered"/,
    );
    expect(RULES).toMatch(
      /output_after oifname "lo" meta l4proto \{ tcp, udp \} th dport 53 meta skuid 10101 counter comment "dns-engine-delivered"/,
    );
    // Only the two controls accept; the counters of the users take no verdict.
    expect(
      [...dnsRules, ...delivered].filter((line) => /\baccept\b/.test(line)),
    ).toHaveLength(2);
  });

  // #714-T02
  it("keeps the engine's boundary where the lane expects it: the runner's table is at priority 0 and rejects the engine user's other packets", () => {
    const netguard = readFileSync(
      fileURLToPath(
        new URL(
          "../../../runner/src/code_reviewer_runner/dynamic_review/netguard.py",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(netguard).toMatch(/hook output priority 0 ;/);
    expect(netguard).toMatch(/reject with icmpx type admin-prohibited/);
  });

  // #714-T02
  it("reads the guard's last word from the files of the lane: the resolver's log goes to the command, which fails the lane", () => {
    expect(NAMESPACE).toMatch(/dynamic-lane-guard-command\.ts" "\$DNS_LOG"/);
    expect(NAMESPACE.indexOf('kill "$DNS_PID"')).toBeLessThan(
      NAMESPACE.indexOf("dynamic-lane-guard-command.ts"),
    );
  });
});
