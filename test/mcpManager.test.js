import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { McpManager, buildMcpToolName, parseMcpToolName } from "../src/mcp/mcpManager.js";

function startMcpTestServer() {
  const state = {
    lastHeaders: null,
    lastExecuteBody: null
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    state.lastHeaders = req.headers;

    if (req.method === "GET" && url.pathname === "/tools") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          version: "2026.1",
          tools: [
            {
              name: "echo",
              description: "Echo back text.",
              input_schema: {
                type: "object",
                properties: {
                  text: { type: "string" }
                },
                required: ["text"]
              }
            }
          ]
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/resources") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          resources: [{ name: "repo_status", description: "Current repository summary." }]
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/prompts") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          prompts: [{ name: "triage_bug", description: "Bug triage prompt." }]
        })
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/tools/execute") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      state.lastExecuteBody = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          result: {
            echoed: state.lastExecuteBody?.arguments?.text ?? ""
          }
        })
      );
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        state,
        endpoint: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

test("mcp manager discovers tools/resources/prompts and executes tool call", async () => {
  const fixture = await startMcpTestServer();

  try {
    const manager = new McpManager({
      servers: [
        {
          id: "demo",
          type: "http",
          endpoint: fixture.endpoint,
          api_key_env: "DEMO_KEY",
          headers: {
            "x-api-key": "${DEMO_KEY}"
          }
        }
      ],
      env: {
        DEMO_KEY: "secret-demo-key"
      },
      timeoutMs: 3000
    });

    const discovery = await manager.discover({ force: true });
    assert.equal(discovery.servers.length, 1);
    assert.equal(discovery.errors.length, 0);
    assert.equal(discovery.toolDefinitions.length, 1);
    assert.equal(discovery.toolDefinitions[0].function.name, "mcp__demo__echo");
    assert.match(discovery.contextText, /repo_status/);
    assert.match(discovery.contextText, /triage_bug/);

    const result = await manager.executeToolCall({
      function: {
        name: "mcp__demo__echo",
        arguments: JSON.stringify({ text: "hello" })
      }
    });

    assert.deepEqual(result.result, { echoed: "hello" });
    assert.equal(result.meta.mcp_server_id, "demo");
    assert.equal(result.meta.mcp_server_version, "2026.1");
    assert.equal(result.meta.mcp_tool_name, "echo");
    assert.equal(fixture.state.lastHeaders.authorization, "Bearer secret-demo-key");
    assert.equal(fixture.state.lastHeaders["x-api-key"], "secret-demo-key");
    assert.equal(fixture.state.lastExecuteBody.name, "echo");
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test("mcp manager isolates per-server discovery failures", async () => {
  const fixture = await startMcpTestServer();

  try {
    const manager = new McpManager({
      servers: [
        {
          id: "healthy",
          type: "http",
          endpoint: fixture.endpoint
        },
        {
          id: "broken",
          type: "http",
          endpoint: "http://127.0.0.1:9"
        }
      ],
      timeoutMs: 500
    });

    const discovery = await manager.discover({ force: true });
    assert.equal(discovery.servers.length, 1);
    assert.equal(discovery.errors.length, 1);
    assert.equal(discovery.errors[0].id, "broken");
    assert.equal(discovery.toolDefinitions.length, 1);
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test("mcp tool name helpers round-trip", () => {
  const name = buildMcpToolName("demo", "echo");
  assert.equal(name, "mcp__demo__echo");
  assert.deepEqual(parseMcpToolName(name), {
    serverId: "demo",
    toolName: "echo"
  });
  assert.equal(parseMcpToolName("write_file"), null);
});
