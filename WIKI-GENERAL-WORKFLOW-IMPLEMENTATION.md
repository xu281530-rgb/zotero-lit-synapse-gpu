# Wiki 通用流程优化与验证

日期：2026-09-06。基础版本：3.2.4；未升版、未发布、未安装到运行中的 Zotero。

## 采用反馈的边界

`../research/zotero-mcp-wiki-feedback-rl-sf.md` 是一篇论文的使用记录，不是通用规范。本次按已确认的范围修复可复现的契约、引用和交互问题，保留原有审计与事务要求。

- 不把 `ablation` 等词加入跨学科禁用词表，也不凭单篇记录调整全库词法阈值。
- 不降低已识别测量值的覆盖要求，不取消逐段阅读记账，不放宽 Evidence 连续原文核验。
- 不引入跨重启保存完整 prepared context 的快照系统；复用项目已有的持久化审查任务与提交回执。
- 不将所有反馈中的审计报警认定为误报；这里只修复已由回归用例确认的引用归属、引用格式和部分公式编号误判。

## 已完成

### 公开调用契约

`wiki_commit.actions` 按动作区分必填参数，跨文献审查的 outcome 也按结论区分必需引用、关系、缺口和触发条件。字段类型集中定义，避免在每个分支重复整份 schema。

完整的 `ADD_CLAIM + SKIP + crossPaperReview` 示例通过 `zotero://tool/wiki_commit` 按需提供。示例使用虚构来源与 ID，提交前必须替换为当前文库中实际阅读的内容。测试用 AJV 校验该示例及非法请求，不只检查字段是否出现。

静态 schema 不替代数据库检查：版本、来源、引用归属、知识变更所需证据仍由实际写入流程核验。降低已有 Claim 的覆盖等级时，保留不附加新 Evidence 的兼容行为。

工具目录实测为 125,957 个 UTF-16 代码单元，未提高现有 126,000 上限。较长方法说明保留在按需文档中，而不是每次对话重复携带。

### 紧凑返回与恢复

`compact=true` 的首屏 JSON 上限为 20,000 个 UTF-16 代码单元。首屏保留短预览、ID、revision、总数及完整内容入口；现有 `pages` 作为兼容别名保留，并明确指向 `recalledPages`。

新增 `preparation`、`reviewTasks` 和 `pendingWikiWriteUp` 上下文区，保存首屏省略的准备信息和义务清单。大型记录仍可通过有序片段无损取回。分页明确返回 `unit: context_entry`、请求上限及字符预算是否提前截断；调用方应使用 `nextOffset`，不能假设每页一定等于 `limit`。

成功读取同一文库的 prepared context 会续期 600 秒空闲时间。无效区名、无效分页参数或其他文库的请求不会续期。正在提交的令牌不会被空闲清理误删。

令牌过期或服务重启后，需要重新调用 `wiki_prepare_update`。已保存的审查任务可由 `wiki_get_link_review` 按 `taskId` 读取，并通过 `expectedRevision` 防止继续审查旧版本。已提交操作沿用 `operationId` 和回执恢复机制，不重复写入知识。

### 明确选择的批量暂缓

`deferMissingTargets` 接受调用方选定的 `{ taskId, expectedRevision }` 列表。服务器逐项检查文库归属、重复选择、revision，以及目标论文当前是否确实没有 Wiki Claims，然后转换为正常的 `deferred` 审查记录。

它不是“没有关系”的判断，也不自动暂缓所有任务。未选择的任务保持原状；若准备后或同一次提交中产生了目标知识，事务会拒绝过期决定并回滚。后续目标知识变化会重新开启审查。相同 `operationId` 的重试不产生重复记录。

### 引用、模板与错误

- 引用解析统一支持 `(chunk 12)`、`[chunk:12]`、范围和列表，并保留旧的重复标签写法。未识别的显式引用返回原文及字符位置。
- 无引用句子后的相邻括号引用归属于该句，连续多个后置引用一起处理，不跨越段落边界。推荐将引用放在句末标点之前；前置引用应与上一条未引用句子分段。
- 显式公式编号及紧随数学标记的编号不再当作列表深度；中文无空格枚举仍参与原有审计。此修复不声称可以可靠解析所有 PDF 中的数学排版。
- 模板、校验和提示共用 section 定义；全文阅读包含“本批覆盖”。说明中的旧“80%”改为实际执行的“全部已识别测量值”，没有改变审计阈值。
- 独立校验问题一次汇总；引用无效时不继续推导依赖该引用的审计。JSON Pointer 使用真实字符串字段 `/readingRecord` 或 `/macroSummary`，章节名称作为独立元数据返回。
- 保留审计 ID 对句子、引用与原文内容的已有绑定；错误区分当前 `activeIssues` 和过期 `staleAuditIds`。
- 插件内工具异常返回 `isError`、JSON 文本和 `structuredContent`，包含 `code`、`message`、`retryable`、操作名和分页位置。插件外的客户端审批、网络中断或工具宿主错误不在该处理器控制范围内。

## 验证

使用 `diagnosing-bugs` 的可复现回归方法，先验证具体失败再修复，不凭反馈推断正确行为。

48 组回归全部通过：全部 33 个非聚合 `test:wiki-*` 测试，以及工具目录、文档工具清单、MCP 协议、项目一致性、数据兼容锁、阅读记账提示、HTTP 传输与分帧、隐私、第二轮阅读/回执/指导和第三轮笔记/问答/全文测试。

重点用例包括：13 项通用流程、22 项跨论文审查、55 项综合审计、33 项问答阅读；大字段分页重组、错误聚合、无效请求不续期、批量暂缓事务回滚、重启服务对象后的幂等重试均有覆盖。

`tsc --noEmit` 和 `git diff --check` 通过。保留了开始任务前已有的修改；未进行数据库迁移或真实文库写入。此次验证没有替代在真实 Zotero 中的安装验收。

## 构建与交付

产物：`zotero-lit-synapse-plugin/.scaffold/build/zotero-lit-synapse.xpi`。

已读取压缩包核对 manifest 版本、64 个包内文件，以及本次更新模块的存在。此次交付文件的 SHA-256：

```text
9807EE7E65E5D335D157CDCAB1002BF0D89DDD7ED7212912E0F5A77206D09B19
```

常规 `npm run build` 已完成打包，但 CLI 的更新提示尝试写入用户目录缓存时遇到 `EPERM`，导致命令失败。未修改系统权限或第三方依赖；随后使用同一构建工具的公开接口成功构建，并单独通过 TypeScript 检查：

```powershell
node --input-type=module -e "process.env.NODE_ENV = 'production'; const {Build, Config} = await import('zotero-plugin-scaffold'); await new Build(await Config.loadConfig()).run();"
.\node_modules\.bin\tsc.cmd --noEmit
```

以上命令在插件目录执行，`NODE_ENV` 仅作用于当前 Node 进程。产物包含当前工作区原有修改和本次优化，未自动安装、复制到 Zotero 配置目录或对外发布。
