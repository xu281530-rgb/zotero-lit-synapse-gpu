# MinerU 3.4.4 hybrid 输出证据核查

核查日期：2026-08-25（仅使用本机一手证据）

## 结论

本机已有的 MinerU 3.4.4 真实 hybrid 响应产物表明，`hybrid-engine` **不会在一次请求中返回两套可独立装配的 VLM 全文和 Pipeline 全文**。它返回的是一套 hybrid 合成结果，以及这套结果的不同表示或中间数据：

```text
content_list_v2.json   最完整的规范化结构文档
content_list.json      同一结果的旧格式表示
model.json             hybrid 模型块及检测信息
layout.json            同一 hybrid 处理链的布局中间数据（部分任务提供）
```

因此不能把 `content_list_v2/content_list/model/layout` 当成 VLM 与 Pipeline 两位独立解析器，对段落进行“两票对照”或多数决。`model.json` 和 `layout.json` 可以在存在时提供 bbox、块类型、原始顺序和 `merge_prev` 等辅助证据，但它们不是第二份独立正文真值。

若确实要取得两份独立结果，必须对同一 PDF 分别执行两次解析：

```text
backend=vlm-engine
backend=pipeline
```

然后由插件另行完成页码、bbox 和文本对齐。当前插件没有执行这两次请求，也没有相应的双结果缓存 schema。

## 插件请求和响应链证据

插件在 [`minerUClient.ts`](../src/modules/mineru/minerUClient.ts) 中：

- 第 236 行把用户的 hybrid 设置作为单一 `backend` 参数提交。
- 第 242-244 行请求 `return_content_list=true`、`return_model_output=true` 和 ZIP 响应。这两个 `return_*` 参数控制产物类型，不代表分别请求 VLM 与 Pipeline。
- 第 463-466 行把 `hybrid` 映射为一个后端值 `hybrid-engine`；只有显式选择 `pipeline` 时才提交 `pipeline`，其他 VLM 选择提交 `vlm-engine`。
- 第 409 行表明 ZIP 解包只保留 JSON；第 470 行开始的 JSON 响应映射也只识别 `content_list_v2`、`content_list`、`model/model_output`、`layout` 和 `middle_json`。代码没有 `vlm_result` 与 `pipeline_result` 两套响应槽位。

Assembler 在 [`structuredDocumentAssembler.ts`](../src/modules/mineru/structuredDocumentAssembler.ts) 第 149 行开始按以下顺序只选择一个权威结构源：

```text
content_list_v2 -> content_list -> model
```

第 1406 行开始只从 `layout.json._version_name` 读取 parser version，并明确把 layout 当作 supplementary 数据；layout 不会被装配为第二份正文。

缓存写入位于 [`minerUService.ts`](../src/modules/mineru/minerUService.ts) 第 1808 行开始。第 1850 行遍历 `result.files` 并保存返回的全部合规 JSON。因此真实缓存中没有 VLM/Pipeline 两套目录或同名的双份结果，不是当前 `selectStructuredSource()` 选择时才把另一套完整结果删掉。

## 真实 hybrid 响应产物

### 18101 实时固定 PDF 验证

2026-08-25 对 `http://127.0.0.1:18101` 的 `/health` 实测返回：

```json
{
  "status": "healthy",
  "version": "3.4.4",
  "protocol_version": 2
}
```

使用仓库内固定的 320632 字节、8 页 PDF，向 `/file_parse` 提交：

```text
backend=hybrid-engine
return_md=false
return_content_list=true
return_model_output=true
response_format_zip=true
```

返回 ZIP 只有一个 `hybrid_auto` 目录，其中包含：

```text
*_model.json
*_content_list.json
*_content_list_v2.json
```

没有 `vlm_result`、`pipeline_result` 或两个后端各自的目录。三份文件也没有
VLM/Pipeline 来源标记。量化关系为：

```text
legacy content_list blocks: 47
content_list_v2 blocks:      47
legacy 与 v2 页码+bbox 一一对应: 47/47
model blocks:                162
每个 v2 block 均覆盖至少一个 model 检测块: 47/47
model 中带非空正文 content 的块: 1/162
```

这说明 `content_list` 是 v2 的 legacy 表示，`model` 主要提供更细的检测/布局块；
它们不是两份可独立投票的全文。

随后对同一 PDF 分别提交 `vlm-engine` 和 `pipeline`，才得到真正独立且不同的
两组 ZIP。三种后端的结构统计为：

```text
backend    content_list blocks    v2 blocks    model blocks
hybrid     47                     47           162
vlm        51                     51            58
pipeline   43                     43             8 (pipeline model 根为页对象)
```

三组 JSON 的 SHA-256 均不同。因此，真正的双源对照在技术上可行，但必须显式
执行 `vlm-engine` 与 `pipeline` 两次请求；一次 `hybrid-engine` 请求不提供这两套
独立全文。

样本目录：

```text
D:\BaiduSyncdisk\ZoteroFile\zotero-lit-synapse\mineru\2F8N4T96\raw
```

该任务缓存了：

```text
7c71422b-be40-43a0-a76a-59a957faa238_content_list_v2.json
7c71422b-be40-43a0-a76a-59a957faa238_content_list.json
7c71422b-be40-43a0-a76a-59a957faa238_model.json
layout.json
```

`layout.json` 的顶层元数据明确为：

```json
{
  "_backend": "hybrid",
  "_version_name": "3.4.4"
}
```

没有 `vlm/...`、`pipeline/...` 或两套独立 `content_list/model`。同一份 `model.json` 的只读统计为：

```text
页数：25
非 ocr_text 语义块：867
ocr_text 块：1672
具有 text/content 正文的 ocr_text：0
```

这些 `ocr_text` 只有检测框等信息，不能组成另一份 Pipeline 正文或阅读顺序。`layout.json` 中的 `preproc_blocks`、`discarded_blocks` 和 `para_blocks` 也属于这一次 hybrid 解析的中间阶段，而不是第二份独立文档。

另一个真实响应目录：

```text
D:\BaiduSyncdisk\ZoteroFile\zotero-lit-synapse\mineru\HGGN8MN6\raw
```

同样只有一组 `*_content_list_v2.json`、`*_content_list.json`、`*_model.json` 和 `layout.json`，与上述形态一致。

## 对 BDGYMLKM 的直接结论

现有目录：

```text
D:\BaiduSyncdisk\ZoteroFile\zotero-lit-synapse\mineru\BDGYMLKM\raw
```

只有：

```text
content_list.json
```

其 `meta.json` 记录：

```json
{
  "signature": "v2|local|hybrid|ch|noocr|formula|table",
  "parserVersion": null,
  "structuredFormat": "content_list",
  "structuredFileName": "raw/content_list.json"
}
```

所以 `BDGYMLKM` 当前缓存既没有 v2，也没有 `model.json` 或 `layout.json`。对这篇文献，现有缓存无法通过任何双源或中间布局证据修复单个 block 内已经颠倒的两栏文本。

重新调用 hybrid 有机会得到更完整的 v2/model/layout 产物，可供 bbox 和原始模型块辅助判定；但即使得到这些文件，它们仍是同一 hybrid 链路的相关产物，不能被描述为 VLM 与 Pipeline 两份独立结果。

## 可行边界

在不增加第二次解析的前提下，可以安全研究的方向是：

- v2 的 block/span bbox 与 legacy `content_list` 的降维文本对齐；
- `model.json` 的块类型、bbox、`merge_prev` 与最终结构顺序对照；
- `layout.json` 的 `preproc_blocks/para_blocks/discarded_blocks` 用作几何和页眉页脚证据；
- 证据冲突或细节缺失时保留原结构或明确失败，不把相关中间产物伪装成独立共识。

如果要求真正利用 VLM 与 Pipeline 互相校验，代价和风险是：

- 每篇 PDF 需要两次独立解析，耗时、显存和缓存体积显著增加；
- 两套 block 类型、坐标尺度和阅读顺序需要新的对齐算法；
- 两者发生冲突时仍需要明确的仲裁规则，不能仅因两套结果存在就自动保证修复正确；
- 这会改变 MinerU 请求、缓存 schema 和失效签名，超出当前 Assembler 局部规则修复。

## 核查限制

服务未暴露 `/openapi.json`、`/docs` 或 `/redoc`，因此无法从在线 OpenAPI schema
读取字段定义；`/health`、`/file_parse` 以及插件实际请求和 ZIP 返回均已实时验证。
官方 GitHub 页面在当前网络环境中加载超时，报告未使用外部二手资料。
