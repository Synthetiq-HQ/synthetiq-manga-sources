#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrix = JSON.parse(await readFile(path.join(root, "certification/flagship-matrix.json"), "utf8"));
const reportPath = path.join(root, "reports/certification-latest.json");

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function fail(id, error) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: String(error?.message || error) },
  }) + "\n");
}

async function certify(moduleID, mode) {
  const allowedModes = new Set(["fixtures", "live", "ios", "all"]);
  if (!allowedModes.has(mode)) throw new Error("mode must be fixtures, live, ios, or all");
  const allowedModules = new Set(["all", ...matrix.modules.flatMap((entry) => [entry.id, entry.slug])]);
  if (!allowedModules.has(moduleID)) throw new Error("module is not in the certification matrix");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "scripts/source-certifier.mjs",
      "--module", moduleID,
      "--mode", mode,
      "--output", path.relative(root, reportPath),
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", async (code) => {
      let report = null;
      try { report = JSON.parse(await readFile(reportPath, "utf8")); } catch { /* return process evidence */ }
      const result = { ok: code === 0, exitCode: code, stdout: stdout.slice(-8_000), stderr: stderr.slice(-8_000), report };
      if (code === 0 || report) resolve(result);
      else reject(new Error(stderr || stdout || `certifier exited ${code}`));
    });
  });
}

const tools = [
  {
    name: "list_modules",
    description: "List source modules and scenarios in the flagship certification matrix.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "certify_module",
    description: "Run bounded fixture, live, iOS WebKit, or full certification for one source module.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string" },
        mode: { type: "string", enum: ["fixtures", "live", "ios", "all"] },
      },
      required: ["module"],
      additionalProperties: false,
    },
  },
  {
    name: "certify_flagships",
    description: "Run the full certification matrix for WeebCentral, Atsu, and MangaFire.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["fixtures", "live", "ios", "all"] } },
      additionalProperties: false,
    },
  },
  {
    name: "latest_report",
    description: "Read the latest machine-readable module certification report.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    try {
      if (message.method === "initialize") {
        reply(message.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "synthetiq-manga-module-certifier", version: "1.0.0" },
        });
      } else if (message.method === "tools/list") {
        reply(message.id, { tools });
      } else if (message.method === "tools/call") {
        const name = message.params?.name;
        const input = message.params?.arguments || {};
        let value;
        if (name === "list_modules") value = matrix;
        else if (name === "certify_module") value = await certify(input.module, input.mode || "all");
        else if (name === "certify_flagships") value = await certify("all", input.mode || "all");
        else if (name === "latest_report") value = JSON.parse(await readFile(reportPath, "utf8"));
        else throw new Error(`Unknown tool: ${name}`);
        reply(message.id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
      } else if (message.id != null) {
        reply(message.id, {});
      }
    } catch (error) {
      if (message.id != null) fail(message.id, error);
    }
  }
});
