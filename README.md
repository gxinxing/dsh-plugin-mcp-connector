# MCP 一站式连接器

基于 DeepSeek Harness 的 MCP 协议可视化管理插件。

## 功能特性

- 可视化面板：在 DSH Web GUI 中通过 `/mcp` 路径访问管理页面
- 动态管理：添加 / 删除 / 启用 / 禁用 / 重启 MCP 服务
- 自动注册工具：启动的服务会自动把 MCP tools 注册到 DSH
- 调用日志：捕获 MCP 工具的调用参数与返回结果
- 配置持久化：服务列表保存在 `~/.dsh/mcp-servers.json`

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 构建
pnpm build

# 3. 安装到 DSH Profile
dsh plugin --profile web add .

# 4. 重启 DSH 并打开面板
dsh --profile web
# 浏览器访问 http://127.0.0.1:3080/mcp
```

## 传输模式

支持以下 MCP 传输模式：
- `stdio`：本地子进程通信
- `sse`：Server-Sent Events
- `streamable-http`：Streamable HTTP

## 工具命名规则

每个 MCP 工具在 DSH 中的公开名称为：

```
mcp__<serverName>__<rawToolName>
```

## License

MIT
