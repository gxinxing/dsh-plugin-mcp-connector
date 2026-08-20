#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const home = process.env.DSH_HOME || resolve(process.env.HOME, ".dsh");
const configPath = resolve(home, "mcp-servers.json");

try {
  const raw = readFileSync(configPath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.servers)) {
    console.error("Config validation failed: `servers` must be an array");
    process.exit(1);
  }
  for (const server of data.servers) {
    if (!server.id || !server.serverName || !server.transport) {
      console.error(`Config validation failed for server ${server.id || "unknown"}: missing required fields`);
      process.exit(1);
    }
  }
  console.log(`Config valid: ${data.servers.length} server(s) configured`);
} catch (error) {
  if (error.code === "ENOENT") {
    console.log("Config file not found, creating empty config");
    writeFileSync(configPath, JSON.stringify({ servers: [] }, null, 2) + "\n");
    process.exit(0);
  }
  console.error("Config validation failed:", error.message);
  process.exit(1);
}
