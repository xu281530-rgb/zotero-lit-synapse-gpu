# LitSynapse 第三轮补查：复现测试

这是审查证据包，不是插件修复包。不会访问真实 Zotero 文库、调用外部服务、监听端口或运行 GPU 文件。

## 重现当前安装包

需要 Python 3.9+ 和 Node.js 22。解压后，在此目录运行：

```sh
python prepare.py "/实际路径/zotero-lit-synapse(1).xpi"
node tests/regression.js
node tests/extended.js
node tests/additional.js
```

`prepare.py` 校验本次安装包的 SHA-256，拒绝覆盖已经存在的 `new/` 目录。

预期结果：
- 基础回归：34 PASS。
- 上轮扩展：29 PASS、2 BUG_REPRODUCED。
- 本轮新增：12 PASS、3 BUG_REPRODUCED。

**BUG_REPRODUCED 是成功复现缺陷，不是功能通过。** 脚本退出 0 仅表示得到了设计时预期的结果，并不是“无 bug”。

这些脚本针对当前安装包。未来修复后的包应更新哈希并将缺陷复现断言改为“期望正确行为”的回归断言，不能要求修复版继续满足旧缺陷断言。

## 更早旧包对照

```sh
python prepare.py "/实际路径/zotero-lit-synapse.xpi" --old
```

Linux/macOS：

```sh
XPI_SOURCE="$PWD/old" AUDIT_RESULTS="$PWD/results/old-control" node tests/additional.js
```

Windows PowerShell：

```powershell
$env:XPI_SOURCE = Join-Path $PWD "old"
$env:AUDIT_RESULTS = Join-Path $PWD "results/old-control"
node tests/additional.js
Remove-Item Env:XPI_SOURCE, Env:AUDIT_RESULTS
```

预期与本轮新增检查相同：12 PASS、3 BUG_REPRODUCED。这说明 D1、D2a、D2b 不是上一轮修复引入的回归。

## 测试方法

`fixtures.js` 从上传包按模块标记加载原始函数/类。未使用的初始化器为空实现；Zotero 对象、保存、文件系统和网络解析返回值被模拟。

`additional.js` 的 D1 经过完整 MCP 分发，再进入原始元数据与标签写方法。模拟对象遵循“条目在内存缓存中复用，setField 在保存前修改对象”的契约，该契约通过官方源码核对。

D2a 同时测试队列恢复和原始解析入口；D2b 通过同文库、不同附件的并发 `getMarkdownForAttachment` 请求复现，不是跨文库同 key 的旧问题。

测试没有覆盖真实宿主界面、真实数据库事务、实际文件系统原子性、实际外部服务、完整 Wiki 工作流、GPU 或长期压力。

完整判断、条件与源码位置见 `synapse-third-audit-report.md`。
