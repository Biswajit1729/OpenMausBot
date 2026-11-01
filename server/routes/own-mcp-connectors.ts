import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";

const TEN_MINUTES = 10 * 60_000;
const MAX_REGISTERED = 500;
const MAX_PROXIES = 32;
const registered = new Map<string, Record<string, string>>();

export function registerConnectorEnv(env: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  const id = createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  if (!registered.has(id) && registered.size >= MAX_REGISTERED) registered.delete(registered.keys().next().value!);
  registered.set(id, { ...env });
  return id;
}

type Proxy = {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  lines: Interface;
  pending: Map<string, (reply: unknown) => void>;
  idle?: NodeJS.Timeout;
};

const proxies = new Map<string, Proxy>();

function closeProxy(key: string, proxy: Proxy, error: Error): void {
  if (proxies.get(key) === proxy) proxies.delete(key);
  clearTimeout(proxy.idle);
  proxy.lines.close();
  for (const resolve of proxy.pending.values()) resolve(error);
  proxy.pending.clear();
}

function startProxy(key: string, env: Record<string, string>): Proxy {
  if (proxies.size >= MAX_PROXIES) {
    const oldestKey = proxies.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = proxies.get(oldestKey);
      if (oldest) {
        closeProxy(oldestKey, oldest, new Error("connector proxy evicted"));
        oldest.child.kill();
      }
    }
  }
  const child = spawn(process.execPath, [SPAWNED_PROXIES.connectors], {
    env: { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const proxy: Proxy = { child, lines: createInterface({ input: child.stdout, crlfDelay: Infinity }), pending: new Map() };
  proxies.set(key, proxy);
  child.stderr.on("data", (chunk: Buffer) => console.warn(`[connector-proxy] ${chunk.toString("utf8").trimEnd()}`));
  proxy.lines.on("line", (line) => {
    let reply: unknown;
    try {
      reply = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!reply || typeof reply !== "object" || !("id" in reply)) return;
    const id = JSON.stringify(reply.id);
    if (id === undefined) return;
    const resolve = proxy.pending.get(id);
    if (!resolve) return;
    proxy.pending.delete(id);
    resolve(reply);
  });
  child.once("exit", (code, signal) => closeProxy(key, proxy, new Error(`connector proxy exited (${code ?? signal ?? "unknown"})`)));
  child.once("error", (error) => closeProxy(key, proxy, error));
  child.stdin.on("error", (error) => closeProxy(key, proxy, error));
  return proxy;
}

function touchProxy(key: string, proxy: Proxy): void {
  if (proxies.get(key) === proxy) {
    proxies.delete(key);
    proxies.set(key, proxy);
  }
  clearTimeout(proxy.idle);
  proxy.idle = setTimeout(() => {
    closeProxy(key, proxy, new Error("connector proxy idle timeout"));
    proxy.child.kill();
  }, TEN_MINUTES);
  proxy.idle.unref();
}

export async function connectorMcpReply(envId: string, token: string, frame: Record<string, unknown>): Promise<unknown | undefined> {
  const stored = registered.get(envId);
  if (!stored) throw new Error("unknown connector env");
  const expected = Buffer.from(stored.OMB_CONNECTOR_TOKEN ?? stored.OMB_COMMS_TOKEN ?? "");
  const got = Buffer.from(token);
  if (!expected.length || expected.length !== got.length || !timingSafeEqual(expected, got)) throw new Error("unauthorized");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored)) if (k.startsWith("OMB_")) env[k] = v;

  const key = envId;
  const proxy = proxies.get(key) ?? startProxy(key, env);
  touchProxy(key, proxy);
  const line = `${JSON.stringify(frame)}\n`;
  if (frame.id === undefined) {
    proxy.child.stdin.write(line);
    return undefined;
  }
  const id = JSON.stringify(frame.id);
  if (id === undefined) throw new Error("invalid connector request id");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (proxy.pending.get(id) !== settle) return;
      proxy.pending.delete(id);
      reject(new Error("connector request timed out"));
    }, TEN_MINUTES);
    const settle = (reply: unknown) => {
      clearTimeout(timeout);
      if (reply instanceof Error) reject(reply);
      else resolve(reply);
    };
    proxy.pending.set(id, settle);
    try {
      proxy.child.stdin.write(line);
    } catch (error) {
      if (proxy.pending.get(id) === settle) proxy.pending.delete(id);
      clearTimeout(timeout);
      reject(error);
    }
  });
}
