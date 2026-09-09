# LitSynapse 第三轮审计回归

## 当前源码验证

在 `zotero-lit-synapse-plugin` 目录运行：

```powershell
npm run test:synapse-followup
```

命令构建当前源码并运行两组审计回归。结果写入各目录的 `results/current-after-fix/`，原证据保留。

| 本目录测试 | 预期结果 |
| --- | --- |
| `tests/regression.js` | 34 PASS |
| `tests/extended.js` | 31 PASS，包含 C1a/C1b 正确行为断言 |
| `tests/additional.js` | 18 PASS，包含 D1、D2a、D2b 及三个补充场景 |
| `tests/cache-isolation.js` | 9 PASS，覆盖临时文件、迁移、归属校验、失败冷却与缓存统计 |

以上合计 92 项不重复检查。一键命令另外运行第二轮目录的 31 项扩展检查，因此控制台合计为 **123 PASS、0 FAIL**。

验证已解压安装包时，在插件目录设置 `XPI_SOURCE` 后运行 `node scripts/test-synapse-followup-audits.js`。该路径必须直接包含 `content/scripts/zotero-lit-synapse.js`。

## 历史证据

原报告和原 `results/*.json` 保留为历史证据。

- `results/current-before-fix/`：当前基线构建确认 D1、D2a、D2b 的复现结果。
- `results/regression-before-fix/`：正确行为断言在修复前失败的记录。
- `results/current-after-fix/`：修复后回归结果。
- 基线提交 `016fb38` 保存原始缺陷复现断言。

`prepare.py` 只接受历史审计包的哈希；历史包在当前正确行为断言下应失败。

## 验证边界

测试从构建产物提取原始函数与类。元数据测试经过完整 MCP 分发，使用共享条目对象，覆盖字段、作者设置和保存异常。MinerU 测试通过真实服务入口执行缓存、任务去重与状态管理逻辑。

Zotero 数据层、网络解析、计时器及文件系统使用模拟接口。已有结构化服务回归另使用本地临时文件。本次没有真实 Zotero GUI、用户数据库、外部服务、GPU 或完整 Wiki 流程验收。

详细结果见 [修复验证记录](fix-verification.md)。
