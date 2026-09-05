# LitSynapse 修复版回归测试与证据

## 范围

这不是插件修复包。不会安装 Zotero，不读取用户真实文库，不调用外部 API，不监听真实端口，也不执行 GPU 文件。
只使用 Node.js 内置模块与 Python 标准库，无需 npm 安装。

## 运行本次修复包

需要 Python 3.9+、Node.js 22（审查使用22.16.0）。

在解压后的测试包根目录运行：

```sh
python prepare.py "/path/to/zotero-lit-synapse(1).xpi"
node tests/regression.js
node tests/extended.js
```

路径替换为本次实际文件位置。Windows可直接使用实际盘符路径。
prepare.py 校验 SHA-256，默认把修复包解压到 `new/`。不覆盖已存在的目标目录。

预期：
- regression.js：34 PASS。
- extended.js：29 PASS、2 BUG_REPRODUCED。
- BUG_REPRODUCED是C1两个异常场景的成功复现，不是插件功能通过。
- 退出0表示测试得到了预期结果（其中包括预期能复现的bug），不是无bug认证。
- 意外的断言失败标记为FAIL，退出1。

## 旧包对照（可选）

旧包不是复验新版本的必需品。

```sh
python prepare.py "/path/to/zotero-lit-synapse.xpi" --old
```

Linux/macOS：

```sh
XPI_SOURCE="$PWD/old" AUDIT_RESULTS="$PWD/results/old-control" node tests/regression.js
XPI_SOURCE="$PWD/old" AUDIT_RESULTS="$PWD/results/old-control" AUDIT_FILTER="C1" node tests/extended.js
```

Windows PowerShell：

```powershell
$env:XPI_SOURCE = Join-Path $PWD "old"
$env:AUDIT_RESULTS = Join-Path $PWD "results/old-control"
node tests/regression.js
$env:AUDIT_FILTER = "C1"
node tests/extended.js
Remove-Item Env:XPI_SOURCE, Env:AUDIT_RESULTS, Env:AUDIT_FILTER
```

旧包基础回归预期31 PASS、3 FAIL，失败恰好是B1/B2/B3旧缺陷。
旧包C1两场景也会复现，说明C1并非本轮修复引入。
当前随包结果已保留此对照。

## 被测代码与模拟边界

主脚本按包内模块标记抽取原始函数/类；未使用的外部初始化器为空实现。
阅读器添加测试导出，不改目标函数。
Zotero、socket、计时器、文件系统、确认窗口均被模拟。
MinerU客户端返回合成结构化结果；结果组装、缓存读写、任务去重和附件同步方法来自原始安装包。
附件导入、删除仅作用于内存模拟接口。
本测试不覆盖真实GUI、数据库事务、网络服务、MCP客户端集成、Wiki完整工作流、GPU、大文库和长期稳定性。

完整判断见 `synapse-reaudit-report.md`。
