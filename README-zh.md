# Zotero LitSynapse - Model Context Protocol Integration for Zotero

Zotero LitSynapse 把你本地的 Zotero 9 文献库变成一个 AI 助手真正能用的工具：它是一个内置了 Model Context Protocol（MCP）服务器的单一 Zotero 插件，让 Claude Desktop、Claude Code、Cursor、Gemini CLI 等客户端可以通过本地 HTTP 连接搜索、阅读、交叉引用甚至（在你允许的情况下）编辑你的文献库——不需要额外的服务器进程，也不会把你的文献库上传到云端。

_This README is also available in: [:gb: English](./README.md) | :cn: 简体中文。_

[![zotero target version](https://img.shields.io/badge/Zotero-9.0.x-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org)
[![Version](https://img.shields.io/badge/Version-3.3.0-brightgreen)]()
[![EN doc](https://img.shields.io/badge/Document-English-blue.svg)](README.md)
[![中文文档](https://img.shields.io/badge/文档-中文-blue.svg)](README-zh.md)

---

## 目录

- [项目概述](#-项目概述)
- [功能导览](#-功能导览)
- [快速上手](#-快速上手)
- [支持的 AI 客户端](#-支持的-ai-客户端)
- [配置参考](#-配置参考)
- [系统架构](#-系统架构)
- [开发者指南](#-开发者指南)
- [故障排查](#-故障排查)
- [MCP 工具参考](#-mcp-工具参考)
- [贡献指南](#-贡献指南)
- [许可证](#-许可证)
- [致谢](#-致谢)

---

## 📚 项目概述

Zotero LitSynapse 是一个基于 Model Context Protocol 的工具服务器，它不是运行在 Zotero 旁边，而是直接嵌入在 Zotero 内部。通过它，AI 助手可以完成你原本需要手动在文献库里做的那些事：

- 🔍 **智能搜索**：三段式检索漏斗——先在全库做关键词 + 语义混合检索，再取摘要，最后深入某一篇的正文段落——全程支持布尔运算、相关性评分和游标分页。
- 📖 **内容提取**：摘要、附件正文、索引后的文档分块，每一种都由专用的分页工具返回，而不是一个带隐藏模式的万能工具。
- 📝 **批注分析**：按颜色、标签、关键词检索并阅读 PDF 高亮、批注和笔记。
- 📂 **分类浏览**：像文件管理器一样逐层浏览分类结构，绝不会一次性把整棵树倒出来。
- 🧠 **语义搜索**：基于向量嵌入的概念匹配，可跨语言、跨措辞发现相关文献，并可选启用 GPU 加速。
- 📄 **高保真 PDF 解析（MinerU）**：可选的版面感知解析器，在文本进入索引之前先把标题层级、公式、表格重建为结构化 Markdown，而不是依赖 Zotero 自带的纯文本提取。
- 🌐 **PDF 翻译**：可选的 AI 辅助翻译流水线，复用 MinerU 解析出的结构，并可维护一份持久化的专业术语表。
- 🧩 **LLM Wiki 长期记忆**：一个由提问驱动、可复用的知识库，存放 Claim、Concept 和 Relation，每一条都能回溯到它源自 Zotero 中的具体段落。
- ✏️ **写入操作**：创建笔记、管理标签、更新元数据、创建条目、重组分类、关联附件——默认全部关闭。
- 🔒 **本地优先的安全设计**：服务器默认只监听本机回环地址，开启远程访问需要显式授权并配置令牌，任何具有写入能力的功能在你手动开启之前都是关闭的。

这让文献综述、引用查找、批注整理和长期笔记积累，变成了一场与你自己文献库之间的对话——而且完全运行在你自己的电脑上。

---

## 🧩 功能导览

### 搜索与检索

- **高级搜索引擎**——支持布尔运算、相关性评分，以及按标题、作者、年份、标签、条目类型的多维度筛选。
- **混合检索漏斗**——`hybrid_search` 并行运行关键词检索和语义向量检索，任一分支通过自己的阈值即可入选，再用加权 Reciprocal Rank Fusion 对幸存结果排序；`search_fulltext` 在单篇论文内部重复同一套漏斗逻辑。
- **按用途拆分的内容工具**——摘要、附件正文、文档分块各自由专用分页工具提供，不再捆绑在一个隐藏的"详细程度"开关背后。
- **智能批注系统**——检索并读取 PDF 高亮、批注、墨迹与图片标注、笔记，可按颜色、标签、关键词筛选，每条结果都能追溯到对应的文献、附件和批注本身。
- **分类管理**——逐层浏览分类层级、按名称搜索分类，并能在不下载文件夹内容的前提下获知每个文件夹的条目数量。

### 语义搜索与 GPU 加速

- 基于索引段落的语义搜索，支持任意 OpenAI 兼容的嵌入接口（OpenAI、Ollama 或自建服务）——自动检测，并提供连接测试与实时速率/成本统计。
- 一个共享的向量索引（基于 SQLite），同时服务于 `semantic_search`、`hybrid_search` 和 `find_similar`；主文献库视图中有索引状态列，右键菜单可对单个条目/整个分类进行索引管理。
- **原生 GPU 向量加速**——一个可选的、仅支持 NVIDIA 显卡的原生模块（`native/vector-gpu/`，CUDA + C++），把向量扫描放到 GPU 上执行而非 CPU，支持 Auto / Float32 / Int8 三种精度模式，并实时汇报状态（设备信息、常驻向量数量，以及回退到 CPU 时的具体原因）。完全可选，不安装它也能在 CPU 上正常工作。
- 内置基准测试工具会实测你自己的文献库，直接给出推荐的阈值和超时设置，而不是让你去猜。

### 高保真 PDF 解析（MinerU）

Zotero 自带的全文提取只是纯文本转储——没有标题、没有表格结构、没有公式。MinerU 是一个可选的解析后端，会在文本被切分、索引之前先把 PDF 的真实版面重建为结构化 Markdown，让搜索结果和全文阅读带上真正的文档结构，而不是一整墙文字。

- 两种部署模式：**云端**（官方 `mineru.net` API——需要你自己的 API Token，并消耗你自己的配额）或**本地**（自建 `mineru-api` 服务，Python 3.10–3.13，默认地址 `http://127.0.0.1:8000`）。
- 可配置模型版本（VLM / hybrid / pipeline）、语言，以及独立开关的 OCR、公式识别、表格识别。
- 解析出的 Markdown 可选择性地作为附件挂载到 Zotero 条目上，并支持配置并发数、超时、大小上限、按需阻塞开关和缓存管理。

**正文来源的优先级。** 无论是为搜索索引切分某个 PDF 的分块，还是按需响应 `get_attachment_text` / `search_fulltext` 的调用，插件每一次都按同一套固定顺序解析正文，因此索引阶段和按需阅读阶段绝不会对"哪一份才是这篇文档的正文"产生分歧：（1）条目上已有的 **Doc2X 原文 Markdown 笔记**；（2）针对这个文件的**已缓存 MinerU 解析结果**；（3）此前解析时已经挂载在条目上的 **MinerU Markdown 附件**；（4）**现场解析**——仅当 MinerU 已启用且偏好设置允许按需解析时才会触发；（5）以上都没有时，最后回退到 Zotero 自带的扁平全文缓存，再到内置 PDF 处理器。`get_attachment_text` 会在 `textSource.method` 中如实汇报究竟是哪一种来源产出了这段文本（`doc2x`、`mineru_cache`、`mineru_attachment`、`mineru`，或其他 PDF 处理器兜底路径）——完整列表见 [`get_attachment_text`](#get_attachment_text) 一节。

**如何识别 Doc2X 生成的原文。** [Doc2X](https://doc2x.noedgeai.com/) 是一个独立的第三方 Zotero 插件，专门负责 PDF 转 Markdown 与翻译；本插件不会自己创建这些笔记，只负责识别已经存在的笔记。它会检查同一父条目下已有的每一条笔记，只有当某条笔记的标题或正文开头明确带有 **"原文MD" 或 "original_MD"** 标记（大小写不敏感）时——这正是 Doc2X 自己用来标记"未翻译原文"、以区别于译文或双语版本的标签——才会把这条笔记当作该 PDF 的原文候选。随后会尝试从这条笔记实际持有的形式中还原出 Markdown 正文（笔记内嵌的数据、Doc2X 在旁边写下的配套源文件，或者把笔记本身的可见内容重新渲染回 Markdown），如果还原出的字符数不足 100，这次匹配会被直接判定无效，避免把一条空笔记或只有标题的笔记误当成真正的正文。当同一条目下有不止一条笔记看起来像候选时，插件会给它们打分排序——笔记内容与 PDF 文件名的相似度、以及 Doc2X 自己记录的任务元数据，都会提高候选的分数——最终得分最高的那一条胜出；这两个信号都不是硬性要求，因为 Doc2X 经常会截断或本地化笔记标题，用户也可能事后重命名过附件。反过来的情况同样会被处理：如果某个 PDF 本身就是 Doc2X 生成的译文或双语版输出（标题类似"译文PDF"、"双语PDF"、"translate_PDF"等），会被识别出来并在挑选"原始 PDF"作为解析对象时直接跳过，确保 MinerU 不会把 Doc2X 自己的翻译结果误当作原文再解析一遍。

### PDF 翻译

一个叠加在 MinerU 解析结果之上的可选翻译流水线，让翻译后的文档保留原始结构，而不是被一个朴素的文本翻译器毁掉表格和标题层级。

- 独立于嵌入服务的翻译配置——API 地址、密钥、模型、目标语言。
- 可选的 AI 上下文感知翻译、单篇文档术语表生成，以及一份可复用的全局术语表，让专业术语在不同论文间保持一致。
- 可选的领域专家画像，用来引导术语选择贴合某个具体学科。

### LLM Wiki 与长期记忆

- 权威的 Page、Claim、Concept、Alias、Relation 和 Evidence 独立保存在专属的 `zotero-lit-synapse-wiki.sqlite` 数据库中，不会与搜索索引混在一起。
- 每一条 Evidence 摘录都会与真实的 Zotero 文档分块进行校验，并在搜索索引重置或重建后自动重新定位，而不会悄悄失效。
- 提供受控的准备-提交流程（`wiki_prepare_update` / `wiki_commit`），以及检索、查看、导出、重验证和单篇论文深读工具——服务器本身不会发起任何隐藏的 LLM 调用。
- Concept 与 Claim 的向量嵌入，加上一跳关系遍历，构成第三条检索路径，与关键词、语义检索并列；Shadow Mode 会让它在你针对自己文献库校准之前，不影响现有排序结果。
- Zotero 内置的 Wiki 面板展示知识状态、Evidence、术语与别名管理、Page 合并、错误 Claim 删除、Markdown 导出，以及一张展示文献间关联的 3D 知识图谱。

### 写入操作

- 创建或修改笔记（支持 Markdown 自动转 HTML）、管理标签、更新元数据字段、创建新条目、重新挂靠或导入独立 PDF。
- 分类变更工具（创建、重命名、删除、增删条目、移动、合并重复条目），全部采用批量预检 + 全有或全无的写入方式，并提供 `dryRun` 模式，让你在真正写入前就能看到确切的变更结果。
- 服务器层面默认全部关闭——除非你主动打开写入操作，否则客户端根本看不到这些工具的存在。

### 安全与隐私

- **默认仅本地运行**——服务器绑定在 `127.0.0.1`，除非你显式开启远程连接，否则数据不会离开你的电脑。
- **Bearer Token 鉴权**——你可以在偏好设置中生成（并随时重新生成）一个 MCP 访问令牌，开启远程访问时必须使用它。
- **高风险功能全部默认关闭**——写入操作、文件导入、暴露本地文件路径默认都是关闭的，破坏性批量操作的确认弹窗也无法从客户端一侧跳过。
- **客户端配置生成器**——一键为你使用的具体 AI 客户端生成可直接粘贴的 MCP 配置，无需手动拼接连接地址和令牌。

---

## 🚀 快速上手

### 1. 安装插件

1. 获取最新的 `zotero-lit-synapse-x.x.x.xpi`——可以从提供本项目给你的人那里拿到、从仓库的 Releases 页面下载，或者[自行构建](#-开发者指南)。
2. 在 Zotero 中，通过 `工具 → 附加组件 → ⚙ → 从文件安装附加组件…` 安装该 `.xpi` 文件。
3. 重启 Zotero。

### 2. 配置服务器

打开 `Zotero → 设置 → Zotero LitSynapse`，进入 **Server（服务器）** 标签页：

1. 勾选 **Enable Server（启用服务器）**，启动内置的 MCP 服务器。
2. **Port（端口）** 保持默认值 `23120` 即可，除非它与本机其他程序冲突。
3. 除非确有需要，否则不要开启远程访问——具体要求见[配置参考](#-配置参考)。
4. 点击 **Generate Client Configuration（生成客户端配置）**，从列表中选择你使用的 AI 客户端，复制生成的配置。

### 3. 连接 AI 客户端

把生成的配置粘贴到对应客户端的 MCP 设置中（各客户端配置文件位置见[支持的 AI 客户端](#-支持的-ai-客户端)），然后重启客户端。对于直接读取原始 MCP JSON 配置的客户端，最简示例如下：

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

### 4. 验证是否生效

对你的 AI 助手说一句类似"帮我在 Zotero 文献库里搜索一下关于 transformer 的文献"这样的话。如果它调用了 Zotero 相关工具并返回了你文献库中的真实结果，说明连接已经成功；如果没有，请参考[故障排查](#-故障排查)。

---

## 🖥️ 支持的 AI 客户端

内置的**客户端配置生成器**（Server 标签页 → Generate Client Configuration）可以按名称直接生成以下每一个客户端的现成配置，通常你不需要手写：

| 客户端 | 说明 |
| :--- | :--- |
| Claude Desktop | Streamable HTTP MCP |
| Claude Code | Streamable HTTP MCP |
| Codex | Streamable HTTP MCP |
| Cline (VS Code) | Streamable HTTP MCP |
| Continue.dev | Streamable HTTP MCP |
| Cursor | Streamable HTTP MCP |
| Cherry Studio | Streamable HTTP |
| Gemini CLI | Streamable HTTP MCP |
| Chatbox | Streamable HTTP MCP |
| WorkBuddy | Streamable HTTP MCP |
| Trae AI | Streamable HTTP MCP |
| Qwen Code | Streamable HTTP MCP |
| 自定义（原生 HTTP） | 任何直接支持 MCP 2025-06-18 Streamable HTTP 协议的客户端 |

任何实现了 MCP 2025-06-18 规范 Streamable HTTP 传输方式的客户端，都可以使用[快速上手](#-快速上手)中给出的原始配置直接连接，即使它不在上面的预设列表中。

---

## ⚙️ 配置参考

所有设置都在 `Zotero → 设置 → Zotero LitSynapse` 中，分布在四个标签页里。

### Server（服务器）

- **Enable Server / Port**——启动内置 MCP 服务器；默认端口为 `23120`。
- **Allow Remote Connections（允许远程连接）**——默认关闭，服务器只接受来自 `127.0.0.1` 的连接。开启后会把服务暴露到你的网络中，并要求配置访问令牌；请只在你信任的网络环境中开启。
- **MCP Access Token（访问令牌）**——可以在此标签页随时生成或重新生成的 Bearer Token；任何远程客户端都必须使用它，即便在本机使用，如果电脑有其他用户共享，也建议启用。
- **Client Configuration Generator（客户端配置生成器）**——为[支持的客户端](#-支持的-ai-客户端)中的任意一个生成可直接粘贴的配置。

### Retrieval & Semantic Search（检索与语义搜索）

- **嵌入服务**——支持任意 OpenAI 兼容接口（OpenAI、Ollama 或自建服务）：API 地址、密钥、模型、向量维度、请求超时、最大批处理大小，并提供内置连接测试。
- **速率限制与用量**——可配置每分钟请求数与每分钟 Token 数上限，并提供实时用量与成本统计，避免索引大型文献库时悄悄超出服务商限额。
- **混合检索调优**——关键词分支和语义分支各自独立的相关性阈值、各自独立的 RRF 权重（把某个权重设为 `0` 即可完全禁用该分支）、邻近段落扩展，以及各自独立的关键词搜索/向量扫描超时。
- **分块设置**——目标分块大小与容差（修改后需要重建索引）。
- **内置基准测试**——一键实测你自己文献库的检索表现，直接给出推荐的阈值和超时设置，而不用你去猜。
- **GPU 向量加速**——[功能导览](#语义搜索与-gpu-加速)中提到的原生 CUDA 向量扫描的启用开关和计算精度（Auto / Float32 / Int8）；同一标签页会实时汇报设备状态，以及回退到 CPU 时的具体原因。

### LLM Wiki

- **Enable Wiki**——整体开关 19 个 `wiki_*` 工具。
- **写入模式**——新 Claim/Concept 的确认后写入或全自动整合。
- **Shadow Mode**——在你针对自己文献库校准之前，阻止 Wiki 检索路径影响 `hybrid_search` / `semantic_search` 的排序结果，默认开启。
- **相关性阈值与 RRF 权重**——关闭 Shadow Mode 后，用来调节 Wiki 检索路径的贡献程度。
- **情节相似度阈值**与**搜索超时**——控制跨论文关联发现的灵敏度和时间预算。
- **数据管理**——Wiki 数据的删除控制，以及当前存储的 Page、Claim、Evidence、向量数量等实时统计。

### Documents（文档处理）

- **MinerU**——云端/本地模式及其接口地址或令牌、模型版本（VLM / hybrid / pipeline）、语言、OCR/公式/表格识别开关、解析后的 Markdown 是否挂载到 Zotero 条目、并发数、超时、文件大小上限、按需阻塞开关，以及缓存管理。
- **PDF Translation（PDF 翻译）**——服务商、API 地址、密钥、模型、目标语言；AI 上下文感知开关；单篇文档与全局术语表选项；可选的领域专家画像。
- **写入与隐私**——**Enable Write Operations（启用写入操作）**（默认关闭）、**每次写入前确认**开关、**Allow File Import（允许文件导入）**（高风险，`write_item` 的 `import` 动作需要它，默认关闭）以及 **暴露本地文件路径**（默认关闭）。

---

## 🏗️ 系统架构

```
AI 客户端  <-- Streamable HTTP -->  Zotero 插件（内置 MCP 服务器 + Zotero API 访问）
```

MCP 服务器、搜索索引、Wiki 数据库，以及可选的 MinerU/GPU 集成，全部运行在 Zotero 进程内部。不需要安装、配置或维护任何独立的服务器进程——在偏好设置中启用服务器就是全部的安装步骤。

---

## 👨‍💻 开发者指南

### 前置要求

- **Zotero 9.0.x**（插件声明的 `strict_min_version` / `strict_max_version` 分别是 `9.0` / `9.0.*`，无法在其他主版本上加载）。
- **Node.js 18+** 与 **npm**——仅在从源码构建插件时需要，运行插件本身不需要。
- **Git**。

### 从源码构建

```bash
git clone https://github.com/xu281530-rgb/zotero-lit-synapse-gpu.git
cd zotero-lit-synapse-gpu/zotero-lit-synapse-plugin
npm install
npm run build      # 构建 .xpi 并通过 tsc --noEmit 做类型检查
npm run start       # 或者：开发模式，热重载进正在运行的 Zotero
```

构建产物会写入 `.scaffold/build/zotero-lit-synapse.xpi`，安装方式与使用预构建版本相同。

### 可选：GPU 原生模块

CUDA 向量加速后端位于 `native/vector-gpu/`，是一个独立的 CMake 项目。配好工具链后，单独构建并打包它的产物：

```bash
npm run build:gpu-native   # 构建原生 CUDA/C++ 模块
npm run package:gpu-assets # 打包构建产物供插件使用
npm run build:gpu          # 一次性完成以上两步
```

这一步完全可选——不构建它，插件依然可以在 CPU 上正常运行。

### 测试

项目提供了大量针对性的测试与校准脚本（远超一百个，覆盖从 BM25F 评分到 Wiki 提交校验，再到 GPU 协议帧格式的方方面面），而不是一个单一的整体测试命令。运行 `npm run test` 可以启动 scaffold 自带的测试运行器；如果需要针对具体改动的脚本，可以查看 `package.json` 的 `scripts` 字段中对应的 `test:*` / `calibrate:*` / `benchmark:*` 脚本。

---

## 🐛 故障排查

**连接被拒绝（`ECONNREFUSED 127.0.0.1:23120`）**
确认 Zotero 正在运行、插件已启用，并且 Server 标签页中的 **Enable Server** 已勾选；再确认 AI 客户端配置中的端口号与偏好设置中显示的端口号一致。

**Streamable HTTP 连接失败**
确认地址完全等于 `http://127.0.0.1:<端口>/mcp`；确认没有防火墙或安全软件阻止 Zotero 进程监听该端口；如果你开启了远程访问，确认客户端把 MCP 访问令牌作为 Bearer 凭证发送。

**AI 客户端看不到任何 Zotero 工具**
确认客户端配置里使用的是 `"transport": "streamable_http"`（而不是 `stdio`）；确认 JSON 语法正确；修改配置后记得重启客户端——大多数客户端只在启动时读取一次 MCP 配置。

**服务器无法启动**
配置的端口可能已被其他进程占用，换一个端口再试；也可以查看 Zotero 自带的错误控制台（`工具 → 开发者 → 错误控制台`）获取更具体的报错信息。

**某次工具调用报校验错误**
服务器会对含糊或格式错误的调用直接按名称拒绝，而不是自己去猜——请直接阅读报错内容本身，它会指出具体是哪个字段、出于什么原因（类型错误、必填数组为空、在改变搜索参数的同时携带了游标等），而不是悄无声息地失败。

如果以上步骤都无法解决问题，请提交 issue，并附上你的操作系统、Zotero 版本、AI 客户端，以及相关的报错文本或日志。

---

## 🔧 MCP 工具参考

所有工具定义都集中在同一处——`src/modules/toolCatalog.ts`——MCP 的 `tools/list` 响应和 HTTP 的 `/capabilities` 文档都是从它投影生成的，不存在需要手动同步的第二份清单，`npm run test:tool-catalog` 会在两份投影出现分歧时直接让构建失败。服务器一共提供 50 个工具，分为五组：搜索与查询 11 个、分类管理 3 个、语义搜索与阅读 6 个、LLM Wiki 19 个、写入操作 11 个。

### 一、搜索与查询（11 个）

#### `hybrid_search`

检索漏斗的第一阶段。它并行运行关键词检索和语义向量检索。关键词分支覆盖全库的元数据（标题、摘要、作者、期刊名、标签、extra 字段）**以及关键词索引中每一篇文档的正文**；语义分支覆盖已索引的段落。两个分支都不会扫描 Zotero 的全文缓存，也不会临时解析 PDF，因此两边的正文覆盖范围都取决于已经建立的索引——`metadata.bodyKeywords` 汇报关键词索引的覆盖比例，每一行结果的 `fullText` 字段汇报语义索引的覆盖情况。

**两个分支如何合并。** 它们从不互相比较。每个分支都在自己的量纲上被独立过滤——关键词用归一化 BM25F，语义用余弦相似度——分别对照用户各自配置的阈值，通过者**取并集**：只要通过任意一个阈值就足够入选，一个分支可以让一篇文档入选，但永远无法否决它。关键词分支从未找到的论文，只要语义打分认可，依然会被返回，反之亦然。

排序则采用**加权 Reciprocal Rank Fusion**，依据每篇文档在**通过它的每个分支内部**所处的名次：

```
score = keywordWeight/(rrfK + keywordRank) + semanticWeight/(rrfK + semanticRank)
```

未入选的分支贡献为零而不是惩罚分，因此同时被两个分支接纳的文档会获得双份贡献，在相近名次下会压过只被单一分支接纳的文档。互相印证体现为排位而不是加分。`rrfK` 控制名次优势衰减的速度；偏好某个分支则是两个权重存在的意义。

**`score` 是名次而不是相关度。** 它是一个很小的名次一致性数值（默认 `rrfK = 60` 时，两个分支都排第一的文档得分接近 0.033），拿它和 0.6 比较、或者和另一次搜索的分数比较都没有意义，而且**不会对它施加任何阈值**。要判断一篇文档究竟有多相关，请看 `normalizedKeywordScore` 和 `normalizedSemanticScore`——它们是各自分支量纲下真实的 0-1 相关度，也正是阈值实际生效的对象。某一项**缺失**代表该分支没有接纳这篇文档，而不是它的分数为零。不要用其他任何方式对结果重新排序：对一次名次融合的结果再排序会破坏融合本身。

- `query`（未携带 `cursor` 时必填）、`keywords`、`domain`、`expertRole`、`topK`、`cursor`、`minKeywordScore`、`minSemanticScore`、`language`、`rrfK`、`keywordWeight`、`semanticWeight`、`libraryID`
- 每篇文档返回一条轻量候选行：`itemKey`、`title`、`creators`、`year`、`publicationTitle`、`language`、RRF 的 `score`、`normalizedKeywordScore`、`normalizedSemanticScore`、`matchedBy`、`matchedKeywords`、`matchedFields`、`hasAbstract`，以及来自最佳匹配段落的简短摘录。
- **不会返回摘要正文。** 摘要依然被索引、依然被关键词分支检索，只是不会随结果返回，这样一份 20 条的候选列表才能保持精简。只有当某篇论文真正值得深入阅读时，才用 `get_item_abstract` 单独获取它的摘要。
- 如果用户只是想知道哪些文献相关，可以直接依据这些结果行作答。

**分页。** `topK` 是单页大小，不是搜索深度。响应中带有 `pagination` 区块——`appliedKeywordMinScore`、`appliedSemanticMinScore`、`totalRelevant`、`returned`、`offset`、`range`、`hasMore`、`nextCursor`，其中 `totalRelevant` 是至少被一个分支接纳的文档总数，通常会超过一页。执行顺序是**检索 → 各分支按自己的阈值过滤 → 取并集 → 按 RRF 排序 → 分页**，因此后面的页码里不可能出现两个分支都拒绝的文档，最后一页也不会被人为填满。把 `nextCursor` 原样作为 `cursor` 传回（其余参数保持不变或省略），即可在同一份排序结果上继续翻页；它不会重新执行检索，因此分页之间不会出现重复、遗漏或乱序。在携带 `cursor` 的同时改变 `query`、`keywords`、`domain`、`expertRole`、`minKeywordScore` 或 `minSemanticScore` 会被拒绝——那属于一次新的搜索。分页状态保留 15 分钟，覆盖最近 5 次搜索；过期的游标会给出明确的错误提示，而不是悄悄从头开始。

**检索深度。** 两个分支都是**穷尽式**的：融合会看到所有候选，`ranked` 包含每一篇被至少一个分支接纳的文档，`results` 只是其中的一个窗口。因此不存在需要"够用就好"的候选池，也没有 `candidateK` 参数。`totalRelevant` 是精确值，只有在某个分支失败或超时时才会退化为下限——此时 `pagination.degradedRetrieval` 和 `pagination.totalRelevantIsLowerBound` 都会被置位。

#### `search_library`

针对标题、作者、年份、条目类型等明确字段约束的结构化元数据搜索。一般文献发现请优先使用 `hybrid_search`。

- `q`、`title`、`titleOperator`、`yearRange`、`itemType`、`includeAttachments`、`relevanceScoring`、`sort`、`limit`（默认 200）、`offset`

#### `search_annotations`

当你还不知道哪篇文档持有相关内容时，用来搜索**你自己的标记**——全库范围的 PDF 高亮、批注，以及你在 Zotero 中写下的笔记。它返回的一切都是用户自己的阅读痕迹，而不是文献本身：应逐字引用并明确归属给用户。

`q`、`colors`、`tags` 中至少要有一个非空值；空字符串和空数组会被直接拒绝，而不是触发一次不加过滤的全量扫描。所有满足过滤条件的标记会在返回单页结果**之前**先被完整评分和排序——此前的实现只对前 100 条任意候选排序，在匹配数超过这个数字的文献库中，真正最佳的结果经常被排在窗口之外。

每条结果携带三个独立的键，其中只有一个是文档键：`sourceItemKey` 是这篇**论文**，`attachmentKey` 是标记所在的那个 PDF，`annotationKey` 是标记本身。请用 `sourceItemKey` 继续后续调用——它正是 `get_annotations(itemKeys)`、`get_item_details`、`search_fulltext`、`get_document_chunks` 所期望的那个键。

> 1.9.1 之前，每条结果只带一个名为 `parentKey` 的字段：对高亮它是附件键，对笔记它是条目键。把一条高亮的 `parentKey` 传给 `get_annotations` 什么也匹配不到、只会返回空页，读起来像"这篇论文没有任何标记"，而不是"传错了键"。这个字段被直接移除而不是标记为废弃：一个名字对应两种含义本身就是缺陷，保留它只会保留这个失败模式。

- `q`、`itemKeys`（文档键；会全部被搜索）、`types`、`colors`、`tags`、`minRelevance`、`limit`（默认 15，最大 100）、`offset`
- 当前页的每一条结果都包含完整的高亮/笔记原文和完整的评论，没有任何压缩或"简略模式"。
- 返回 `pagination`，包含 `total`、`offset`、`limit`、`hasMore`、`nextOffset`
- 每条结果返回 `sourceItemKey`、`attachmentKey`（笔记没有此字段）和 `annotationKey`
- 当一条标记之上没有文档——比如一条顶层笔记，或者挂在未归档附件上的标记——`sourceItemKey` 会是 **null**，并附上 `noSourceItemReason` 说明原因。它绝不会用别的值来替补：曾经短暂地用独立笔记自身的键顶替过这个字段，结果在真实文献库中 `get_annotations` 对它返回 0 条标记，而 `get_document_chunks` 则把"缺少索引"归咎于一篇本就没有附件的笔记。一个所有文档级工具都会拒绝的键，就不是一个文档键。
- 把附件键、笔记键或标记键传给 `get_item_details`、`get_document_chunks` 或 `search_fulltext`，现在会被直接按名称拒绝，并在拒绝信息中给出应该使用的文档键。此前 `get_item_details` 会在附件键上"成功"执行，并把 PDF 的文件名当作标题返回。

#### `search_fulltext`

检索漏斗的第三阶段：对由 `hybrid_search` 定位到的**某一篇**文档的段落，执行关键词 + 语义混合检索。评分规则与 `hybrid_search` 完全一致，只是下沉了一层——候选变成了这篇论文的段落，而不是全库的文档。两个分支受同样的两项用户设置约束，通过者取并集（一个段落只需要满足其中一个条件），排序采用加权 RRF，依据每个段落在各自分支内的名次，因此这里的 `score` 同样是名次而不是相关度。全库范围的全文扫描在此被禁用。

调用它之前，先用 `get_item_abstract` 读一遍这篇论文的摘要，根据论文实际研究的内容重新确定 `domain` 和 `expertRole`，并用论文自身的主题写出 `query` 和 `keywords`——**用这篇论文实际使用的那种语言**，只用一种语言而不是两种都用，因为另一种语言的探针词无法匹配到单篇文档中的段落。

- `itemKey`（必填）、`query`、`keywords`、`domain`、`expertRole`、`maxChunks`、`minKeywordScore`、`minSemanticScore`、`chunkIds`、`neighborRadius`、`libraryID`

#### `search_collections`

当用户按名称提到某个文件夹、你需要它的 `collectionKey` 时，用来按名称查找分类。只返回身份信息和路径，不返回内容。参数：`q`（必填）、`limit`、`offset`、`libraryID`。可通过响应中的 `pagination.nextOffset` 继续翻页。

#### `get_libraries`

列出当前客户端可见的所有 Zotero 文献库。响应格式为 `{ results, pagination, metadata }`，`pagination` 中包含 `total`、`hasMore`、`nextOffset`。参数：`limit`、`offset`。

#### `search_libraries`

当用户提到某个群组文献库、你需要它的 `libraryID` 时，用来按名称查找文献库。参数：`q`（必填）、`limit`、`offset`。

#### `get_annotations`

读取你已经指名的文档上**你自己的标记**：PDF 高亮、批注、图片与墨迹标注，以及你在 Zotero 中写下的笔记。笔记正文正是从这里获取的——`get_item_details` 不再返回笔记正文，因为一个元数据查询顺带把用户的私人笔记发出去，却没有任何标记说明这段话到底是谁写的。

传入 `itemKeys`（一篇或**多篇**文档——全部都会被读取，这也是"对比我在这五篇论文里的标记"能一次调用完成的原因）、`itemKey`、`annotationId`、`annotationIds` 中的**恰好一个**。`itemKeys` 接受的是**文档**键——即 `search_annotations` 结果中的 `sourceItemKey`，而不是它的 `attachmentKey`。每条结果都携带它来源的 `sourceItemKey`，因此即便一次读取多篇文档，标记的归属依然清晰可辨。

结果总是分页返回，因为一份读得仔细的 PDF 可能有成百上千条高亮。当前页中每一条标记都包含完整的原文和完整的评论。

- `itemKeys`、`itemKey`、`annotationId`、`annotationIds`、`types`、`colors`、`tags`、`limit`（默认 20，最大 100）、`offset`、`libraryID`

#### `get_item_details`

一个条目的书目元数据——引用工具。返回标题、作者、日期、条目类型、期刊、卷期页码、DOI、URL、语言、标签，以及每个附件各一行的信息。

**它不返回任何正文内容，这是有意为之。** 没有摘要正文、没有笔记正文、没有批注文字、没有 PDF 正文、没有分块——这些内容各自都有专门的工具负责返回，并且各自都做了正确的分页。它给你的是"是否存在"这一层信息：`hasAbstract` / `abstractChars` 说明 `get_item_abstract` 会返回什么，但并不真的返回；`noteCount` 说明 `get_annotations` 能找到多少条笔记。

`fullText` 汇报语义索引实际持有的内容，使用与所有搜索结果相同的五档取值（`indexed` / `parse_failed` / `no_source` / `not_indexed` / `unknown`）。这取代了旧版每附件一个的 `hasFulltext` 布尔值——它只看文件扩展名，因此会把从未成功解析过的 PDF 也标记为"有全文"；这个按附件区分的旧标志依然保留，改名为 `hasExtractableText`，含义是"这种文件类型理论上可以提取出文本"。

参数：`itemKey`（必填）、`libraryID`。

#### `get_item_abstract`

检索漏斗的第二阶段：按需获取某个条目的摘要。只在你确实认真考虑要深入阅读某篇论文时才调用它——它不是 `hybrid_search` 之后的批量步骤，20 条候选并不意味着要拿 20 份摘要。

参数：`itemKey`（必填）、`format`（json/text）。

#### `get_attachment_text`

**单个附件**（PDF、Markdown/HTML/纯文本文件）的正文文本，仅此而已。它取代了 `get_content`——后者把摘要、笔记、每个附件的正文和网页快照全部合并成一个对象，既没法单独只要其中一项，也完全没有分页。

**选择附件。** 只传 `itemKey` 会得到附件列表而不返回正文；再带上你想要的 `attachmentKey` 重新调用一次。只有一个可提取文本的附件时会自动选中（`selectedAutomatically: true`）；有两个时绝不会替你猜——因为读错附件返回的文本看起来完全正常，却属于另一份文档。对于独立的 PDF 或其他未归档附件，直接把该附件自己的键作为 `itemKey` 传入即可，不需要父条目。当本地文件可用时，附件行会包含 `sizeBytes`。

**文本的来源。** 每次响应都会在 `textSource.method` 中说明来源，并附带一段 `description` 说明这段文本可以在多大程度上被信任：`doc2x`（保留了出版商的原始结构）、`mineru_cache` / `mineru_attachment`（复用了先前解析好的 MinerU Markdown，版面已重建）、`mineru`（本次调用中实时解析）、`markdown_attachment`、`zotero_fulltext_cache`（Zotero 自带的扁平索引——**没有版面、没有表格**）、`pdf_processor`、`html_parsing`、`text_reading`。无法产出文本时，`method` 会说明具体原因（`mineru_disabled`、`mineru_on_demand_disabled`、`mineru_failed`、`mineru_error`、`no_text`）。

**分页。** 文本以字符窗口的形式返回，会在附近有段落或句子边界的地方截断，确保一个窗口不会截断在词语中间。`pagination` 包含 `totalChars`、`offset`、`returnedChars`、`hasMore`、`nextOffset`。

- `itemKey`（必填）、`attachmentKey`、`offset`、`limit`、`libraryID`

### 二、分类管理（3 个）

#### `get_collections`

列出分类，主要用途是让你读到用户真实的文件夹名称，再把相关的分类作为 `collectionKeys` 传给 `hybrid_search`。扁平结构且支持分页：默认返回顶层分类，或者 `parentCollection` 的直接子分类。

响应格式为 `{ results, pagination, metadata }`。1.9.1 之前它返回的是一个裸数组，总数放在 `X-Total-Count` 响应头里——而 MCP 协议只转发响应体，因此总数和服务器附带的 `metadata` 区块都会被 `JSON.stringify` 悄悄丢弃，300 条结果中的一页 100 条会和一个只有 100 条的完整文献库无法区分。`search_collections` 返回同样的响应结构。

参数：`parentCollection`、`limit`（默认 100）、`offset`、`libraryID`。

> `recursive` 参数已在 1.9.1 移除。它会在一次不分页的响应中返回所有层级，与 `get_collection_items` 功能重复，并重新引入了逐层浏览器本来要替代的整体转储问题。现在传入它会直接报错，而不是被静默忽略。`get_collection_items` 会为每个文件夹汇报 `directItemCount`、`totalItemCount` 和 `hasChildren`，因此不下载子树内容也能了解它包含什么。

> `get_subcollections` 已在 1.9.0 作为重复工具被移除：它其实就是把这个工具的 `parentCollection` 改名为 `collectionKey`，最终走的是同一个处理逻辑、同一套递归遍历。请改用带 `parentCollection` 参数的 `get_collections`。

#### `get_collection_details`

某个分类的元数据：名称、父分类、包含多少条目和子分类，但不列出具体内容。参数：`collectionKey`（必填）。

#### `get_collection_items`

**像文件管理器一样逐层浏览文献库。** 每次调用返回当前层级的子文件夹，以及直接归档在这一层的一页文档——绝不会返回整棵树。

不带 `collectionKey` 调用即可从库的根目录开始（顶层分类，以及未归入任何分类的文档），传入你想打开的文件夹的 `collectionKey` 即可继续下钻。每次响应都会重复当前的 `location`（`libraryID`、`collectionKey`、`name`、`path`）以及你从哪个 `parent` 而来。

每个子文件夹行都带有 `directItemCount`、`totalItemCount` 和 `hasChildren`，这让你可以在不打开任何内容的情况下选择该往哪里下钻：`directItemCount` 为 0、`totalItemCount` 为 300 的文件夹是一个容器，而不是死胡同。`totalItemCount` 会去重——一篇同时归档在父文件夹和子文件夹中的论文只会被计一次。

文档行的信息刻意保持精简——`itemKey`、标题、作者、年份、期刊、DOI、条目类型。不包含摘要、笔记、批注、附件正文或分块：旧版本会返回 `formatItem` 的完整默认字段列表，导致两行结果就有 4.5 KB，列出一个 200 条的文件夹几乎耗尽一个上下文窗口。

- `collectionKey`、`path`（例如 `"Materials/Solidification/CET"`，会被解析为对应的键；路径存在歧义时会直接报错并列出候选键，而不是随意猜测）、`limit`、`offset`、`libraryID`
- 返回 `location`、`parent`、`subcollections`、`items`、`itemPagination`

### 三、语义检索与阅读（6 个，可在偏好设置中禁用）

`hybrid_search`、`keyword_search`、`semantic_search` 返回**同样的轻量候选行**，共享同样的范围限定和游标分页逻辑，因此在它们之间切换没有任何额外成本。真正不同、也绝不能混用的有两点：每个工具应用的是它**自身所属分支**的阈值（`keyword_search` 用关键词阈值，`semantic_search` 和 `find_similar` 用语义阈值，`hybrid_search` 独立应用两者），以及 `score` 字段的含义——在单分支工具上是 0–1 的相关度，在 `hybrid_search` 和 `search_fulltext` 上则是名次融合的**位置**。它们的实现也是共享的：一个词法检索服务（`runLexicalSearch`）、一个语义检索服务（`SemanticSearchService.search`）、一套分页存储、一套结果行投影逻辑，两种检索算法都不存在第二份实现。

#### `keyword_search`

纯词法检索——不涉及向量嵌入，也不做任何语义打分。它把你的检索词与**整个文献库**的元数据（标题、摘要、作者、期刊名、标签、extra 字段）**以及关键词索引中每一篇文档的正文**放在同一次 BM25F 计算中打分。

**正文覆盖是局部的。** 正文匹配读取的是插件自己的关键词索引；它从不扫描 Zotero 的全文缓存，也从不临时打开 PDF，因此它能覆盖到的正好是已经建立索引的那些文档。结果中缺席的论文可能只是尚未建立索引，而不是真的不相关——`metadata.bodyKeywords` 会同时汇报 `indexedDocuments` 和 `metadataCollectionSize`，方便你区分这两种情况。

正文命中也是一次完整的命中：一篇标题、摘要、标签中都不含任何检索词的文档，仍然可以仅凭正文进入排名。这样的结果行会带有 `matchedFields: ["body"]` 和一个 **`bodyEvidence`** 数组——列出承载了这些检索词的具体段落，每一条都附带其 `chunkId`、命中了哪些关键词、命中了多少次，以及段落原文。对于一条纯正文命中的结果，这是唯一能解释它为何出现在结果中的信息。`occurrences` 只是给阅读者看的证据强度指标，不参与排序。

这里的 `score` 是真正的 0–1 相关度：只有一个分支意味着不存在需要融合的对象，因此它就是被应用了阈值的、归一化后的 BM25F 分数。这与 `hybrid_search` 的 `score`——一个名次融合位置——完全是两个量纲，绝不能把两者的数值互相带入比较。这里应用的阈值是用户的**关键词**相关性阈值，与门控 `hybrid_search` 关键词分支的是同一个设置。

它有两种用途：一是不能遗漏的精确检索词，二是——也是设计初衷——作为一个**粗筛工具**，把它的 `itemKeys` 交给 `semantic_search`，让语义打分只在这份候选名单内进行。对于普通的文献发现，`hybrid_search` 仍然是默认的第一步，因为它同时运行了这个分支和语义分支。

- `keywords`（未携带游标时必填；支持中英双语，1–16 个，推荐 5–12 个）、`query`（仅作为兜底探针，绝不会被向量化）、`domain`、`expertRole`、`collectionKeys`、`itemKeys`、`topK`、`cursor`、`minScore`、`libraryID`

#### `semantic_search`

纯粹的向量相似度检索：把一段自然语言查询向量化，并与每一个已索引段落进行比较。适用于那些你无法精确定位关键词、或者用作 `keyword_search` 粗筛结果之上精排的场景。

在 1.9.0 之前，这是唯一一个还停留在检索漏斗架构之前的工具：写死的 `topK = 10` 和 `minScore = 0.3`，完全无视用户自己的设置；没有游标；没有分类或条目范围限定；结果行直接携带未截断的原始分块文本（在真实文献库中，整段参考文献列表都可能作为"证据"出现）；也没有 `fullText` 状态——因此一次命中论文摘要的语义结果，和一次命中论文正文的结果完全无法区分。以上问题现在已全部与 `hybrid_search` 保持一致。

- `query`（未携带游标时必填）、`domain`、`expertRole`、`collectionKeys`、`itemKeys`、`topK`、`cursor`、`minScore`、`language`、`libraryID`

#### `find_similar`

用一篇论文自身的若干段落作为查询，查找与之语义相似的**文档**。纯语义匹配——不涉及任何关键词。

通常先用 `search_fulltext` 挑出源论文中有代表性的段落，再把它们的 `chunkId` 传入这里。每个分块都会作为独立的查询向量在整个索引中被扫描一遍；各个分块的得分会被汇总成每个候选文档的**唯一**得分（对每个查询分块，取该候选文档中最匹配的两个段落取平均；再把各查询分块得到的这些平均值以 0.75 × 均值 + 0.25 × 最大值的方式组合），因此一篇文档要合格，需要和所提供的多个方面产生关联，而不是仅凭一个偶然匹配的段落。源论文本身会被排除在结果之外。

所有超过用户相关性阈值的文档都会被返回——合格数量没有上限——并进行排序和分页。**单页最多包含用户配置的最大文档数**，没有固定的页面大小，`topK` 只能把它调低。结果只携带身份信息、分数和匹配到的 `chunkId`，不携带段落正文；要阅读某个候选，请用 `search_fulltext`。

超时：没有独立设置。扫描的时间预算是用户设置的单次扫描超时 `vectorScanTimeoutMs`，按查询分块数量以及即将执行扫描的路径进行缩放——CPU 上是 `0.8 + 0.35N`（对索引进行一次共享遍历），GPU 上是 `0.5 + 1.1N`（每个查询分块各自进行一次常驻向量扫描）。两个系数都来自实测（`npm run benchmark:find-similar-scaling`），实际应用的时间预算会在响应的 metadata 中给出。

- `itemKey`（发起新搜索时必填）、`chunkIds`（发起新搜索时必填，最多 20 个，且必须全部来自同一篇文档）、`minScore`、`topK`（单页大小，受用户设置的最大文档数限制）、`libraryID`、`cursor`（在不重新扫描的情况下继续翻页）

#### `semantic_status`

获取语义搜索服务状态和索引统计信息，无需任何参数。

#### `build_search_index`

显式为一个或多个文档构建或刷新统一搜索索引。它使用与 Zotero 更新索引命令相同的目标化生命周期——对每篇文档提取并分块一次，随后同时更新语义向量和关键词索引。它保留了现有的构建锁、暂停/重置屏障、失败日志、分块设置和嵌入兼容性检查。这个操作可能开销较大，且 `wiki_build_from_paper` 从不会隐式触发它。

- `itemKeys`（必填，1-100 篇文档）、`libraryID`
- 为每篇文档返回一个结果以及汇总统计。语义和关键词两方面的结果是分开汇报的，因此一个分支不会悄悄掩盖另一个分支的失败。`parse_failed` 和 `no_source` 会如实汇报确实没有可索引正文的情况，而不是虚报成功。

#### `get_document_chunks`

按语义索引存储的顺序，**从头到尾读一篇论文的正文**，每页返回几个分块。`search_fulltext` 回答的是"这篇论文哪里提到了 X"；这个工具回答的是"让我完整读一遍这篇论文"。

每个分块都带有 `chunkIndex`（在阅读顺序中的位置）和 `chunkId`（`search_fulltext` 和 `find_similar` 所接受的稳定 ID）。这两者**不可**互相换算——它们在任何分块被丢弃的地方都会产生偏差——因此永远不要用一个去推算另一个。

分页是强制的：一页最多 20 个分块，没有办法一次要到整篇文档。一篇 PDF 从未成功解析、或者没有文本附件的文档，会被**直接拒绝**并说明具体是哪种情况，而不是拿标题和摘要冒充正文来敷衍作答。

- `itemKey`（未携带游标时必填）、`cursor`、`offset`、`limit`、`libraryID`
- 返回 `fullText`、`pagination`（`totalChunks`、`returned`、`offset`、`range`、`hasMore`、`nextCursor`）和 `data`

> `fulltext_database` 已在 1.9.0 移除。它原有四个动作中的两个（`list`、`stats`）本质是暴露给调用方的索引管理操作；第三个（`get`）会在一次不分页的响应中返回整篇文档——这是当时唯一还残留的、绕开所有其他工具都遵守的检索漏斗的通道。索引维护现在只存在于插件的偏好设置界面中。

### 四、LLM Wiki（19 个，可独立禁用）

Wiki 是一个独立的长期知识数据库。它存储可复用的 Page、Claim、Concept、Relation 和可追溯的 Evidence，而不是又一份论文摘要索引。日常研究使用"准备-受控提交"流程；`wiki_build_from_paper` 只能用于用户明确要求深读的某一篇论文。服务器本身不会发起任何隐藏的 LLM 调用。

**两种阅读方式，共用一份阅读笔记。** 一篇论文可以以两种不同的方式被阅读，两者都会写入同一份 Markdown 笔记和同一份"实际读过哪些分块"的台账。

**提问驱动的阅读**是日常路径。用户提出问题，先后用 `hybrid_search`、`search_fulltext` 找到相关段落，模型真正读了其中一些并给出回答——随后，对**每一篇真正被读过的论文**，调用 `wiki_update_reading_note`，带上 `readChunkIds`（本次真正用来回答问题的分块）、检索这篇论文时使用的 `domain` 和 `expertRole`，以及重写后、包含刚学到的内容的整份笔记。检索返回过、但没有人真正使用过的分块不会被列入：检索不等于阅读，服务器只对被明确声明过的内容负责。

以这种方式读过的分块以**集合**而非游标的方式累积。先 `{7,8,42}` 再 `{15,42,70}` 是五个不同的分块，而不是六个；重复出现的 42 不会被计两次，一次调用内部的重复同样如此。笔记标题栏用方格图案描绘覆盖情况：读过的分块是实心方格，未读的是空心方格（超过一百个分块后，一格会代表若干个分块，部分读过的格子会画成半实心）。

顺序是**先笔记、后 Wiki**，服务器会强制执行这一点，而不只是要求：如果最近一次阅读还没有反映到 Wiki 里，这篇论文会拒绝被再次阅读，直到某次 `wiki_commit` 引用了它。一次提问读了三篇论文，只需要一次引用了全部三篇的提交即可结清。只有真正读到了新内容的那一轮才需要更新 Wiki——如果这一轮只是基于已有理解作答，就应如实说明并跳过更新，而不是往 Wiki 里塞入重复内容。写入的内容应该延伸已经存在的 Page、Claim、Concept 和关系，而不是在旁边制造近似重复的条目。

笔记只会增长。每次重写都可以重新组织、合并和修正，但一次丢失超过原文十分之一内容的重写会被拒绝——如果每一轮都压缩一点点，到第二十次提问时第三页读到的那些参数就会消失得无影无踪，而单独看每一次重写又都显得合理。笔记中的每一个事实、参数、结果、机制和图表，都必须在正文中标明它来自哪个分块（例如"熔池深度达到 1.2 mm（分块 42）"），否则笔记无法保存；把分块编号写在**标题**里同样会被拒绝，因为那是流水账，不是知识组织方式。

提问驱动的阅读**永远**不会达到 `paper_reviewed` 深度。即使零散的提问碰巧覆盖了每一个分块，这条路径上的 `finalSynthesis` 依然会被拒绝，Evidence 也只能停留在 `chunk_local` 或 `section_read` 层级。"通读全文"指的是一个具体的动作——完整读一遍，再把它当作一个整体去梳理——无论零散的片段读了多少次，都无法构成这个动作。

**深读单篇论文**是最初的路径，现在会**继承**提问阅读已经读过的内容。一篇论文按固定顺序被阅读，服务器会强制执行这个顺序。开局的 `wiki_build_from_paper` 调用只返回论文的元数据和摘要，不返回正文；`wiki_set_reading_expert` 会给出唯一一位负责阅读这篇论文的领域专家，同时在这个 Zotero 条目上创建一份持久化的 Markdown **阅读笔记**附件。随后正文分块按页依次送达，每送达一页就用 `wiki_update_reading_note` 重写整份笔记——合并、重新排序、修正，而不是简单追加。按投送批次组织的笔记（例如"分块 8-15"、"本批新增"）会被拒绝：分块只是文本的运输方式,不是组织知识的方式。最多允许有一个已投送但尚未处理的批次，否则下一页会被拒绝送达；一个确实没有新增内容的批次可以回答 `unchanged`，但不能连续两次都这样回答。

笔记顶部的信息块——`paperKey`、`title`、`abstract`、`expert`、`readChunks`、`totalChunks`、`nextChunk`、`coverage`、`status`、`updatedAt`——由服务器根据阅读台账自动维护，而不是由模型填写，因此笔记里写的任何内容都无法让这篇论文的进度看起来比实际更靠前。因为笔记是条目上一份真实的文件，Zotero 重启、MCP 断开连接或者上下文被压缩都不会造成任何损失：`wiki_get_reading_note` 会返回笔记、专家画像，以及应该从哪个分块继续阅读。

如果提问阅读已经涉及过这篇论文，`wiki_build_from_paper` 不会从头开始：同一个会话会被原地升级为全文阅读模式，保留原有的分块台账和笔记，翻页时会跳过页首那些已经读过的连续文本，只请求提问从未触及的部分，`carriedOverFromQuestionAnswering` 会说明具体继承了多少内容。唯一仍然要求重新给出的是一份**经过认真考虑**的专家画像：提问过程中临时根据检索参数拼凑出的阅读者身份会被标记为临时性的、可能被替换，因为决定由谁来通读一整篇论文，值得认真对待。显式传入的 `offset` 从不会被跳过,因此重新阅读某个段落以核对一句引用依然可行,也不会对完整性检查产生任何额外成本。

一旦所有分块都已投送完毕,在 `wiki_prepare_update` 允许开始正式写入之前,还需要再完成三次审查:一次针对整篇论文（`finalSynthesis`）,一次针对论文确立的术语（带 `final` 的 `wiki_record_concepts`）,一次针对**整个 Wiki**（`wiki_prepare_update` 上的 `wikiReview`）。第二次审查会构建独立的概念库:每个概念是一个实体,有一个主术语和任意数量的别名术语,每个术语都带有中文全称、英文全称和缩写——硬性规则是缩写永远不能单独存在。一篇没有引入任何新内容的论文,可以返回一个空列表并说明原因。名称永远不会被直接覆盖掉:两篇论文对同一个术语有不同的拼写方式时,两种拼写都会作为同一个概念下的两行术语保留下来,只有当某篇论文明确推翻了模型此前推断出的某个值时,那个值才会被替换。

第三次审查是 2.5.0 版本新增的。前两次审查关注的都是**这篇论文本身**:笔记是否连贯,术语是否已经审查过。但 Wiki 是在整个阅读过程中持续增量增长的,到论文读完时通常已经出现了漂移——某个早期分块写下的 Claim,被后面的分块限定了适用范围;两个相隔多轮写下的 Concept,其实是同一个东西;早期画出的一条关系,现在已经不再成立。所以最后这道关卡会带着读完的整篇论文,从五个维度反问:是否需要调整或新建某个 Page;完整阅读之后,哪些 Claim 得到了确认、需要加限定条件、需要合并,或者被推翻了;哪些 Claim 的 Evidence 还比较单薄,哪些 Evidence 现在可以提升到全文深度;哪些术语需要新增、修正或去重;哪些关系应该被建立或撤销。每一个维度都必须给出回答——"这里不需要改动,因为……"是一个完全合格、也是最常见的回答——但沉默不被接受,因为沉默无法与"没有真正检查过"区分开来。这个审查每篇论文只会被要求一次,验证失败后的重试不会重新触发它。

Evidence 只有在两个条件都满足时才能达到 `paper_reviewed` 或 `cross_paper` 深度:全文阅读投送了每一个分块,**并且**完成了那次最终审查。投送不等于理解。笔记本身永远不能作为 Evidence——Claim 依然必须引用经过校验、确实来自论文自身索引分块的摘录,而且那个分块必须已经被记录为"已读",无论它是通过 `wiki_build_from_paper` 投送的,还是通过 `readChunkIds` 声明的。引用一段没有人读过的文字会被直接按名称拒绝:摘录内容确实存在于论文中,缺失的是对它的阅读。这正是"先笔记、后 Wiki"的另一半含义——一条 Claim 只能建立在笔记已经记录过的内容之上。笔记本身也被排除在搜索索引之外,因此一篇论文的总结永远不会被当成论文本身检索出来。

- `wiki_prepare_update` — 在提出任何变更之前先搜索现有知识;最多传入两个精确的 `proposedPageTitles`,让它签发的短时效令牌只能授权那些真正被搜索过的 Page 标题。`pendingWikiWriteUp` 会列出哪些论文的阅读笔记已经领先于 Wiki。一篇论文一旦被完整深读过,还需要额外提供 `wikiReview`——一次覆盖 Page、Claim、Evidence、Concept、Relation 五个维度的全 Wiki 审查
- `wiki_get_prepared_context` — 按区块和偏移量取回一份已准备好的快照。准备阶段默认返回精简结果;使用 `preview: true` 可以在提交五维度审查之前先查看 Claim、Evidence 和跨论文候选项。阅读记录和较大的条目会分页返回,不会丢失内容
- `wiki_commit` — 应用已通过校验的 `SKIP`、Evidence、Claim、Page、Relation 或冲突处理动作
- `wiki_search` — 检索 Concept/Alias、Claim、Relation,以及一跳范围内的 Evidence 关联
- `wiki_get_page` — 读取一个 Page 及其 Claim 和 Evidence
- `wiki_get_claim` — 读取一条原子化的 Claim 及其来源信息
- `wiki_get_link_review` — 取回持久化的跨论文任务、目标快照、结论和历史记录。可以独立于 prepare 令牌单独获取 Page 目标、发现结果、结论、结果或历史。对比选定的旧 Wiki 知识、记录每一次排除、并显式推迟处理缺失的知识。`wiki_commit.crossPaperReview` 会把结论绑定到真实的 Claim、术语来源,或新的 Claim 关系上;`checkpoint: true` 可以在不结束阅读的情况下保存进度。图谱按论文对绘制连线,优先展示分歧、共享 Claim、方法比较或限定条件,其次是共享 Page,再次是共享 Concept。点击任意一条连线会以统一的卡片形式展示所有关系,附带 Claim 和原文摘录。Evidence 摘要会区分当前有效的支持、已归档的来源,以及未经验证的语义评估;保留下来的旧版评分只是启发式参考,不是正确性概率
- `wiki_status` — 汇报 Wiki 和 Evidence 关联的状态
- `wiki_export` — 渲染衍生的 Markdown,不改动权威数据库;概念库会作为最后一节被附加进去
- `wiki_record_concepts` — 记录在真正阅读一篇论文过程中识别出的专业概念,每个概念作为一个实体,带一个主术语和任意数量的别名术语(中文全称/英文全称/缩写),以及它们被识别出的来源文档。不带 `final` 的调用只会暂存在当前打开的阅读会话中,不写入任何内容;带 `final` 的那一次调用会一次性写入全部内容,因此一篇论文只需要一次数据库写入和一次确认,而不是按批次多次写入。每个字段都带有自己的来源标注——引自论文原文、由模型补全、或由人工编辑——模型可以用自己的知识补全某个术语,只要如实说明这一点
- `wiki_list_concepts` — 列出独立的概念库,包含每个术语及其来源
- `wiki_export_concepts` — 单独把概念库导出为 Markdown
- `wiki_reverify` — 在索引重建之后重新关联 Evidence,并在同一次操作中对所有待处理的跨论文候选项重新对照实时索引进行校验
- `wiki_scan_links` — 计算跨论文关联候选:哪些论文与哪些论文相关,通过哪些段落、术语或概念产生关联。通常不需要手动调用——一篇论文第一次产生真实阅读记录时会被自动加入队列,队列会在后台自行处理;刻意批量导入论文并不会触发它。一次扫描是对全库最多 20 个代表性分块做一次向量扫描,随后进行不再重新扫描全库的成对精细比对。它写入的是**建议**:这些建议会在 `wiki_prepare_update` 中以 `pendingLinkSignals` 的形式出现,附带原文段落和服务器计算出的 `mustResolve`,这个工具本身不会写入任何 Page、Claim、Evidence、Concept 或关系
- `wiki_build_from_paper` — 深读一篇被明确指定的论文:先返回元数据和摘要,再按页依次返回正文分块;沿着 `pagination.nextCursor` 持续调用,直到 `pagination.coverageComplete` 为真;必须先结束当前正在读的论文,才能开始下一篇。它会继承提问阅读已经读过的内容——同一份笔记、同一份台账——只请求剩余部分。"同一时间只能深读一篇"这条限制只适用于全文阅读本身;提问驱动的阅读不占用这个名额,可以同时涉及多篇论文
- `wiki_set_reading_expert` — 根据论文的元数据和摘要生成这篇论文唯一的领域专家画像,并在对应的 Zotero 条目上创建持久化的 Markdown 阅读笔记
- `wiki_update_reading_note` — 用你当前对这篇论文的理解重写整份阅读笔记。在全文阅读中每投送一页调用一次;在回答完提问后,对每一篇真正读过的论文调用一次,并带上 `readChunkIds` 说明真正被使用过的分块,以及检索这篇论文时用的 `domain` / `expertRole`。`finalSynthesis` 用于在所有分块都投送完毕后标记全文审查这一遍,提问驱动的路径上不可用
- `wiki_get_reading_note` — 取回一篇论文的笔记、专家画像和精确的续读位置;这是重启或上下文压缩之后的恢复路径
- `wiki_finish_reading` — 在不写入的情况下关闭一篇论文(`skipped`)。不带 `itemKey` 时关闭的是当前正在深读的论文;带上 `itemKey` 时也可以关闭一篇提问阅读一直在涉及的论文,从而解除对它继续被阅读的限制

### 五、写入操作（11 个，可在偏好设置中禁用）

写入操作被禁用时（这是默认状态），这 11 个工具全部会从 `tools/list` 和 `/capabilities` 中隐藏——服务器不会去宣传一个自己会拒绝执行的能力。

还有两个 Wiki 工具与它们同步隐藏，值得特别说明，因为它们并不在本节列出：`wiki_set_reading_expert` 和 `wiki_update_reading_note` 会在 Zotero 条目上创建并重写阅读笔记这份真实的 Markdown 附件，因此它们本质上是 Zotero 写入操作，也按写入操作被门控。关闭写入操作因此也会连带停用 Wiki 阅读笔记——从 `tools/list` 中消失的是十三个工具，而不是十一个。

#### 分类变更

- `create_collection` — `name`（必填）、`parentCollection`、`libraryID`
- `update_collection` — `collectionKey`（必填），以及 `name`、`parentCollection` 中至少一项
- `delete_collection` — `collectionKey`（必填）、`deleteItems`
- `add_items_to_collection` — `collectionKey`、`itemKeys`（均为必填）
- `remove_items_from_collection` — `collectionKey`、`itemKeys`（均为必填）
- `move_items_to_collection` — `toCollectionKey`、`itemKeys`（均为必填）、`dryRun`
- `merge_items` — `groups`（必填）、`dryRun`

`move_items_to_collection` 是重组工具，也是这五个工具中唯一一个结果是**替换归档**而非追加归档的工具：每个条目最终只归档在 `toCollectionKey` 中，不会保留在其他地方。如果一份文档需要同时保留在多个文件夹中，请改用 `add_items_to_collection`。

批量操作是全有或全无的。缺失的条目、已在回收站的条目，以及子级笔记或附件，都会在任何写入发生之前的预检阶段被直接拒绝，因此一个错误的键会让整批操作直接中止、什么都不会被写入，而不会让文献库处于"重组到一半"的状态；写入本身在单个事务中完成。`dryRun` 会执行同样的预检并返回同样的方案——哪些条目会移动、每个条目会失去哪些归档关系——但不会真正写入，也不会触发确认弹窗，这正是它能安全地用来向用户展示一个拟议中的重组方案的原因。

对于 `add_items_to_collection` 和 `remove_items_from_collection`，如果整批条目全部缺失，本次调用会直接失败。如果是部分缺失，则返回 `success: false` 和 `partial: true`，并分别列出已完成和缺失的键。重新挂靠的确认弹窗会列出目标分类和每一个子级键；合并操作的确认弹窗会对分组做预检，并列出每一个保留下来的条目和每一个将被 Zotero 移入回收站的重复条目。

#### 条目与笔记变更

#### `write_note`

创建或修改 Zotero 笔记，支持 Markdown 自动转换为 HTML。

- `action`（必填：create/update/append）、`parentKey`、`noteKey`、`content`（必填）、`tags`

`content` 是必填字段且必须是字符串；不传它和传一个空字符串是两回事。空字符串意味着**清空**，只有 `update` 动作接受它——此时笔记会被清空，响应中会报告 `cleared: true` 以及被清除的字符数（笔记条目本身仍然保留——如果需要彻底删除，请在 Zotero 中手动删除）。`create` 和 `append` 会拒绝空内容，因为在这两种场景下，空内容只可能意味着内容生成本身出了问题、返回了空结果。

#### `write_tag`

对条目添加、移除或替换标签。

- `action`（必填：add/remove/set）、`itemKey`（必填）、`tags`（必填）

#### `write_metadata`

更新条目的元数据字段（标题、摘要、日期、DOI、作者等）。

- `itemKey`（必填）、`fields`、`creators`

#### `write_item`

创建新条目、重新挂靠已有附件，或把本地文件作为附件导入。

- `action`（必填：create/reparent/import）、`itemType`、`fields`、`creators`、`tags`、`attachmentKeys`、`parentKey`
- 仅 import 需要：`filePath`（文件的绝对路径）、`parentItemKey`（要挂载到的条目）、`title`（默认取文件名）

`create` 在单个事务中同时完成新条目的创建和每一个 `attachmentKeys` 的重新挂靠，因此一旦失败不会写入任何内容，重试也不会留下重复条目。指向不存在内容、或指向的内容并非附件的键，不会导致整个创建过程中止——它们会连同原因一起出现在响应的 `skippedAttachments` 中。

`import` 额外要求开启 **Allow File Import** 偏好设置，否则会直接失败；它对应的场景是"把一份 PDF 转换成 Markdown，再把这份 `.md` 挂载到条目上"。

---

## 🤝 贡献指南

欢迎贡献代码、报告问题或提出建议！

1. Fork 本仓库。
2. 创建你的特性分支（`git checkout -b feature/AmazingFeature`）。
3. 提交你的更改（`git commit -m 'Add some AmazingFeature'`）。
4. 推送到该分支（`git push origin feature/AmazingFeature`）。
5. 提交一个 Pull Request。

## 📄 许可证

本项目基于 [MIT 许可证](./LICENSE) 开源。

## 🙏 致谢

- [Zotero](https://www.zotero.org/) —— 一款出色的开源文献管理工具。
- [Model Context Protocol](https://modelcontextprotocol.org/) —— 用于 AI 工具集成的协议标准。
- [![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
- 本项目基于 [cookjohn](https://github.com/cookjohn) 的原始项目 [zotero-lit-synapse](https://github.com/cookjohn/zotero-lit-synapse) 开发——感谢这份最初的 Zotero LitSynapse 集成方案，本项目正是在它的基础上衍生而来。
- 同时感谢 Zotero Mark Reader 作者，本项目的阅读/批注相关功能借鉴了它的实现思路。
