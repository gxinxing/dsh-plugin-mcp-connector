import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function configPath() {
  const home = process.env.DSH_HOME || join(process.env.HOME, ".dsh");
  return join(home, "mcp-servers.json");
}

export function loadServers() {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.servers)) return { servers: [] };
    return data;
  } catch {
    return { servers: [] };
  }
}

export function saveServers(data) {
  writeFileSync(configPath(), JSON.stringify(data, null, 2) + "\n");
}
