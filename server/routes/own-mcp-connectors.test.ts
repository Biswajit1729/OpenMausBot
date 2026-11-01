import { describe, expect, it } from "vitest";

import { ownMcpOverHttp } from "../drivers/turn-mcp.ts";
import { CONNECTOR_ENV_HEADER } from "./own-mcp-http-path.ts";
import { connectorMcpReply, registerConnectorEnv } from "./own-mcp-connectors.ts";

describe("the connectors MCP server over HTTP", () => {
  it("rejects an unknown env id", async () => {
    await expect(connectorMcpReply("0".repeat(64), "x", {})).rejects.toThrow("unknown connector env");
  });

  it("rejects a wrong token", async () => {
    const id = registerConnectorEnv({ OMB_CONNECTOR_TOKEN: "expected" });
    await expect(connectorMcpReply(id, "other", { jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow("unauthorized");
  });

  it("ownMcpOverHttp sends an opaque id, not the env", () => {
    const server = {
      name: "composio",
      command: process.execPath,
      args: ["/x/connector-proxy.js"],
      env: { OMB_HARNESS_URL: "http://127.0.0.1:8799", OMB_CONNECTOR_TOKEN: "t" },
    };
    const headers = ownMcpOverHttp(server)?.headers;
    expect(headers?.[CONNECTOR_ENV_HEADER]).toBe(registerConnectorEnv(server.env));
    expect(headers?.[CONNECTOR_ENV_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(ownMcpOverHttp({ ...server, env: { OMB_HARNESS_URL: server.env.OMB_HARNESS_URL } })).toBeNull();
  });
});
