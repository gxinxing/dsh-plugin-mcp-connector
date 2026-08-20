import { loadServers, saveServers } from "./config.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { createHash } from "node:crypto";
//#region src/host/index.js
const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;
function publicToolName(serverName, rawName) {
	const joined = `mcp__${serverName}__${rawName}`;
	const normalized = joined.replace(INVALID_NAME_CHARS, "_");
	if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
	const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
	return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
function createTransport(server) {
	if (server.transport === "stdio") return new StdioClientTransport({
		command: server.command,
		args: server.args ?? [],
		env: {
			...scrubbedParentEnv(),
			...server.env ?? {}
		},
		cwd: server.cwd || void 0
	});
	if (server.transport === "sse") return new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } });
	if (server.transport === "streamable-http") return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } });
	throw new Error(`Unsupported transport: ${server.transport}`);
}
async function listToolsUncached(client, cursor) {
	return client.request({
		method: "tools/list",
		...cursor === void 0 ? {} : { params: { cursor } }
	}, ListToolsResultSchema);
}
async function callToolUncached(client, rawName, args, signal, timeoutMs) {
	return client.request({
		method: "tools/call",
		params: {
			name: rawName,
			arguments: args
		}
	}, {}, {
		signal,
		timeout: timeoutMs
	});
}
function createExecutor(client, rawName, timeoutMs) {
	return async (args, exec) => {
		const result = await callToolUncached(client, rawName, args ?? {}, exec.signal, timeoutMs);
		if (!Array.isArray(result.content)) {
			const text = typeof result.toolResult === "string" ? result.toolResult : "(no output)";
			if (result.isError === true) throw new Error(text);
			return { content: [{
				type: "text",
				text
			}] };
		}
		const text = result.content.map((b) => b.type === "text" ? b.text : `[${b.type}]`).join("\n");
		if (result.isError === true) throw new Error(text || "Tool returned an error");
		return { content: result.content };
	};
}
var ServerInstance = class {
	constructor(ctx, server) {
		this.ctx = ctx;
		this.server = server;
		this.client = null;
		this.disposers = /* @__PURE__ */ new Map();
		this.connected = false;
	}
	async start() {
		if (this.connected) return;
		const transport = createTransport(this.server);
		this.client = new Client({
			name: "dsh-mcp-connector",
			version: "0.1.0"
		}, { capabilities: {} });
		this.client.onclose = () => {
			this.connected = false;
			this.ctx.logger.warn(`mcp-connector(${this.server.serverName}): connection closed`);
		};
		this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			this.ctx.logger.info(`mcp-connector(${this.server.serverName}): tool list changed, re-syncing`);
			try {
				await this.syncTools();
			} catch (e) {
				this.ctx.logger.error(`mcp-connector(${this.server.serverName}): re-sync failed: ${e.message}`);
			}
		});
		try {
			await this.client.connect(transport);
			this.connected = true;
			await this.syncTools();
			this.ctx.logger.info(`mcp-connector(${this.server.serverName}): connected`);
		} catch (e) {
			this.connected = false;
			this.ctx.logger.error(`mcp-connector(${this.server.serverName}): connection failed: ${e.message}`);
			throw e;
		}
	}
	async syncTools() {
		const definitions = /* @__PURE__ */ new Map();
		let cursor;
		do {
			const response = await listToolsUncached(this.client, cursor);
			for (const tool of response.tools) {
				const publicName = publicToolName(this.server.serverName, tool.name);
				if (definitions.has(publicName)) throw new Error(`mcp-connector(${this.server.serverName}): duplicate tool "${tool.name}"`);
				definitions.set(publicName, {
					name: publicName,
					description: tool.description ?? `MCP tool ${tool.name}`,
					parameters: tool.inputSchema ?? {
						type: "object",
						additionalProperties: true
					},
					output: {
						schema: {
							type: "object",
							properties: { content: {
								type: "array",
								items: {}
							} },
							required: ["content"],
							additionalProperties: false
						},
						render(_args, value) {
							if (Array.isArray(value?.content)) return value.content.map((b) => b.type === "text" ? {
								type: "text",
								text: b.text
							} : {
								type: "text",
								text: JSON.stringify(b)
							});
							return [{
								type: "text",
								text: JSON.stringify(value)
							}];
						}
					},
					execute: createExecutor(this.client, tool.name, this.server.toolCallTimeoutMs ?? 6e4)
				});
			}
			cursor = response.nextCursor;
		} while (cursor);
		for (const dispose of this.disposers.values()) dispose();
		this.disposers.clear();
		try {
			for (const [name, def] of definitions) this.disposers.set(name, this.ctx.tools.register(def));
		} catch (e) {
			for (const dispose of this.disposers.values()) dispose();
			this.disposers.clear();
			this.ctx.logger.error(`mcp-connector(${this.server.serverName}): tool registration failed: ${e.message}`);
			return;
		}
	}
	async stop() {
		if (this.client) {
			try {
				await this.client.close();
			} catch {}
			this.client = null;
		}
		for (const dispose of this.disposers.values()) dispose();
		this.disposers.clear();
		this.connected = false;
	}
};
var host_default = {
	name: "mcp-connector",
	inject: [
		"tools",
		"subprocess",
		"fs",
		"harness",
		"timer",
		"webServer"
	],
	async apply(ctx) {
		const data = loadServers();
		const instances = /* @__PURE__ */ new Map();
		const logs = [];
		const MAX_LOGS = 500;
		ctx.on("tools/pre-execute", (exec, next) => {
			if (!exec.tool.name.startsWith("mcp__")) return next();
			exec.__mcpLog = {
				serverId: exec.tool.name.split("__")[1],
				toolName: exec.tool.name,
				args: exec.args,
				timestamp: Date.now()
			};
			return next();
		});
		ctx.on("tools/result", (exec, result) => {
			if (!exec.__mcpLog) return;
			logs.unshift({
				...exec.__mcpLog,
				result: result.value,
				isError: result.isError
			});
			if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
		});
		for (const server of data.servers) {
			if (!server.enabled) continue;
			const instance = new ServerInstance(ctx, server);
			instances.set(server.id, instance);
			try {
				await instance.start();
			} catch {}
		}
		const handlers = /* @__PURE__ */ new Map();
		const register = (method, fn) => {
			const dispose = ctx.harness.handle(method, fn);
			handlers.set(method, dispose);
		};
		register("mcp/list-servers", async () => {
			return data.servers.map((s) => ({
				id: s.id,
				serverName: s.serverName,
				transport: s.transport,
				enabled: s.enabled,
				connected: instances.get(s.id)?.connected ?? false
			}));
		});
		register("mcp/add-server", async (args) => {
			const server = {
				id: `srv_${Date.now().toString(36)}`,
				enabled: true,
				reconnect: {
					enabled: true,
					initialDelayMs: 500,
					maxDelayMs: 3e4,
					maxAttempts: 10
				},
				toolCallTimeoutMs: 6e4,
				...args
			};
			if (!server.serverName || !server.transport) throw new Error("serverName and transport are required");
			if (server.transport === "stdio" && !server.command) throw new Error("command is required for stdio");
			if ((server.transport === "sse" || server.transport === "streamable-http") && !server.url) throw new Error("url is required for HTTP transports");
			data.servers.push(server);
			saveServers(data);
			const instance = new ServerInstance(ctx, server);
			instances.set(server.id, instance);
			try {
				await instance.start();
			} catch (e) {
				ctx.logger.error(`mcp-connector: failed to start new server: ${e.message}`);
			}
			return {
				ok: true,
				id: server.id
			};
		});
		register("mcp/remove-server", async (args) => {
			const { id } = args;
			const instance = instances.get(id);
			if (instance) {
				await instance.stop();
				instances.delete(id);
			}
			data.servers = data.servers.filter((s) => s.id !== id);
			saveServers(data);
			return { ok: true };
		});
		register("mcp/toggle-server", async (args) => {
			const { id, enabled } = args;
			const server = data.servers.find((s) => s.id === id);
			if (!server) throw new Error("server not found");
			server.enabled = enabled;
			saveServers(data);
			if (enabled) {
				const instance = new ServerInstance(ctx, server);
				instances.set(id, instance);
				try {
					await instance.start();
				} catch (e) {
					ctx.logger.error(`mcp-connector: failed to start server: ${e.message}`);
				}
			} else {
				const instance = instances.get(id);
				if (instance) {
					await instance.stop();
					instances.delete(id);
				}
			}
			return { ok: true };
		});
		register("mcp/restart-server", async (args) => {
			const { id } = args;
			const instance = instances.get(id);
			if (instance) {
				await instance.stop();
				instances.delete(id);
			}
			const server = data.servers.find((s) => s.id === id);
			if (!server) throw new Error("server not found");
			const newInstance = new ServerInstance(ctx, server);
			instances.set(id, newInstance);
			try {
				await newInstance.start();
			} catch (e) {
				ctx.logger.error(`mcp-connector: restart failed: ${e.message}`);
			}
			return { ok: true };
		});
		register("mcp/get-logs", async () => {
			return logs.slice(0, 200);
		});
		const html = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
		const disposeRoute = ctx.get("webServer").register({
			kind: "prefix",
			path: "mcp",
			handler: async (req, res) => {
				const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
				const json = (status, body) => {
					res.writeHead(status, {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*"
					});
					res.end(JSON.stringify(body));
				};
				const readBody = async () => {
					const chunks = [];
					for await (const chunk of req) chunks.push(chunk);
					return JSON.parse(Buffer.concat(chunks).toString("utf8"));
				};
				if (pathname === "/" || pathname === "/index.html") {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(html);
					return;
				}
				if (pathname.startsWith("/api/")) {
					if (req.method === "OPTIONS") {
						res.writeHead(204, {
							"Access-Control-Allow-Origin": "*",
							"Access-Control-Allow-Methods": "POST, OPTIONS",
							"Access-Control-Allow-Headers": "Content-Type"
						});
						res.end();
						return;
					}
					if (req.method !== "POST") {
						json(405, { error: "Method Not Allowed" });
						return;
					}
					let body;
					try {
						body = await readBody();
					} catch {
						json(400, { error: "Invalid JSON" });
						return;
					}
					try {
						if (pathname === "/api/servers") json(200, await ctx.harness.handle("mcp/list-servers", {})());
						else if (pathname === "/api/servers/add") json(200, await ctx.harness.handle("mcp/add-server", body)());
						else if (pathname === "/api/servers/remove") json(200, await ctx.harness.handle("mcp/remove-server", body)());
						else if (pathname === "/api/servers/toggle") json(200, await ctx.harness.handle("mcp/toggle-server", body)());
						else if (pathname === "/api/servers/restart") json(200, await ctx.harness.handle("mcp/restart-server", body)());
						else if (pathname === "/api/logs") json(200, await ctx.harness.handle("mcp/get-logs", {})());
						else json(404, { error: "Not Found" });
					} catch (e) {
						json(500, { error: e.message });
					}
					return;
				}
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not Found");
			}
		});
		ctx.effect(() => {
			return async () => {
				disposeRoute();
				for (const dispose of handlers.values()) dispose();
				for (const instance of instances.values()) try {
					await instance.stop();
				} catch {}
			};
		});
	}
};
//#endregion
export { host_default as default };
