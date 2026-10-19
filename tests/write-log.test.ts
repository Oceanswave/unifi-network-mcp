import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkClient } from "../src/client.js";
import { registerAllTools } from "../src/tools/index.js";
import { WriteLog, localTimestamp, openWriteLog, type WriteLogEntry } from "../src/write-log.js";
import { createMockServer, ZONES } from "./tools/_helpers.js";

// The client calls undici's fetch rather than the global one, so mock that.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({ ...await importOriginal<typeof import("undici")>(), fetch: fetchMock }));

/**
 * UNIFI_NETWORK_WRITE_LOG records every write tool call as one JSON line:
 * what was asked (redacted), what was sent (canonical path, no host), and how
 * it ended. The file is private to the operator, and a failing log never
 * breaks a call.
 */

const API_KEY = "test-api-key-fixture";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const page = (data: unknown[]) => ({ offset: 0, limit: 200, count: data.length, totalCount: data.length, data });

const ssid = {
  id: "w1", type: "STANDARD", name: "Office", enabled: true, broadcastingFrequenciesGHz: [5],
  securityConfiguration: { type: "WPA2_PERSONAL", passphrase: "test-passphrase-fixture" },
  multicastToUnicastConversionEnabled: false, clientIsolationEnabled: false, hideName: false,
  uapsdEnabled: false, arpProxyEnabled: false, bssTransitionEnabled: false, advertiseDeviceName: false,
  channel2gLockedTo6: false, dtimPeriod2gLockedTo3: false,
};

describe("write log", () => {
  let lines: string[];
  let call: (tool: string, input: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  const entries = () => lines.map((line) => JSON.parse(line) as WriteLogEntry);

  function setup({ readOnly = false, sink }: { readOnly?: boolean; sink?: (line: string) => void } = {}) {
    lines = [];
    const log = new WriteLog(sink ?? ((line) => { lines.push(line); }), API_KEY);
    const client = new NetworkClient({ host: "api.ui.com", consoleId: "console-77", apiKey: API_KEY, verifySsl: true, readOnly });
    const { server, handlers } = createMockServer();
    registerAllTools(server, client, readOnly, { writeLog: log });
    call = (tool, input) => handlers.get(tool)(input, {});
    return handlers;
  }

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, options: RequestInit) => {
      const { pathname } = new URL(url);
      if (options.method === "GET" && pathname.endsWith("/firewall/zones")) return Promise.resolve(json(page(ZONES)));
      if (options.method === "GET" && pathname.endsWith("/wifi/broadcasts/w1")) return Promise.resolve(json(ssid));
      return Promise.resolve(json({ id: "new" }));
    });
    setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a successful write with its canonical path and status", async () => {
    const result = await call("unifi_update_wifi", { siteId: "s1", wifiBroadcastId: "w1", hideName: true });
    expect(result.isError).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    const [entry] = entries();
    expect(entry).toEqual({
      ts: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      tsLocal: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/),
      tool: "unifi_update_wifi",
      args: { siteId: "s1", wifiBroadcastId: "w1", hideName: true },
      method: "PUT",
      path: "/integration/v1/sites/s1/wifi/broadcasts/w1",
      dryRun: false,
      outcome: "ok",
      status: 200,
      durationMs: expect.any(Number),
    });
    expect(Object.keys(entry).slice(0, 4)).toEqual(["ts", "tsLocal", "tool", "args"]);
    expect(lines[0]).not.toContain("api.ui.com");
    expect(lines[0]).not.toContain("console-77");
  });

  it("does not record read tools", async () => {
    await call("unifi_list_sites", {});
    await call("unifi_get_wifi", { siteId: "s1", wifiBroadcastId: "w1" });
    expect(lines).toEqual([]);
  });

  it("records a dry run with the request it would send, without the query", async () => {
    await call("unifi_delete_network", { siteId: "s1", networkId: "n1", force: true, dryRun: true });
    expect(entries()[0]).toMatchObject({
      tool: "unifi_delete_network", method: "DELETE", path: "/integration/v1/sites/s1/networks/n1", dryRun: true, outcome: "dry_run",
    });
    expect(entries()[0]).not.toHaveProperty("status");
  });

  it("records a WAN-exposure refusal, on a dry run too", async () => {
    const policy = { name: "In", enabled: true, action: { type: "ALLOW" }, source: { zoneId: "zone-external" }, destination: { zoneId: "zone-internal" } };
    await call("unifi_create_firewall_policy", { siteId: "s1", policy, confirm: true });
    await call("unifi_create_firewall_policy", { siteId: "s1", policy, dryRun: true });
    expect(entries().map(({ outcome, reason, method, path, dryRun }) => ({ outcome, reason, method, path, dryRun }))).toEqual([
      { outcome: "refused", reason: "wan_exposure", method: "POST", path: "/integration/v1/sites/s1/firewall/policies", dryRun: false },
      { outcome: "refused", reason: "wan_exposure", method: "POST", path: "/integration/v1/sites/s1/firewall/policies", dryRun: true },
    ]);
  });

  it("records a request-guard refusal", async () => {
    // The SDK would reject this ID; called directly, the guard is what stops it.
    await call("unifi_delete_network", { siteId: "s1", networkId: "..", confirm: true });
    expect(entries()[0]).toMatchObject({ outcome: "refused", reason: "request_guard", method: "DELETE", path: "/integration/v1/sites/s1/networks/.." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a missing confirmation", async () => {
    await call("unifi_delete_network", { siteId: "s1", networkId: "n1" });
    expect(entries()[0]).toMatchObject({ outcome: "refused", reason: "confirmation_required", method: null, path: null });
  });

  it("records a controller error with its status but never the body", async () => {
    fetchMock.mockResolvedValue(json({ code: "api.err", message: "private controller detail" }, 500));
    const result = await call("unifi_restart_device", { siteId: "s1", deviceId: "d1" });
    expect(result.content[0].text).toContain("private controller detail");
    expect(entries()[0]).toMatchObject({ outcome: "error", status: 500, method: "POST", path: "/integration/v1/sites/s1/devices/d1/actions" });
    expect(lines[0]).not.toContain("private controller detail");
  });

  it("records a network failure as an error with no status", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await call("unifi_restart_device", { siteId: "s1", deviceId: "d1" });
    expect(entries()[0]).toMatchObject({ outcome: "error", method: "POST" });
    expect(entries()[0]).not.toHaveProperty("status");
  });

  it("records an input error that sent nothing", async () => {
    await call("unifi_create_dns_policy", { siteId: "s1", type: "A_RECORD", enabled: true, domain: "x.example" });
    expect(entries()[0]).toMatchObject({ outcome: "error", method: null, path: null });
  });

  it("redacts secrets and anything keyed like one", async () => {
    await call("unifi_create_firewall_policy", {
      siteId: "s1",
      policy: { name: "Block", action: { type: "BLOCK" }, apiToken: "test-token-fixture", nested: { password: "test-password-fixture", privateKey: { pem: "x" } }, secret: 42 },
    });
    await call("unifi_update_wifi", {
      siteId: "s1", wifiBroadcastId: "w1",
      securityConfiguration: { type: "WPA2_PERSONAL", passphrase: "test-new-passphrase-fixture", presharedKeys: [{ passphrase: "test-vlan-passphrase-fixture", network: { type: "NATIVE" } }] },
    });
    const [policy, wifi] = entries();
    expect(policy.args).toEqual({
      siteId: "s1",
      policy: { name: "Block", action: { type: "BLOCK" }, apiToken: "[REDACTED]", nested: { password: "[REDACTED]", privateKey: "[REDACTED]" }, secret: "[REDACTED]" },
    });
    expect(wifi.args).toMatchObject({ securityConfiguration: { type: "WPA2_PERSONAL", passphrase: "[REDACTED]", presharedKeys: "[REDACTED]" } });
    for (const secret of ["test-token-fixture", "test-password-fixture", "test-new-passphrase-fixture", "test-vlan-passphrase-fixture", "test-passphrase-fixture"]) expect(lines.join("")).not.toContain(secret);
  });

  it("never logs the API key, even when the model passes it as an argument", async () => {
    await call("unifi_create_voucher", { siteId: "s1", name: `note ${API_KEY}`, timeLimitMinutes: 60, count: 1 });
    await call("unifi_restart_device", { siteId: "s1", deviceId: "d1" });
    expect(fetchMock.mock.calls[0][1].headers["X-API-KEY"]).toBe(API_KEY);
    expect(lines.join("")).not.toContain(API_KEY);
    expect(entries()[0].args).toMatchObject({ name: "note [REDACTED]" });
  });

  it("keeps the call working when the log cannot be written, and says so once", async () => {
    const errorMock = vi.spyOn(console, "error").mockImplementation(vi.fn());
    setup({ sink: () => { throw new Error("ENOSPC: no space left on device"); } });
    const first = await call("unifi_restart_device", { siteId: "s1", deviceId: "d1" });
    const second = await call("unifi_restart_device", { siteId: "s1", deviceId: "d2" });
    expect([first.isError, second.isError]).toEqual([undefined, undefined]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(String(errorMock.mock.calls[0][0])).toContain("ENOSPC");
  });

  it("formats the local timestamp with the zone offset", () => {
    const date = new Date("2026-10-18T12:34:56.789Z");
    const local = localTimestamp(date);
    expect(new Date(local).getTime()).toBe(date.getTime());
  });
});

describe("WriteLog.open", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unifi-log-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const mode = (path: string) => statSync(path).mode & 0o777;

  it("creates the file 0600 and missing directories 0700", () => {
    const path = join(dir, "a", "b", "writes.jsonl");
    WriteLog.open(path, API_KEY);
    expect(mode(path)).toBe(0o600);
    expect(mode(join(dir, "a", "b"))).toBe(0o700);
    expect(mode(join(dir, "a"))).toBe(0o700);
  });

  it("appends to an existing file and leaves an existing directory alone", async () => {
    chmodSync(dir, 0o755);
    const path = join(dir, "writes.jsonl");
    writeFileSync(path, "{\"earlier\":true}\n", { mode: 0o600 });
    const log = WriteLog.open(path, API_KEY);
    await log.record("unifi_restart_device", { siteId: "s1", deviceId: "d1", dryRun: true }, () => Promise.resolve({ content: [] }));
    const fileLines = readFileSync(path, "utf8").trim().split("\n");
    expect(fileLines).toHaveLength(2);
    expect(JSON.parse(fileLines[1])).toMatchObject({ tool: "unifi_restart_device", outcome: "ok", dryRun: true });
    expect(mode(dir)).toBe(0o755);
  });

  it("refuses a symlink", () => {
    const target = join(dir, "target.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, join(dir, "link.jsonl"));
    expect(() => WriteLog.open(join(dir, "link.jsonl"), API_KEY)).toThrow(/symlink/);
  });

  it("refuses a dangling symlink rather than creating its target", () => {
    symlinkSync(join(dir, "elsewhere.jsonl"), join(dir, "link.jsonl"));
    expect(() => WriteLog.open(join(dir, "link.jsonl"), API_KEY)).toThrow(/symlink/);
    expect(existsSync(join(dir, "elsewhere.jsonl"))).toBe(false);
  });

  it.each([0o664, 0o646, 0o666, 0o620])("refuses a file with mode %o, which others can write", (fileMode) => {
    const path = join(dir, "writes.jsonl");
    writeFileSync(path, "");
    chmodSync(path, fileMode);
    expect(() => WriteLog.open(path, API_KEY)).toThrow(/group- or world-writable/);
  });

  it("accepts a file others can only read", () => {
    const path = join(dir, "writes.jsonl");
    writeFileSync(path, "");
    chmodSync(path, 0o644);
    expect(() => WriteLog.open(path, API_KEY)).not.toThrow();
  });

  it("refuses a file with another hard link", () => {
    const path = join(dir, "writes.jsonl");
    writeFileSync(path, "", { mode: 0o600 });
    linkSync(path, join(dir, "other"));
    expect(() => WriteLog.open(path, API_KEY)).toThrow(/hard links/);
  });

  it("refuses a directory", () => {
    mkdirSync(join(dir, "log"));
    expect(() => WriteLog.open(join(dir, "log"), API_KEY)).toThrow();
  });

  it("stops the server with a configuration error when the file is unusable", () => {
    symlinkSync("/etc/passwd", join(dir, "link.jsonl"));
    const errorMock = vi.spyOn(console, "error").mockImplementation(vi.fn());
    const exitMock = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    openWriteLog(join(dir, "link.jsonl"), API_KEY);
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(String(errorMock.mock.calls[0][0])).toMatch(/^Configuration error: cannot use UNIFI_NETWORK_WRITE_LOG .*symlink/);
  });
});
