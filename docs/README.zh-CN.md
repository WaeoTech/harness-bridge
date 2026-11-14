<div align="center">

[English](../README.md) · **简体中文**

# 🌉 Harness Bridge

### DSH 拆任务，Claude Code 执行，DSH 检查结果。

<img src="assets/harness-bridge-cover.jpg" alt="连接任务规划与代码执行的桥梁，以及返回父代理的验证路径" width="1000" />

[GitHub](https://github.com/WaeoTech/harness-bridge) · [安装与配置](#安装与配置) · [架构](architecture.md) · [验证记录](validation.md) · [Grok 配置](grok-compat.md)

</div>

Harness Bridge 是一个本地 DSH 插件，把已经安装的 Claude Code CLI 变成父 agent 可以调用的 `claude_code` 工具。它读取官方 `stream-json` 事件，返回会话 ID、任务结果、权限拒绝和费用估计；用户继续使用自己的 Claude Code 登录态。

当前为实验原型，目标 DSH 版本为 `0.2.0-rc.2`。[源码仓库](https://github.com/WaeoTech/harness-bridge)公开，npm 包尚未发布，请从源码本地安装。已在美国节点用真实 Claude Code `2.1.325`、Node `22.22.3` 和现有 Grok 反代完成普通回复、真实读文件、UUID 会话恢复、真实编辑与父进程算术检查。DSH 原生工具注册另在本机验证；完整 DSH GUI 会话、Anthropic 官方模型、macOS 和 Windows 尚未实测。详见[验证记录](validation.md)。

## 安装与配置

准备 Node.js 22+、目标版本 DSH、可供 DSH 插件管理器调用的 pnpm，以及已安装、已登录的 Claude Code：

```bash
git clone https://github.com/WaeoTech/harness-bridge.git
cd harness-bridge
node bin/cli.js doctor
node bin/cli.js run --cwd /absolute/project --prompt "审查认证模块，列出可验证的问题"
dsh plugin --profile web add "$PWD"
```

向 Web profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 增加已插入行的覆盖配置：

```yaml
- id: tool-harness-bridge
  config:
    workspaceRoot: /absolute/project
    executable: claude
    profile: zh-CN
    allowEdits: false
    maxTurns: 8
    maxBudgetUsd: 2
    timeoutMs: 300000
```

覆盖 `config` 时保留需要的所有字段。必须明确配置绝对 `workspaceRoot`；插件不会自动猜测当前 DSH 工作区。第一版一个实例对应一个工作区。同一插件实例只允许运行一个子任务。

配置完成后，用该 profile 启动 DSH。已有进程应通过其支持的配置编辑入口应用，或由用户自行重启；仅修改磁盘上的 patch 不保证热更新。

在权限模式为 `danger-full-access` 的 DSH 会话中说：

> 调用 claude_code 审查认证模块。给出具体验收条件，收到结果后由你检查对应源码；遇到登录或权限失败就停止。

需要编辑时，由操作者先设置 `allowEdits: true`，父 agent 再传 `mode: "edit"`。默认只开放 Read、Glob、Grep；编辑模式额外开放 Edit、Write。子 CLI 不开放 Bash 或 MCP。测试由父 DSH 在检查变更后执行。

卸载：

```bash
dsh plugin --profile web remove @waeotech/harness-bridge
```

## 使用过程

1. 用户提供目标、工作目录和验收条件。
2. DSH 读取必要背景，给 Claude Code 一个范围明确的任务。
3. 插件检查父会话权限、目录、编辑授权和运行限制。
4. 插件启动 `claude -p`，通过 stdin 发送 prompt，消费 `stream-json`。
5. 父 DSH 收到结构化结果，检查源码和实际 diff，再执行相关验证。
6. 验收通过则报告完成；需要补充时显式复用返回的 UUID。

插件当前向 DSH 返回最终结果，没有把 Claude 的逐 token 输出接入 Web GUI。独立 CLI 可加 `--events` 将原始事件写到 stderr；其中可能包含源码和任务内容。

## 语言、权限与账号

语言配置支持 `zh-CN`、`en-US`、`en-GB`、`ja-JP`，分别控制语言、拼写和表达方式。恢复会话时保持相同的语言配置；原型尚未持久化会话与语言的对应关系。语言风格不能证明用户国籍、所在地或账号资格，也不能保证不封号。

子 CLI 不能自动继承 DSH 文件沙箱，所以插件只在无限制 DSH 会话中执行。`workspaceRoot` 用于检查启动目录，**不是操作系统级文件访问边界**。Claude 的文件工具和本机权限仍由用户账户及 CLI 自身决定。

CLI 使用 `dontAsk`、明确工具清单和限制参数；没有启用跳过全部权限的选项。Claude print 模式仍可能加载用户或项目的 hooks、配置和指令，读取工具清单不保证 hooks 不写文件。只在信任的工作区运行；处理外部项目建议先使用可丢弃 worktree 并检查本地 Claude 配置。

DSH 适配器使用原生 subprocess 服务管理进程组和取消，继承环境会过滤凭据类变量，并保留正常 HOME 以使用用户已有登录态。独立 CLI 继承启动 shell 的环境。核心桥接不读取、复制或保存凭据文件；可选包装器可显式读取操作者指定的私有 provider 配置，父模型不能通过工具参数改变此路径。

已有 OpenAI/Grok 网关时，可把插件的 `executable` 指向可选包装器的启动脚本。当前测试的 Grok Web 路径不传递标准工具字段，需要显式开启 `textTools: true`，通过严格 JSON 请求真实工具；格式、工具名称和参数对象会被校验，具体参数由 CLI 工具验证。该模式仍可能返回虚假的完成声明，必须由父 DSH 检查文件与测试。[Grok 配置与限制](grok-compat.md)说明私有配置、启动脚本和支持范围。

预算和轮数转发给 Claude，费用为估计，不能当作强制计费防火墙；父 DSH 本身也有模型成本。遇到认证、权限、策略失败停止；不进行自动换号、重试登录或代理切换。父 agent 必须将子输出视为待检查的数据。

## 验证与后续

```bash
npm test
npm run check
npm pack --dry-run
```

本机 19 项自动测试全部通过，无跳过，覆盖分片 UTF-8/JSON、异常事件、结果与权限拒绝、目录检查、进程退出、超时、取消、原生工具注册、标准协议转换和严格 JSON 文本工具协议。原生适配器测试需要可解析的 DSH peer 包；没有 peer 时明确跳过。美国节点的真实读写和恢复已通过，但本次未覆盖完整 DSH GUI 会话、Anthropic 官方模型和跨平台安装。

下一阶段优先补齐真实 CLI 兼容矩阵、会话映射、worktree 隔离、父界面任务进度，以及有上限的“计划 → 执行 → 检查 diff → 跑测试 → 决定继续”循环。需要交互式工具审批时，再评估官方 Claude Agent SDK。

[架构与方案比较](architecture.md) · [完整英文说明](../README.md) · [MIT 许可证](../LICENSE)

README 展示结构参考 [qybaihe/bla](https://github.com/qybaihe/bla)，实现独立编写，不复用其安全能力、成绩、宣传指标或品牌。
