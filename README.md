# Zotero LitSynapse - Model Context Protocol Integration for Zotero

Zotero LitSynapse turns your local Zotero 9 library into a tool an AI assistant can actually use: it is a single Zotero plugin with a built-in Model Context Protocol (MCP) server, so a client like Claude Desktop, Claude Code, Cursor, or Gemini CLI can search, read, cross-reference, and (optionally) edit your references over a local HTTP connection — no separate server process, no cloud upload of your library.

_This README is also available in: [:cn: 简体中文](./README-zh.md) | :gb: English._

[![zotero target version](https://img.shields.io/badge/Zotero-9.0.x-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org)
[![Version](https://img.shields.io/badge/Version-3.3.0-brightgreen)]()
[![EN doc](https://img.shields.io/badge/Document-English-blue.svg)](README.md)
[![中文文档](https://img.shields.io/badge/文档-中文-blue.svg)](README-zh.md)

---

## Table of Contents

- [Overview](#-overview)
- [Feature Tour](#-feature-tour)
- [Quick Start](#-quick-start)
- [Supported AI Clients](#-supported-ai-clients)
- [Configuration Reference](#-configuration-reference)
- [Architecture](#-architecture)
- [Developer Guide](#-developer-guide)
- [Troubleshooting](#-troubleshooting)
- [MCP Tool Reference](#-mcp-tool-reference)
- [Contributing](#-contributing)
- [License](#-license)
- [Acknowledgements](#-acknowledgements)

---

## 📚 Overview

Zotero LitSynapse is a tool server, built on the Model Context Protocol, that lives inside Zotero itself rather than beside it. Through it, an AI assistant can do the things a research assistant would do with your library by hand:

- 🔍 **Smart Search**: a three-stage retrieval funnel — hybrid keyword + semantic search across the whole library, then an abstract, then full-text passages of one paper — with boolean operators, relevance scoring, and cursor pagination throughout.
- 📖 **Content Extraction**: abstracts, attachment text, and indexed document chunks, each returned by a purpose-built paginated tool rather than one tool with hidden modes.
- 📝 **Annotation Analysis**: search and read PDF highlights, comments, and notes by color, tag, or keyword.
- 📂 **Collection Browsing**: browse and search the collection hierarchy one level at a time, like a file manager, without ever dumping the whole tree.
- 🧠 **Semantic Search**: embedding-based concept matching that finds related work across languages and vocabularies, with optional GPU acceleration.
- 📄 **High-Fidelity PDF Parsing (MinerU)**: an optional layout-aware parser that reconstructs headings, formulas, and tables into Markdown before the text ever reaches the search index, instead of relying on Zotero's flat text extraction.
- 🌐 **PDF Translation**: an optional AI-assisted translation pipeline that reuses MinerU's parsed structure and can build a persistent glossary of domain terms.
- 🧩 **LLM Wiki Memory**: a question-driven, reusable knowledge base of Claims, Concepts, and Relations, every one of them linked back to the exact Zotero passage it came from.
- ✏️ **Write Operations**: create notes, manage tags, update metadata, create items, reorganize collections, and attach files — all off by default.
- 🔒 **Local-First Security**: the server binds to loopback by default, remote access requires an explicit opt-in and a bearer token, and every write-capable feature is disabled until you turn it on.

This turns literature review, citation lookup, annotation triage, and long-term note-taking into a conversation with your own library, entirely on your own machine.

---

## 🧩 Feature Tour

### Search & Retrieval

- **Advanced search engine** — full-text search with boolean operators, relevance scoring, and filters for title, creator, year, tags, and item type.
- **Hybrid retrieval funnel** — `hybrid_search` runs keyword and semantic retrieval in parallel, unions whatever clears either branch's own threshold, and ranks the survivors with weighted Reciprocal Rank Fusion; `search_fulltext` repeats the same funnel one level down, inside a single paper.
- **Purpose-specific content tools** — abstracts, attachment text, and document chunks each come from their own paginated tool, so nothing is bundled behind a hidden "detail level" flag.
- **Smart annotation system** — search and retrieve PDF highlights, comments, ink and image annotations, and notes, filterable by color, tag, or keyword, with every hit attributed back to the document, the attachment, and the mark itself.
- **Collection management** — browse the hierarchy level by level, search collections by name, and get per-folder item counts without downloading the folder's contents.

### Semantic Search & GPU Acceleration

- Embedding-based semantic search over indexed passages, using any OpenAI-compatible embedding endpoint (OpenAI, Ollama, or a self-hosted equivalent) — auto-detected, with connection testing and live rate-limit / cost tracking.
- A single vector index (SQLite-backed) shared by `semantic_search`, `hybrid_search`, and `find_similar`, with an index-status column in the main library view and per-item/per-collection index management from the context menu.
- **Native GPU vector acceleration** — an optional, NVIDIA-only native module (`native/vector-gpu/`, CUDA + C++) that runs the vector scan on the GPU instead of the CPU, with Auto / Float32 / Int8 precision modes and live status reporting (device, resident vector count, and why it fell back to CPU when it does). Entirely optional; everything works on CPU without it.
- A built-in benchmark tool measures your actual library and recommends threshold and timeout values instead of asking you to guess them.

### High-Fidelity PDF Parsing (MinerU)

Zotero's own full-text extraction is a flat text dump — no headings, no table structure, no formulas. MinerU is an optional parsing backend that reconstructs a PDF's real layout into structured Markdown before that text is chunked and indexed, so search results and full-text reads carry actual document structure instead of a wall of text.

- Two deployment modes: **cloud** (the official `mineru.net` API — requires your own API token and consumes your quota) or **local** (a self-hosted `mineru-api` service, Python 3.10–3.13, default `http://127.0.0.1:8000`).
- Configurable model version (VLM / hybrid / pipeline), language, and independent toggles for OCR, formula recognition, and table recognition.
- The parsed Markdown can optionally be attached to the Zotero item as its own note, with configurable concurrency, timeout, size limits, an on-demand-blocking toggle, and cache management.

**Text source priority.** Whenever the plugin needs a PDF's body text — to build a chunk for the search index, or to answer `get_attachment_text` / `search_fulltext` on demand — it resolves the text through the same ordered list every time, so indexing and on-demand reading never disagree about which version of a document is the real one: (1) a **Doc2X original-Markdown note**, if one exists on the item; (2) a **cached MinerU parse** of this exact file; (3) a **MinerU Markdown attachment** already attached by an earlier parse; (4) an **on-demand MinerU parse**, only if MinerU is enabled and on-demand parsing is allowed; (5) Zotero's own flat full-text cache, then the built-in PDF processor, as the final fallback. `get_attachment_text` reports which of these actually produced the text in `textSource.method` (`doc2x`, `mineru_cache`, `mineru_attachment`, `mineru`, or one of the PDF-processor fallbacks) — see [`get_attachment_text`](#get_attachment_text) for the full list.

**How a Doc2X original note is identified.** [Doc2X](https://doc2x.noedgeai.com/) is a separate, third-party Zotero add-on for PDF-to-Markdown parsing and translation; this plugin does not create Doc2X notes, it only recognizes ones that already exist. It inspects every note already attached to the same parent item and accepts one as the PDF's original Markdown only if its title or leading text is explicitly marked **"原文MD" or "original_MD"** (case-insensitive) — the label Doc2X itself uses for the untranslated source, as opposed to a translated or bilingual version. The Markdown is then recovered from whichever form that note actually holds (data embedded in the note, a companion source file Doc2X wrote alongside it, or by re-rendering the note's own visible content back into Markdown), and a candidate is rejected outright if fewer than 100 characters come back, so an empty or title-only note is never mistaken for real text. When more than one note on the same item looks like a candidate, filename affinity with the PDF and Doc2X's own task metadata both raise a candidate's score, and the highest-scoring one wins — neither signal is a hard requirement by itself, since Doc2X often shortens or localizes note titles and users rename attachments. The reverse case is handled too: a PDF that Doc2X itself generated as translated or bilingual output (titled things like "译文PDF", "双语PDF", or "translate_PDF") is recognized and skipped as a *source* to parse, so MinerU is never run on Doc2X's own translation believing it to be the original.

### PDF Translation

An optional translation pipeline layered on top of MinerU's parsed output, so translated documents keep their original structure instead of losing tables and headings to a naive text translator.

- Its own provider configuration — API URL, key, model, and target language — independent of the embedding provider.
- Optional AI-context awareness during translation, per-document glossary generation, and a reusable global glossary so domain terminology stays consistent across papers.
- Optional domain-expert selection to steer terminology choices for a specific field.

### LLM Wiki and Long-Term Memory

- Authoritative Pages, Claims, Concepts, Aliases, Relations, and Evidence are stored independently in their own `zotero-lit-synapse-wiki.sqlite` database — not mixed into the search index.
- Every Evidence excerpt is verified against a real Zotero document chunk, and automatically relinked after a search-index reset or rebuild rather than silently going stale.
- A controlled prepare → commit workflow (`wiki_prepare_update` / `wiki_commit`) plus search, read, export, reverify, and single-paper deep-read tools — the server makes no hidden LLM calls of its own.
- Concept and Claim embeddings plus one-hop relation traversal form a third retrieval route alongside keyword and semantic search; Shadow Mode keeps it from affecting existing rankings until you have calibrated it against your own library.
- A Zotero Wiki panel shows knowledge status, Evidence, terminology and alias management, Page merging, Claim deletion, Markdown export, and a 3D knowledge graph of how your papers connect.

### Write Operations

- Create or modify notes (with Markdown-to-HTML auto-conversion), manage tags, update metadata fields, create new items, and reparent or import standalone PDFs.
- Collection mutation tools (create, rename, delete, add/remove/move items, merge duplicates) with all-or-nothing preflight validation and a `dryRun` mode that shows exactly what would change before anything is written.
- Off by default at the server level — a client is never told these tools exist unless you turn Write Operations on.

### Security & Privacy

- **Local-only by default** — the server binds to `127.0.0.1` and never leaves your machine unless you explicitly enable remote connections.
- **Bearer-token authentication** — an MCP access token you generate (and can regenerate) from the preferences pane, required whenever remote access is enabled.
- **Opt-in everything risky** — Write Operations, file import, and exposing local file paths are all off until you turn them on, and the confirmation prompt for destructive batch operations cannot be skipped from the client side.
- **Client configuration generator** — one click produces a ready-to-paste MCP configuration for your specific AI client, so you never hand-edit connection URLs or tokens.

---

## 🚀 Quick Start

### 1. Install the Plugin

1. Get the latest `zotero-lit-synapse-x.x.x.xpi` — either from whoever gave you this project, from the repository's Releases, or by [building it yourself](#-developer-guide).
2. In Zotero, install it via `Tools → Add-ons → ⚙ → Install Add-on From File…`.
3. Restart Zotero.

### 2. Configure the Server

Open `Zotero → Settings → Zotero LitSynapse` and go to the **Server** tab:

1. Check **Enable Server** to start the built-in MCP server.
2. Leave **Port** at its default (`23120`) unless it conflicts with something else on your machine.
3. Leave remote access off unless you specifically need it — see [Configuration Reference](#-configuration-reference) for what enabling it requires.
4. Click **Generate Client Configuration**, pick your AI client from the list, and copy the result.

### 3. Connect Your AI Client

Paste the generated configuration into your client's MCP settings (see [Supported AI Clients](#-supported-ai-clients) for where each client keeps that file), then restart the client. A minimal example for a client that reads raw MCP server JSON:

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

### 4. Verify It Works

Ask your AI assistant something like *"Search my Zotero library for anything about transformers"*. If it calls a Zotero tool and returns real results from your library, you're connected. If not, see [Troubleshooting](#-troubleshooting).

---

## 🖥️ Supported AI Clients

The built-in **Client Configuration Generator** (Server tab → Generate Client Configuration) produces a ready-to-use configuration for each of these clients by name, so you rarely need to hand-write one:

| Client | Notes |
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
| Custom (raw HTTP) | Any client that speaks MCP 2025-06-18 Streamable HTTP directly |

Any other client that implements the Streamable HTTP transport of the MCP 2025-06-18 specification can connect using the raw configuration shown in [Quick Start](#-quick-start), even without a named preset.

---

## ⚙️ Configuration Reference

All settings live in `Zotero → Settings → Zotero LitSynapse`, split across four tabs.

### Server

- **Enable Server** / **Port** — starts the integrated MCP server; default port is `23120`.
- **Allow Remote Connections** — off by default, the server only accepts connections from `127.0.0.1`. Turning this on exposes the server to your network and requires setting an access token; only enable it on a network you trust.
- **MCP Access Token** — a bearer token you generate (and can regenerate at any time) from this tab; required for any remote client and recommended even locally if other users share the machine.
- **Client Configuration Generator** — produces a ready-to-paste configuration for any of the [supported clients](#-supported-ai-clients).

### Retrieval & Semantic Search

- **Embedding provider** — any OpenAI-compatible endpoint (OpenAI, Ollama, or self-hosted): API base URL, key, model, vector dimensions, request timeout, and max batch size, with a built-in connection test.
- **Rate limiting & usage** — configurable requests-per-minute and tokens-per-minute ceilings, plus live usage and cost statistics so indexing a large library doesn't silently blow through a provider's limits.
- **Hybrid search tuning** — independent relevance thresholds for the keyword and semantic branches, independent RRF weights for each (setting either weight to `0` disables that branch entirely), neighbor-chunk expansion, and separate keyword-search / vector-scan timeouts.
- **Chunking** — target chunk size and tolerance (changing these requires rebuilding the index).
- **Built-in benchmark** — a one-click benchmark that measures your actual library's search performance and recommends threshold and timeout values, instead of leaving you to guess.
- **GPU vector acceleration** — enable/disable toggle and compute precision (Auto / Float32 / Int8) for the native CUDA vector scan described in [Feature Tour](#semantic-search--gpu-acceleration); the same tab reports live device status and, if it fell back to CPU, why.

### LLM Wiki

- **Enable Wiki** — turns the 19 `wiki_*` tools on or off as a group.
- **Write mode** — confirm-before-write or fully automatic consolidation of new Claims/Concepts.
- **Shadow Mode** — keeps Wiki-derived retrieval from affecting `hybrid_search` / `semantic_search` rankings until you've calibrated it against your own library; on by default.
- **Relevance threshold & RRF weight** — tune how much the Wiki's own retrieval route contributes once Shadow Mode is off.
- **Episode-similarity threshold** and **search timeout** — control cross-paper link discovery sensitivity and its time budget.
- **Data controls** — deletion controls for Wiki data, and live statistics on pages, claims, evidence, and embeddings currently stored.

### Documents

- **MinerU** — cloud vs. local mode and its endpoint/token, model version (VLM / hybrid / pipeline), language, OCR/formula/table toggles, whether parsed Markdown is attached to the Zotero item, concurrency, timeout, max file size, an on-demand-blocking toggle, and cache management.
- **PDF Translation** — provider, API URL, key, model, and target language; AI-context toggle; per-document and global glossary options; optional domain-expert selection.
- **Write & privacy** — **Enable Write Operations** (off by default), **confirm every write** toggle, **Allow File Import** (high-risk — required for the `import` action of `write_item`, off by default), and **expose local file paths** (off by default).

---

## 🏗️ Architecture

```
AI Client  <-- Streamable HTTP -->  Zotero Plugin (integrated MCP server + Zotero API access)
```

Everything — the MCP server, the search index, the Wiki database, and the optional MinerU/GPU integrations — runs inside the Zotero process. There is no separate server to install, configure, or keep alive; enabling the server in preferences is the entire setup.

---

## 👨‍💻 Developer Guide

### Prerequisites

- **Zotero 9.0.x** (the plugin declares `strict_min_version` / `strict_max_version` of `9.0` / `9.0.*` and will not load on other major versions).
- **Node.js 18+** and **npm** — only needed to build the plugin from source, not to run it.
- **Git**.

### Build From Source

```bash
git clone https://github.com/xu281530-rgb/zotero-lit-synapse-gpu.git
cd zotero-lit-synapse-gpu/zotero-lit-synapse-plugin
npm install
npm run build      # builds the .xpi and type-checks with tsc --noEmit
npm run start       # or: development mode with hot reload into a running Zotero
```

The built add-on is written to `.scaffold/build/zotero-lit-synapse.xpi`; install it the same way as a prebuilt release.

### Optional: GPU Native Module

The CUDA vector-acceleration backend lives in `native/vector-gpu/` as its own CMake project. Build it and package its assets separately once your toolchain is set up:

```bash
npm run build:gpu-native   # builds the native CUDA/C++ module
npm run package:gpu-assets # packages the built assets for the plugin
npm run build:gpu          # both steps together
```

This is entirely optional — the plugin runs on CPU without it.

### Testing

The project ships an extensive suite of targeted test and calibration scripts (well over a hundred, covering everything from BM25F scoring to Wiki commit validation to GPU protocol framing) rather than one monolithic test command. Run `npm run test` for the scaffold's own test runner, or browse the `scripts:` section of `package.json` for a specific `test:*` / `calibrate:*` / `benchmark:*` script relevant to what you're changing.

---

## 🩺 Troubleshooting

**Connection refused (`ECONNREFUSED 127.0.0.1:23120`)**
Make sure Zotero is running, the plugin is enabled, and **Enable Server** is checked on the Server tab. Confirm the port in your AI client's configuration matches the port shown in preferences.

**Streamable HTTP connection fails**
Double-check the URL is exactly `http://127.0.0.1:<port>/mcp`, that no firewall or security software is blocking Zotero's process from listening on that port, and — if you enabled remote access — that the client is sending the MCP access token as a bearer credential.

**The AI client doesn't see any Zotero tools**
Confirm the client's configuration uses `"transport": "streamable_http"` (not `stdio`), that the JSON is syntactically valid, and restart the client after any configuration change — most clients only read MCP configuration at startup.

**The server won't start**
Another process may already hold the configured port; change the port in preferences and try again. Check Zotero's own error console (`Tools → Developer → Error Console`) for a more specific error.

**A tool call fails with a validation error**
The server refuses ambiguous or malformed calls by name rather than guessing — read the error message itself; it names the specific field and why (a wrong key type, an empty required array, a cursor combined with changed search parameters, and so on) rather than failing silently.

If none of this resolves it, please open an issue with your OS, Zotero version, AI client, and the relevant error text or log output.

---

## 🔧 MCP Tool Reference

All tool definitions live in one place — `src/modules/toolCatalog.ts` — and both the MCP `tools/list` response and the HTTP `/capabilities` document are projected from it. There is no second list to keep in sync, and `npm run test:tool-catalog` fails the build if the two projections ever disagree. The server exposes 50 tools across five groups: 11 for search and query, 3 for collection management, 6 for semantic search and reading, 19 for the LLM Wiki, and 11 for write operations.

### 1. Search & Query (11 tools)

#### `hybrid_search`

Stage 1 of the retrieval funnel. It runs keyword retrieval and semantic vector retrieval in parallel. The keyword branch covers the metadata of the whole library (title, abstract, creators, publication title, tags, extra) **and the body text of every document in the keyword index**; the semantic branch covers the indexed passages. Neither branch scans Zotero's full-text cache or parses a PDF on the fly, so body coverage on both sides is whatever has been indexed — `metadata.bodyKeywords` reports the keyword index's share, and each row's `fullText` field reports the semantic index's.

**How the two branches combine.** They are never compared against each other. Each is filtered on its OWN scale — normalised BM25F for keyword, cosine similarity for semantic — against its own user-configured threshold, and the survivors are **unioned**: clearing either threshold on its own is enough, so a branch can admit a document but can never veto one. A paper the keyword branch never found is still returned when the embedding rates it, and vice versa.

Ranking is then **weighted Reciprocal Rank Fusion** over where each document placed _within each branch that admitted it_:

```
score = keywordWeight/(rrfK + keywordRank) + semanticWeight/(rrfK + semanticRank)
```

An absent branch contributes nothing rather than a penalty, so a document both branches admit collects two contributions and outranks single-branch documents at comparable ranks. Corroboration is expressed as position, not as a bonus. `rrfK` controls how quickly rank advantage flattens out; preferring a branch is what the two weights are for.

**`score` is a position, not a relevance.** It is a small rank-consensus number (a document first in both branches lands near 0.033 at the default `rrfK = 60`), comparing it against 0.6 or against another search's scores is meaningless, and **no threshold is applied to it**. For how relevant a document actually is, read `normalizedKeywordScore` and `normalizedSemanticScore` — real 0-1 relevances on their own branch's scale, and exactly what the thresholds were applied to. A **missing** one means that branch did not admit the document, not that it scored zero. Do not re-sort the rows by anything else: re-sorting a rank fusion undoes it.

- `query` (required unless `cursor` is given), `keywords`, `domain`, `expertRole`, `topK`, `cursor`, `minKeywordScore`, `minSemanticScore`, `language`, `rrfK`, `keywordWeight`, `semanticWeight`, `libraryID`
- Returns a lightweight candidate row per document: `itemKey`, `title`, `creators`, `year`, `publicationTitle`, `language`, the RRF `score`, `normalizedKeywordScore`, `normalizedSemanticScore`, `matchedBy`, `matchedKeywords`, `matchedFields`, `hasAbstract` and a short evidence snippet from the best-matching passages.
- **Abstracts are not returned.** They are still indexed and still searched by the keyword branch — they are just not shipped back, so a 20-candidate shortlist stays a shortlist. Fetch one with `get_item_abstract` only for a paper worth going deeper on.
- Answer from these rows directly when the user only asks which literature is relevant.

**Paging.** `topK` is the size of one page, not the depth of the search. The response carries a `pagination` block — `appliedKeywordMinScore`, `appliedSemanticMinScore`, `totalRelevant`, `returned`, `offset`, `range`, `hasMore`, `nextCursor` — where `totalRelevant` is how many documents at least one branch admitted, which is usually more than one page. The order is **retrieve → gate each branch on its own threshold → union → rank by RRF → page**, so a later page can never contain a document both branches rejected and a short final page is never padded out. Pass `nextCursor` back as `cursor` (with every other argument unchanged or omitted) to window further down the _same_ ranking; it does not re-run retrieval, so pages cannot duplicate, drop or reorder documents. Changing `query`, `keywords`, `domain`, `expertRole`, `minKeywordScore` or `minSemanticScore` alongside a cursor is rejected — that is a new search. Pagination state lives 15 minutes and covers the 5 most recent searches; an expired cursor fails with a clear message rather than silently restarting.

**Retrieval depth.** Both branches are _exhaustive_: fusion sees every candidate, `ranked` holds every document at least one branch admitted, and `results` is just a window onto it. There is therefore no candidate pool to saturate and no `candidateK` parameter. `totalRelevant` is exact, and degrades to a lower bound only when a branch failed or timed out — in which case `pagination.degradedRetrieval` and `pagination.totalRelevantIsLowerBound` are both set.

#### `search_library`

Structured metadata search for explicit title, author, year, item type, or other field constraints. Use `hybrid_search` first for general literature discovery.

- `q`, `title`, `titleOperator`, `yearRange`, `itemType`, `includeAttachments`, `relevanceScoring`, `sort`, `limit` (default 200), `offset`

#### `search_annotations`

Search **your own marks** across the library — PDF highlights and comments, and the notes you typed into Zotero — when you do not yet know which document holds them. Everything it returns is the user's reading, not the literature: quote it verbatim and attribute it to the user.

At least one non-empty `q`, `colors` or `tags` value is required; blank strings and empty arrays are rejected instead of triggering an unfiltered sweep. Every mark matching the filters is scored and ranked _before_ one page is served — the previous implementation ranked an arbitrary first 100 candidates, so in a library with more matches than that the best one was routinely outside the window it ranked.

Each hit carries three separate keys, and only one of them is a document key: `sourceItemKey` is the **paper**, `attachmentKey` is the PDF the mark sits on, and `annotationKey` is the mark itself. Continue with `sourceItemKey` — it is what `get_annotations(itemKeys)`, `get_item_details`, `search_fulltext` and `get_document_chunks` all expect.

> Before 1.9.1 a row carried one field named `parentKey`, which held the attachment key for a highlight and the item key for a note. Feeding a highlight's `parentKey` to `get_annotations` matched nothing and returned an empty page, which reads as "this paper has no marks" rather than as a wrong key. The field is gone rather than deprecated: one name with two meanings is the defect, so keeping it would keep the failure.

- `q`, `itemKeys` (document keys; all of them are searched), `types`, `colors`, `tags`, `minRelevance`, `limit` (default 15, maximum 100), `offset`
- Every row on the current page contains the full highlight/note text and its complete comment; there is no token compression or detail mode.
- Returns `pagination` with `total`, `offset`, `limit`, `hasMore`, `nextOffset`
- Each row returns `sourceItemKey`, `attachmentKey` (absent for notes) and `annotationKey`
- `sourceItemKey` is **null** when the mark has no document above it — a top-level note, or a mark on an unfiled attachment — with `noSourceItemReason` saying which. It is never filled in with a substitute: a standalone note's own key briefly stood in here, and against a real library `get_annotations` on it returned 0 marks while `get_document_chunks` blamed a missing index for a note that has no attachment. A key every document-level tool rejects is not a document key.
- Handing an attachment, note or annotation key to `get_item_details`, `get_document_chunks` or `search_fulltext` is now refused by name, and the refusal gives you the document key to use instead. `get_item_details` previously _succeeded_ on an attachment key and returned the PDF's filename as the title.

#### `search_fulltext`

Stage 3 of the retrieval funnel: hybrid keyword + semantic search over the passages of ONE document located by `hybrid_search`. The scoring rule is identical to `hybrid_search`, one level down — the candidates are this paper's passages instead of the library's documents. Both branches are gated on the SAME two user settings, the survivors are unioned (a passage only has to clear one of the two), and ranking is weighted RRF over each passage's within-branch rank, so `score` is a position rather than a relevance here too. Whole-library full-text scanning is disabled.

Before calling it, read that paper's abstract with `get_item_abstract`, re-fit `domain` and `expertRole` to what the paper actually studies, and write `query` and `keywords` from its own subject matter — **in the language that paper is written in**, one language rather than both, since probes in the other language cannot match a single document's passages.

- `itemKey` (required), `query`, `keywords`, `domain`, `expertRole`, `maxChunks`, `minKeywordScore`, `minSemanticScore`, `chunkIds`, `neighborRadius`, `libraryID`

#### `search_collections`

Find collections whose name matches a query, when the user refers to a folder by name and you need its `collectionKey`. Returns identity and path, not contents. Params: `q` (required), `limit`, `offset`, `libraryID`. Continue with the response's `pagination.nextOffset`.

#### `get_libraries`

List every Zotero library available in this client. The response is `{ results, pagination, metadata }`, with `total`, `hasMore` and `nextOffset` in `pagination`. Params: `limit`, `offset`.

#### `search_libraries`

Find a library by name, when the user names a group library and you need its `libraryID`. Params: `q` (required), `limit`, `offset`.

#### `get_annotations`

Read **your own marks** on documents you already name: PDF highlights, comments, image and ink annotations, and the notes you typed into Zotero. This is where note bodies come from — `get_item_details` no longer returns them, because a metadata lookup shipping the user's private notes gave no marker saying whose words were whose.

Pass exactly one of `itemKeys` (one or **many** documents — all of them are read, which is what makes "compare my marks across these five papers" a single call), `itemKey`, `annotationId`, or `annotationIds`. `itemKeys` takes **document** keys — the `sourceItemKey` of a `search_annotations` hit, never its `attachmentKey`. Each row carries the `sourceItemKey` it came from, so marks stay attributable when several documents are read at once.

Results always page because a well-read PDF can hold hundreds of highlights. Every mark on the current page contains its complete original text and comment.

- `itemKeys`, `itemKey`, `annotationId`, `annotationIds`, `types`, `colors`, `tags`, `limit` (default 20, maximum 100), `offset`, `libraryID`

#### `get_item_details`

Bibliographic metadata for one item — the citation tool. Returns title, creators, date, item type, venue, volume/issue/pages, DOI, URL, language, tags, and one row per attachment.

**It returns no content, by design.** No abstract text, no note bodies, no annotation text, no PDF text, no chunks — each of those has a tool that returns it on purpose and pages it properly. What you get instead is availability: `hasAbstract` / `abstractChars` say what `get_item_abstract` would return without returning it, and `noteCount` says how many notes `get_annotations` would find.

`fullText` reports what the semantic index actually holds, on the same five-value scale every search result uses (`indexed` / `parse_failed` / `no_source` / `not_indexed` / `unknown`). This replaces the old per-attachment `hasFulltext` boolean, which only looked at the file extension and therefore claimed full text for PDFs that had never parsed; the per-attachment flag is still there as `hasExtractableText`, meaning "this file type could yield text".

Params: `itemKey` (required), `libraryID`.

#### `get_item_abstract`

Stage 2 of the retrieval funnel: one item's abstract, on demand. Call it only for a candidate you are seriously considering reading in depth — it is not a batch step after `hybrid_search`, so 20 candidates does not mean 20 abstracts.

Params: `itemKey` (required), `format` (json/text).

#### `get_attachment_text`

The text of **one attachment** — a PDF, a Markdown/HTML/plain-text file — and nothing else. Replaces `get_content`, which merged the abstract, the notes, every attachment's text and a webpage snapshot into one object with no way to ask for just one of them, and no paging at all.

**Choosing the attachment.** Call with `itemKey` alone to get the attachment list and no text; call again with the `attachmentKey` you want. An item with exactly one text-bearing attachment is selected automatically (`selectedAutomatically: true`); an item with two is never guessed between, because reading the wrong one returns text that looks entirely valid and belongs to a different document. For a standalone PDF or other unfiled attachment, pass that attachment's key as `itemKey`; no parent item is required. Attachment rows include `sizeBytes` when the local file is available.

**Where the text came from.** Every response names its source in `textSource.method`, with a `description` saying what may be relied on: `doc2x` (publisher structure preserved), `mineru_cache` / `mineru_attachment` (reused MinerU Markdown, reconstructed layout), `mineru` (parsed during this call), `markdown_attachment`, `zotero_fulltext_cache` (Zotero's flat index — **no layout, no tables**), `pdf_processor`, `html_parsing`, `text_reading`. When no text could be produced, the method says why (`mineru_disabled`, `mineru_on_demand_disabled`, `mineru_failed`, `mineru_error`, `no_text`).

**Paging.** Text comes back in character windows, cut at a paragraph or sentence boundary where one is nearby so a window never ends mid-word. `pagination` carries `totalChars`, `offset`, `returnedChars`, `hasMore`, `nextOffset`.

- `itemKey` (required), `attachmentKey`, `offset`, `limit`, `libraryID`

### 2. Collection Management (3 tools)

#### `get_collections`

List collections, mainly so you can read the user's real folder names and pass the relevant ones to `hybrid_search` as `collectionKeys`. Flat and paginated: top-level collections by default, or `parentCollection`'s direct children.

The response is `{ results, pagination, metadata }`. Until 1.9.1 it was a bare JSON array with the total in an `X-Total-Count` header, so over MCP — which forwards only the body — the total and the `metadata` block the server attached were both silently dropped by `JSON.stringify`, and a page of 100 out of 300 was indistinguishable from a complete library of 100. `search_collections` returns the same envelope.

Params: `parentCollection`, `limit` (default 100), `offset`, `libraryID`.

> `recursive` was removed in 1.9.1. It returned every level in one unpaginated response, duplicating `get_collection_items` and reintroducing the bulk dump the level-by-level browser replaced. Passing it is an error, not a no-op. `get_collection_items` reports `directItemCount`, `totalItemCount` and `hasChildren` per folder, so you can see what a subtree holds without downloading it.

> `get_subcollections` was removed in 1.9.0 as a duplicate: it was this tool with `parentCollection` renamed to `collectionKey`, ending in the same handler with the same recursive walk. Use `get_collections` with `parentCollection`.

#### `get_collection_details`

Metadata about one collection: name, parent, how many items and subcollections it holds. It does not list them. Params: `collectionKey` (required).

#### `get_collection_items`

**Browse the library one level at a time, like a file manager.** Each call returns the subfolders at the current level plus one page of the documents filed directly there — never the whole tree.

Call it with no `collectionKey` to start at the library root (its top-level collections, plus any documents in no collection at all), then descend by passing the `collectionKey` of the folder you want to open. Every response repeats the current `location` (`libraryID`, `collectionKey`, `name`, `path`) and the `parent` you came from.

Each subfolder row carries `directItemCount`, `totalItemCount` and `hasChildren`, which is how you choose where to descend without opening anything: a folder with `directItemCount: 0` and `totalItemCount: 300` is a container, not a dead end. `totalItemCount` de-duplicates, so a paper filed in both a parent and its child counts once.

Document rows are deliberately thin — `itemKey`, title, creators, year, venue, DOI, item type. No abstracts, notes, annotations, attachment text or chunks: the old version returned `formatItem`'s full default field list, so two rows measured 4.5 KB and listing a 200-item folder was most of a context window.

- `collectionKey`, `path` (e.g. `"Materials/Solidification/CET"`, resolved to a key; an ambiguous path fails and lists the candidate keys rather than guessing), `limit`, `offset`, `libraryID`
- Returns `location`, `parent`, `subcollections`, `items`, `itemPagination`

### 3. Semantic & Reading (6 tools, can be disabled in preferences)

`hybrid_search`, `keyword_search` and `semantic_search` return **the same lightweight candidate row** and share the same scoping and cursor paging, so switching between them costs nothing. Two things do differ and must not be carried across: each tool applies the threshold of the branch it _is_ (`keyword_search` the keyword floor, `semantic_search` and `find_similar` the semantic floor, `hybrid_search` both independently), and the `score` field means a 0–1 relevance on the single-branch tools but a rank-fusion **position** on `hybrid_search` and `search_fulltext`. They also share their implementation: one lexical service (`runLexicalSearch`), one semantic service (`SemanticSearchService.search`), one page store and one row projection. There is no second copy of either retrieval algorithm.

#### `keyword_search`

Lexical-only retrieval — no embeddings, nothing scored semantically. It matches your terms against the metadata of the **whole library** (title, abstract, creators, publication title, tags, extra) **and against the body text of every document in the keyword index**, scored together in one BM25F pass.

**Body coverage is partial.** Body matching reads the plugin's own keyword index; it never scans Zotero's full-text cache and never opens a PDF on the fly, so it reaches exactly the documents that have been indexed. A paper absent from the results may simply be unindexed rather than irrelevant — `metadata.bodyKeywords` reports `indexedDocuments` against `metadataCollectionSize` so you can tell the two apart.

A body hit is a full hit: a document with none of your keywords in its title, abstract or tags still enters the ranking on its body alone. Such a row comes back with `matchedFields: ["body"]` and a **`bodyEvidence`** array — the passages that carried the terms, each with its `chunkId`, which keywords it contained, how many times, and the passage text. For a body-only row that is the only thing explaining why the document is there. `occurrences` is evidence strength for the reader; it takes no part in ranking.

`score` here is a genuine 0–1 relevance: one branch means there is nothing to fuse, so it is the normalised BM25F score the threshold was applied to. That is **not** the same quantity as `hybrid_search`'s `score`, which is a rank-fusion position — never carry a number between the two. The floor applied is the user's **keyword** relevance threshold, the same setting that gates `hybrid_search`'s keyword branch.

Two uses: an exact term you must not miss, and — the intended one — a **coarse filter** whose `itemKeys` you hand to `semantic_search` so the semantic pass only scores that shortlist. For ordinary discovery `hybrid_search` is still the default first step, since it runs this branch _and_ the semantic one.

- `keywords` (required unless following a cursor; bilingual, 1–16, ~5–12 recommended), `query` (fallback probes only — never embedded), `domain`, `expertRole`, `collectionKeys`, `itemKeys`, `topK`, `cursor`, `minScore`, `libraryID`

#### `semantic_search`

Pure embedding-similarity retrieval: one natural-language query is embedded and compared against every indexed passage. Use it for a concept whose vocabulary you cannot pin down, or as the fine pass over a `keyword_search` shortlist.

Before 1.9.0 this tool was the last one still on the pre-funnel architecture: hard-coded `topK = 10` and `minScore = 0.3` that ignored the user's own settings, no cursor, no collection or item scoping, rows shipping raw untruncated chunk text (in a real library, whole reference lists as "evidence"), and no `fullText` status — so a semantic hit on a paper's _abstract_ was indistinguishable from a hit on its body. All of that now matches `hybrid_search` exactly.

- `query` (required unless following a cursor), `domain`, `expertRole`, `collectionKeys`, `itemKeys`, `topK`, `cursor`, `minScore`, `language`, `libraryID`

#### `find_similar`

Find DOCUMENTS semantically similar to one paper, using several of that paper's own passages as the query. Purely semantic — no keywords take part.

The AI first picks representative chunks of the source paper with `search_fulltext`, then passes their `chunkId`s here. Every chunk is scanned against the whole index as its own query vector; chunk scores are aggregated into ONE score per candidate document (for each query chunk, the candidate's two best passages are averaged; those per-query scores are combined as 0.75 × mean + 0.25 × max), so a paper qualifies by relating to several of the facets supplied rather than by owning one lucky passage. The source paper is excluded from its own results.

Every document above the user's relevance threshold is returned — there is no cap on how many qualify — ranked and paged. **One page holds at most the user's configured maximum number of documents**; there is no fixed page count, and `topK` can only lower it. Results carry identity, scores and matched `chunkId`s, not passage text; read a candidate with `search_fulltext`.

Timeout: no separate setting. The scan deadline is the user's single-scan `vectorScanTimeoutMs` scaled by the number of query chunks and the path that will run it — `0.8 + 0.35N` on the CPU (one shared pass over the index) and `0.5 + 1.1N` on the GPU (one resident-vector scan per query). Both multipliers come from measurements (`npm run benchmark:find-similar-scaling`) and the applied budget is reported in the response metadata.

- `itemKey` (required for a new search), `chunkIds` (required for a new search, max 20, all from that one item), `minScore`, `topK` (page size, capped by the user's maximum number of documents), `libraryID`, `cursor` (page on without re-scanning)

#### `semantic_status`

Get semantic search service status and index statistics. No parameters required.

#### `build_search_index`

Explicitly build or refresh the unified search index for one or more documents. The same targeted lifecycle used by Zotero's update-index command extracts and chunks each document once, then updates both semantic vectors and the keyword index. It keeps the existing build lock, pause/reset fences, failure journal, chunk settings and embedding compatibility checks. This can be expensive and is never triggered implicitly by `wiki_build_from_paper`.

- `itemKeys` (required, 1-100 documents), `libraryID`
- Returns a result for every document and aggregate counts. Semantic and keyword outcomes are separate, so one branch cannot silently hide failure in the other. `parse_failed` and `no_source` report the real absence of indexed body text rather than claiming success.

#### `get_document_chunks`

Read **one paper's body straight through**, in the order the semantic index stored it, a few chunks per page. `search_fulltext` answers "where in this paper does it say X"; this answers "let me read this paper".

Every chunk carries `chunkIndex` (position in reading order) and `chunkId` (the stable id `search_fulltext` and `find_similar` accept). The two are _not_ interchangeable — they diverge wherever a chunk was dropped — so never compute one from the other.

Paging is mandatory: a page is at most 20 chunks and there is no way to ask for the whole document. A document whose PDF never parsed, or which has no text attachment, is **refused** with a message naming which case it is, rather than being answered with its title and abstract dressed up as body text.

- `itemKey` (required unless following a cursor), `cursor`, `offset`, `limit`, `libraryID`
- Returns `fullText`, `pagination` (`totalChunks`, `returned`, `offset`, `range`, `hasMore`, `nextCursor`) and `data`

> `fulltext_database` was removed in 1.9.0. Two of its four actions (`list`, `stats`) were index administration exposed to callers, and a third (`get`) returned an entire document in one unpaginated response — the single standing bypass around the retrieval funnel every other tool enforces. Index maintenance now lives only in the plugin's preferences UI.

### 4. LLM Wiki (19 tools, can be disabled independently)

The Wiki is an independent long-term knowledge database. It stores reusable Pages, Claims, Concepts, Relations and traceable Evidence rather than another paper-summary index. Normal research uses a prepare/controlled-commit flow; `wiki_build_from_paper` is allowed only for one paper explicitly requested by the user. The server performs no hidden LLM calls.

**Two ways of reading, one reading note.** A paper gets read in two different ways, and both write into the same Markdown note and the same ledger of chunks actually read.

*Question-driven reading* is the everyday path. The user asks something, `hybrid_search` then `search_fulltext` find the relevant passages, the model genuinely reads some of them and answers — and then, for **every paper it really read**, calls `wiki_update_reading_note` with `readChunkIds` (the chunks it actually used to answer), the `domain` and `expertRole` it searched that paper with, and the paper's whole note rewritten to include what it just learned. A chunk that retrieval returned but nobody engaged with is not listed: retrieval is not reading, and the server only stands behind what was declared.

Chunks read this way accumulate as a SET, not a cursor. `{7,8,42}` then `{15,42,70}` is five distinct chunks, not six; the repeated 42 is not counted twice, and neither is a repeat inside one call. The note's header draws the coverage: a filled square per chunk read, a hollow one per chunk unread (past a hundred chunks one cell spans several, and a partly-read cell is drawn half-filled).

The order is **note first, Wiki second**, and the server enforces it rather than asking: a paper whose last reading has not reached the Wiki refuses to be read again until a `wiki_commit` cites it. One question that read three papers is settled by one commit citing all three. Only a turn that actually read something new owes a Wiki update — a turn that answered from what was already understood says so and skips it, rather than padding the Wiki with duplicates. What is written should extend the Page, Claim, Concept and relations that already exist instead of creating near-duplicates beside them.

The note only grows. Each rewrite may reorganise, merge and correct, but one that loses more than a tenth of the document is refused — compress a little every turn and by the twentieth question the parameters read on page 3 are gone, and no single rewrite ever looks unreasonable. Every fact, parameter, result, mechanism and figure in it names the chunk it came from, in the prose ("melt-pool depth reaches 1.2 mm (chunk 42)"), or the note will not save; a chunk number in a *heading* is still refused, because that is a page log.

Question-driven reading **never** reaches `paper_reviewed`. Even if scattered questions happen to touch every chunk, `finalSynthesis` is refused on this path and Evidence stays at `chunk_local` or `section_read`. Whole-paper depth names an act — reading it through, then reconciling it as one thing — that scattered passages never perform, however many of them there are.

*Reading one paper deeply* is the original path, and it now INHERITS what the questions read. A paper is read in a fixed order, and the server enforces it. The opening `wiki_build_from_paper` call returns the paper's metadata and abstract and no body text; `wiki_set_reading_expert` answers it with the one domain expert who will read this paper, which also creates a persistent Markdown **reading note** as an attachment on the Zotero item. Body chunks then flow one page at a time, and after each page the whole note is rewritten with `wiki_update_reading_note` — merged, reordered and corrected, not appended to. Notes organised by delivery batch (`Chunks 8-15`, `New in this batch`) are refused: a chunk is how text is transported, not a way to organise knowledge. At most one delivered batch may be outstanding before the next page is refused; a batch that genuinely adds nothing can be answered with `unchanged`, but not twice running.

The note's top block — `paperKey`, `title`, `abstract`, `expert`, `readChunks`, `totalChunks`, `nextChunk`, `coverage`, `status`, `updatedAt` — is maintained by the server from the reading ledger, never by the model, so nothing written in the note can make the paper look further along than it is. Because the note is a real file on the item, a Zotero restart, an MCP disconnect or a context compaction costs nothing: `wiki_get_reading_note` hands back the note, the expert and the chunk index to resume at.

If questions had already been asking about this paper, `wiki_build_from_paper` does not start over: the same session is promoted in place to full-text mode, keeping its chunk ledger and its note, paging skips runs of already-read text at the head of a page and asks only for what the questions never reached, and `carriedOverFromQuestionAnswering` says how much was inherited. The one thing still asked for is a *considered* expert profile: the reader a question assembles on the fly from its retrieval parameters is marked provisional and may be replaced, because who reads a paper end to end is a decision worth making properly. An explicit `offset` is never skipped ahead of, so re-reading a passage to check a quotation still works and still costs nothing against the integration gate.

Once every chunk has been delivered, three more passes are required before `wiki_prepare_update` will start the write-up: one over the whole paper (`finalSynthesis`), one over the terminology it established (`wiki_record_concepts` with `final`), and one over the **whole Wiki** (`wikiReview` on `wiki_prepare_update`). The second builds the independent concept library: one entity per concept, one primary term and any number of alias terms, every term carrying a Chinese full name, an English full name and an abbreviation — with the hard rule that an abbreviation may never stand alone. A paper that introduced nothing new answers with an empty list and a reason. Names are never overwritten away: two papers that spell the same term differently keep both spellings as two term rows of one concept, and only a value the model had merely inferred is replaced when a paper contradicts it.

The third pass is new in 2.5.0. The first two both look at the PAPER: is the note coherent, has the terminology been reviewed. But the Wiki has been growing incrementally the whole time and has usually drifted by the end — a Claim written from an early chunk that a later one bounds, two Concepts written turns apart that are really one, a relation drawn early that no longer holds. So the last gate asks, with the finished paper in hand, what it means for what is already stored, on five axes: does a Page need adjusting or creating; which Claims does the complete reading confirm, qualify, merge or contradict; which Claims are thin on Evidence and which Evidence can now be carried at full-paper depth; which terms need adding, correcting or de-duplicating; which relations should be drawn or withdrawn. Every axis must be answered — "nothing to change here, because ..." is a perfectly good answer and the commonest one — and silence is not accepted, because it cannot be told apart from not having looked. It is asked once per paper, and a retry after a validation error does not re-ask.

Evidence reaches `paper_reviewed` or `cross_paper` depth only when both are true: every chunk delivered by a full-text read **and** that final pass recorded. Delivery is not understanding. The note itself is never Evidence — Claims still cite excerpts verified against the paper's own indexed chunks, and that chunk must already be recorded as READ, whether delivered by `wiki_build_from_paper` or declared through `readChunkIds`. Quoting a passage nobody read is refused by name: the excerpt is genuinely in the paper, what is missing is a reading of it. That is the other half of "note first, Wiki second" — a Claim can only rest on something the note already accounts for. The note is also excluded from the search index, so a summary of a paper can never be retrieved as if it were the paper.

- `wiki_prepare_update` — search existing knowledge before proposing changes; pass up to two exact `proposedPageTitles` so its short-lived token can authorize only the Page titles that were actually searched. `pendingWikiWriteUp` names the papers whose reading notes have moved ahead of the Wiki. Once a paper has been read in full it also requires `wikiReview`, a pass over the whole Wiki on five axes: pages, claims, evidence, concepts, relations
- `wiki_get_prepared_context` — retrieve a prepared snapshot by section and offset. Prepare defaults to compact output; use `preview: true` to inspect claims, evidence and cross-paper candidates before submitting the five-axis review. Reading records and large entries are paged without losing content.
- `wiki_commit` — apply validated `SKIP`, Evidence, Claim, Page, Relation or conflict actions
- `wiki_search` — search Concept/Alias, Claim, Relation and one-hop Evidence links
- `wiki_get_page` — read a Page with its Claims and Evidence
- `wiki_get_claim` — read one atomic Claim and its provenance
- `wiki_get_link_review` — recover durable cross-paper tasks, target snapshots, outcomes and history. Page targets, discovery, verdicts, outcomes or history independently of prepare tokens. Compare selected old Wiki knowledge, record every exclusion, and defer missing knowledge explicitly. `wiki_commit.crossPaperReview` binds conclusions to actual Claims, term sources or new Claim relations; `checkpoint: true` saves progress without ending reading. The graph draws one line per paper pair, prioritizing disagreement, shared Claims, method comparisons or qualifications, shared pages, then shared concepts. Clicking any line shows every relationship in consistent cards with Claims and source excerpts. Evidence summaries distinguish current support, archived sources and unverified semantic assessments; the retained legacy score is heuristic, not a correctness probability.
- `wiki_status` — report Wiki and Evidence-link status
- `wiki_export` — render derived Markdown without changing the authoritative database; the concept library is appended as a final section
- `wiki_record_concepts` — record the professional concepts recognised while actually reading a paper, each as one entity with one primary term and any number of alias terms (Chinese full name / English full name / abbreviation), with the source documents they were recognised in. Calls without `final` are staged on the open reading session and write nothing; the one call with `final` writes everything at once, so a paper costs one database write and one confirmation instead of one per batch. Every field carries its own provenance — quoted from the paper, completed by the model, or edited by a person — and the model may complete a term from its own knowledge as long as it says so
- `wiki_list_concepts` — list the independent concept library, with every term and its sources
- `wiki_export_concepts` — export the concept library on its own as Markdown
- `wiki_reverify` — relink Evidence after index rebuilds, and re-verify every pending cross-paper candidate against the live index in the same pass
- `wiki_scan_links` — compute cross-paper link candidates: which papers are related to which, through which passages, terms or concepts. Normally unnecessary — a paper is queued automatically the first time it produces a real reading record, and the queue drains in the background; importing papers deliberately does not trigger it. One scan is a single full-library vector pass over at most 20 representative chunks, followed by a pairwise refinement that does not re-scan the library. What it writes are suggestions: they surface in `wiki_prepare_update` as `pendingLinkSignals` with both passages and a server-computed `mustResolve`, and nothing here writes a Page, a Claim, Evidence, a Concept or a relation
- `wiki_build_from_paper` — read one explicitly requested paper: metadata and abstract first, then one page of chunks at a time; follow `pagination.nextCursor` until `pagination.coverageComplete` is true, and finish the open paper before starting another. It inherits whatever questions already read of that paper — same note, same ledger — and asks only for the rest. The one-paper-at-a-time lock applies to full-text reading alone; question-driven reading takes no slot and may accumulate several papers at once
- `wiki_set_reading_expert` — generate this paper's one domain expert from its metadata and abstract, and create its persistent Markdown reading note on the Zotero item
- `wiki_update_reading_note` — replace the whole reading note with your current understanding of the paper. Called once per page during a full-text read; called once per paper actually read after answering a question, with `readChunkIds` naming the chunks that were genuinely used and the `domain` / `expertRole` the paper was searched with. `finalSynthesis` marks the whole-paper pass once every chunk has been delivered, and is not available on the question-driven path
- `wiki_get_reading_note` — read back a paper's note, expert and exact resume point; the recovery path after a restart or a context compaction
- `wiki_finish_reading` — close an open paper without writing it up (`skipped`). Without `itemKey` it closes the paper being read in full; with one it can also close a paper that questions have been reading, which releases the block on reading it further

### 5. Write Operations (11 tools, can be disabled in preferences)

All eleven are hidden from `tools/list` and from `/capabilities` when write operations are disabled, which is the default — the server never advertises a capability it would refuse.

Two Wiki tools go with them, and they are worth knowing about because they are not in this section: `wiki_set_reading_expert` and `wiki_update_reading_note` create and rewrite the paper's reading note as a real Markdown attachment on the Zotero item, so they are Zotero writes and are gated as such. Turning write operations off therefore also stops Wiki reading notes — thirteen tools disappear from `tools/list`, not eleven.

#### Collection mutation

- `create_collection` — `name` (required), `parentCollection`, `libraryID`
- `update_collection` — `collectionKey` (required), plus at least one of `name` or `parentCollection`
- `delete_collection` — `collectionKey` (required), `deleteItems`
- `add_items_to_collection` — `collectionKey`, `itemKeys` (both required)
- `remove_items_from_collection` — `collectionKey`, `itemKeys` (both required)
- `move_items_to_collection` — `toCollectionKey`, `itemKeys` (both required), `dryRun`
- `merge_items` — `groups` (required), `dryRun`

`move_items_to_collection` is the reorganisation tool, and the only one of the five whose result is a *placement* rather than an addition: each item ends up filed in `toCollectionKey` and nowhere else. Use `add_items_to_collection` instead when a document is meant to stay in several folders.

The batch is all-or-nothing. Missing items, trashed items, and child notes or attachments are rejected during a preflight pass that runs before any write, so a bad key aborts the batch with nothing written rather than leaving the library half-reorganised; the write itself then runs in a single transaction. `dryRun` executes the same preflight and returns the same plan — which items move, which filings each one loses — without writing and without raising the confirmation prompt, which is what makes it safe to show a user a proposed reorganisation before performing it.

For `add_items_to_collection` and `remove_items_from_collection`, an all-missing batch is a failed tool call. A mixed batch returns `success: false` and `partial: true`, with the completed and missing keys listed separately. The confirmation dialog for reparenting lists the target and every child key; merge confirmation preflights the groups and names each survivor and every duplicate that Zotero will move to the trash.

#### Item and note mutation

#### `write_note`

Create or modify Zotero notes. Supports Markdown auto-conversion to HTML.

- `action` (required: create/update/append), `parentKey`, `noteKey`, `content` (required), `tags`

`content` is required and must be a string; omitting it and passing an empty string are different things. An empty string means ERASE and is accepted only by `update`, where it clears the note and the response reports `cleared: true` with the number of characters erased (the note item itself stays — delete it in Zotero if it should be gone). `create` and `append` refuse empty content, because there it can only mean the content generation came back empty.

#### `write_tag`

Add, remove, or replace tags on items.

- `action` (required: add/remove/set), `itemKey` (required), `tags` (required)

#### `write_metadata`

Update metadata fields on items (title, abstract, date, DOI, creators, etc.).

- `itemKey` (required), `fields`, `creators`

#### `write_item`

Create new items, reparent existing attachments, or import a local file as an attachment.

- `action` (required: create/reparent/import), `itemType`, `fields`, `creators`, `tags`, `attachmentKeys`, `parentKey`
- import only: `filePath` (absolute path to the file), `parentItemKey` (the item to attach it to), `title` (defaults to the file name)

`create` runs in a single transaction covering the new item and every `attachmentKeys` re-parenting, so a failure writes nothing and retrying cannot leave a duplicate item behind. Keys that name nothing, or name something that is not an attachment, do not abort the creation — they come back in `skippedAttachments` with the reason.

`import` additionally requires the **Allow File Import** preference and fails without it; it is the path for "convert a PDF to Markdown, then attach the `.md` to the item".

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit pull requests, report issues, or suggest enhancements.

1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/AmazingFeature`).
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4. Push to the branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

## 📄 License

This project is licensed under the [MIT License](./LICENSE).

## 🙏 Acknowledgements

- [Zotero](https://www.zotero.org/) — an excellent open-source reference management tool.
- [Model Context Protocol](https://modelcontextprotocol.org/) — the protocol for AI tool integration.
- [![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
- This project builds on the original [zotero-lit-synapse](https://github.com/cookjohn/zotero-lit-synapse) by [cookjohn](https://github.com/cookjohn) — thank you for the original Zotero LitSynapse integration this project is derived from.
- Thanks also to the author of Zotero Mark Reader for the reading/annotation functionality this project draws on.
