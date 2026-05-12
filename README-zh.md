<p align="center">
  <img src="docs/assets/phantom.svg" alt="Phantom" width="120" height="120" />
</p>

<h1 align="center">Phantom</h1>
<p align="center">一个拥有自己电脑的 AI 同事。</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/tests-1819%20passed-brightgreen.svg" alt="Tests">
  <a href="https://hub.docker.com/r/ghostwright/phantom"><img src="https://img.shields.io/docker/pulls/ghostwright/phantom.svg" alt="Docker Pulls"></a>
  <img src="https://img.shields.io/badge/version-0.20.2-orange.svg" alt="Version">
</p>

<p align="center">
  <a href="https://ghostwright.dev/phantom">网站</a> &middot;
  <a href="https://ghostwright.dev/phantom">免费获取 Phantom</a> &middot;
  <a href="docs/">文档</a> &middot;
  <a href="https://github.com/ghostwright/phantom/issues">问题</a>
</p>

---

## 核心理念

当今的 AI 代理是一次性的。你打开聊天，得到答案，关闭标签页，上下文就消失了。下次你又得从头开始。每个会话都是第一天。

Phantom 采用了不同的方法：**给 AI 它自己的电脑。** 一台专用机器，让它安装软件、启动数据库、构建仪表板、记住你上周告诉它的事情，并且每天都在你的工作中变得更好。你的笔记本电脑仍然是你的。代理的工作区是它自己的。

这不是一个聊天机器人。它是一个在 Slack 上运行的同事，有 Web 聊天界面在 `/chat`，有自己的电子邮件地址，能创建自己的工具，并且无需许可就能构建基础设施。不要只听我们说——往下滚动看看生产环境中的 Phantom 实际构建了什么。

## 实际效果展示

这些不是模型图。它们发生在生产环境的 Phantom 实例上。

### 从零构建分析平台

一个 Phantom 被要求帮助数据分析。它在自己的 VM 上安装了 ClickHouse，下载了完整的 Hacker News 数据集，加载了跨越 2007-2021 年的 2870 万行数据，构建了带有交互式图表的分析仪表板，并创建了 REST API 来查询数据。然后它将该 API 注册为 MCP 工具，以便在未来的会话中使用，其他代理也可以查询。

没有人要求它构建这些。它识别出分析是有用的，并构建了整个技术栈。

<p align="center">
  <img src="docs/assets/story-clickhouse.gif" alt="Phantom 构建了包含 2870 万行 Hacker News 数据的 ClickHouse 分析仪表板" width="800" />
</p>

*2870 万条数据。75.5 万独立作者。430 万篇文章。由 Phantom 在自己的机器上构建、加载和服务。*

### 用从未内置的渠道扩展了自己

Phantom 内置了 Slack、Telegram、Email 和 Webhook 渠道。它没有内置 Discord。当被问到"我能在 Discord 上和你聊天吗？"时，Phantom 说："现在还不行。Discord 还没有接入。不过，我可以构建它。"

它解释了 Discord Bot API，引导用户创建 Discord 应用程序，提供了安全令牌提交的魔法链接，并说："一旦你保存它，我就会自动启动容器，你就上线 Discord 了。"

提交令牌后，Phantom 在 Discord 上线了。它永久获得了一个从未设计过的通信渠道。

<p align="center">
  <img src="docs/assets/story-discord.png" alt="Phantom 在被要求时为自己构建了 Discord 支持" width="800" />
</p>

*代理坦诚地说出了它不能做什么，然后当场构建了这个能力。*

### 开始监控自己的基础设施

一个 Phantom 发现了 [Vigil](https://github.com/baudsmithstudios/vigil)，一个只有 3 个 GitHub star 的轻量级开源系统监控工具。它理解了 Vigil 的功能，将其集成到现有的 ClickHouse 实例中，构建了每 30 秒批量传输指标的同步管道，并创建了实时监控仪表板，显示服务健康状态、Docker 容器状态、网络 I/O、磁盘 I/O、系统负载和数据管道健康状况。

890,450 行数据。25 个指标。自动刷新。代理正在监控自己的基础设施。

<p align="center">
  <img src="docs/assets/story-vigil.gif" alt="Phantom 使用 Vigil 和 ClickHouse 监控自己的基础设施" width="800" />
</p>

*它找到了一个 3 星的开源项目，将其集成到数据管道中，为自己构建了可观测性。*

---

这就是当你给 AI 它自己的电脑时会发生的事情。

## 自带模型

Phantom 不锁定于任何单一的 AI 后端。它开箱即用地支持七个提供商，通过单个 YAML 块配置：

- **Anthropic**（默认）- Claude Opus、Sonnet、Haiku
- **Z.AI** - 通过 [Z.AI 的 Anthropic 兼容 API](https://docs.z.ai/guides/llm/glm-5) 使用 GLM-5.1 和 GLM-4.5-Air。比 Claude Opus 便宜约 15 倍，编码质量相当。
- **OpenRouter** - 一个密钥访问 100+ 模型
- **Ollama** - 在你自己的 GPU 上运行任何 GGUF 模型，零 API 成本
- **vLLM** - 自托管推理，兼容 OpenAI 端点
- **LiteLLM** - 本地代理，桥接 OpenAI、Gemini 等
- **自定义** - 任何兼容 Anthropic Messages API 的端点

切换提供商只需两行 YAML：

```yaml
# phantom.yaml
model: claude-opus-4-7
provider:
  type: zai
  api_key_env: ZAI_API_KEY
  model_mappings:
    sonnet: glm-5.1
```

在 `.env` 中设置 `ZAI_API_KEY`，重启，完成。从那时起，主代理和每个进化流程都通过选定的提供商运行。工具相同，记忆相同，自进化管道相同。只有大脑改变了。

Anthropic 仍然是默认的。现有部署无需任何配置更改即可继续工作。完整参考请参见 [docs/providers.md](docs/providers.md)。

## 快速开始

### Docker（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/ghostwright/phantom/main/docker-compose.user.yaml -o docker-compose.yaml
curl -fsSL https://raw.githubusercontent.com/ghostwright/phantom/main/.env.example -o .env
# 编辑 .env - 添加你的 ANTHROPIC_API_KEY、Slack 令牌和 OWNER_SLACK_USER_ID
docker compose up -d
```

你的 Phantom 正在运行。Qdrant 启动用于记忆，Ollama 拉取嵌入模型，代理启动。在 `http://localhost:3100/health` 检查健康状态。配置好 Slack 后，它会在准备就绪时给你发私信。添加 `RESEND_API_KEY` 用于发送邮件。完整设置请参见 [Getting Started](docs/getting-started.md)。

> **安全提示，Docker socket 挂载：** `docker-compose.yaml` 将
> `/var/run/docker.sock` 挂载到 Phantom 容器中，以便它可以生成同级
> 容器（例如沙箱代码执行）。这是一个有意的
> 架构权衡：socket 授予容器**对 Docker 守护进程的 root 等效
> 访问权限**，这意味着被入侵的 Phantom 进程
> 可以创建、修改或销毁主机上的任何容器。缓解措施：
> 在专用机器或 VM 上运行 Phantom（不要用你的个人工作站），
> 并且不要将主机的 Docker socket 暴露给不受信任的工作负载。完整威胁模型请参见
> [docs/security.md](docs/security.md)。

### 托管（免费）

在专用 VM 上获取 Phantom，无需安装任何东西。带上你的 Anthropic API 密钥，我们给你机器。

**[ghostwright.dev/phantom](https://ghostwright.dev/phantom)**

## 人们用 Phantom 构建了什么

Phantom 不仅仅是为工程师准备的。它是为任何想要一个能记忆、学习和构建可以实际分享的东西的 AI 的人准备的。

**关键区别：** 当 AI 运行在你的笔记本电脑上时，它构建的一切都被困在 localhost 上。只有你能看到它。Phantom 运行在有公共域名的 VM 上。仪表板、工具、页面、API——它们都有一个你可以发送给团队、经理或客户的 URL。你的笔记本电脑不是服务器。Phantom 的 VM 是。

### 为不写代码的人

你不需要安装开发者工具、学习构建系统或搞清楚托管。你在 Slack 中描述你想要什么。Phantom 构建它，在自己的机器上部署它，然后给你一个链接。

- **"给我构建一个高亮过期邮件的 Chrome 扩展。"** Phantom 构建它并给你一个 zip 文件。你把它拖到 Chrome 里。没有 Xcode，没有 npm，没有终端。只需安装即可使用。
- **"为我的副业做一个着陆页。"** Phantom 构建页面，在其公共域名上服务，并给你一个 URL。发送给任何人。无需托管设置，无需域名配置。
- **"创建一个我们开放支持工单的周报。"** Phantom 构建自动化，按计划运行，每周五从自己的电子邮件地址发送摘要给你。
- **"构建一个团队可以提交功能请求的表单。"** Phantom 在其域名上创建它，处理提交，并将它们路由到 Slack。

### 软件工程

- **每日站会：** "每个工作日上午 9 点，总结开放的 PR、CI 状态和需要审核的内容。" Phantom 检查 GitHub，编译摘要，并发布到你的团队频道。
- **代码库入门：** "克隆这个仓库并给我一个架构概述。" Phantom 阅读代码并返回具体内容，而不是泛泛而谈。"Next.js 16 with App Router, Drizzle ORM on Neon Postgres, 迁移检查中有不稳定的步骤。"
- **基础设施：** "为这个项目设置一个开发 Postgres。" Phantom 在自己的机器上启动 Docker 容器，创建 schema，运行迁移，并给你一个连接字符串。你的笔记本电脑上没有安装任何东西。
- **数据管道：** "每小时从我们的 API 拉取数据并加载到 Postgres。" Phantom 构建管道，在其 VM 上运行数据库，并安排定时任务。你得到一个连接字符串。
- **自定义 MCP 工具：** "创建一个查询我们内部 API 的 MCP 工具。" Phantom 构建工具，注册它，任何连接到它的 Claude Code 实例都可以立即调用。

### 销售和客户管理

- **潜在客户研究：** "研究这 10 家公司并构建外展策略。" Phantom 收集情报，识别决策者，并创建你可以与团队分享的简报页面。
- **招聘档案：** "为这个候选人制作一个档案页面。" Phantom 研究这个人并构建一个公开档案页面，你可以发送给招聘经理。带认证的可分享 URL。
- **竞争对手监控：** "每 2 分钟检查与我们产品类似的开源仓库。" Phantom 运行定时任务，跟踪新进入者，并在 Slack 中发布更新。

### 数据和分析

- **构建你自己的分析栈：** Phantom 安装数据库，构建 ETL 管道，并将 API 注册为 MCP 工具供未来会话使用。全部在自己的机器上。（参见上面的 ClickHouse 故事。）
- **可分享仪表板：** "跟踪我们的 PR 速度并展示给团队。" Phantom 构建一个 ECharts 仪表板，在带认证的公共 URL 上服务，并发送链接给你。你的团队收藏它。他们看到的和你一样。
- **数据探索：** "加载这个数据集并让我提问。" Phantom 在其 VM 上创建可查询环境。你用 plain English 提问，它翻译成 SQL。

### 运营、市场和其他所有人

- **自动化报告：** "每周五给团队负责人发送开放问题的周报。" Phantom 编译报告并从自己的电子邮件地址发送。
- **竞争对手观察：** "监控这五个网站的变化，有更新时告诉我。" Phantom 按计划检查并在 Slack 中通知你。
- **博客草稿：** "根据我们最近的产品更新写一篇文章。" Phantom 阅读变更日志，撰写草稿，并作为页面服务，你可以审阅并与编辑分享。
- **个人教练：** "为我创建一个训练计划。" Phantom 构建一个完整的计划，带有教练人设，作为页面服务，你可以每天参考。

### 适用于所有人

- 记住你上周一告诉它的事情，并在周三使用它。
- 永远不会问同样的问题两次。
- 每天在 YOUR 工作中变得更好，而不仅仅是做一个通用助手。

## 有何不同

大多数 AI 助手运行在你的电脑上，共享你的资源，并在会话之间忘记一切。Phantom 围绕不同的假设设计：代理应该有自己的工作区。

| | 传统（运行在你的机器上） | Phantom（自己的机器） |
|--------|-----------------------------------|--------------------------|
| **你的电脑** | 与代理共享 | 完全属于你 |
| **安全** | 代理可以访问你的完整文件系统 | 隔离的 VM，你控制它能看到什么 |
| **凭据** | 通常以明文存储在配置文件中 | AES-256-GCM 加密，通过安全表单收集 |
| **分享** | 困在 localhost，其他人看不到 | 带认证的公共 URL，与任何人分享 |
| **工具** | 固定集合，安装时定义 | 运行时创建自己的工具，跨重启持久化 |
| **可用性** | 仅当你的机器开机时 | 24/7，在云中运行 |
| **成本** | 使用你的 CPU 和内存 | $7-20/月用于专用 VM |

## 为什么这很重要

**"为什么它需要自己的电脑？"**

因为你可能有 8GB 的笔记本电脑，却能花 $20/月 给你的代理 64GB 内存。因为它可以安装软件、启动数据库、运行服务而不碰你的机器。因为它始终在线，即使你的笔记本电脑合上了。因为它构建的一切都有公共 URL——仪表板、API、页面、工具——你用链接分享。你的笔记本电脑做不到。它没有公共 IP。Phantom 的 VM 有。

**"为什么自进化很重要？"**

因为第 1 天的 Phantom 是通用的。第 30 天的 Phantom 知道你的代码库、部署流程、PR 惯例，以及你最大的客户在续费前总是询问正常运行时间。你永远不需要重复自己。代理观察、反思、提出更改建议，通过不同的模型验证（以避免自我增强偏差），并进化。每个版本都被存储。你可以回滚。

**"为什么动态工具很重要？"**

因为只能使用预构建工具的代理会遇到天花板。Phantom 构建它需要的东西。一个 Phantom 构建了 `send_slack_message` 工具，注册了它，并淘汰了旧的变通方案。该工具在重启后仍然存在。通过 MCP 连接的其他代理也可以使用它。

## 功能

| 功能 | 为什么重要 |
|---------|----------------|
| **自己的电脑** | 你的笔记本电脑仍然是你的。代理安装软件，24/7 运行，在自己的机器上构建基础设施。 |
| **自带模型** | Anthropic、Z.AI (GLM-5.1)、OpenRouter、Ollama、vLLM、LiteLLM 或任何兼容 Anthropic Messages API 的端点。在 YAML 中选择你的后端，同一个代理处处适用。 |
| **自进化** | 代理在每次会话后重写自己的配置，由 LLM 评委验证。第 30 天知道第 1 天不知道的事情。 |
| **持久记忆** | 三层向量记忆。周一提到的事情，周三就会用到。无需重复解释。 |
| **动态工具** | 在运行时创建和注册自己的 MCP 工具。工具在重启后仍然存在，跨会话工作。 |
| **加密密钥** | AES-256-GCM 加密表单，带魔法链接认证。配置文件中没有明文凭据。 |
| **邮件身份** | 每个 Phantom 都有自己的电子邮件地址。向 Slack 工作区之外的人发送报告。 |
| **Web 聊天** | 完整的基于浏览器的聊天客户端在 `/chat`，支持 SSE 流、文件附件和 Web Push 通知。无需 Slack。 |
| **可分享页面** | 在带认证的公共 URL 上生成仪表板和工具。分享链接，任何人都能看到。 |
| **MCP 服务器** | Claude Code 连接到你的 Phantom。其他 Phantom 连接到你的 Phantom。它是 API，不是死胡同。 |

## 架构

<div align="center">

```
            External Clients
  Claude Code | Dashboard | Other Phantoms
                    |
          MCP (Streamable HTTP)
                    |
+------------------------------------------+
|        PHANTOM (Bun process)             |
|                                          |
|  Channels       Agent Runtime            |
|  Slack          query() + hooks          |
|  Web Chat       Prompt Assembler         |
|  Telegram       base + role + evolved    |
|  Email          + memory context         |
|  Webhook / CLI                           |
|                                          |
|  Memory System  Self-Evolution Engine    |
|  Qdrant         6-step pipeline          |
|  Ollama         5-gate validation        |
|  3 collections  LLM judges (optional)    |
|                                          |
|  MCP Server     Role System              |
|  8 universal    YAML-first roles         |
|  + role tools   Onboarding flow          |
|  + dynamic      Evolution focus          |
+------------------------------------------+
            |                |
       +---------+      +---------+
       | Qdrant  |      | SQLite  |
       | Docker  |      |   Bun   |
       +---------+      +---------+
```

</div>

## 从 Claude 连接

首先，生成令牌。命令输出一个 bearer 令牌。保存它以备下一步使用。

**裸机：**
```bash
bun run phantom token create --client claude-code --scope operator
```

**Docker：**
```bash
docker exec phantom bun run phantom token create --client claude-code --scope operator
```

**或者直接在 Slack 中问你的 Phantom：** "为 Claude Code 创建一个 MCP 令牌。" 它会生成令牌并给你配置片段。

然后使用令牌连接。将下面的 `YOUR_TOKEN` 替换为上面命令中的令牌。对于本地实例，使用 `http://localhost:3100/mcp` 代替 `ghostwright.dev` URL。

### Claude Code（CLI）

通过 CLI 添加：

```bash
claude mcp add phantom https://your-phantom.ghostwright.dev/mcp \
  --transport http \
  --header "Authorization: Bearer ***
```

或直接添加到项目的 `.mcp.json`：

```json
{
  "mcpServers": {
    "phantom": {
      "type": "http",
      "url": "https://your-phantom.ghostwright.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

### Claude Desktop

Claude Desktop 仅支持 stdio 传输，因此你需要 [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) 来桥接连接。

将此添加到 `claude_desktop_config.json`（设置 → 开发者 → 编辑配置）：

```json
{
  "mcpServers": {
    "phantom": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-phantom.ghostwright.dev/mcp",
        "--header",
        "Authorization: Bearer ***
      ]
    }
  }
}
```

保存后重启 Claude Desktop。首次连接可能需要一点时间，因为 `mcp-remote` 需要下载。

### 验证

连接后，Claude 可以查询你的 Phantom 的记忆、提问、检查状态，以及使用代理构建的任何动态工具。

## 自进化

核心差异化优势。每次会话后：

1. **观察** - 从对话中提取纠正、偏好和领域事实
2. **评估** - 将会话表现与当前配置进行比较
3. **生成** - 提出最小、有针对性的配置更改
4. **验证** - 5 道关卡：宪法、回归、大小、漂移、安全
5. **应用** - 写入批准的更改，递增版本号
6. **整合** - 定期将观察压缩为原则

安全关键关卡使用 Sonnet 作为默认的跨模型评委（主代理运行在 Opus 上，因此评委运行在 Sonnet 上以避免自我增强偏差）。操作员可以选择 Opus 评委以获得更深入的推理，但成本更高。三评委投票，少数否决：一个反对的评委就能阻止更改。每个版本都被存储。你可以比较第 1 天和第 30 天。你可以回滚。

## Ghostwright 生态系统

Phantom 是 Ghostwright 家族的第四个产品：

- **[Ghost OS](https://github.com/ghostwright/ghost-os)** - macOS 辅助功能和屏幕感知的 MCP 服务器
- **[Shadow](https://github.com/ghostwright/shadow)** - Mac 的环境捕获和回忆
- **[Specter](https://github.com/ghostwright/specter)** - Hetzner 上的 VM 配置，带 DNS、TLS 和 systemd
- **Phantom** - 自主同事

<details>
<summary><strong>开发环境设置</strong></summary>

```bash
git clone https://github.com/ghostwright/phantom.git
cd phantom
bun install

# 启动向量数据库和嵌入模型
docker compose up -d qdrant ollama
docker exec phantom-ollama ollama pull nomic-embed-text

# 初始化配置
bun run phantom init --yes

# 设置你的 API 密钥
export ANTHROPIC_API_KEY=sk-ant-...

# 启动
bun run phantom start
```

```bash
bun test              # 1584 个测试
bun run lint          # Biome
bun run typecheck     # tsc --noEmit
```

详细的 Slack 设置、.env 配置、VM 部署和故障排除请参见 [docs/getting-started.md](docs/getting-started.md)。

</details>

## 贡献

我们需要帮助来开发新的角色模板、渠道集成、记忆策略和跨环境测试。如果你正在构建能学习和改进的 AI 代理，这就是你的项目。

指南请参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

Apache 2.0。使用它、修改它、部署它、在它基础上构建。参见 [LICENSE](LICENSE)。
