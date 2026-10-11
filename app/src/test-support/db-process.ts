// Starts src/test-support/db-child.ts as a real process and gives tests line based control of it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

const defaultChildScript = fileURLToPath(
  new URL("./db-child.ts", import.meta.url),
);
const running = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
});

export type DbProcess = {
  /** Resolves with the next line the process prints; rejects if it exits first. */
  nextLine(): Promise<string>;
  send(line: string): void;
  /** Closes stdin, which tells a lock holder with no timer to release. */
  closeInput(): void;
  exited: Promise<number | null>;
};

export function startDbProcess(
  args: string[],
  childScript: string = defaultChildScript,
): DbProcess {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--conditions=react-server", childScript, ...args],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  running.add(child);

  const pending: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  const buffered: string[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const waiting = pending.shift();
    if (waiting) waiting.resolve(line);
    else buffered.push(line);
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      for (const waiting of pending.splice(0)) {
        waiting.reject(
          new Error(`db-child exited with ${code} before printing: ${stderr}`),
        );
      }
      resolve(code);
    });
  });

  return {
    nextLine() {
      const line = buffered.shift();
      if (line !== undefined) return Promise.resolve(line);
      return new Promise((resolve, reject) =>
        pending.push({ resolve, reject }),
      );
    },
    send: (line) => void child.stdin.write(`${line}\n`),
    closeInput: () => void child.stdin.end(),
    exited,
  };
}
