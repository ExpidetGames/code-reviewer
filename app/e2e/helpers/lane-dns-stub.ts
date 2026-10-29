// SPDX-License-Identifier: LicenseRef-Proprietary

// The resolver of the privileged Dynamic e2e lane (#667). The lane's network namespace has loopback and a way out that
// leads nowhere; a name lookup that goes to the resolver of the runner (on GitHub's Azure runners 168.63.129.16, UDP 53)
// reaches the network guard and counts as a violation of the process that asked, on some runners and some runs only. The
// lane therefore has a resolver of its own on loopback: it answers every name with "no such name" at once and writes down
// what was asked, so nothing leaves the namespace and a failure names the name. Minimal DNS: one question, no records.
import { createSocket, type Socket } from "node:dgram";

const TYPES: Record<number, string> = {
  1: "A",
  5: "CNAME",
  12: "PTR",
  15: "MX",
  16: "TXT",
  28: "AAAA",
  33: "SRV",
  65: "HTTPS",
};
const HEADER = 12;

/** Where the question of a query ends (after its name, type and class), or -1 when the message is not one. */
function questionEnd(message: Buffer): number {
  if (message.length < HEADER + 5) return -1;
  if (message.readUInt16BE(4) !== 1) return -1;
  let at = HEADER;
  while (at < message.length) {
    const length = message[at]!;
    if (length === 0) return at + 5 <= message.length ? at + 5 : -1;
    // A compression pointer does not appear in the question of a query.
    if (length > 63) return -1;
    at += length + 1;
  }
  return -1;
}

/** The name and the type asked by a query, or null when the message is no query with one question. */
export function readQuestion(
  message: Buffer,
): { name: string; type: string } | null {
  const end = questionEnd(message);
  if (end === -1) return null;
  const labels: string[] = [];
  let at = HEADER;
  while (message[at] !== 0) {
    labels.push(message.toString("latin1", at + 1, at + 1 + message[at]!));
    at += message[at]! + 1;
  }
  const type = message.readUInt16BE(at + 1);
  return { name: labels.join("."), type: TYPES[type] ?? `TYPE${String(type)}` };
}

/** The answer "no such name" (NXDOMAIN) to a query: its id, its question, no records. */
export function noSuchNameAnswer(query: Buffer): Buffer {
  const end = questionEnd(query);
  const answer = Buffer.from(query.subarray(0, end === -1 ? HEADER : end));
  // QR, the opcode and RD of the query kept; RA set; RCODE 3.
  answer[2] = 0x80 | (query[2]! & 0x79);
  answer[3] = 0x80 | 3;
  answer.writeUInt16BE(end === -1 ? 0 : 1, 4);
  answer.writeUInt16BE(0, 6);
  answer.writeUInt16BE(0, 8);
  answer.writeUInt16BE(0, 10);
  return answer;
}

/** The answer "format error" (FORMERR) to a message that is a query but not one with a single readable question. */
export function formatErrorAnswer(query: Buffer): Buffer {
  const answer = Buffer.from(query.subarray(0, HEADER));
  answer[2] = 0x80 | (query[2]! & 0x79);
  answer[3] = 0x80 | 1;
  for (const at of [4, 6, 8, 10]) answer.writeUInt16BE(0, at);
  return answer;
}

/** A packet that is a query (QR clear) with at least a header; anything else is not answered, so two resolvers cannot loop. */
function isQueryWithHeader(message: Buffer): boolean {
  return message.length >= HEADER && (message[2]! & 0x80) === 0;
}

export type LaneResolver = {
  port: number;
  /** `A name`, `AAAA name`, … in the order they were asked. */
  asked(): string[];
  close(): Promise<void>;
};

/** Starts the resolver on loopback; `onAsked` is told of every question as it arrives. */
export async function startLaneResolver(options: {
  port: number;
  onAsked?: (line: string) => void;
}): Promise<LaneResolver> {
  const asked: string[] = [];
  const socket: Socket = createSocket("udp4");
  // Everything that arrives is written down, also what is no question: the guard's allowlist has no such line, so the lane
  // fails and the line says what arrived (its length and first bytes).
  const note = (line: string) => {
    asked.push(line);
    options.onAsked?.(line);
  };
  socket.on("message", (message, remote) => {
    const what = `${String(message.length)} bytes ${message.subarray(0, 24).toString("hex")}`;
    // An answer (QR set) is not a question, whatever follows its header: two resolvers cannot loop on each other.
    if (message.length > 2 && (message[2]! & 0x80) !== 0) {
      note(`IGNORED an answer, ${what}`);
      return;
    }
    const question = readQuestion(message);
    if (question === null) {
      if (!isQueryWithHeader(message)) {
        note(`IGNORED a packet too short to be a query, ${what}`);
        return;
      }
      note(`MALFORMED not a query with one question, ${what}`);
      socket.send(formatErrorAnswer(message), remote.port, remote.address);
      return;
    }
    note(`${question.type} ${question.name}`);
    socket.send(noSuchNameAnswer(message), remote.port, remote.address);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(options.port, "127.0.0.1", resolve);
  });
  return {
    port: socket.address().port,
    asked: () => [...asked],
    close: () =>
      new Promise<void>((resolve) => {
        socket.close(() => {
          resolve();
        });
      }),
  };
}
