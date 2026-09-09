# 第二轮与第三轮审计修复验证

日期：2026-09-05。当前源码版本：3.1.0。

按用户要求，修复前先提交已有修改：`016fb38`，`chore: checkpoint existing fixes and audit evidence`，共 73 个文件；提交后工作区干净。本次修复以该提交为基线。

## 验证结论

报告中的四个缺陷均在当前源码构建上复现，随后修复。C1 的两个场景属于同一缺陷。

| 编号 | 修复前证据 | 修复方式与回归 |
| --- | --- | --- |
| C1 | 跨文库相同 key 的并发请求只解析第一份 PDF；串行解析共享目录并可复用错误内容 | 任务使用 `libraryID:key`；结构化缓存、元数据、Doc2X 元数据和临时文件按文库及附件隔离。读取仍校验元数据归属。覆盖并发、重启、相同文件属性、临时导入、冷却与统计 |
| D1 | 无效第二字段使调用报错，但标题留在共享对象中；随后标签保存提交该标题 | 使用 Zotero `clone` 暂存并验证全部字段和作者。正式设置或保存失败时恢复原始字段值与完整作者对象，覆盖原始日期和机构作者；随后标签保存不会夹带失败修改 |
| D2a | 注入一次写入失败后，后续两次操作均未再次尝试写入；成功解析产物被错误清除 | 写队列允许前次失败后的任务继续执行，当次错误仍返回调用者。保留未持久化标记以支持重试，状态写入使用同目录临时文件。辅助状态保存失败不会删除已完成的解析缓存 |
| D2b | 同一文库两份附件首次并发读取状态，只保留一份禁止自动重建记录 | 首次加载共享同一 Promise 和状态对象，顺序持久化；并发调用及重启后均保留两份记录 |

旧解析缓存仅在元数据中的文库和附件 key 都明确匹配时复制到新目录。迁移先写结构化文件、最后写元数据，保留原目录中的文件。缺少归属、错误文库或错误 key 的缓存不会套用到当前附件；启动时的旧格式整理也跳过归属不明的记录。

## 执行结果

在 `zotero-lit-synapse-plugin` 中执行：

```powershell
npm run test:synapse-followup
node --experimental-strip-types scripts/test-mineru-structured-service.js
node --experimental-strip-types scripts/test-mineru-md-index-integration.js
node scripts/test-mineru-reader-structured.js
node scripts/test-synapse-audit-regressions.js
node scripts/test-write-metadata-validation.js
node scripts/test-write-item-atomicity.js
```

- 两轮审计：92 项不重复检查全部通过。一键命令重复执行两目录中相同的 31 项扩展检查，合计 123 PASS、0 FAIL。
- 已有 MinerU 结构化服务回归：通过，使用本地临时文件验证缓存升级、读取、损坏重试、附件替换与删除。
- 阅读器结构化缓存，以及 Markdown 的语义、关键词、混合检索集成回归：通过。
- 上一轮回归：22/22 通过。
- 元数据参数校验：6/6 通过；条目写入原子性：5/5 通过。
- 构建和 TypeScript 类型检查：通过。
- 相关源码与项目内测试脚本的 ESLint 检查：通过。
- `git diff --check`：通过。
- 安装包 ZIP CRC：通过，64 个成员；全部 7 个 JavaScript 文件通过 `node --check`。

新增的一键命令会生成 `.scaffold/build/zotero-lit-synapse.xpi`。本次没有调整版本号、安装到用户 Zotero 或发布远程版本。

本次最终安装包 SHA-256：

```text
e9a9c24edfaf80d8925faf36b1eb2b75145d0b905e46045a92ba483272ef4ea9
```

## 证据位置与限制

两组目录的 `results/current-before-fix/` 保存原缺陷复现，`results/regression-before-fix/` 保存修复前正确行为测试失败记录，`results/current-after-fix/` 保存修复后结果。原审计报告和原结果未覆盖。

这些测试验证当前插件代码的行为，使用模拟的 Zotero 数据层及外部解析服务。未在真实 Zotero 数据库中注入保存失败，也未调用真实 MinerU、翻译、嵌入服务或验收完整 Wiki/GPU 流程；本记录不构成对这些未测环境的稳定性承诺。

本次修复不会追溯修改真实文库里已经生成的附件。若此前确实触发过跨文库错误导入，需对相关 PDF 强制重新解析以替换错误内容。
