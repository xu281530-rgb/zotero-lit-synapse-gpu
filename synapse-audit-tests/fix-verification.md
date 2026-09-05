# BUG 复核与修复记录

日期：2026-09-05。环境：Windows，Node.js v22.21.1。

## 结论

原报告 B1、B2、B3 均属实，并已在当前源码中修复。先运行原始安装包的复现测试，再增加检查正确行为的源码回归测试，最后对重新构建的插件运行修复后断言。

原始安装包 SHA-256 与报告一致：

```text
55beb39978f90f434885f9eb26eab5282fad2041bf433877fcc49fa8c10a970e
```

原始代码重复测试结果为 **31 PASS + 3 BUG_REPRODUCED**。这证明原报告的三项缺陷可重复出现，原测试退出码 0 不能解释为插件没有 BUG。复现明细保留在 [test-results.json](test-results.json)。

修复后构建产物的同组检查为 **34/34 PASS**，明细见 [test-results-fixed.json](test-results-fixed.json)。

## 修复范围

| 问题 | 核实的原因 | 修复后的行为 |
| --- | --- | --- |
| B1 服务重启状态失真 | 旧 socket 的异步关闭回调直接修改共享状态；停止函数依赖可能过期的布尔值 | 关闭时先解除 socket 所有权，迟到回调和连接按 socket 身份过滤；停止和启动失败均清理实际持有的资源 |
| B2 跨文库翻译缓存混用 | 内存缓存、磁盘目录、写入队列和通知仅以 attachment.key 标识附件 | 统一使用 libraryID + key；术语编辑窗口的文献选择也传递完整身份；MinerU 重新解析或解析失败只清除所属文库的新翻译缓存 |
| B3 索引期间群组事件丢失 | 通知在 isAutoIndexing 为 true 时提前返回；后续周期扫描只覆盖个人库 | 索引期间继续合并待处理事件；本轮完成后自动排空队列；保留按文库分组、force 合并、重试和防止生成 Markdown 自触发的逻辑 |

主要源码：

- [httpServer.ts](../zotero-lit-synapse-plugin/src/modules/httpServer.ts)：监听器生命周期。
- [hooks.ts](../zotero-lit-synapse-plugin/src/hooks.ts)：通知入队和构建完成后的继续处理。
- [zotero-mark-reader.js](../zotero-lit-synapse-plugin/addon/mark-reader/content/scripts/zotero-mark-reader.js)：缓存身份、持久化、迁移和通知。
- [translation-task.js](../zotero-lit-synapse-plugin/addon/mark-reader/content/translation-task.js)：术语编辑窗口的文献身份。
- [minerUService.ts](../zotero-lit-synapse-plugin/src/modules/mineru/minerUService.ts)：按文库清除失效翻译缓存。

## 缓存兼容

新翻译缓存位置为 `zotero-lit-synapse/mineru/reader/<libraryID>/<attachmentKey>/translation-cache.json`，缓存内容同时保存 `libraryID` 和 `attachmentKey`。

旧缓存只有在源内容哈希相同且归属可验证时才复制到新位置。已声明文库身份的文件必须匹配；未声明身份的文件还需匹配 `meta.json`，并确认 Zotero 中该 key 只有一个所属文库。文库冲突、同 key 歧义、源内容变化或缺少归属证据时不自动迁移。迁移保留旧文件，不将旧缓存默认归入个人库。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 原始 XPI 缺陷复现 | 31 PASS + 3 BUG_REPRODUCED |
| 新增源码专项回归 | 22/22 PASS |
| 修复后构建产物审查 | 34/34 PASS |
| 项目完整自动回归 | 113/113 个测试脚本 PASS，包含上述 22 项专项回归 |
| MinerU 结构化服务及阅读器测试 | 两项脚本均通过 |
| `npm run build` | 构建及 `tsc --noEmit` 通过 |
| 修改文件 ESLint / `git diff --check` | 通过 |
| XPI 内容一致性与 JavaScript 语法 | 7 个 JS 文件与被测构建文件哈希相同，均通过 `node --check` |
| `npm run test:gpu-xpi` | 资源与打包检查通过，未执行 GPU 二进制 |

源码专项测试在 [test-synapse-audit-regressions.js](../zotero-lit-synapse-plugin/scripts/test-synapse-audit-regressions.js)。它转译并执行实际 TypeScript 模块和实际阅读器脚本，模拟宿主依赖；索引测试驱动真实通知处理函数和真实队列，未另写一份队列算法。修复前的首批 20 项专项检查有 18 项失败，修复后通过；另补了 2 项 MinerU 缓存清除集成检查。

既有 `test-persistent-delete-recovery.js` 有一项字符串断言依赖旧的忙碌状态判断。已改为检查永久删除处理优先于禁用/暂停刷新分支，其余删除恢复测试保留并通过。

项目回归明细由 [audit-unit-results.json](../zotero-lit-synapse-plugin/.scaffold/audit-unit-results.json) 记录。复测命令见 [README.md](README.md)；全部项目自动回归可在插件目录运行 `node scripts/run-audit-regressions.mjs`。

## 修复包

[zotero-lit-synapse-3.1.0-audit-fixed.xpi](../../zotero-lit-synapse-3.1.0-audit-fixed.xpi)

```text
SHA-256: 628467d1f34d3d769885725563bc6709370f25e21546ccd207f01f6fc3ba579d
```

这是本地修复构建，清单版本仍为 3.1.0。原始安装包保留，未发布或安装到 Zotero。基于提交 `78307732d9638dc1a4db9629aa8c0ee9fd1fc7b2` 的工作区修改构建。

## 验证边界

已完成源码和构建产物的可重复模拟测试、静态检查及打包检查。未访问用户真实文库，未进行 Zotero GUI 安装、真实操作系统端口启停、真实群组同步、外部翻译/嵌入/MinerU API 或 GPU 执行测试。因此这些结果不等同于完整宿主端到端验收。

真实宿主验收仍应覆盖原报告的三个场景：连续更换端口后禁用服务，跨文库同 key 附件交替保存和重新打开，以及长索引期间添加/修改群组文献后自动完成索引。
