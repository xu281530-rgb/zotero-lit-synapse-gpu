# LitSynapse 第二轮审计回归

## 当前源码验证

在 `zotero-lit-synapse-plugin` 目录运行：

```powershell
npm run test:synapse-followup
```

命令构建当前源码并执行两组审计回归。本目录 `tests/extended.js` 的 C1a/C1b 已改为正确行为断言，预期为 **31 PASS、0 FAIL**。结果写入 `results/current-after-fix/`，原证据保留。

如需单独验证已解压的安装包，可在本目录运行：

```powershell
$env:XPI_SOURCE = '已解压安装包的绝对路径'
$env:AUDIT_RESULTS = Join-Path $PWD 'results/current-after-fix'
node tests/regression.js
node tests/extended.js
Remove-Item Env:XPI_SOURCE, Env:AUDIT_RESULTS
```

`XPI_SOURCE` 必须直接包含 `content/scripts/zotero-lit-synapse.js`。基础回归预期 34 PASS，扩展回归预期 31 PASS。

## 历史证据

原报告、原 `results/*.json`、`results/old-control/` 和差异文件记录历史审计结果，不代表修复后的状态。

- `results/current-before-fix/`：本次在基线提交 `016fb38` 的构建上重现 C1a/C1b。
- `results/regression-before-fix/`：正确行为断言在修复前失败的记录。
- `results/current-after-fix/`：修复后回归结果。
- 原始“应复现错误”脚本保存在基线提交 `016fb38`。

`prepare.py` 仍只接受历史审计包的哈希。修复包使用上面的 `XPI_SOURCE` 路径；历史缺陷包在当前正确行为断言下应失败。

## 验证边界

测试执行构建产物的原始逻辑，模拟 Zotero、文件系统、计时器、socket 和解析服务，不访问真实文库或外部 API。

详细修复说明见 [修复验证记录](../synapse-third-audit-tests/fix-verification.md)。真实 Zotero、外部服务和 MCP 客户端集成不在本次自动测试结论内。
