# DSH MCP 一站式连接器插件

基于 DeepSeek Harness 的 MCP 协议可视化管理插件。提供 WebUI 面板，支持 stdio / SSE / Streamable HTTP 三种 MCP 传输模式，可动态添加、删除、启停 MCP 服务，并自动将 MCP 工具注册进 DSH 工具集。

## 功能特性

- 可视化面板：在 DSH Web GUI 中通过 `/mcp` 路径访问管理页面。
- 动态管理：添加 / 删除 / 启用 / 禁用 / 重启 MCP 服务，无需重启 DSH。
- 自动注册工具：启动的服务会自动把 MCP tools 注册到 DSH，模型可直接调用（名称规则 `mcp__<serverName>__<toolName>`）。
- 调用日志：捕获 MCP 工具的调用参数与返回结果，方便排错。
- 配置持久化：服务列表保存在 `~/.dsh/mcp-servers.json`。

## 快速开始

### 1. 安装依赖

```bash
cd dsh-plugin-mcp-connector
pnpm install
```

### 2. 构建（可选）

源码已经是 ESM，可直接使用 `lib/` 中的文件。如需重新构建：

```bash
pnpm build
```

### 3. 安装到 DSH Profile

假设你使用的是 `web` profile：

```bash
dsh plugin --profile web add .
```

安装后重启 DSH：

```bash
dsh --profile web
```

### 4. 打开管理面板

浏览器访问：

```
http://127.0.0.1:3080/mcp
```

（端口号以实际启动日志为准）

## 配置说明

配置文件路径：`~/.dsh/mcp-servers.json`

```json
{
  "servers": [
    {
      "id": "srv_abc123",
      "serverName": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "cwd": "",
      "env": {},
      "enabled": true,
      "reconnect": {
        "enabled": true,
        "initialDelayMs": 500,
        "maxDelayMs": 30000,
        "maxAttempts": 10
      },
      "toolCallTimeoutMs": 60000
    }
  ]
}
```

字段说明：
- `transport`: `stdio` | `sse` | `streamable-http`
- `command`: stdio 模式下可执行文件路径
- `args`: 参数数组
- `url`: SSE / Streamable HTTP 模式下的服务地址
- `headers`: HTTP 请求头
- `serverName`: 唯一命名空间，用于生成 DSH 工具名

## 工具命名规则

每个 MCP 工具在 DSH 中的公开名称为：

```
mcp__<serverName>__<rawToolName>
```

超出 DeepSeek 函数名长度限制（64 字符）或包含非法字符时会自动归一化并附加 SHA-256 哈希，避免冲突。

## 注意事项

- 本插件需要 DSH 内置的 `webServer`、`tools`、`subprocess` 等服务，仅支持 Web / Headless 等完整 profile。
- `dsh-mcp-client` 相关逻辑基于官方 `@deepseek-ai/dsh-mcp-client` 包实现，感谢 DeepSeek Harness 社区。
- 配置修改后新增的服务会立即尝试连接；禁用服务会断开连接并注销工具。

## License

MIT
