# Zotero MCP - Model Context Protocol Integration for Zotero

Zotero MCP 是一个开源项目，旨在通过模型上下文协议（Model Context Protocol, MCP）将强大的 AI 功能与领先的文献管理工具 Zotero 无缝集成，为 AI 助手（如 Claude）提供与您本地 Zotero 文献库交互的能力。
_This README is also available in: [:gb: English](./README.md) | :cn: 简体中文._
[![zotero target version](https://img.shields.io/badge/Zotero-9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org)
[![Version](https://img.shields.io/badge/Version-2.7.7-brightgreen)]()
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
- 📖 **内容提取**：通过专用分页工具读取 PDF 全文、笔记、批注和摘要
- 📝 **批注分析**：按颜色、标签、关键词检索和分析 PDF 高亮与注释
- 📂 **分类浏览**：浏览和搜索分类层级结构，获取分类下的条目
- 🧠 **语义搜索**：基于 AI 向量嵌入的概念匹配，发现跨语言的相关文献
- 🧩 **LLM Wiki 长期记忆**：通过提问逐步沉淀可复用的 Claim、Concept 和 Relation，并始终回溯 Zotero 原文 chunk
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
- **按用途读取内容**: 摘要、完整批注、附件正文窗口和索引段落分别由专用分页工具返回，不再使用隐藏内容模式
- **智能批注系统**: 按颜色、标签、关键词搜索和检索 PDF 高亮、注释和笔记，支持智能排序
- **分类管理**: 浏览、搜索分类层级结构，获取分类详情、子分类和条目列表
- **语义搜索**: 基于 AI 向量嵌入的语义搜索，支持 OpenAI/Ollama API，发现概念相关的文献
- **LLM Wiki 与长期研究记忆**:
  - Page、Claim、Concept、Alias、Relation 与 Evidence 的权威数据独立保存到 `zotero-mcp-wiki.sqlite`
  - 每条 Evidence 都验证真实 Zotero 文献和原文 chunk；搜索索引 reset/rebuild 后自动进入待重连并重新定位，不删除长期知识
  - 提供受控的准备、提交、检索、查看、导出、重验证和指定单篇深读工具；服务器不新增隐藏 LLM 调用
  - Alias/Concept、Claim embedding、Relation 和有限一跳关联构成第三路召回；2.0.0 默认使用 Shadow Mode，不改变现有关键词+语义 Weighted RRF 排序，等待真实文库校准
  - Zotero Wiki 面板支持知识状态、证据查看、标准术语与 alias 管理、Page 合并、错误 Claim 删除、Markdown 导出和文献知识图谱
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

插件集成的 MCP 服务器提供以下 **47 个工具**，分为 5 大类：

### 一、搜索与查询（12 个）

#### `hybrid_search`

检索漏斗的第一段。该工具并行执行关键词检索和语义向量检索。关键词一路覆盖
**全库元数据**（标题、摘要、作者、期刊名、标签、Extra）**以及已建立关键词索引的
正文**；语义一路覆盖已索引的段落。两路都不扫描 Zotero 的全文缓存、也不会临时解析
PDF，所以两边的正文覆盖范围都等于「已经索引了多少」——关键词侧的覆盖率见
`metadata.bodyKeywords`，语义侧见每一行的 `fullText` 字段。

**两路如何融合**：两路**从不互相比较分数**。关键词一路按归一化 BM25F、语义一路
按余弦相似度，**各自用各自的阈值过滤**；通过的结果取**并集**——只要过了其中任意
一路就会进入结果，某一路可以「放行」，但永远不能「否决」。也就是说，关键词一路
完全没找到的文献，语义分够高照样返回，反之亦然。

排序则用**加权 RRF**，依据是每篇文献在**准入它的那一路里的名次**：

```
score = keywordWeight/(rrfK + keywordRank) + semanticWeight/(rrfK + semanticRank)
```

缺席的一路贡献 0，而不是扣分。两路都准入的文献因此拿到两份贡献，在名次相当时
排在只有一路准入的文献前面——「互相印证」体现为位次，而不是一笔加成分。

**`score` 是名次分，不是相关度**：它数值很小（两路都排第一时约 0.033），拿它跟
0.6 比、或者跟另一次检索的分数比，都没有意义，也**不再有任何阈值二次过滤它**。
要判断「有多相关」，看 `normalizedKeywordScore` 和 `normalizedSemanticScore`
——这两个才是真实的 0-1 相关度，也正是阈值实际作用的那两个数；**某一栏缺失表示
那一路没有准入这篇，而不是它得了 0 分**。不要按其它字段重排结果：重排会把融合
本身抵消掉。

返回的是**轻量候选行**：`itemKey`、题名、作者、年份、期刊、该文献的书写语言、
RRF 排序分 `score`、两路各自的相关度、命中来源 `matchedBy`、
`matchedKeywords` / `matchedFields`、`hasAbstract`，以及少量最相关段落的证据摘录。

**摘要不再随结果返回**。摘要仍然参与关键词检索、语义检索与排序，只是不再一并
发回——20 篇候选里通常只有几篇需要细看。需要看摘要时，对那一篇单独调用
`get_item_abstract`。若用户只问哪些文献相关，直接用这些候选行回答即可。

**分页**。`topK` 是「一页多少篇」，不是「这次检索挖多深」。响应里带一个
`pagination` 块：`appliedKeywordMinScore` / `appliedSemanticMinScore`（本次生效
的两路阈值）、`totalRelevant`（**至少被一路准入的文献总数**，通常不止一页）、
`returned`、`offset`、`range`、`hasMore`、`nextCursor`。顺序是
**召回 → 两路各自按阈值准入 → 取并集 → RRF 排序 → 再分页**，所以后面的页永远
不会出现两路都没准入的文献，最后一页短也绝不会拿低分结果凑数。把
`nextCursor` 原样作为 `cursor` 传回（其余参数保持不变或省略），就能在**同一份
已排好序的名单**上继续往下看——它不会重新检索，因此不会重复、遗漏或改变顺序。
带着 cursor 同时改 `query` / `keywords` / `domain` / `expertRole` /
`minKeywordScore` / `minSemanticScore` 会被拒绝：那是另一次检索，应该重新发起。分页状态保留 15 分钟、最近 5 次检索；
cursor 过期会明确报错，而不是悄悄重新搜一遍。

**检索深度**。两路召回都是**穷尽**的：融合层拿到的是全部候选，`ranked` 里是所有
通过阈值的文献，`results` 只是它上面的一扇窗口，所以不存在「候选池被挖满、池外
还有合格文献」这回事，也没有 `candidateK` 这个参数。`totalRelevant` 是精确值，
只有在某一路检索失败或超时时才降级为下界，此时 `pagination.degradedRetrieval`
与 `pagination.totalRelevantIsLowerBound` 会同时置位。

#### `search_library`

高级文献库搜索，支持多维度筛选、布尔运算和相关性评分。

| 参数                 | 类型    | 描述                                                                       |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `q`                  | string  | 通用搜索关键词                                                             |
| `title`              | string  | 标题搜索（支持 `titleOperator`: contains/exact/startsWith/endsWith/regex） |
| `yearRange`          | string  | 年份范围（如 "2020-2023"）                                                 |
| `fulltext`           | string  | 全文搜索（附件/笔记内容），支持 `fulltextMode`: attachment/note/both       |
| `itemType`           | string  | 文献类型筛选（journalArticle/book/attachment 等）                          |
| `includeAttachments` | string  | 设为 "true" 可搜索独立 PDF 条目                                            |
| `relevanceScoring`   | boolean | 启用相关性评分                                                             |
| `sort`               | string  | 排序：relevance/date/title/year                                            |
| `limit` / `offset`   | number  | 分页控制，`limit` 默认 200                                                 |

#### `search_annotations`

按关键词、颜色或标签搜索批注，支持智能排序和相关性过滤。

| 参数       | 类型     | 描述                                                              |
| ---------- | -------- | ----------------------------------------------------------------- |
| `q`        | string   | 搜索关键词（与 colors/tags 至少提供一个）                         |
| `itemKeys` | string[] | 限定搜索范围到指定条目                                            |
| `types`    | string[] | 批注类型：note/highlight/annotation/ink/text/image                |
| `colors`   | string[] | 按颜色过滤（支持色名或 hex：yellow/red/green/blue/purple/orange） |
| `tags`     | string[] | 按标签过滤                                                        |

当前页内的高亮、笔记正文和评论都按完整原文返回，不做令牌压缩；`limit` 默认
15、最大 100。

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

检索漏斗的第三段：对 `hybrid_search` 定位到的**单篇**文献做正文级混合检索。
评分规则与 `hybrid_search` **完全一致，只是候选从「整库的文献」换成「这一篇的
段落」**：关键词一路按归一化 BM25F、语义一路按余弦，各自用**同一组用户设置**的
阈值准入，取并集后按加权 RRF 排序——一个段落只要过了其中一路就会返回。`score`
同样是 RRF 名次分而非相关度。全库正文扫描已禁用。

调用前应先用 `get_item_abstract` 读该篇摘要，据此把 `domain` 与 `expertRole`
重新贴合到这篇论文，并根据它自身的研究内容重写 `query` 与 `keywords`——
**关键词用该文献自身的语言书写，只用一种语言**：单篇文档内部，另一种语言的
探针匹配不到任何内容，只会稀释关键词覆盖度。

| 参数               | 类型     | 描述                                         |
| ------------------ | -------- | -------------------------------------------- |
| `itemKey`          | string   | **必需**，要深入的那一篇                     |
| `query`            | string   | 针对该篇写的自然语言检索句                   |
| `keywords`         | string[] | 该篇专属探针，使用该文献自身的语言           |
| `domain`           | string   | 重新贴合该篇的学科/子领域                    |
| `expertRole`       | string   | 针对该篇采用的专家视角                       |
| `chunkIds`         | number[] | 上下文扩展：拉取指定段落的相邻段落           |
| `neighborRadius`   | number   | 上下文扩展半径，受用户设置上限约束           |
| `maxChunks`        | number   | 返回段落数上限，受用户设置上限约束           |
| `minKeywordScore`  | number   | 关键词一路的相关度下限，只能比用户设置更严格 |
| `minSemanticScore` | number   | 语义一路的相关度下限，只能比用户设置更严格   |

#### `search_collections`

按名称查找分类，用于「用户提到某个文件夹名、你需要它的 `collectionKey`」。
返回的是身份与路径，不是内容。参数：`q`（必需）、`limit`、`offset`、`libraryID`；
用响应中的 `pagination.nextOffset` 继续翻页。

#### `get_libraries`

列出当前 Zotero 客户端里的所有文献库。响应为
`{ results, pagination, metadata }`，`pagination` 含 `total`、`hasMore` 和
`nextOffset`。参数：`limit`、`offset`。

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

结果始终分页：一篇读透的 PDF 可能有几百条高亮。当前页内每条高亮、笔记正文和
评论都完整返回，不做截断或令牌压缩。

- `itemKeys`、`itemKey`、`annotationId`、`annotationIds`、`types`、`colors`、
  `tags`、`limit`（默认 20、最大 100）、`offset`、`libraryID`

#### `get_item_details`

**文献元数据详情工具**，用于引用与著录。返回标题、作者、日期、类型、期刊、
卷期页、DOI、URL、语言、标签，以及每个附件一行的基本信息。

**不返回任何正文内容**：没有摘要正文、没有 Notes 正文、没有批注正文、没有 PDF
正文、没有 chunks——这四类各有专门的工具按需返回并正确分页。这里给出的是
**可用性**：`hasAbstract` / `abstractChars` 告诉你 `get_item_abstract` 会返回
什么而不返回它，`noteCount` 告诉你 `get_annotations` 能找到几条笔记。

`fullText` 使用与全部检索结果**同一套五态全文状态**（`indexed` / `parse_failed`
/ `no_source` / `not_indexed` / `unknown`），取代了原先按附件给的
`hasFulltext` 布尔值——那个值只看文件扩展名，因此对从未解析成功的 PDF 也报
「有全文」。按附件的判断仍在，改名为 `hasExtractableText`，含义是「这种文件类型
可能能抽出文本」。

参数：`itemKey`（必需）、`libraryID`。

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

独立 PDF 或其他未归档附件不需要父条目：直接把附件 key 作为 `itemKey`。本地文件
可访问时，附件清单还会返回 `sizeBytes`。

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

参数：`parentCollection`、`limit`（默认 100）、`offset`、`libraryID`。

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
行**，共用同一套范围限定和同一套 cursor 分页，所以三者之间切换没有额外学习成本。
但有两点不同，不能互相搬运：一是**各自适用自己那一路的阈值**（`keyword_search`
用关键词阈值，`semantic_search` 与 `find_similar` 用语义阈值，`hybrid_search`
两个独立各用各的）；二是 **`score` 的含义不同**——单分支工具的 `score` 是 0-1
相关度，而 `hybrid_search` 与 `search_fulltext` 的 `score` 是 RRF **名次分**。它们在实现上也是共用的：一份词法检索服务
（`runLexicalSearch`）、一份语义检索服务（`SemanticSearchService.search`）、
一份分页存储、一份候选行投影——**不存在三套检索算法**。

#### `keyword_search`

**独立关键词检索**，纯词法匹配，不涉及任何 embedding。检索范围是**全库的元数据**
（标题、摘要、作者、期刊名、标签、Extra）**加上已建立关键词索引的正文**，两者在
同一次 BM25F 打分里一起算。

**正文覆盖是部分的。** 正文匹配读的是插件自己的关键词索引，既不扫描 Zotero 的
全文缓存，也不会临时解析 PDF——它只能覆盖已经建过索引的文献。因此一篇文献没出现
在结果里，可能只是**没建索引**，而不是不相关：`metadata.bodyKeywords` 里的
`indexedDocuments` 与 `metadataCollectionSize` 就是用来区分这两件事的。

正文命中是完整命中：一篇标题、摘要、标签里一个查询词都没有的文献，可以仅凭正文
进入排名。这类结果的 `matchedFields` 是 `["body"]`，并带回 **`bodyEvidence`**
——命中所在的段落，每条含 `chunkId`、该段命中了哪些关键词、命中几次、以及片段
原文。对一条「正文-only」的结果来说，这是它为什么会出现在你面前的**唯一**依据。
其中 `occurrences` 是给人看的证据强度，**不参与任何排序或打分**。

这里的 `score` 是**真实的 0-1 相关度**：只有一路，没有东西要融合，所以它就是阈值
实际作用的那个归一化 BM25F 分。它和 `hybrid_search` 的 `score`（RRF 名次分）
**不是同一个量纲**，两者之间不要互相搬运数值。生效的下限是用户的**关键词**相关度
阈值，与 `hybrid_search` 关键词分支用的是同一项设置。

两种用途：一是用户点名的精确术语、缩写、牌号、标准号，必须一条不漏；二是——也是
设计意图——**关键词粗筛**，把它返回的 `itemKeys` 交给 `semantic_search` 作为
`itemKeys`，让语义精查只在这份短名单上打分。日常文献发现仍应首选
`hybrid_search`，因为它同时跑这一路和语义那一路。

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

达到阈值的文献数量不设上限，按分数排序后分页返回；**每页返回数量受用户设置的「最大返回文献数」限制**，没有写死的每页篇数，`topK` 只能把它调得更小；响应里返回 `hasMore` / `nextCursor`；翻页只是在已排好序的名单上开窗口，不会重新扫描全库。返回内容只有身份、分数和命中的 `chunkId`，不含段落原文——要读内容请对该文献调用 `search_fulltext`。

超时：不新增独立设置。扫描截止时间 = 用户的单次扫描超时 `vectorScanTimeoutMs` × 动态倍率，倍率按查询 chunk 数量 N 和实际执行路径确定：CPU 为 `0.8 + 0.35N`（数据库只读一遍，只有点积随 N 增长），GPU 为 `0.5 + 1.1N`（向量常驻显存，每个查询各扫一遍）。两组系数均来自实测（`npm run benchmark:find-similar-scaling`），本次生效的预算会写在返回的 `metadata.scanBudget` 里。

| 参数        | 类型     | 描述                                                               |
| ----------- | -------- | ------------------------------------------------------------------ |
| `itemKey`   | string   | 查询文献（新检索必需，翻页时可省略）                               |
| `chunkIds`  | number[] | 该文献中代表性段落的 chunkId（新检索必需，最多 20 个，须同属一篇） |
| `minScore`  | number   | 文献级相关度下限，只能比用户设置更严格                             |
| `topK`      | number   | 每页篇数，上限为用户设置的最大返回文献数                           |
| `cursor`    | string   | 续页游标，原样回传 `nextCursor`                                    |
| `libraryID` | number   | 文献库 ID（默认用户库）                                            |

#### `semantic_status`

查看语义搜索服务的状态、索引统计和覆盖率。无需参数。

#### `build_search_index`

为一篇或多篇文献显式建立或更新统一搜索索引。它直接复用 Zotero“更新索引”的
targeted build 生命周期：正文只提取、切块一次，然后同时更新语义向量与关键词索引；
现有 build lock、暂停/reset 栅栏、失败日志、Chunk 设置和嵌入兼容性检查都继续生效。
该操作可能成本较高，`wiki_build_from_paper` 不会隐式触发它。

- `itemKeys`（必需，1-100 篇）、`libraryID`
- 逐篇返回语义索引、关键词索引和正文可用性，并给出总体统计；任一分支失败都会明确
  标出。`parse_failed` 与 `no_source` 表示真实的正文缺失，不会伪装成索引成功。

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

### 四、LLM Wiki（17 个，可独立禁用）

Wiki 使用独立长期知识数据库，保存可复用的 Page、Claim、Concept、Relation 和可回溯
Evidence，而不是再建一份论文摘要索引。普通研究采用“先检索、后受控提交”的流程；
`wiki_build_from_paper` 仅允许用户明确指定单篇文献时使用。服务器不会隐藏调用 LLM。

**两种阅读，同一份阅读总结。** 一篇文献有两种被读的方式，它们写进同一份 Markdown
阅读总结，共用同一份已读 chunk 台账。

*问答式渐进阅读*是日常路径：用户提问，`hybrid_search` → `search_fulltext` 找到相关
段落，AI 真正读懂其中一部分并作答，随后对**每一篇真正读过的文献**调用
`wiki_update_reading_note`，传入 `readChunkIds`（本轮真正读过并用于作答的 chunk）、
检索时用的 `domain` / `expertRole`，以及整份重写后的阅读总结。检索命中但没有真正阅读
的 chunk 不能列进去——检索返回不等于阅读，服务器只为你申报的部分背书。

已读 chunk 是**集合**而不是游标：第一次读 `{7,8,42}`、第二次读 `{15,42,70}`，累计为
`{7,8,15,42,70}` 共 5 个，重复的 42 不会重复计数，同一次调用里重复申报也不会。总结
顶部会画出覆盖情况，实心方块表示已读、空心方块表示未读（超过 100 个 chunk 时一格代表
若干 chunk，部分已读用半实心方块表示）。

顺序是**先总结、后 Wiki**，并且由服务器强制：某篇文献上一轮读到的内容还没写进 Wiki
时，这篇文献拒绝被再次阅读，直到一次 `wiki_commit` 引用了它。同一轮问答读了三篇文献，
就可以由一次提交同时结清三篇。真正读到新内容才需要写 Wiki；本轮没读到新内容就明确
跳过，不必为了凑流程往 Wiki 里塞重复条目。写入时应当优先扩充已有的 Page、Claim、
Concept 与关系，而不是在旁边新建一份近似的。

阅读总结只增不减：每次重写允许重组、合并、修正，但整体缩水超过一成会被拒绝——每轮
悄悄压缩一点，二十轮之后早期读到的参数就全没了，而这种退化单看任何一次重写都很合理。
总结里的每一条事实、参数、结论、机制和图表都必须在正文中标注对应 chunk 编号（如
「熔池深度 1.2 mm（chunk 42）」），否则无法保存；但标题里出现 chunk 编号仍然会被
拒绝，那是分页日志。

问答式阅读**永远不会**获得 `paper_reviewed`：即使零散读遍全文，`finalSynthesis` 在这条
路径上被拒绝，Evidence 一律停留在 `chunk_local` / `section_read`。全文深度是一个动作
——从头读到尾，再把它作为一个整体重新梳理——零散片段无论累计多少都没有执行过它。

*全文深度阅读*仍是原来的路径，且会**继承**问答阶段的成果。阅读顺序由服务器强制。首次调用 `wiki_build_from_paper`
只返回该文献的元数据与摘要，不返回任何正文；随后用 `wiki_set_reading_expert`
生成这篇文献专属的领域专家角色，同时在该 Zotero 条目下创建一份持久化的 Markdown
**阅读总结**附件。之后正文按页下发，每读完一批，用 `wiki_update_reading_note`
重写**整份**总结——新增、删除、合并、移动、改写，而不是往后追加。按分页组织的笔记
（`Chunks 8-15`、`本页新增`）会被拒绝：chunk 只是正文的传输单位，不是知识的组织
方式。未回写的批次最多允许积压 1 批，第 2 批未回写就拒绝继续下发；若某一批确实没有
新内容，可用 `unchanged` 说明原因，但不允许连续两次。

总结顶部的机器可读区——`paperKey`、`title`、`abstract`、`expert`、`readChunks`、
`totalChunks`、`nextChunk`、`coverage`、`status`、`updatedAt`——由服务器依据阅读台账
写入，AI 不能修改，因此总结里的任何措辞都无法让这篇文献看起来读得比实际更多。由于
它是条目下的真实文件，Zotero 重启、MCP 断线、对话中断与 context compaction 都不会
造成损失：`wiki_get_reading_note` 会交回总结、专家角色和应当续读的 chunk 序号。

若这篇文献此前已被问答读过，`wiki_build_from_paper` 不会从头再来：同一个阅读会话被
就地提升为全文模式，已读 chunk 台账与阅读总结原样保留，翻页会跳过开头已读的连续区段，
只补读问答没有覆盖到的部分，响应中的 `carriedOverFromQuestionAnswering` 说明继承了
多少。唯一仍会重新要求的是那份**慎重**的专家角色——问答阶段由检索参数临时拼出的角色
标记为 provisional，可以被正式角色替换，因为从头读完一篇文献值得先认真决定由谁来读。
显式传入 `offset` 时不会跳读，这样为了核对引文而回读某一段仍然可用，且不计入整合闸门。

全部 chunk 交付完成后，还必须再做三次覆盖全文的复盘，`wiki_prepare_update` 才会开始
写入阶段：一次是整体重构阅读总结（`finalSynthesis`），一次是复盘该文献确立的术语
（`wiki_record_concepts` 且 `final` 为真），最后一次是对**整个 Wiki** 的系统性复盘
（`wiki_prepare_update` 的 `wikiReview`）。后者构建独立术语库：一个概念一个实体，
含一个主术语与任意别名术语，每组术语都由中文全称、英文全称、简称构成，且硬性规则是
简称禁止独立存在；确实没有新术语时，用空清单加理由作答。有效名称不会被静默吞掉：
两篇文献对同一术语给出不同拼写时，两个名称都作为该概念的两条术语保留；只有 AI 推断
出来、又被文献否定的字段才会按文献修正。用户手动修改过的字段与手动锁定的主术语，
AI 之后都不再改动。

第三道门是 2.5.0 新增的。前两道看的都是**这篇文献**：总结是否连贯，术语是否梳理过。
但 Wiki 是在阅读过程中一路增量长出来的，到读完时往往已经漂移——早期依据某个 chunk
写下的 Claim 被后面的 chunk 限定了范围，隔了几轮写下的两个 Concept 其实是同一个，
早期画出的关系已经不再成立。所以最后要求以读完的全文为依据，对已有内容做一次五个
维度的复盘：Page 是否需要补充、调整或新建；Claim 需要新增、合并、修正还是被推翻；
Evidence 是否单薄、哪些可以提升到全文深度；Concept / Term 需要补充、纠错还是去重；
已有关系需要新增还是撤销。每个维度都必须作答，「无需改动，因为……」是完全合格的答案，
也是最常见的答案；不作答则不放行，因为空白与「没看过」无法区分。复盘一篇文献只需
提交一次，校验失败后重试不必重复提交。

此外，Evidence 只有在**全部 chunk 已交付**且
**该次整体重构已记录**时，才能达到 `paper_reviewed` / `cross_paper` 深度——交付不等于
读懂。总结本身永远不是 Evidence：Claim 仍必须引用能在该文献真实 chunk 中校验通过的
原文摘录，而且该 chunk 必须**已经被记录为读过**——由 `wiki_build_from_paper` 下发，
或由 `wiki_update_reading_note` 的 `readChunkIds` 申报。引用一段没人读过的原文会被
指名拒绝：摘录确实在文献里，缺的是对它的阅读。这也是「先总结、后 Wiki」的另一半——
Claim 只能建立在阅读总结已经涵盖的内容之上。该附件也被排除在检索索引之外，避免一篇论文的总结被当作论文原文检索出来。

- `wiki_prepare_update` —— 写入前搜索已有知识；可传入最多两个准确的 `proposedPageTitles`，短期 token 只能授权真正搜索过的 Page 标题；`pendingWikiWriteUp` 列出阅读总结已领先于 Wiki 的文献；文献读完全文后还需传入 `wikiReview`（Page / Claim / Evidence / Concept / 关系五个维度的整体复盘）
- `wiki_commit` —— 提交经过验证的 SKIP、Evidence、Claim、Page、Relation 或冲突动作
- `wiki_search` —— 检索 Concept/Alias、Claim、Relation 与一跳 Evidence 关联
- `wiki_get_page` —— 查看 Page、Claim 与 Evidence
- `wiki_get_claim` —— 查看一个原子 Claim 及其来源
- `wiki_status` —— 查看 Wiki 与 Evidence 链接状态
- `wiki_export` —— 导出派生 Markdown，不改变权威数据库；末尾追加术语库章节
- `wiki_record_concepts` —— 记录在真正阅读文献时识别出的专业概念：每个概念一个实体，含一个主术语与任意别名术语，每组术语都由中文全称、英文全称、简称三个字段构成，并记录来源文献。未带 `final` 的调用只暂存在当前阅读会话中、不写库也不弹确认；带 `final` 的那一次把全部内容一次写入，因此一篇文献只有一次写入、一次确认。每个字段单独记录来源类型（文献原文 / AI 补全 / 人工修改），AI 可以依据可靠专业知识补全中文、英文或简称，但必须如实标注
- `wiki_list_concepts` —— 列出独立术语库，含全部术语与来源
- `wiki_export_concepts` —— 单独导出术语库 Markdown
- `wiki_reverify` —— 索引重建后重新定位 Evidence，并在同一轮里重新校验全部未结算的跨文献候选连接
- `wiki_scan_links` —— 计算跨文献候选连接：库中哪些文献可能相关，具体通过哪些段落、术语或概念相关。通常不需要手动调用——一篇文献首次产生真实阅读记录时会自动入队，队列在后台消化；批量导入不会触发扫描。一次扫描 = 用该文献最多 20 个代表性段落做一次全库向量粗召回，再在 top 候选上做文献对局部双向精查，精查阶段不再扫全库。它写入的只是候选：会出现在 `wiki_prepare_update` 的 `pendingLinkSignals` 里，带两侧原文摘录和由服务端计算的 `mustResolve`；这里不写入任何 Page、Claim、Evidence、概念或关系
- `wiki_build_from_paper` —— 阅读用户明确指定的单篇文献：先给元数据与摘要，再分页下发正文；用 `pagination.nextCursor` 逐页翻到 `pagination.coverageComplete` 为真，且必须先结束当前这篇才能开始下一篇；继承该文献问答阶段已读的 chunk 与阅读总结，只补读未读部分。这个「一次一篇」的独占限制只针对全文阅读，问答式阅读不受限，可同时累积多篇
- `wiki_set_reading_expert` —— 依据元数据与摘要生成该文献专属的领域专家角色，并在条目下创建持久化 Markdown 阅读总结
- `wiki_update_reading_note` —— 用当前对该文献的理解整体替换阅读总结。全文阅读时每读完一批调用一次；问答后对每篇真正读过的文献调用一次，并传入 `readChunkIds`（本轮真正读过并用于作答的 chunk）与检索时的 `domain` / `expertRole`。`finalSynthesis` 表示全文交付后的最终整体重构，问答路径不可用
- `wiki_get_reading_note` —— 取回某篇文献的总结、专家角色与准确续读位置；重启或对话中断后的恢复入口
- `wiki_finish_reading` —— 只读不写地结束一篇打开的文献（`skipped`）。不传 `itemKey` 时结束当前全文阅读的那篇；传 `itemKey` 时也可结束一篇问答式阅读的文献，同时解除它「未写入 Wiki」的阻塞

### 五、写入操作（11 个，可在偏好设置中禁用）

写入默认关闭。关闭时这 11 个工具在 `tools/list` 与 `/capabilities` 中都不出现——
服务器绝不声明一个自己会拒绝执行的能力。

还有两个 Wiki 工具会跟着一起消失，它们不在本节里，但值得单独说明：
`wiki_set_reading_expert` 与 `wiki_update_reading_note` 会在 Zotero 条目下真的
创建并改写 Markdown 阅读总结附件，属于 Zotero 写操作，因此受同一道写入闸门管辖。
也就是说，关闭写入会连带停掉 Wiki 阅读总结，`tools/list` 里少掉的是 13 个工具，
不是 11 个。

#### 分类增删改

- `create_collection` —— `name`（必需）、`parentCollection`、`libraryID`
- `update_collection` —— `collectionKey`（必需），并且 `name`、`parentCollection`
  至少提供一个
- `delete_collection` —— `collectionKey`（必需）、`deleteItems`
- `add_items_to_collection` —— `collectionKey`、`itemKeys`（均必需）
- `remove_items_from_collection` —— `collectionKey`、`itemKeys`（均必需）
- `move_items_to_collection` —— `toCollectionKey`、`itemKeys`（均必需）、`dryRun`
- `merge_items` —— `groups`（必需）、`dryRun`

`move_items_to_collection` 是重新整理文献库用的工具，也是这几个里唯一结果为
「归位」而非「追加」的一个：执行完每个条目只属于 `toCollectionKey` 一个分类，
原有的其他归属全部解除。如果某篇文献本就该同时属于多处（比如既在课题分类里、
又在待读清单里），请改用 `add_items_to_collection`，它不动已有归属。

整批要么全成、要么全不动。执行前有一轮体检：条目不存在、条目在回收站、以及
子笔记或子附件（这类条目根本不能归入分类）都会让整批中止，此时一个字节都没写，
返回里会列出出问题的 key，你改好或剔除后重新调用即可；体检通过后的写入在单个
事务里完成，中途失败也不会留下整理到一半的库。`dryRun` 跑的是同一套体检、返回
同一份计划——哪些条目移动、每个条目会失去哪些归属——但不写入，也不弹确认框，
因此可以放心用它把整理方案先摆给用户看，确认后再真正执行。

`add_items_to_collection` 和 `remove_items_from_collection` 如果所有 key 都不存在，
会作为工具调用失败；有效和无效 key 混合时返回 `success: false`、`partial: true`，
并分别列出完成项和缺失项。附件迁移确认框会列出目标父条目和全部子 key；合并确认框
会先做预检，再逐组列出保留条目以及将被 Zotero 移入回收站的重复条目。

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

`content` 必须是字符串，且「不传」和「传空字符串」是两回事。空字符串表示
**清空**，只有 `update` 接受：它会把笔记内容抹掉，返回里带 `cleared: true`
和被抹掉的字符数（笔记条目本身还在，要彻底删除请在 Zotero 里删）。
`create` 和 `append` 拒绝空内容——在这两个动作下，空内容只可能意味着你的
内容生成返回了空值。

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

创建新的文献条目、重新关联附件，或把本机文件导入为附件。

| 参数             | 类型     | 描述                                                                 |
| ---------------- | -------- | -------------------------------------------------------------------- |
| `action`         | string   | **必需**：create（创建条目）/reparent（移动附件）/import（导入文件） |
| `itemType`       | string   | 条目类型（journalArticle/book/conferencePaper/thesis 等）            |
| `fields`         | object   | 元数据字段                                                           |
| `creators`       | array    | 作者列表                                                             |
| `tags`           | string[] | 标签                                                                 |
| `attachmentKeys` | string[] | 要关联的独立附件 Key 列表                                            |
| `parentKey`      | string   | reparent 操作的目标父条目 Key                                        |
| `filePath`       | string   | import 专用：要导入文件的绝对路径                                    |
| `parentItemKey`  | string   | import 专用：把文件挂到哪个条目下                                    |
| `title`          | string   | import 专用：附件显示名，默认取文件名                                |

`create` 的条目创建与全部 `attachmentKeys` 归属变更在同一个事务里完成，因此失败
时一个字节都不会写入，重试也不会留下重复条目。找不到、或不是附件的 key 不会中止
创建，它们会带着原因出现在返回的 `skippedAttachments` 里。

`import` 还需要**允许文件导入**这项偏好处于开启状态，否则直接失败；它就是
「把 PDF 转成 Markdown 再挂回条目」这条路要用的动作。

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
