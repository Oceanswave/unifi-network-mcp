import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, writeSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { REDACTED, redactSecrets } from "./utils/secrets.js";

/**
 * UNIFI_NETWORK_WRITE_LOG: one JSON line per write tool call, so an operator
 * can see what an agent changed (or tried to) without trusting its account
 * of it. Lines carry the canonical request path and HTTP status, never the
 * host, the console ID, the API key or a controller response body.
 */

export type RefusalReason = "request_guard" | "wan_exposure" | "confirmation_required";

export interface WriteLogEntry {
  ts: string;
  tsLocal: string;
  tool: string;
  args: unknown;
  method: string | null;
  path: string | null;
  dryRun: boolean;
  outcome: "ok" | "dry_run" | "refused" | "error";
  status?: number;
  reason?: RefusalReason;
  durationMs: number;
}

/** What one write tool call did, as NetworkClient and the safety checks report it. */
interface WriteCall {
  request?: { method: string; path: string; status?: number };
  refusal?: { reason: RefusalReason; method?: string; path?: string };
}

const currentCall = new AsyncLocalStorage<WriteCall>();

const withoutQuery = (path: string) => path.split("?")[0];

/** NetworkClient: a write request passed the guard and is about to be sent. */
export function noteWriteRequest(method: string, path: string): void {
  const call = currentCall.getStore();
  if (call) call.request = { method, path: withoutQuery(path) };
}

/** NetworkClient: the controller answered the write request. */
export function noteWriteStatus(status: number): void {
  const request = currentCall.getStore()?.request;
  if (request) request.status = status;
}

/** A check refused the call; the first refusal is the one logged. */
export function noteRefusal(reason: RefusalReason, method?: string, path?: string): void {
  const call = currentCall.getStore();
  if (call && !call.refusal) call.refusal = { reason, method, ...(path === undefined ? {} : { path: withoutQuery(path) }) };
}

const SECRET_KEY = /passphrase|password|secret|key|token/i;

function redactArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactArgs);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, SECRET_KEY.test(key) ? REDACTED : redactArgs(entry)])
  );
}

/** "2026-10-18T21:04:05.123+02:00": the local time with its offset. */
export function localTimestamp(date: Date): string {
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: { dryRun?: unknown; wouldExecute?: { method?: unknown; path?: unknown } };
}

export class WriteLog {
  private failed = false;

  /** sink appends one line; it may throw, and a failure is reported once and never breaks the call. */
  constructor(private readonly sink: (line: string) => void, private readonly apiKey: string) {}

  /**
   * Open path for appending, creating it 0600 (and its directory 0700) if
   * needed. Throws for a symlink, anything but a regular file, or a file
   * others can write to, which could be truncated or filled with lies.
   */
  static open(path: string, apiKey: string): WriteLog {
    let existing: Stats | undefined;
    try {
      existing = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (existing?.isSymbolicLink()) throw new Error("it is a symlink; point it at the file itself");
    if (existing === undefined) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // O_NOFOLLOW closes the gap between the check above and the open.
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stats = fstatSync(fd);
    const problem = !stats.isFile() ? "it is not a regular file"
      : stats.nlink > 1 ? "it has other hard links, so lines could land in another file"
      : (stats.mode & 0o022) !== 0 ? `it is group- or world-writable (mode ${(stats.mode & 0o777).toString(8)}); chmod 600 it`
      : undefined;
    if (problem !== undefined) {
      closeSync(fd);
      throw new Error(problem);
    }
    return new WriteLog((line) => { writeSync(fd, line); }, apiKey);
  }

  /** Run one write tool call and append its line. */
  async record<T>(tool: string, input: unknown, run: () => T | Promise<T>): Promise<T> {
    const started = new Date();
    const call: WriteCall = {};
    let result: T | undefined;
    try {
      result = await currentCall.run(call, run);
      return result;
    } finally {
      this.append(this.entry(tool, input, call, result as ToolResult | undefined, started));
    }
  }

  private entry(tool: string, input: unknown, call: WriteCall, result: ToolResult | undefined, started: Date): WriteLogEntry {
    const dryRun = input !== null && typeof input === "object" && "dryRun" in input && input.dryRun === true;
    const preview = result?.structuredContent?.dryRun === true ? result.structuredContent.wouldExecute : undefined;
    const base = {
      ts: started.toISOString(),
      tsLocal: localTimestamp(started),
      tool,
      args: redactArgs(redactSecrets(input)),
      method: null as string | null,
      path: null as string | null,
      dryRun,
    };
    const durationMs = Date.now() - started.getTime();
    if (call.refusal) {
      const { reason, method, path } = call.refusal;
      return { ...base, method: method ?? null, path: path ?? null, outcome: "refused", reason, durationMs };
    }
    if (preview) {
      const method = typeof preview.method === "string" ? preview.method : null;
      const path = typeof preview.path === "string" ? withoutQuery(`/integration/v1${preview.path}`) : null;
      return { ...base, method, path, outcome: "dry_run", durationMs };
    }
    const request = call.request;
    const status = request?.status === undefined ? {} : { status: request.status };
    const where = request ? { method: request.method, path: request.path } : {};
    return { ...base, ...where, outcome: result === undefined || result.isError ? "error" : "ok", ...status, durationMs };
  }

  private append(entry: WriteLogEntry): void {
    try {
      let line = JSON.stringify(entry);
      // Arguments are the model's; if it ever pasted the key into one, keep it out.
      if (this.apiKey.length >= 8) line = line.replaceAll(this.apiKey, REDACTED);
      this.sink(`${line}\n`);
    } catch (err) {
      if (this.failed) return;
      this.failed = true;
      console.error(`UNIFI_NETWORK_WRITE_LOG: cannot write the log (${err instanceof Error ? err.message : String(err)}); tool calls continue, but are not being logged.`);
    }
  }
}

/** Open the write log at startup, or exit with a configuration error. */
export function openWriteLog(path: string, apiKey: string): WriteLog {
  try {
    return WriteLog.open(path, apiKey);
  } catch (err) {
    console.error(`Configuration error: cannot use UNIFI_NETWORK_WRITE_LOG (${path}): ${err instanceof Error ? err.message : String(err)}`);
    return process.exit(1);
  }
}
