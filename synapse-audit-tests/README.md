# 原始 XPI 的缺陷复现测试

这不是修复后的插件，也不会安装插件、访问你的 Zotero 数据库或执行原生 GPU 文件。

## 运行

准备 Python 3.9 以上版本与 Node.js（本次使用 v22.16.0）。
把本测试包解压到一个新目录；原始 XPI 不包含在测试包内，使用你本次上传的那个文件。

在测试包根目录执行：

```sh
python prepare.py "/path/to/zotero-lit-synapse.xpi"
node tests/audit.js
```

Windows 上把第一条命令的文件路径替换为实际位置即可。
prepare.py 只接受 SHA-256 与本次审查一致的安装包，拒绝意外覆盖已有 source 目录。

## 输出的含义

`test-results.json` 同时写入控制台输出。
- PASS：被测正常行为符合预期。本次 31 项。
- BUG_REPRODUCED：断言确认原始缺陷能够复现。本次 3 项。这不是功能通过。
- FAIL：测试本身没有得到预期输出，需要调查测试依赖或代码变化。

退出码 0 表示本报告描述的行为均复现，不表示插件无 bug。修复后这三个缺陷复现测试的旧断言应当不再成立；工程中应把它们改成对正确行为的回归断言，而不是继续期待异常结果。

## 修复后回归

本地工程新增了直接执行当前源码的回归测试。在插件工程目录运行：

```sh
npm run test:synapse-audit
npm run build
```

构建完成后，在本测试包目录验证构建产物：

```sh
node tests/audit.js --fixed --source ../zotero-lit-synapse-plugin/.scaffold/build/addon
```

`--fixed` 将三项缺陷断言改为正确行为断言，正常结果为 34 项 PASS。输出单独保存在 `test-results-fixed.json`，原始安装包的结果仍保存在 `test-results.json`。不传 `--fixed` 时保持原始缺陷复现模式。`--output` 可指定结果文件。

修复与验证详情见 `fix-verification.md`。

## 测试边界

主脚本按包内模块标记抽取，被测函数与类没有重写。未调用的外部初始化器使用空实现；Zotero API、socket、文件系统、计时器和确认对话框在测试中被模拟。阅读器只增加测试导出。没有访问真实 API、监听真实端口、执行真实 Zotero 数据库保存、渲染真实 GUI、运行 GPU 或进行压力测试。

B1 的模拟依照 Mozilla close 异步回调约定；B2 的输入依照 Zotero libraryID + key 唯一约束；B3 使用实际通知处理函数，模拟普通群组文献新增通知，并检查实际周期构建函数选择的 libraryID。

审查报告见同包 `synapse-audit-report.md`。源代码片段行号基于校验通过的原始包，不能套用到其他版本。
