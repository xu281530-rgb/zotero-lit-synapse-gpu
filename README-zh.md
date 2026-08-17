# Zotero MCP - Model Context Protocol Integration for Zotero

Zotero MCP 是一个开源项目，旨在通过模型上下文协议（Model Context Protocol, MCP）将强大的 AI 功能与领先的文献管理工具 Zotero 无缝集成，为 AI 助手（如 Claude）提供与您本地 Zotero 文献库交互的能力。
_This README is also available in: [:gb: English](./README.md) | :cn: 简体中文._
[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org)
[![Version](https://img.shields.io/badge/Version-1.9.2-brightgreen)]()
[![EN doc](https://img.shields.io/badge/Document-English-blue.svg)](README.md)
[![中文文档](https://img.shields.io/badge/文档-中文-blue.svg)](README-zh.md)

---

## 关注我们

| 公众号                       |                                           加入群聊                                            |
| :--------------------------- | :-------------------------------------------------------------------------------------------: |
| ![Reading PDF](./IMG/MP.jpg) | 扫左侧公众号二维码，关注后私信「入群」即可（群二维码有时效且群已满 200 人，无法直接扫码加入） |

## 📚 项目概述

Zotero MCP 服务器是一个基于 Model Context Protocol 的工具服务器，它为 Claude Desktop 等 AI 应用提供了与 Zotero 文献管理系统的无缝集成。通过此服务器，AI 助手可以：

- 🔍 **智能搜索**：多维度搜索文献库（标题/作者/年份/标签/全文/语义），支持布尔运算和相关性评分
- 📖 **内容提取**：获取 PDF 全文、笔记、摘要、网页快照等多种内容，支持精细的模式控制
- 📝 **批注分析**：按颜色、标签、关键词检索和分析 PDF 高亮与注释
- 📂 **分类浏览**：浏览和搜索分类层级结构，获取分类下的条目
- 🧠 **语义搜索**：基于 AI 向量嵌入的概念匹配，发现跨语言的相关文献
- ✏️ **写入操作**：创建笔记、管理标签、更新元数据、创建新条目并关联附件
- 💾 **全文数据库**：访问和搜索缓存的 PDF 全文内容

这使得 AI 助手能够帮助您进行文献综述、引用管理、内容分析、批注整理、知识库管理等学术工作。

## 🚀 项目结构

本项目采用了**统一架构**，将 MCP 服务器集成在插件内：

- **`zotero-mcp-plugin/`**: 一个集成了 **MCP 服务器功能**的 Zotero 插件，使用 Streamable HTTP 协议直接与 AI 客户端通信
- **`IMG/`**: 截图和说明文档图片
- **`README.md`** / **`README-zh.md`**: 项目说明文档

**统一架构：**

```
AI 客户端 ↔ Streamable HTTP ↔ Zotero 插件（集成 MCP 服务器）
```

这种设计消除了对单独 MCP 服务器进程的需求，提供了更加简化和高效的集成方式。

---

## 🚀 快速上手指南

本指南旨在帮助普通用户快速配置和使用 Zotero MCP，让您的 AI 助手能够与 Zotero 文献库无缝协作。

### 1. 快速使用教程（面向普通用户）

**Zotero MCP 是什么？**

简单来说，Zotero MCP 是一座桥梁，它连接了您的 AI 客户端（如 Cherry Studio, Gemini CLI, Claude Desktop 等）和本地的 Zotero 文献管理软件。通过它，AI 助手可以直接搜索、查询和引用您 Zotero 库中的文献，极大地提升学术研究和写作效率。

**两步快速开始：**

1.  **安装插件**：
    - 从提供本项目给您的人那里获取最新的 `zotero-mcp-plugin-x.x.x.xpi` 文件（或参考下方开发者指南自行构建）。
    - 在 Zotero 中，通过 `工具 -> 附加组件` 安装该 `.xpi` 文件。
    - 重启 Zotero。

2.  **配置插件**：
    - 在 Zotero 的 `首选项 -> Zotero MCP Plugin` 标签页中：
      - **启用服务器**：勾选此选项启动集成的 MCP 服务器
      - **端口设置**：默认为 `23120`（可根据需要修改）
      - **生成客户端配置**：点击此按钮获取适用于您 AI 客户端的配置代码
    - 将生成的配置代码复制到您的 AI 客户端配置文件中

配置完成后，您就可以在 AI 助手中通过自然语言与您的 Zotero 文献库进行交互了。

**配置示例（Claude Desktop）：**

```json
{
  "mcpServers": {
    "zotero": {
      "transport": "streamable_http",
      "url": "http://127.0.0.1:23120/mcp"
    }
  }
}
```

**使用示例:**

- `"帮我查找一下我的 Zotero 库里所有关于"人工智能"的文献"`
- `"获取去年由 Hinton 发表的关于 transformer 的期刊文章"`
- `"查找 DOI 为 10.1038/nature14539 的文献"`

---

### 2. 连接 AI 客户端

**重要**：Zotero 插件现在包含了**集成的 MCP 服务器**，使用 Streamable HTTP 协议。无需安装单独的服务器。

#### Streamable HTTP 连接

插件使用 Streamable HTTP 协议，支持与 AI 客户端的实时双向通信：

1. 在 Zotero 插件设置中**启用服务器**
2. 点击**生成客户端配置**按钮
3. 将生成的配置**复制到您的 AI 客户端**

#### 支持的 AI 客户端

- **Claude Desktop**: Streamable HTTP MCP 支持
- **Cherry Studio**: Streamable HTTP 支持
- **Cursor IDE**: Streamable HTTP MCP 支持
- **自定义实现**: Streamable HTTP 协议

### 验证与故障排查

配置完成后，如何确认一切正常工作？

**1. 验证连接**

- **查看客户端状态**：大多数 AI 客户端（如 ChatBox, Cherry Studio）的 MCP 配置界面会显示服务器的连接状态。如果显示为 "Connected" 或绿色指示灯，说明连接已成功建立。
- **使用测试命令**：在 AI 助手的聊天框中，发送一个简单的测试命令，例如：
  `"使用 zotero 工具查找任何文献，返回一条即可"`
  如果 AI 能够调用 `zotero.search_library` 并返回结果，说明整个链路已通。

**2. 故障排查指南**

如果连接失败或工具不工作，请按以下步骤排查：

| 步骤  | 检查项              | 解决方案                                                                                                                                                                |
| :---- | :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **Zotero 插件服务** | 确保 Zotero 正在运行，并且在 `首选项 -> Zotero MCP Plugin` 中，"Enable Server" 已被勾选。                                                                               |
| **2** | **路径配置**        | 确认 AI 客户端中的 `command` 设置为 `node`，并且作为参数的 `index.js` **绝对路径**完全正确。路径错误是导致失败的最常见原因。                                            |
| **3** | **端口冲突**        | 如果 Zotero 插件端口 `23119` 被占用，请在插件设置中更换端口，并在 `zotero-mcp-server` 目录下创建 `.env` 文件，内容为 `ZOTERO_API_PORT=新端口号`。                       |
| **4** | **查看日志**        | 大多数客户端都提供 MCP 服务器的日志输出功能。在 MCP 配置界面寻找 "Show Logs" 或类似的按钮。日志是定位问题的最有效工具，通常会明确指出是路径错误、命令失败还是其他问题。 |
| **5** | **防火墙/安全软件** | 确认您的防火墙或安全软件没有阻止 `node.exe` (Windows) 或 `node` (macOS/Linux) 的网络通信。                                                                              |
| **6** | **环境依赖**        | 确保您的系统中已安装 Node.js (版本 18+)。您可以在终端中运行 `node -v` 来检查版本。                                                                                      |

**3. 常见错误信息**

- **`command not found` 或 `spawn ENOENT`**: 通常表示 `node` 命令不存在或路径错误。请检查 Node.js 是否已正确安装并加入了系统环境变量，或者检查客户端配置中的命令是否正确。
- **`Error: connect ECONNREFUSED 127.0.0.1:23119`**: 表示 MCP 服务器无法连接到 Zotero 插件。请执行上述排查指南的第 1 步和第 3 步。
- **JSON 格式错误**: 在手动编辑配置文件时，请确保您的 JSON 语法正确，没有遗漏逗号或括号。

如果以上步骤均无法解决问题，请联系插件维护者，并附上您的操作系统、客户端版本和相关的日志信息，以便更好地帮助您。

---

## 🧩 插件功能特性

`zotero-mcp-plugin` 是一个集成了 MCP 服务器功能的 Zotero 插件，直接与 AI 客户端通信。

### 主要功能

- **集成 MCP 服务器**: 内置 MCP 服务器，使用 Streamable HTTP 协议，无需额外进程
- **高级搜索引擎**: 支持全文搜索、布尔运算、相关性评分，按标题、作者、年份、标签、文献类型等多维度筛选
- **统一内容提取**: 从 PDF、附件、笔记、摘要、网页快照中提取内容，支持四种模式（minimal/preview/standard/complete）
- **智能批注系统**: 按颜色、标签、关键词搜索和检索 PDF 高亮、注释和笔记，支持智能排序
- **分类管理**: 浏览、搜索分类层级结构，获取分类详情、子分类和条目列表
- **语义搜索**: 基于 AI 向量嵌入的语义搜索，支持 OpenAI/Ollama API，发现概念相关的文献
- **写入功能**: 创建/修改笔记、管理标签、更新元数据字段、创建新条目并关联独立 PDF
- **全文数据库**: 缓存的 PDF 全文数据库，支持列表、搜索、获取和统计操作
- **独立附件管理**: 搜索和管理只有 PDF 没有元数据信息的独立条目
- **客户端配置生成器**: 自动为各种 AI 客户端生成配置
- **安全性**: 仅本地操作，确保数据完全隐私
- **用户友好**: 通过 Zotero 首选项界面轻松配置

---

## 效果展示

这里是一些展示 Zotero MCP 功能的截图：

| 功能                      |                   截图                    |
| :------------------------ | :---------------------------------------: |
| **功能说明**              |      ![功能说明](./IMG/功能说明.png)      |
| **文献检索**              |      ![文献检索](./IMG/文献检索.png)      |
| **元数据查看**            |    ![元数据查看](./IMG/元数据查看.png)    |
| **全文读取 1**            |    ![全文读取 1](./IMG/全文读取1.png)     |
| **全文读取 2**            |    ![全文读取 2](./IMG/全文读取2.png)     |
| **附件检索 (Gemini CLI)** | ![附件检索](./IMG/geminicli-附件检索.png) |
| **PDF 读取 (Gemini CLI)** | ![PDF 读取](./IMG/geminicli-pdf读取.png)  |

---

## 👨‍💻 开发者安装指南

### 前置要求

- **Zotero** 7.0 或更高版本
- **Node.js** 18.0 或更高版本（仅用于开发）
- **npm** 或 **yarn** 包管理器（仅用于开发）
- **Git**（仅用于开发）

### 步骤 1: 安装和配置 Zotero 插件

1. 自行构建最新的 `zotero-mcp-plugin-x.x.x.xpi` 文件（见下方步骤 2），或获取他人提供的预构建版本
2. 在 Zotero 中，通过 `工具 -> 附加组件` 安装该 `.xpi` 文件
3. 在 Zotero 的 `首选项 -> Zotero MCP Plugin` 标签页中，配置服务器设置：
   - **启用服务器**：启动集成的 MCP 服务器
   - **端口设置**：默认为 `23120`
   - **生成客户端配置**：点击按钮获取适用于您 AI 客户端的配置

### 步骤 2: 开发环境设置（可选）

如果您想要修改或开发插件，可以按照以下步骤设置开发环境：

1. 获取本仓库（克隆或直接复制项目目录）后进入目录：

   ```bash
   cd zotero-mcp
   ```

2. 设置插件开发环境：

   ```bash
   cd zotero-mcp-plugin
   npm install
   npm run build
   ```

3. 在 Zotero 中加载插件：

   ```bash
   # 开发模式（自动重载）
   npm run start

   # 或手动安装构建后的 .xpi 文件
   npm run build
   ```

### 步骤 3: 连接 AI 客户端

插件包含了集成的 MCP 服务器，使用 Streamable HTTP 协议：

**Streamable HTTP 连接示例（Claude Desktop）：**

1. 找到 Claude Desktop 配置文件：
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Linux**: `~/.config/Claude/claude_desktop_config.json`

2. 编辑配置文件：

   ```json
   {
     "mcpServers": {
       "zotero": {
         "transport": "streamable_http",
         "url": "http://127.0.0.1:23120/mcp"
       }
     }
   }
   ```

3. 重启 Claude Desktop 应用

### 步骤 4: 开始使用

配置完成后，您就可以在 AI 助手中通过自然语言与您的 Zotero 文献库进行交互了。

**示例:**

- `"帮我查找一下我的 Zotero 库里所有关于“人工智能”的文献"`
- `"获取去年由 Hinton 发表的关于 transformer 的期刊文章"`
- `"查找 DOI 为 10.1038/nature14539 的文献"`

---

## 👨‍💻 开发者文档

### 技术架构

```
┌─────────────┐  Streamable HTTP  ┌──────────────────────────────┐
│ AI 客户端    │ <--------------> │ Zotero 插件（集成 MCP 服务器） │
│ (Claude, etc) │                   │ + 内置API + 数据访问        │
└─────────────┘                   └──────────────────────────────┘
```

1. **AI 客户端** 通过 Streamable HTTP 协议直接与插件通信
2. **Zotero 插件** 内置 MCP 服务器，处理 MCP 请求并调用 Zotero API
3. **数据处理** 在插件内部完成，无需额外进程
4. **响应返回** 直接发送给 AI 客户端

### 插件开发

1. 进入插件目录并安装依赖：
   ```bash
   cd zotero-mcp-plugin
   npm install
   ```
2. 启动开发模式：

   ```bash
   npm start
   ```

   这将启动 Zotero 并自动加载插件。代码更改时会自动重载。

3. 构建插件 `.xpi` 文件：
   ```bash
   npm run build
   ```

### MCP 服务器开发

MCP 服务器已集成在插件内，位于 `src/modules/streamableMCPServer.ts`。主要功能：

- Streamable HTTP 连接管理
- MCP 协议处理
- 工具调用路由
- 错误处理和日志记录

---

## 🔧 API 参考（MCP 工具列表）

所有工具定义只写在一处——`src/modules/toolCatalog.ts`——MCP 的 `tools/list`
响应与 HTTP `/capabilities` 文档都由它投影得到。**不存在需要人工同步的第二份
清单**，`npm run test:tool-catalog` 会在两份投影出现分歧时让构建失败。

插件集成的 MCP 服务器提供以下 **28 个工具**，分为 4 大类：

### 一、搜索与查询（12 个）

#### `hybrid_search`

检索漏斗的第一段。该工具并行执行 Zotero 元数据关键词检索和语义向量检索，
再融合成一个 0-1 的相关度分数，不扫描全库正文。

**两路如何融合**：两路各自按绝对尺度归一化，然后取**较强的一路**作为基准分，
较弱的一路以有上限的「一致性加成」形式叠加。因此佐证只会抬高分数，不会稀释
——一篇仅凭语义证据就超过阈值的文献，再加一个弱关键词命中依然超过阈值。
RRF（Reciprocal Rank Fusion）也会计算，但**只用于融合分数相同时的并列决胜**；
`rrfK` 调的是这个决胜，不是排序本身。

返回的是**轻量候选行**：`itemKey`、题名、作者、年份、期刊、该文献的书写语言、
融合分数 `score`、命中来源 `matchedBy`、`matchedKeywords` / `matchedFields`、
`hasAbstract`，以及少量最相关段落的证据摘录。

**摘要不再随结果返回**。摘要仍然参与关键词检索、语义检索与排序，只是不再一并
发回——20 篇候选里通常只有几篇需要细看。需要看摘要时，对那一篇单独调用
`get_item_abstract`。若用户只问哪些文献相关，直接用这些候选行回答即可。

**分页**。`topK` 是「一页多少篇」，不是「这次检索挖多深」。响应里带一个
`pagination` 块：`appliedMinScore`（本次生效的阈值）、`totalRelevant`（**通过
阈值的文献总数**，通常不止一页）、`returned`、`offset`、`range`、`hasMore`、
`nextCursor`。顺序是 **召回 → 评分排序 → 按 minScore 过滤 → 再分页**，所以后
面的页永远不会出现低于阈值的文献，最后一页短也绝不会拿低分结果凑数。把
`nextCursor` 原样作为 `cursor` 传回（其余参数保持不变或省略），就能在**同一份
已排好序的名单**上继续往下看——它不会重新检索，因此不会重复、遗漏或改变顺序。
带着 cursor 同时改 `query` / `keywords` / `domain` / `expertRole` / `minScore`
会被拒绝：那是另一次检索，应该重新发起。分页状态保留 15 分钟、最近 5 次检索；
cursor 过期会明确报错，而不是悄悄重新搜一遍。

**检索深度**。两路召回都是**穷尽**的：融合层拿到的是全部候选，`ranked` 里是所有
通过阈值的文献，`results` 只是它上面的一扇窗口，所以不存在「候选池被挖满、池外
还有合格文献」这回事，也没有 `candidateK` 这个参数。`totalRelevant` 是精确值，
只有在某一路检索失败或超时时才降级为下界，此时 `pagination.degradedRetrieval`
与 `pagination.totalRelevantIsLowerBound` 会同时置位。

#### `search_library`

高级文献库搜索，支持多维度筛选、布尔运算、相关性评分和智能模式控制。

| 参数                 | 类型    | 描述                                                                       |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `q`                  | string  | 通用搜索关键词                                                             |
| `title`              | string  | 标题搜索（支持 `titleOperator`: contains/exact/startsWith/endsWith/regex） |
| `yearRange`          | string  | 年份范围（如 "2020-2023"）                                                 |
| `fulltext`           | string  | 全文搜索（附件/笔记内容），支持 `fulltextMode`: attachment/note/both       |
| `itemType`           | string  | 文献类型筛选（journalArticle/book/attachment 等）                          |
| `includeAttachments` | string  | 设为 "true" 可搜索独立 PDF 条目                                            |
| `mode`               | string  | 处理模式：minimal(30)/preview(100)/standard(自适应)/complete(500+)         |
| `relevanceScoring`   | boolean | 启用相关性评分                                                             |
| `sort`               | string  | 排序：relevance/date/title/year                                            |
| `limit` / `offset`   | number  | 分页控制                                                                   |

#### `search_annotations`

按关键词、颜色或标签搜索批注，支持智能排序和相关性过滤。

| 参数       | 类型     | 描述                                                              |
| ---------- | -------- | ----------------------------------------------------------------- |
| `q`        | string   | 搜索关键词（与 colors/tags 至少提供一个）                         |
| `itemKeys` | string[] | 限定搜索范围到指定条目                                            |
| `types`    | string[] | 批注类型：note/highlight/annotation/ink/text/image                |
| `colors`   | string[] | 按颜色过滤（支持色名或 hex：yellow/red/green/blue/purple/orange） |
| `tags`     | string[] | 按标签过滤                                                        |
| `mode`     | string   | 内容处理模式                                                      |

每条命中带三个互不相同的 key，其中只有一个是文献级 key：`sourceItemKey` 是
**文献条目**，`attachmentKey` 是批注所在的 PDF/附件，`annotationKey` 是批注
本身。继续往下查一律用 `sourceItemKey`——`get_annotations(itemKeys)`、
`get_item_details`、`search_fulltext`、`get_document_chunks` 认的都是它。

> 1.9.1 之前每行只有一个 `parentKey`，它对高亮是附件 key、对笔记是文献 key。
> 把高亮的 `parentKey` 交给 `get_annotations` 会一条都匹配不到，返回一个空页，
> 看上去像「这篇没有标记」而不像「你传错了 key 的种类」。这个字段是直接删除
> 而不是标记弃用：一个名字两种含义本身就是缺陷，留着就等于把故障留着。

当这条标记上面根本没有文献时——用户自己写的顶层笔记，或者挂在未归档附件上的
标记——`sourceItemKey` 是 **null**，并由 `noSourceItemReason` 说明是哪一种。
它绝不会用替代值填上：独立笔记的自身 key 一度充当过这个角色，而在真实库里实测，
拿它调 `get_annotations` 返回 0 条，调 `get_document_chunks` 则报「它有一个文本
附件但未建索引」——笔记根本没有附件。**所有文献级工具都拒收的 key，就不是文献
级 key。**

把附件 key、笔记 key 或批注 key 交给 `get_item_details`、`get_document_chunks`、
`search_fulltext`，现在会被明确拒绝，并告诉你该用哪个 key。此前
`get_item_details` 传附件 key 会「成功」返回，标题是 PDF 文件名。

#### `search_fulltext`

检索漏斗的第三段：对 `hybrid_search` 定位到的**单篇**文献做正文级混合检索
（关键词 + 语义，同一套融合评分与阈值）。全库正文扫描已禁用。

调用前应先用 `get_item_abstract` 读该篇摘要，据此把 `domain` 与 `expertRole`
重新贴合到这篇论文，并根据它自身的研究内容重写 `query` 与 `keywords`——
**关键词用该文献自身的语言书写，只用一种语言**：单篇文档内部，另一种语言的
探针匹配不到任何内容，只会稀释关键词覆盖度。

| 参数             | 类型     | 描述                                     |
| ---------------- | -------- | ---------------------------------------- |
| `itemKey`        | string   | **必需**，要深入的那一篇                 |
| `query`          | string   | 针对该篇写的自然语言检索句               |
| `keywords`       | string[] | 该篇专属探针，使用该文献自身的语言       |
| `domain`         | string   | 重新贴合该篇的学科/子领域                |
| `expertRole`     | string   | 针对该篇采用的专家视角                   |
| `chunkIds`       | number[] | 上下文扩展：拉取指定段落的相邻段落       |
| `neighborRadius` | number   | 上下文扩展半径，受用户设置上限约束       |
| `maxChunks`      | number   | 返回段落数上限，受用户设置上限约束       |
| `minScore`       | number   | 相关度下限，只能比用户设置更严格         |

#### `search_collections`

按名称查找分类，用于「用户提到某个文件夹名、你需要它的 `collectionKey`」。
返回的是身份与路径，不是内容。参数：`q`、`limit`、`libraryID`。

#### `get_libraries`

列出当前 Zotero 客户端里的所有文献库。参数：`limit`、`offset`。

#### `search_libraries`

按名称查找文献库，用于用户提到某个群组库、你需要它的 `libraryID` 时。
参数：`q`（必需）、`limit`、`offset`。

#### `get_annotations`

读取**你自己在指定文献上留下的标记**：PDF 高亮、批注、图片/墨迹批注，以及你在
Zotero 里手写的笔记。**笔记正文从这里读**——`get_item_details` 不再返回笔记
正文，因为元数据查询顺带把用户的私人笔记发回去时，没有任何标记说明哪些话是
谁写的。

`itemKeys`、`itemKey`、`annotationId`、`annotationIds` 四者传其一。`itemKeys`
支持**多篇**，而且每一篇都会真的读到——这正是「对比我在这五篇上的标记」能一次
调用完成的原因。`itemKeys` 收的是**文献条目 key**——即 `search_annotations`
命中行里的 `sourceItemKey`，而不是它的 `attachmentKey`；返回的每一行也都带着
自己的 `sourceItemKey`，多篇混在一页时仍然各归各的来源。

结果始终分页：一篇读透的 PDF 有几百条高亮，而 `complete` 以前的含义是「一次
全部返回」。

- `itemKeys`、`itemKey`、`annotationId`、`annotationIds`、`types`、`colors`、
  `tags`、`detail`（minimal/preview/standard/complete）、`maxTokens`、`limit`、
  `offset`、`libraryID`

#### `get_item_details`

**文献元数据详情工具**，用于引用与著录。返回标题、作者、日期、类型、期刊、
卷期页、DOI、URL、语言、标签、所属分类（含路径），以及每个附件一行的基本信息。

**不返回任何正文内容**：没有摘要正文、没有 Notes 正文、没有批注正文、没有 PDF
正文、没有 chunks——这四类各有专门的工具按需返回并正确分页。这里给出的是
**可用性**：`hasAbstract` / `abstractChars` 告诉你 `get_item_abstract` 会返回
什么而不返回它，`noteCount` 告诉你 `get_annotations` 能找到几条笔记。

`fullText` 使用与全部检索结果**同一套五态全文状态**（`indexed` / `parse_failed`
/ `no_source` / `not_indexed` / `unknown`），取代了原先按附件给的
`hasFulltext` 布尔值——那个值只看文件扩展名，因此对从未解析成功的 PDF 也报
「有全文」。按附件的判断仍在，改名为 `hasExtractableText`，含义是「这种文件类型
可能能抽出文本」。

参数：`itemKey`（必需）、`mode`（minimal/standard/complete）、`libraryID`。

#### `get_item_abstract`

检索漏斗的第二段：按需获取**单篇**摘要。只在你确实考虑深入阅读某篇时才调用，
一次一个 `itemKey`；它不是 `hybrid_search` 之后的批处理步骤——20 篇候选不等于
20 次摘要读取。参数：`itemKey`（必需）、`format`（json/text）。

#### `get_attachment_text`

**获取指定文献条目下某一个附件的文本内容**——PDF、Markdown/HTML/纯文本文件——
除此之外什么都不返回。它取代了 `get_content`：后者把摘要、Notes、每个附件的
正文和网页快照混在一个对象里返回，既无法只要其中一路，也完全没有分页。

**选择附件**。只传 `itemKey` 会返回该条目的附件清单而不返回正文；再带上你要的
`attachmentKey` 调用一次即可。条目下只有一个可出文本的附件时会自动选中
（`selectedAutomatically: true`）；有两个时**绝不猜**——读错附件返回的文本看起来
完全正常，却属于另一篇文档。

**明确文本来源**。每次响应都在 `textSource.method` 里说明文本是哪条路径产出的，
并附一句 `description` 说明可以据此主张什么：`doc2x`（保留出版结构，最好）、
`mineru_cache` / `mineru_attachment`（复用已有 MinerU Markdown，版面是重建的）、
`mineru`（本次调用现场解析）、`markdown_attachment`、`zotero_fulltext_cache`
（Zotero 自带全文索引，**无版面、无表格**）、`pdf_processor`、`html_parsing`、
`text_reading`。取不到文本时，method 会说明原因：`mineru_disabled`、
`mineru_on_demand_disabled`、`mineru_failed`、`mineru_error`、`no_text`。

**分页**。文本按字符窗口返回，并在附近有段落或句子边界时切在边界上，所以一个
窗口不会断在词中间。`pagination` 里有 `totalChars`、`offset`、`returnedChars`、
`hasMore`、`nextOffset`。

它**不承担全文检索职责**：定位文献用 `hybrid_search` / `keyword_search`，在单篇
内部查找用 `search_fulltext`。

- `itemKey`（必需）、`attachmentKey`、`offset`、`limit`、`libraryID`

### 二、分类管理（3 个）

#### `get_collections`

列出分类，主要用途是让你读到用户真实的文件夹名，再把相关的作为 `collectionKeys`
传给 `hybrid_search` 限定范围。扁平分页列表：默认列顶层分类，或者
`parentCollection` 的直接子级。

响应结构是 `{ results, pagination, metadata }`。1.9.1 之前它返回的是一个裸
JSON 数组、总数只放在 `X-Total-Count` 响应头里，而 MCP 只转发 body，所以总数
和服务端挂上去的 `metadata` 都被 `JSON.stringify` 静默丢弃了——300 条里的第
一页 100 条，和一共就 100 条的完整库，返回的东西一模一样。`search_collections`
用同一个信封。

参数：`parentCollection`、`mode`、`limit`、`offset`、`libraryID`。

> `recursive` 已在 1.9.1 删除。它一次返回所有层级且不分页，和
> `get_collection_items` 重复，等于把逐级浏览刚取代掉的整体倾倒又放了回来。
> 现在传它会直接报错而不是被忽略。想知道某个子树里有什么，用
> `get_collection_items`——它按文件夹给出 `directItemCount`、`totalItemCount`
> 和 `hasChildren`，不需要把整棵树拉下来。

> `get_subcollections` 已在 1.9.0 删除：它就是本工具把 `parentCollection` 改名成
> `collectionKey`，最终进的是同一个 handler、走同一段递归。改用
> `get_collections` 并传 `parentCollection`。

#### `get_collection_details`

单个分类的元数据：名称、父级、含多少条目与子分类。它**不列出**这些内容。
参数：`collectionKey`（必需）。

#### `get_collection_items`

**像文件浏览器一样逐级浏览文献库**。每次调用只返回当前这一层的子目录，加上当前
层**直属**文献的一页——绝不返回整棵树。

不传 `collectionKey` 就从文献库顶层开始（顶层分类，以及不属于任何分类的文献），
然后传入想进入的目录的 `collectionKey` 逐级下探。每次响应都会重复当前位置
（`location`：`libraryID`、`collectionKey`、`name`、`path`）和你来时的 `parent`，
所以随时能往回走。

每个子目录行带 `directItemCount`、`totalItemCount`、`hasChildren`——这正是「不打开
就能决定往哪下探」的依据：`directItemCount` 为 0 而 `totalItemCount` 有 300 的
目录是个容器，不是死胡同。`totalItemCount` 会去重，同时归在父目录和子目录下的
一篇文献只算一篇。

文献行刻意做得很轻：`itemKey`、标题、作者、年份、期刊、DOI、类型。**没有摘要、
Notes、批注、附件正文或 chunks**——旧版本直接用 `formatItem` 的默认字段表，两条
就有 4.5 KB，列一个 200 篇的目录要吃掉大半个上下文窗口。

- `collectionKey`、`path`（如 `"材料/凝固/柱状晶"`，会解析成 key；路径有歧义时
  **报错并列出候选 key**，绝不猜）、`limit`、`offset`、`libraryID`
- 返回 `location`、`parent`、`subcollections`、`items`、`itemPagination`

### 三、语义检索与阅读（5 个，可在偏好设置中禁用）

`hybrid_search`、`keyword_search`、`semantic_search` 返回**完全相同的轻量候选
行**，共用同一套范围限定、同一个用户阈值和同一套 cursor 分页，所以三者之间切换
没有额外学习成本。它们在实现上也是共用的：一份词法检索服务
（`runLexicalSearch`）、一份语义检索服务（`SemanticSearchService.search`）、
一份分页存储、一份候选行投影——**不存在三套检索算法**。

#### `keyword_search`

**独立关键词检索**，只在 Zotero 元数据（标题、摘要、作者、期刊名、标签）上做
词法匹配。不涉及任何 embedding，也不扫描正文。

两种用途：一是用户点名的精确术语、缩写、牌号、标准号，必须一条不漏；二是——也是
设计意图——**关键词粗筛**，把它返回的 `itemKeys` 交给 `semantic_search` 作为
`itemKeys`，让语义精查只在这份短名单上打分。日常文献发现仍应首选
`hybrid_search`，因为它同时跑这一路和语义那一路并做融合。

- `keywords`（新检索时必需；中英双语，1–16 个，推荐 5–12）、`query`（只用于
  缺省时生成机械回退探针，**永远不会被 embedding**）、`domain`、`expertRole`、
  `collectionKeys`、`itemKeys`、`topK`、`cursor`、`minScore`、`libraryID`

#### `semantic_search`

**纯语义检索**：把一句自然语言查询做 embedding，与全部已索引段落比对。适合概念或
机理明确、但用词无法确定的问题，也适合作为 `keyword_search` 粗筛之后的精查。

1.9.0 之前，这是全插件最后一个还停在旧架构上的工具：`topK` 硬编码 10、`minScore`
硬编码 0.3，完全无视用户自己的阈值与页大小；没有 cursor；不支持 collection 或
itemKeys 限定；返回的行里带**未截断的原始 chunk 正文**（在真实文献库里，整段参考
文献列表被当作「证据」发回来）；也没有统一全文状态——因此语义命中一篇论文的**摘要**
和命中它的正文，在返回结果里长得一模一样。现在这些全部与 `hybrid_search` 对齐。

- `query`（新检索时必需）、`domain`、`expertRole`、`collectionKeys`、`itemKeys`、
  `topK`、`cursor`、`minScore`、`language`、`libraryID`

#### `find_similar`

以一篇文献的多个代表性段落为查询，发现语义相似的**文献**。全程纯语义，不涉及关键词。

调用链：AI 先用 `search_fulltext` 从目标文献中挑出有代表性的核心段落 → 把这些 `chunkId` 传给本工具 → 直接复用它们已存储的向量扫描整个语义索引（不重新生成向量）→ 自动排除该文献自身 → 按文献聚合成唯一分数 → 过用户阈值 → 分页。

聚合口径：对每个查询 chunk，取候选文献中最相似的两段求平均得到 s_i；文献分 = 0.75 × mean(s_i) + 0.25 × max(s_i)。全部是余弦值的均值/最大值，与阈值同为 0–1 尺度。这样一篇文献要靠「在你给的多个方面上都相关」得分，而不是靠单个偶然高分段落。

达到阈值的文献数量不设上限，按分数排序后每页最多 20 篇，返回 `hasMore` / `nextCursor`；翻页只是在已排好序的名单上开窗口，不会重新扫描全库。返回内容只有身份、分数和命中的 `chunkId`，不含段落原文——要读内容请对该文献调用 `search_fulltext`。

超时：不新增独立设置。扫描截止时间 = 用户的单次扫描超时 `vectorScanTimeoutMs` × 动态倍率，倍率按查询 chunk 数量 N 和实际执行路径确定：CPU 为 `0.8 + 0.35N`（数据库只读一遍，只有点积随 N 增长），GPU 为 `0.5 + 1.1N`（向量常驻显存，每个查询各扫一遍）。两组系数均来自实测（`npm run benchmark:find-similar-scaling`），本次生效的预算会写在返回的 `metadata.scanBudget` 里。

| 参数        | 类型     | 描述                                                              |
| ----------- | -------- | ----------------------------------------------------------------- |
| `itemKey`   | string   | 查询文献（新检索必需，翻页时可省略）                              |
| `chunkIds`  | number[] | 该文献中代表性段落的 chunkId（新检索必需，最多 20 个，须同属一篇） |
| `minScore`  | number   | 文献级相关度下限，只能比用户设置更严格                            |
| `topK`      | number   | 每页篇数，上限为用户设置（最大 20）                               |
| `cursor`    | string   | 续页游标，原样回传 `nextCursor`                                   |
| `libraryID` | number   | 文献库 ID（默认用户库）                                           |

#### `semantic_status`

查看语义搜索服务的状态、索引统计和覆盖率。无需参数。

#### `get_document_chunks`

**按文献原始 chunk 顺序分页读整篇正文**。`search_fulltext` 回答的是「这篇论文在
哪里说了 X」，本工具回答的是「让我把这篇读一遍」。

每个 chunk 带 `chunkIndex`（阅读顺序上的位置）和 `chunkId`（索引分配的稳定 id，
也是 `search_fulltext`、`find_similar` 接受的那个）。两者**不可互相推算**——凡是
有 chunk 被丢弃的文档，它们就会错开。

**禁止一次性返回整篇**：一页最多 20 个 chunk，没有任何参数能要来全文。PDF 从未
解析成功、或根本没有文本附件的文献会被**拒绝**，并说明是四种情况中的哪一种，
而不是把标题和摘要伪装成正文交回去。

- `itemKey`（新阅读时必需）、`cursor`、`offset`、`limit`、`libraryID`
- 返回 `fullText`、`pagination`（`totalChunks`、`returned`、`offset`、`range`、
  `hasMore`、`nextCursor`）和 `data`

> `fulltext_database` 已在 1.9.0 删除。它四个 action 里有两个（`list`、`stats`）
> 是把索引库管理能力直接暴露给 AI，第三个（`get`）会**一次性、无分页**地返回整篇
> 正文——那是全服务器唯一一条绕开检索漏斗的旁路。数据库维护能力保留在插件设置
> 界面内部，不再对外暴露。

### 四、写入操作（9 个，可在偏好设置中禁用）

写入默认关闭。关闭时这 9 个工具在 `tools/list` 与 `/capabilities` 中都不出现——
服务器绝不声明一个自己会拒绝执行的能力。

#### 分类增删改

- `create_collection` —— `name`（必需）、`parentCollection`、`libraryID`
- `update_collection` —— `collectionKey`（必需）、`name`、`parentCollection`
- `delete_collection` —— `collectionKey`（必需）、`deleteItems`
- `add_items_to_collection` —— `collectionKey`、`itemKeys`（均必需）
- `remove_items_from_collection` —— `collectionKey`、`itemKeys`（均必需）

#### 条目与笔记写入

#### `write_note`

创建或修改 Zotero 笔记，支持 Markdown 自动转换为 HTML。

| 参数        | 类型     | 描述                                                |
| ----------- | -------- | --------------------------------------------------- |
| `action`    | string   | **必需**：create/update/append                      |
| `parentKey` | string   | 关联到指定条目（create 时可选，省略则创建独立笔记） |
| `noteKey`   | string   | 已有笔记 Key（update/append 必需）                  |
| `content`   | string   | **必需**，笔记内容（Markdown 或 HTML）              |
| `tags`      | string[] | 添加标签                                            |

#### `write_tag`

添加、移除或替换条目上的标签。

| 参数      | 类型     | 描述                                                 |
| --------- | -------- | ---------------------------------------------------- |
| `action`  | string   | **必需**：add（追加）/remove（移除）/set（替换全部） |
| `itemKey` | string   | **必需**，条目 Key                                   |
| `tags`    | string[] | **必需**，标签列表                                   |

#### `write_metadata`

更新条目的元数据字段（标题、摘要、日期、DOI、作者等）。

| 参数       | 类型   | 描述                                                          |
| ---------- | ------ | ------------------------------------------------------------- |
| `itemKey`  | string | **必需**，条目 Key                                            |
| `fields`   | object | 要更新的字段（title/abstractNote/date/url/DOI/language 等）   |
| `creators` | array  | 替换作者列表，每项包含 creatorType/firstName/lastName 或 name |

#### `write_item`

创建新的文献条目或重新关联附件。

| 参数             | 类型     | 描述                                                      |
| ---------------- | -------- | --------------------------------------------------------- |
| `action`         | string   | **必需**：create（创建条目）/reparent（移动附件）         |
| `itemType`       | string   | 条目类型（journalArticle/book/conferencePaper/thesis 等） |
| `fields`         | object   | 元数据字段                                                |
| `creators`       | array    | 作者列表                                                  |
| `tags`           | string[] | 标签                                                      |
| `attachmentKeys` | string[] | 要关联的独立附件 Key 列表                                 |
| `parentKey`      | string   | reparent 操作的目标父条目 Key                             |

---

## 🐛 常见问题 (FAQ)

#### 1. 连接被拒绝错误

**问题**: `Error: connect ECONNREFUSED 127.0.0.1:PORT`
**解决方案**:

- 确保 Zotero 正在运行
- 检查 Zotero 插件是否已启用
- 在插件设置中检查服务器是否已启用
- 确认端口号（默认 23120）与 AI 客户端配置一致

#### 2. Streamable HTTP 连接失败

**问题**: `Streamable HTTP connection failed`
**解决方案**:

- 确保在插件设置中启用了服务器
- 检查防火墙设置，允许 Zotero 进行网络通信
- 确认 URL 格式正确：`http://127.0.0.1:23120/mcp`

#### 3. Claude Desktop 无法识别工具

**问题**: Claude 不显示 Zotero 相关工具
**解决方案**:

- 检查 `claude_desktop_config.json` 中的配置是否正确
- 确保使用了 `"transport": "streamable_http"` 配置
- 确保 JSON 格式正确
- 重启 Claude Desktop 应用

#### 4. 插件服务器无法启动

**问题**: 插件设置显示服务器启动失败
**解决方案**:

- 检查端口是否被占用，尝试更换端口
- 重启 Zotero 应用
- 查看 Zotero 错误控制台（`工具 -> 开发者 -> 错误控制台`）

---

## 🤝 贡献指南

欢迎贡献代码、报告问题或提出建议！

1.  Fork 本仓库。
2.  创建您的功能分支 (`git checkout -b feature/AmazingFeature`)。
3.  提交您的更改 (`git commit -m 'Add some AmazingFeature'`)。
4.  推送到分支 (`git push origin feature/AmazingFeature`)。
5.  开启一个 Pull Request。

## 📄 许可证

本项目采用 [MIT License](./LICENSE) 授权。

## 🙏 致谢

- [Zotero](https://www.zotero.org/) - 优秀的开源文献管理工具。
- [Model Context Protocol](https://modelcontextprotocol.org/) - 实现 AI 工具集成的协议。
- [![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
- 本项目基于 [cookjohn](https://github.com/cookjohn) 的原始 [zotero-mcp](https://github.com/cookjohn/zotero-mcp) 项目开发，感谢原作者的工作。
- 同时感谢 [Zotero Mark Reader](PENDING_URL) 项目作者，本项目的阅读/批注相关功能借鉴了该项目。
