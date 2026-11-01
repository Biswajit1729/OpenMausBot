import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: spawnMock,
}));

import { connectorMcpReply, registerConnectorEnv } from "./own-mcp-connectors.ts";

describe("connector proxy environment", () => {
  it("round trips with only OMB_ env", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    let spawnOptions: unknown;
    spawnMock.mockImplementation((...args: unknown[]) => {
      spawnOptions = args[2];
      return child;
    });
    child.stdin.on("data", (chunk: Buffer) => {
      const frame = JSON.parse(chunk.toString("utf8")) as { id: unknown };
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { ok: true } })}\n`);
    });

    const id = registerConnectorEnv({ OMB_CONNECTOR_TOKEN: "t", NODE_OPTIONS: "--require /evil.js" });
    await expect(connectorMcpReply(id, "t", { jsonrpc: "2.0", id: 7, method: "tools/list" }))
      .resolves.toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    expect(spawnOptions).toMatchObject({ env: { ELECTRON_RUN_AS_NODE: "1" } });
    expect(spawnOptions).not.toHaveProperty("env.NODE_OPTIONS");
  });
});
