import { MAX_HYBRID_KEYWORDS, MAX_SUPPLIED_KEYWORDS } from "./hybridSearch";
// Imported from the leaf module rather than the ./semantic barrel: the
// barrel pulls in the vector store and the PDF worker, and this file is
// pure data that the catalog tests must be able to load without either.
import { MAX_SIMILAR_QUERY_CHUNKS } from "./semantic/similarDocumentAggregation";
import {
  DEFAULT_ATTACHMENT_TEXT_WINDOW,
  MAX_ATTACHMENT_TEXT_WINDOW,
} from "./attachmentText";
import {
  DEFAULT_DOCUMENT_CHUNKS_PER_PAGE,
  MAX_DOCUMENT_CHUNKS_PER_PAGE,
} from "./documentChunks";

/**
 * The one and only description of what this server can do.
 *
 * There used to be two hand-written lists: `getAvailableTools()` in
 * streamableMCPServer.ts, which is what `tools/list` actually served, and
 * `getCapabilities().tools` in httpServer.ts, which is what `/capabilities`
 * advertised. They drifted, as two hand-maintained copies of the same fact
 * always do — the HTTP copy was still advertising `get_attachment_content`,
 * `get_item_fulltext`, `get_item_pdf_content`, `get_annotation_by_id` and
 * `get_annotations_batch` long after those tools stopped existing, while
 * missing eleven tools that did. A client reading it was told to call things
 * that would fail and never told about half the server.
 *
 * Both callers now project this array. Adding, renaming or removing a tool is
 * one edit here, and `scripts/test-tool-catalog.js` fails the build if the two
 * surfaces ever disagree again.
 */
export interface ToolDefinition {
  name: string;
  /** Grouping shown by /capabilities. Not part of the MCP tool contract. */
  category: ToolCategory;
  description: string;
  inputSchema: Record<string, any>;
}

export type ToolCategory =
  | "search"
  | "retrieval"
  | "collections"
  | "semantic"
  | "write";

/** Tools that only exist when semantic search is switched on. */
export const SEMANTIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "semantic_search",
  "keyword_search",
  "find_similar",
  "semantic_status",
  "search_fulltext",
  "get_document_chunks",
]);

/**
 * Tools removed by the 1.9.0 architecture pass, and what replaced them.
 *
 * They are gone from `tools/list`, so no model can be led into calling one.
 * A client that still holds a stale list gets this sentence instead of
 * "Unknown tool", because the useful half of the answer is the replacement.
 */
export const REMOVED_TOOL_REPLACEMENTS: Readonly<Record<string, string>> = {
  get_content:
    "get_content was removed because it mixed abstract, notes, annotations and PDF text into one payload. To read an attachment's text, call get_attachment_text (it names the extraction source and pages through the text). To read a paper's body in indexed order, call get_document_chunks. For an abstract, call get_item_abstract. For your own notes and highlights, call get_annotations.",
  fulltext_database:
    "fulltext_database was removed: it was a database-administration surface (list/stats) plus an unpaginated whole-document dump (get). To read one paper's body in order, call get_document_chunks with its itemKey. To search inside one paper, call search_fulltext. Index statistics are a plugin-preferences concern and are no longer exposed to callers.",
  get_attachment_content:
    "get_attachment_content no longer exists. Use get_attachment_text.",
  get_item_fulltext:
    "get_item_fulltext no longer exists. Use get_document_chunks for ordered reading, or search_fulltext to search within one paper.",
  get_item_pdf_content:
    "get_item_pdf_content no longer exists. Use get_attachment_text with that item's PDF attachmentKey.",
  get_annotation_by_id:
    "get_annotation_by_id no longer exists. Use get_annotations with annotationId.",
  get_annotations_batch:
    "get_annotations_batch no longer exists. Use get_annotations with annotationIds, or with itemKeys for several documents at once.",
  get_subcollections:
    "get_subcollections was removed as a duplicate: it was get_collections with parentCollection renamed to collectionKey. Call get_collections with parentCollection set to that key for its direct children, or browse the library one level at a time with get_collection_items, which also reports how many documents each subtree holds.",
};

/**
 * Every tool this build knows how to serve, before preference filtering.
 *
 * Built fresh on each call rather than frozen at module load: a few
 * descriptions interpolate limits that a user can change at runtime.
 */
export function buildToolCatalog(): ToolDefinition[] {
  return [
  {
    name: 'hybrid_search',
    category: 'search',
    description: [
      'DEFAULT FIRST STEP for locating literature. Runs Zotero metadata/field keyword retrieval and semantic vector retrieval in parallel, then fuses them into one normalized 0-1 relevance score: each branch is normalised on its own scale, the stronger branch sets the score, and the weaker branch adds a bounded agreement bonus, so corroboration can only lift a document and never dilute it. Reciprocal Rank Fusion is computed too, but only as the tie-break between candidates whose fused scores are equal — rrfK tunes that tie-break, not the ranking. It does not scan full document text.',
      '',
      'The library is bilingual, so every call must retrieve Chinese AND English literature, no matter which language the user asked in. Do NOT translate the question into a single language and do NOT restrict the search to the language of the question. You (the calling AI) are responsible for the query rewrite: this tool never calls an LLM of its own.',
      '',
      'BEFORE writing any argument, run this analysis on the user question — it is the difference between a good and a useless search, and no part of it happens server-side:',
      'A. Classify the question: which discipline, and which specific sub-field or research direction inside it?',
      'B. Adopt that expert role for the rest of this call — reason as a specialist in that sub-field would, using the vocabulary of its literature.',
      'C. Determine the real research intent: which mechanism, property, process, material system or quantitative relationship is actually being asked about, including what the user implied but did not say.',
      'D. Only then derive query and keywords FROM that domain analysis, not from the surface wording of the question.',
      '',
      'Build the arguments like this:',
      '1. query — one complete natural-language sentence expressing the real information need as an expert in that field would state it, used verbatim as the embedding input for cross-lingual semantic search. Do not reduce it to loose tokens. Writing it as an English phrasing followed by " / " and the Chinese phrasing is recommended, so the embedding sees both surface forms.',
      `2. keywords — the terms a specialist in that sub-field would actually search on, covering BOTH Chinese and English: the core concepts, the mechanism and governing variables behind the question, standard technical translations, accepted synonyms and variant phrasings, the field's abbreviations, and closely coupled concepts with a clear professional link to the intent. For best results, providing about 5-12 relevant Chinese and/or English keywords is recommended; this is guidance, not a constraint — any number from 1 to ${MAX_HYBRID_KEYWORDS} is accepted. All of them are matched in a single pass over the candidate records (title, abstract, creator, publication title, tags), then scored by term specificity, field weight and how many distinct keywords each record matched, so short exact terms work far better than long sentences.`,
      '3. Do NOT pad the list. Every keyword must be defensible as a term of art tied to the research intent; generic, weakly related or category-level words dilute keyword-coverage scoring and push the right papers down the ranking.',
      '',
      'Worked example — user asks "温度梯度如何影响定向凝固中的柱状晶转变？":',
      '  A/B/C: materials science → solidification / microstructure formation; reasoning as a solidification specialist, the real intent is how the thermal gradient G, together with the growth rate R, governs the columnar-to-equiaxed transition — i.e. G-R processing maps and nucleation ahead of the growth front.',
      '  query: "Effects of temperature gradient on columnar-to-equiaxed transition during directional solidification / 温度梯度对定向凝固柱状晶-等轴晶转变的影响"',
      '  keywords: ["温度梯度", "定向凝固", "柱状晶", "等轴晶", "柱状晶-等轴晶转变", "凝固速率", "temperature gradient", "directional solidification", "columnar grain", "equiaxed grain", "columnar-to-equiaxed transition", "CET", "growth rate"]',
      '  Note what came from domain knowledge rather than from the question: the CET abbreviation, growth rate / 凝固速率 as the co-governing variable, and the columnar/equiaxed grain pair. Note also what was left out: "材料", "实验", "influence factors" — true of the question but too generic to discriminate between papers.',
      '',
      'If you do not pass keywords - or pass an array that is empty after blank entries are trimmed - the server falls back to mechanically tokenizing the query, returns keywordSource "fallback", a keywordFallbackReason naming which of the two happened, and a warning stating the keywords were NOT produced by domain-expert analysis. That path exists only so the call still runs, and it does return a real ranking. Redo the search ONCE with proper keywords; if you have already retried, keep the results rather than calling a third time.',
      '',
      'Leave language at its "all" default so retrieval stays genuinely cross-lingual; the other language values only narrow recall.',
      '',
      'SCORING: both branches are normalized to 0-1 and fused into one relevance score by taking the stronger branch and adding a bounded share of the weaker one, so a second, weaker hit can never push a document below what it scored on its own. Documents below the user-configured threshold are discarded by the server, and at most the user-configured number of documents is returned. That number is an upper bound, NOT a target: a weakly related paper is never added to make the list longer.',
      '',
      'WHAT YOU GET BACK: a LIGHTWEIGHT candidate row per surviving document — itemKey, title, creators, year, venue, the language it is written in, the fused score, which of your keywords matched which fields, and a short snippet from its best-matching passages. That is a shortlist to triage, not a reading pile.',
      '',
      'ABSTRACTS ARE NOT RETURNED, on purpose. They are still indexed, still searched by the keyword branch, and still part of what produced this ranking — they are simply not shipped back, because most candidates never need to be read in full. Judge each row from its title, score, matched keywords and snippet. Only for a paper you are seriously considering going deeper on, call get_item_abstract with that one itemKey. Reading every candidate\'s abstract is the exact behaviour this design removes: 20 candidates does not mean 20 abstracts.',
      '',
      'SCOPE: by default this searches the entire library. When the user question is clearly confined to part of their collection, call get_collections FIRST, read the real folder names, and pass the relevant ones as collectionKeys — the scope is applied before scoring, so it cuts the work rather than filtering the results afterwards. Judge each collection by what it plainly is: include what the user named, include what obviously relates, exclude only what obviously does not, and INCLUDE anything you cannot classify. Personal folder names carry no subject information — "待读", "综述", "课题资料", "论文写作" — yet often hold exactly the papers that matter, so uncertainty means include, never exclude. When most of the structure is opaque to you, or the question spans several fields, skip collectionKeys and search everything: a scope that misses a paper is a worse outcome than a scan that costs a little more.',
      '',
      'PAGING: topK is the size of ONE page, not the depth of the search. The response carries a pagination block: appliedMinScore (the floor these results passed), totalRelevant (how many documents cleared that floor — often more than one page), returned, hasMore and nextCursor. Filtering happens BEFORE paging, so a later page can never contain a document below the threshold, and a short last page is never padded out. To read further, call hybrid_search again with cursor set to nextCursor and everything else unchanged; that returns the next window of the SAME ranking rather than a fresh search. Page on when the bottom of a page is still relevant, or when the user asked for a comprehensive sweep or a literature review — not by reflex. Never lower minScore to make more results appear.',
      '',
      'THEN: having read one paper\'s abstract, redo the expert analysis for THAT paper — re-fit domain and expertRole to what it actually studies, write a query and keywords out of its own subject matter, in the language that paper is written in — and call search_fulltext with its single itemKey. Answer from the stage-1 rows alone when the user only asks which literature is relevant.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Complete natural-language sentence describing the information need as a specialist in the question\'s sub-field would state it, written after you have classified the discipline and worked out the real research intent. Embedded as-is for cross-lingual semantic search, so it must read as prose, not a token list. Include both an English and a Chinese phrasing (separated by " / ") so the embedding covers both.'
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_SUPPLIED_KEYWORDS,
          description: `Lexical probes for the keyword branch, derived from your domain analysis of the question rather than from its wording: the core concepts and mechanism, precise Chinese AND English terms of art, standard technical translations, accepted synonyms, field abbreviations, and closely coupled concepts with a clear professional link to the research intent. For best results, it is recommended to provide 5-12 relevant Chinese and/or English keywords. Fewer or more keywords are still allowed within the implemented input limit of 1 to ${MAX_HYBRID_KEYWORDS} entries. Always supply both scripts regardless of the language the user asked in. Do not pad with generic or weakly related words — keyword coverage is part of the score, so filler actively hurts ranking. All keywords are matched together in one pass over title, abstract, creator, publicationTitle and tags, and ranked by term specificity, field weight and keyword coverage, so a broad word cannot outrank a discriminative phrase. Omitting this makes the server fall back to mechanically splitting the query: it can only probe the language the user typed in, is scored at a lower weight, and the response is flagged with keywordSource "fallback" plus an explicit warning.`
        },
        domain: {
          type: 'string',
          description: 'The discipline and specific sub-field you classified the question into before writing the query, e.g. "materials science / solidification microstructure". Required, together with expertRole, for the call to be recorded as domain-expert retrieval; without both, the response comes back with keywordSource "fallback" and degraded: true even when your keywords were good.'
        },
        expertRole: {
          type: 'string',
          description: 'The expert perspective you adopted for this call, e.g. "solidification processing specialist". Required together with domain.'
        },
        topK: {
          type: 'number',
          description: 'PAGE SIZE: how many documents one response carries. The user configures the real maximum; this can only ask for FEWER. It is a ceiling and never a quota to fill — and it no longer decides how far the ranking goes, because anything past it is reachable through cursor rather than lost.'
        },
        collectionKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict the search to these Zotero collections (keys from get_collections), their subcollections included. The restriction is applied BEFORE scoring: the keyword branch only reads items inside the scope and the vector scan only computes similarity for their chunks, so this is a real reduction in work rather than a filter over whole-library results. Omit it to search everything. SELECTION RULE — include a collection when the user named it, when its subject plainly relates to the question, AND when you cannot tell what it contains: names like "综述", "待读", "课题资料", "论文写作", "New Folder" carry no subject information but routinely hold the most relevant papers, so they belong IN the scope. Exclude only what is plainly unrelated. If most collections are unreadable to you, or the question spans fields, omit this argument and search the whole library. Missing a paper is a worse failure than scanning extra ones.'
        },
        uncertainCollectionKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Of the collectionKeys you passed, which ones you included because you could NOT judge their subject rather than because you judged them relevant. Declaring them changes nothing about the search; it is reported back in metadata so the user can see which parts of the scope were guesses. Leave it out when every choice was a judgement.'
        },
        cursor: {
          type: 'string',
          description: 'Continue a previous hybrid_search: pass the nextCursor it returned, exactly as given. The cursor names one already-ranked, already-threshold-filtered result set, and returns the next page of THAT set — it does not re-run retrieval, so pages cannot duplicate, drop or reorder documents. Send it with query, keywords, domain, expertRole and minScore either unchanged or omitted; changing any of them is a different search and is rejected. Omit cursor to start a new search.'
        },
        minScore: {
          type: 'number',
          description: 'Relevance floor 0-1 applied to the fused score. May only be STRICTER than the user setting; a lower value is raised back to the user threshold. Documents below it are discarded and are never padded back in.'
        },
        language: {
          type: 'string',
          enum: ['zh', 'en', 'all', 'auto'],
          description: 'Semantic branch language filter. Keep the "all" default for genuinely cross-lingual recall; "zh"/"en" restrict the index to that language and "auto" restricts it to the detected query language, both of which drop literature written in the other language. Only set this when the user explicitly asks for one language.'
        },
        rrfK: {
          type: 'number',
          description: 'Rank constant for the Reciprocal Rank Fusion TIE-BREAK (default: 60). Ranking is decided by the fused 0-1 relevance score; RRF only orders candidates whose fused scores are equal, so changing this rarely changes anything.'
        },
        keywordWeight: {
          type: 'number',
          description: 'Non-negative keyword branch weight (default: 1)'
        },
        semanticWeight: {
          type: 'number',
          description: 'Non-negative semantic branch weight (default: 1)'
        },
        libraryID: {
          type: 'number',
          description: 'Zotero library ID used by both keyword and semantic retrieval'
        },
      },
      required: ['query']
    }
  },
  {
    name: 'get_libraries',
    category: 'retrieval',
    description: 'List all Zotero libraries available in the current client. Returns minimal library metadata for each library as a paginated array.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum results to return' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
    },
  },
  {
    name: 'search_library',
    category: 'search',
    description: 'Structured Zotero metadata/field search for explicit title, author, year, item type, or other field constraints. For general literature discovery, use hybrid_search first. Attachment full-text search is not available through this tool. To find standalone PDFs without metadata, use itemType="attachment" with includeAttachments="true".',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        q: { type: 'string', description: 'General search query' },
        title: { type: 'string', description: 'Title search' },
        titleOperator: {
          type: 'string',
          enum: ['contains', 'exact', 'startsWith', 'endsWith', 'regex'],
          description: 'Title search operator'
        },
        yearRange: { type: 'string', description: 'Year range (e.g., "2020-2023")' },
        itemType: {
          type: 'string',
          description: 'Filter by item type (e.g., "attachment" to list standalone files like PDFs imported without metadata, "journalArticle", "book", etc.)'
        },
        includeAttachments: {
          type: 'string',
          enum: ['true', 'false'],
          description: 'Include standalone attachment items (e.g., PDFs without parent item) in results. Must be "true" when itemType is "attachment". Default: false.'
        },
        mode: {
          type: 'string',
          enum: ['minimal', 'preview', 'standard', 'complete'],
          description: 'Processing mode: minimal (30 results), preview (100), standard (adaptive), complete (500+). Uses user default if not specified.'
        },
        relevanceScoring: { type: 'boolean', description: 'Enable relevance scoring' },
        sort: {
          type: 'string',
          enum: ['relevance', 'date', 'title', 'year'],
          description: 'Sort order'
        },
        limit: { type: 'number', description: 'Maximum results to return (overrides mode default)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
    },
  },
  {
    name: 'search_libraries',
    category: 'retrieval',
    description: 'Find a Zotero library by name, when the user names a group library and you need its libraryID for the other tools. Returns [{libraryID, name, libraryType}]. Call get_libraries instead when you want to see everything available.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Library name search query' },
        limit: { type: 'number', description: 'Maximum results to return' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['q'],
    },
  },
  {
    name: 'search_annotations',
    category: 'search',
    description: [
      'SEARCH YOUR OWN MARKS ACROSS THE LIBRARY: PDF highlights, PDF comments, image and ink annotations, and the notes you typed into Zotero. This is your reading, not the literature — quote it verbatim and attribute it to yourself, never to the paper.',
      '',
      'Its counterpart is get_annotations, which reads the marks on documents you already name. Use search_annotations when you do not yet know WHICH document carries the mark: "what did I highlight in yellow about grain refinement", "which papers did I tag as 待验证".',
      '',
      'FILTERS. At least one of q, colors or tags is required — an unfiltered sweep of every mark in the library is not a question. All three compose: q ranks by relevance to the query, colors and tags narrow. Colours are a personal code and yours may differ, but the common convention is yellow=question, red=error/important, green=agree, blue=info, purple=definition. itemKeys narrows to specific documents and accepts SEVERAL of them; every key you pass is searched.',
      '',
      'RANKING AND PAGING. Every mark matching your filters is scored and ranked before anything is returned, then one page is served. Ranking used to run over an arbitrary first 100 candidates, which silently discarded the best match whenever a library held more than that; it no longer does. The response carries pagination with total, offset, limit, hasMore and nextOffset. Page on only while the marks are still answering the question.',
      '',
      'CONTINUING FROM A HIT. Every row carries three distinct keys, and only one of them is a document key. sourceItemKey IS THE DOCUMENT: pass it to get_annotations(itemKeys) to read that paper’s other marks, to get_item_details for the citation, or to search_fulltext / get_document_chunks to go into the body. attachmentKey is the PDF the mark sits on; annotationKey is the mark itself, accepted by get_annotations(annotationIds). Neither of those two works as an item key anywhere, and the document-level tools now refuse them by name rather than returning something plausible.',
      '',
      'sourceItemKey IS NULL when the mark has no document above it — a top-level note the user wrote, or a mark on an attachment filed under nothing. noSourceItemReason then says which. There is nothing to follow up in that case; the row is complete on its own. It is never filled in with a substitute key, because every substitute is one the document-level tools reject silently.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        q: { type: 'string', description: 'Search query (optional if colors or tags provided)' },
        itemKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit the search to these documents. DOCUMENT keys (a mark’s sourceItemKey), not attachment keys. ALL of them are searched, not just the first.'
        },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['note', 'highlight', 'annotation', 'ink', 'text', 'image']
          },
          description: 'Which kinds of mark to search. "note" is a note you typed in Zotero (standalone or attached to an item); "highlight", "ink", "text" and "image" are PDF annotations; "annotation" means any PDF annotation. Defaults to note + highlight + annotation.'
        },
        colors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by colors. Use hex codes (#ffd400) or names (yellow, red, green, blue, purple, orange). Common mappings: yellow=question, red=error/important, green=agree, blue=info, purple=definition'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags attached to annotations'
        },
        detail: {
          type: 'string',
          enum: ['minimal', 'preview', 'standard', 'complete'],
          description: 'How much of each mark to return: minimal (identity and a few words), preview (a short excerpt), standard (the mark and its comment — the default), complete (verbatim text with no compression). Uses the user setting when omitted. "mode" is accepted as a synonym.'
        },
        maxTokens: {
          type: 'number',
          description: 'Token budget for the page (uses user setting default if not specified). Marks are compressed to fit it; raise detail to complete to stop that.'
        },
        minRelevance: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.1,
          description: 'Minimum relevance threshold (only applies when q is provided)'
        },
        limit: { type: 'number', description: 'Marks per page (default 15, maximum 100).' },
        offset: { type: 'number', default: 0, description: 'Pagination offset. Pass the nextOffset from the previous response to continue.' }
      },
      description: 'Requires at least one of: q (query), colors, or tags'
    },
  },
  {
    name: 'get_item_details',
    category: 'retrieval',
    description: [
      'BIBLIOGRAPHIC METADATA for one item. This is the citation tool: everything you need to cite a paper correctly and to see how it sits in the library.',
      '',
      'RETURNS: title, creators (with roles), date and year, item type, publication title, volume, issue, pages, DOI, ISSN/ISBN, URL, language, publisher, tags, the collections the item belongs to (with their paths), and one row per attachment — key, filename, content type, size, and whether its text can be read.',
      '',
      'DOES NOT RETURN CONTENT, by design. No abstract text, no note bodies, no annotation text, no PDF text, no chunks. Every one of those has a tool that returns it on purpose and pages it properly: get_item_abstract for the abstract, get_annotations for your notes and highlights, get_attachment_text for an attachment, get_document_chunks for the indexed body. Returning them here made a metadata lookup silently ship a whole paper, so it no longer does. What you get instead is availability: hasAbstract and abstractChars tell you what get_item_abstract would return without returning it.',
      '',
      'FULL-TEXT STATUS. fullText reports what the semantic index actually holds for this document, on the same five-value scale every search result uses: indexed (real body text), parse_failed (a PDF or Markdown exists but could not be parsed), no_source (no text-bearing attachment at all), not_indexed (has a source but is not in the index yet), unknown (indexed before this was recorded). This replaces the old per-attachment hasFulltext boolean, which only looked at the file extension and therefore claimed full text for PDFs that had never parsed. The per-attachment hasExtractableText flag is still there, but it means "this file type could yield text", not "we have its text".',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        itemKey: { type: 'string', description: 'Unique item key' },
        mode: {
          type: 'string',
          enum: ['minimal', 'standard', 'complete'],
          description: 'How much metadata to return: minimal (identity only: key, title, creators, year, item type), standard (the citation fields plus tags and attachment rows — the default), complete (standard plus collections, identifiers and every populated Zotero field). No mode returns content of any kind. Uses the user default when omitted; "preview" is accepted as a synonym for "standard" for older callers.'
        },
      },
      required: ['itemKey'],
    },
  },
  {
    name: 'get_annotations',
    category: 'retrieval',
    description: [
      'READ YOUR OWN MARKS ON DOCUMENTS YOU ALREADY NAME: PDF highlights, PDF comments, image and ink annotations, and the notes you typed into Zotero for those items.',
      '',
      'THIS IS THE TOOL FOR NOTE BODIES. Notes are not returned by get_item_details or by any content tool any more; they come from here, alongside the highlights, because they are the same kind of thing — what YOU wrote about the paper. Everything this returns is your own reading, so quote it verbatim and never attribute it to the paper itself.',
      '',
      'NAMING WHAT TO READ. Pass exactly one of: itemKeys (one or MANY documents — all of them are read, which is what makes "compare my marks across these five papers" a single call), itemKey (one document, kept for convenience), annotationId, or annotationIds. Its counterpart is search_annotations, which finds marks when you do NOT know which document carries them.',
      '',
      'PAGING. A well-read PDF holds hundreds of highlights, so results are always paged: the response carries pagination with total, offset, limit, hasMore and nextOffset, and each row carries the sourceItemKey it came from so marks stay attributable when you read several documents at once. There is no way to demand every mark in one response — page on only while they are still answering the question.',
      '',
      'KEYS ON A ROW. sourceItemKey is the document and is exactly what itemKeys expects, so a mark found by search_annotations can be followed straight back here. attachmentKey (the PDF) and annotationKey (the mark) are reported too, and neither is an item key. sourceItemKey is null, with noSourceItemReason set, for a top-level note or a mark on an unfiled attachment — there is no document to follow up to.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        itemKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Read the marks on these documents. DOCUMENT keys, not attachment keys: use the sourceItemKey of a search_annotations hit, never its attachmentKey. ALL of them are read, not just the first; every returned row names the sourceItemKey it came from.'
        },
        itemKey: { type: 'string', description: 'Read the marks on this one document. Shorthand for itemKeys with a single entry.' },
        annotationId: { type: 'string', description: 'Read one specific annotation by ID' },
        annotationIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Read specific annotations by ID'
        },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['note', 'highlight', 'annotation', 'ink', 'text', 'image']
          },
          default: ['note', 'highlight', 'annotation'],
          description: 'Which kinds of mark to include. "note" is a note you typed in Zotero; "highlight", "ink", "text" and "image" are PDF annotations; "annotation" means any PDF annotation. Pass ["note"] to read only your written notes.'
        },
        colors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by colors. Use hex codes (#ffd400) or names (yellow, red, green, blue, purple, orange). Example: ["yellow", "red"] to get question and error annotations'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags attached to annotations'
        },
        detail: {
          type: 'string',
          enum: ['minimal', 'preview', 'standard', 'complete'],
          description: 'How much of each mark to return: minimal (identity and a few words), preview (a short excerpt), standard (the mark and its comment — the default), complete (verbatim text with no compression). Uses the user setting when omitted. "mode" is accepted as a synonym.'
        },
        maxTokens: {
          type: 'number',
          description: 'Token budget for the page (uses user setting default if not specified). Marks are compressed to fit it; raise detail to complete to stop that.'
        },
        limit: { type: 'number', description: 'Marks per page (default 20, maximum 100).' },
        offset: { type: 'number', default: 0, description: 'Pagination offset. Pass the nextOffset from the previous response to continue.' }
      },
      description: 'Requires one of: itemKeys, itemKey, annotationId, or annotationIds'
    },
  },
  {
    name: 'get_attachment_text',
    category: 'retrieval',
    description: [
      'Read the TEXT OF ONE ATTACHMENT of one Zotero item — a PDF, a Markdown/HTML/plain-text file — and nothing else.',
      '',
      'This tool returns attachment text only. It does NOT return the abstract, your notes, your annotations, or a merged bundle of all of them. Those have their own tools: get_item_abstract for the abstract, get_annotations for your own notes and highlights. It is also NOT a search tool: it cannot find which document to read. Locate the document with hybrid_search / keyword_search first, and search inside it with search_fulltext.',
      '',
      'CHOOSING THE ATTACHMENT. Call with itemKey alone and you get the item\'s attachment list — key, filename, content type, size, whether text can be extracted — and no text. Then call again with the attachmentKey you want. When the item has exactly one text-bearing attachment it is selected automatically and its text is returned on the first call, with selectedAutomatically: true saying so.',
      '',
      'WHERE THE TEXT CAME FROM. Every response names its source in textSource.method, because the same PDF yields materially different text depending on which path produced it: doc2x (Doc2X Markdown, best structure), mineru_cache (a MinerU/Doc2X Markdown that already existed — no parsing), mineru (parsed by MinerU during this call), markdown_attachment (a Markdown file attached to the item), zotero_fulltext_cache (Zotero\'s own extracted text index — flat, no layout), html_parsing, text_reading. When no text could be produced, method says why: mineru_disabled, mineru_on_demand_disabled, mineru_failed, mineru_error, no_text. Never present zotero_fulltext_cache output as though it preserved tables or headings.',
      '',
      'PAGING. Text is returned in character windows, never all at once. The response carries totalChars, offset, returnedChars, hasMore and nextOffset; pass nextOffset back as offset to continue. Windows are cut at a paragraph or sentence boundary where one is nearby, so a window does not end mid-word. Read on only while the text is still answering the question.',
      '',
      'For ordered reading of a paper\'s BODY as the semantic index stored it — with stable chunk numbers you can hand to search_fulltext or find_similar — prefer get_document_chunks. Use this tool when you need the attachment as it was extracted, or when the attachment is not in the semantic index at all.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        itemKey: {
          type: 'string',
          description: 'The Zotero item whose attachment you want to read. Required.'
        },
        attachmentKey: {
          type: 'string',
          description: 'Which attachment of that item to read. Omit to list the item\'s attachments instead of reading one; omitting it is also fine when the item has exactly one text-bearing attachment, which is then selected automatically.'
        },
        offset: {
          type: 'number',
          minimum: 0,
          description: 'Character offset to start reading from (default: 0). Pass the nextOffset from the previous response to continue.'
        },
        limit: {
          type: 'number',
          minimum: 1,
          description: `Characters to return in this window (default: ${DEFAULT_ATTACHMENT_TEXT_WINDOW}, maximum: ${MAX_ATTACHMENT_TEXT_WINDOW}).`
        },
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
      },
      required: ['itemKey'],
    },
  },
  {
    name: 'get_collections',
    category: 'collections',
    description: 'List collections as a flat, paginated page: top-level ones by default, or the direct children of parentCollection. The response is { results, pagination, metadata } - pagination carries total, offset, limit, hasMore and nextOffset, so a short page is distinguishable from the last page. There is no recursive option: to see what a subtree holds, browse it with get_collection_items, which reports directItemCount, totalItemCount and hasChildren per folder.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        mode: {
          type: 'string',
          enum: ['minimal', 'preview', 'standard', 'complete'],
          description: 'Processing mode: minimal (20 collections), preview (50), standard (100), complete (500+). Uses user default if not specified.'
        },
        limit: { type: 'number', description: 'Maximum results to return (overrides mode default).' },
        offset: { type: 'number', description: 'Pagination offset. Continue from pagination.nextOffset.' },
        parentCollection: {
          type: 'string',
          description: 'Key of a parent collection. When provided, returns direct children of that collection instead of top-level collections.'
        },
      },
    },
  },
  {
    name: 'search_collections',
    category: 'collections',
    description: 'Find collections whose name matches a query, when the user refers to a folder by name and you need its collectionKey. Returns identity and path, not contents — open a match with get_collection_items, or pass its key to hybrid_search as collectionKeys to scope a search.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        q: { type: 'string', description: 'Collection name search query' },
        limit: { type: 'number', description: 'Maximum results to return' },
      },
    },
  },
  {
    name: 'get_collection_details',
    category: 'collections',
    description: 'Metadata about ONE collection: its name, its parent, how many items and subcollections it holds. It does not list them — use get_collection_items to see what is inside.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionKey: { type: 'string', description: 'Collection key' },
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
      },
      required: ['collectionKey'],
    },
  },
  {
    name: 'get_collection_items',
    category: 'collections',
    description: [
      'BROWSE THE LIBRARY ONE LEVEL AT A TIME, like opening folders in a file manager. Each call shows you the subfolders of where you are, plus the documents filed directly at that level — never the whole tree.',
      '',
      'START AT THE TOP by calling with no collectionKey and no path: you get the library root, its top-level collections, and any documents sitting outside every collection. Then descend by passing the collectionKey of the subfolder you want to open. Every response repeats the current location (libraryID, collectionKey, name, path) and the parent you came from, so you can always walk back up.',
      '',
      'READING THE SUBFOLDER ROWS. Each subcollection carries collectionKey, name, directItemCount (documents filed at that level), totalItemCount (that level plus everything nested below it) and hasChildren. Those three numbers are how you decide where to descend without opening anything: a folder whose directItemCount is 0 but whose totalItemCount is 300 is a container, not a dead end. Descending is one call per level, on purpose — the old habit of pulling the whole nested tree in one response is what this replaces.',
      '',
      'THE DOCUMENT ROWS ARE DELIBERATELY THIN: itemKey, title, creators, year, publication title, DOI, item type. No abstracts, no notes, no annotations, no attachment text, no chunks. This is a directory listing, so it must stay cheap enough to walk. When a document looks worth pursuing, take its itemKey to get_item_details, get_item_abstract or search_fulltext.',
      '',
      'PAGING applies to the documents at the current level (subfolders are always returned in full, since a level has few of them). itemPagination carries total, offset, limit, hasMore and nextOffset. A large folder is several pages.',
      '',
      'THIS IS NAVIGATION, NOT SEARCH. If the user is looking for literature ON A TOPIC, use hybrid_search — optionally scoped with collectionKeys, which is what get_collections is for. Browse when the question is about the SHAPE of the library: what is in this folder, how is this project organised, which folders exist.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        collectionKey: {
          type: 'string',
          description: 'The folder to open. Omit it (with no path) to list the top level of the library. This is the stable identifier and the one to prefer; every response returns the collectionKey of everything it lists, so descending never requires a name lookup.'
        },
        path: {
          type: 'string',
          description: 'Convenience alternative to collectionKey: a slash-separated folder path such as "Materials/Solidification/CET", optionally prefixed with the library name. Resolved to a collectionKey, which is what comes back. If the path is ambiguous — two sibling folders with the same name — the call fails and lists the candidate collectionKeys so you can pick one; it never guesses. Ignored when collectionKey is given.'
        },
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        limit: { type: 'number', description: 'Documents per page at the current level (default 50, maximum 200). Does not affect the subfolder list.' },
        offset: { type: 'number', description: 'Pagination offset for the documents at the current level. Pass the nextOffset from the previous response to continue.' },
      },
      required: [],
    },
  },
  // get_subcollections used to live here. It was `get_collections` with the
  // parameters renamed: `collectionKey` meant `parentCollection`, and both
  // ended in the same handler with the same recursive walk. Two names for one
  // behaviour is two things a caller has to learn and two places a change has
  // to land, so the duplicate is gone and get_collections does the job.
  {
    name: 'create_collection',
    category: 'write',
    description: 'Create a new collection in the library. Optionally nest it under a parent collection.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        name: { type: 'string', description: 'Name of the new collection' },
        parentCollection: {
          type: 'string',
          description: 'Key of the parent collection. If omitted, creates a top-level collection.'
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_collection',
    category: 'write',
    description: 'Rename or move an existing collection. Provide name to rename, parentCollection to move (empty string moves to top level).',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        collectionKey: { type: 'string', description: 'Key of the collection to update' },
        name: { type: 'string', description: 'New name for the collection' },
        parentCollection: {
          type: 'string',
          description: 'Key of the new parent collection. Use empty string "" to move to top level.'
        },
      },
      required: ['collectionKey'],
    },
  },
  {
    name: 'delete_collection',
    category: 'write',
    description: 'Delete a collection. WARNING: This is a destructive operation. By default, items in the collection are NOT deleted (only removed from the collection). Set deleteItems=true to also send items to trash.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        collectionKey: { type: 'string', description: 'Key of the collection to delete' },
        deleteItems: {
          type: 'boolean',
          description: 'If true, also send items in the collection to trash. Default: false (items remain in library).'
        },
      },
      required: ['collectionKey'],
    },
  },
  {
    name: 'add_items_to_collection',
    category: 'write',
    description: 'Add one or more items to a collection by their item keys.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        collectionKey: { type: 'string', description: 'Key of the target collection' },
        itemKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of item keys to add to the collection'
        },
      },
      required: ['collectionKey', 'itemKeys'],
    },
  },
  {
    name: 'remove_items_from_collection',
    category: 'write',
    description: 'Remove one or more items from a collection. Items are NOT deleted from the library, only removed from this collection.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        collectionKey: { type: 'string', description: 'Key of the collection' },
        itemKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of item keys to remove from the collection'
        },
      },
      required: ['collectionKey', 'itemKeys'],
    },
  },
  {
    name: 'search_fulltext',
    category: 'semantic',
    description: [
      'SECOND-STAGE retrieval: a hybrid search inside the full text of ONE document located by hybrid_search. Same machinery as hybrid_search - keyword matching plus vector semantic retrieval over the same index, fused into the same normalized 0-1 relevance score, filtered by the same user threshold - except the candidates are the passages (chunks) of a single paper instead of the whole library.',
      '',
      "Call it once per document, with that document's own itemKey.",
      '',
      'BEFORE you write the arguments, redo the expert analysis FOR THIS PAPER. Do not reuse the library-level query and keywords: they were written for the user question in general, and they will retrieve the same generic passages from every paper.',
      'A. Get this paper\'s abstract first, with get_item_abstract on its itemKey — hybrid_search does not return abstracts. Read it together with the hit evidence hybrid_search gave you for this paper.',
      "B. Re-judge the field from \"user question + this paper's title + its abstract + its evidence\", and adopt the expert role that THIS paper belongs to. Expect it to be narrower or simply different from the stage-1 pair, and pass the re-fitted values in domain and expertRole.",
      'C. Identify what is particular to THIS paper: its study object, material or sample system, experimental or computational method, the variables it manipulates and measures, the mechanism it argues for, and its own terminology and abbreviations.',
      'D. Write query and keywords out of THAT: a natural-language sentence about what you need from this paper, and probes in this paper\'s own vocabulary and terms of art.',
      'E. Write those keywords in the LANGUAGE THIS PAPER IS WRITTEN IN — one language, not both. Library-wide search is bilingual because the library is; this search is not, because a single document is not. Chinese probes cannot match an English paper\'s passages and vice versa: they match nothing and only dilute keyword coverage. hybrid_search reports each candidate\'s language, and the abstract confirms it. Only a genuinely mixed-language document takes mixed probes.',
      '',
      'CONTEXT EXPANSION: read the returned passages first and stop when the evidence is sufficient. Only when a passage is clearly missing its cause, its consequence, its experimental conditions or its mechanism context, call this tool again with chunkIds set to the chunkId(s) of that passage - it then returns those passages plus their immediate neighbours in reading order, within the radius the user allows. Never request neighbours by default and never ask for the whole document.',
      '',
      "Result counts are capped by the user's preferences and the relevance threshold is a floor you cannot lower. Passages below it are discarded; the cap is a ceiling, not a quota, so a document with only one good passage returns one passage.",
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        itemKey: {
          type: 'string',
          description: 'The single item key to dig into, taken from a hybrid_search candidate row whose abstract you have already read with get_item_abstract.'
        },
        query: {
          type: 'string',
          description: 'Natural-language sentence describing what you need FROM THIS PAPER, written after re-judging the field from the user question plus this paper\'s abstract (fetched with get_item_abstract) and its stage-1 evidence. Embedded as-is for semantic retrieval over this paper\'s passages, so write prose, not tokens, and write it in the language this paper is written in. Required unless chunkIds is used.'
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_SUPPLIED_KEYWORDS,
          description: `Probes specific to THIS paper: its study object, material system, method, variables, mechanism terms and its own abbreviations. Write them in the LANGUAGE THIS PAPER IS WRITTEN IN - one language, not both: this searches inside a single document, so probes in the other language match nothing and only dilute keyword coverage. hybrid_search reports each candidate's language and the abstract confirms it. Do not copy the library-level bilingual keyword set. 1 to ${MAX_HYBRID_KEYWORDS} entries; around 5-12 is recommended. Omitting them makes the server fall back to mechanically splitting the query and flags the result as keywordSource "fallback".`
        },
        domain: {
          type: 'string',
          description: 'The discipline and sub-field THIS paper belongs to, as you judged it from the question plus this paper\'s abstract and evidence. Re-fit it to this paper instead of repeating the library-level domain; it is normal for it to come out narrower or simply different. Required, together with expertRole, for the call to count as domain-expert retrieval.'
        },
        expertRole: {
          type: 'string',
          description: 'The specialist perspective you adopted for this paper, e.g. "solidification microstructure specialist". Required, together with domain, for the call to count as domain-expert retrieval.'
        },
        chunkIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'CONTEXT EXPANSION mode. The chunkId(s) of passages that lack surrounding context. Returns those passages plus their neighbours within the user-configured radius, in reading order, and performs no ranking. Use only after reading the search results and finding a specific gap.'
        },
        neighborRadius: {
          type: 'number',
          description: 'How many chunks either side to include in context expansion. Capped by the user setting; ask for less, never more.'
        },
        maxChunks: {
          type: 'number',
          description: 'Upper bound on returned passages. Capped by the user setting. Only lowers the cap; it can never raise it, and it never pads weak passages in to reach a count.'
        },
        minScore: {
          type: 'number',
          description: 'Relevance floor 0-1 for the fused score. May only be stricter than the user setting; a lower value is raised back to it.'
        },
      },
      required: ['itemKey'],
    },
  },
  {
    name: 'get_item_abstract',
    category: 'retrieval',
    description: [
      "Get ONE item's abstract - the author's own summary from the original publication.",
      '',
      'This is the on-demand middle step of the retrieval funnel, and it is deliberately not part of what hybrid_search returns. Call it for a candidate you are seriously considering going deeper on, one itemKey at a time. Do NOT sweep it across a result set: if 3 of 20 candidates look worth pursuing, you fetch 3 abstracts. When a candidate row already shows a paper is off-topic, decide that from the row and never fetch its abstract at all.',
      '',
      'What to do with what comes back: read it together with the user question, the title and the hit evidence hybrid_search gave for this paper, then re-fit domain and expertRole to what THIS paper actually studies, and derive a query and keywords from its own subject matter - in the language the paper is written in - for a search_fulltext call on that single itemKey.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        itemKey: { type: 'string', description: 'Item key' },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Response format (default: json)'
        },
      },
      required: ['itemKey'],
    },
  },
  // Retrieval - one page of ranked candidate rows. All three search tools
  // return the SAME row shape, so a caller learns it once.
  {
    name: 'keyword_search',
    category: 'semantic',
    description: [
      'LEXICAL-ONLY retrieval over Zotero metadata: title, abstract, creators, publication title and tags. No embeddings are involved, nothing is scored semantically, and document body text is not scanned.',
      '',
      'WHEN TO USE IT. Two cases, and they are the only two.',
      '1. The user named something exact - a term of art, an author, an abbreviation, a compound, a standard number - and you want every document that literally contains it, including ones a semantic query would rank low.',
      '2. COARSE FILTER before a fine search. Run keyword_search to reduce the library to a defensible shortlist, take the itemKeys it returned, and pass them to semantic_search as itemKeys. The semantic pass then scores only that shortlist. This is the cheap way to ask a conceptual question of a precisely delimited subset.',
      'For ordinary literature discovery, hybrid_search is still the default first step - it runs this branch AND the semantic branch and fuses them, so calling both separately is strictly more work for a worse ranking.',
      '',
      'KEYWORDS ARE THE WHOLE INPUT. Pass the terms a specialist in the sub-field would actually search on, covering BOTH Chinese and English: core concepts, mechanism and governing variables, standard technical translations, accepted synonyms, the abbreviations of the field. The library is bilingual and this tool searches all of it, so restricting yourself to the language the user typed in silently halves recall. Around 5-12 keywords is the recommendation; 1 to \' + String(MAX_HYBRID_KEYWORDS) + \' is accepted. Do not pad the list - every keyword must be defensible as a term of art, because generic words dilute the coverage score and push the right papers down.',
      '',
      'SCORING. Each keyword is matched in a single pass over the candidate records, then scored by term specificity, field weight and how many DISTINCT keywords a record matched, and normalised to the same 0-1 scale every other relevance score in this plugin uses. The relevance threshold set by the user is applied before paging, exactly as in hybrid_search.',
      '',
      'WHAT YOU GET BACK. The same lightweight candidate row hybrid_search returns - itemKey, title, creators, year, venue, language, score, which keywords matched which fields, whether an abstract exists, and fullText (whether that document has indexed body text). Abstracts are not shipped back; fetch one with get_item_abstract for a paper worth pursuing.',
      '',
      'PAGING. topK is the page size, not the depth of the search. Use pagination.nextCursor with every other argument unchanged to window further down the SAME ranking.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_HYBRID_KEYWORDS,
          description: `The bilingual domain terms to match. Required when starting a new search; omit when following a cursor. 1 to ${MAX_HYBRID_KEYWORDS} entries, about 5-12 recommended.`
        },
        query: {
          type: 'string',
          description: 'Optional. Only used to derive fallback probes when keywords is omitted, which is a degraded path reported as keywordSource "fallback". It is never embedded - this tool has no semantic branch.'
        },
        domain: {
          type: 'string',
          description: 'The discipline and sub-field you classified the question into. Declaring it (with expertRole) is what lets the call be recorded as domain-expert retrieval rather than mechanical tokenisation.'
        },
        expertRole: {
          type: 'string',
          description: 'The specialist perspective you adopted when deriving the keywords.'
        },
        collectionKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict the search to these collections and their subcollections. Resolved to item keys BEFORE scoring, so it removes work rather than filtering results afterwards. Read the real folder names with get_collections first; include anything whose subject you cannot determine, because personal folder names carry no subject information and often hold the papers that matter.'
        },
        itemKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict the search to these specific documents. This is the coarse-filter-then-fine-search path: run keyword_search first, take the itemKeys it returned, and pass them here so the semantic pass only scores that shortlist. Combined with collectionKeys, the two scopes intersect.'
        },
        topK: {
          type: 'number',
          description: 'Page size: documents per response, capped by the user setting. A ceiling, never a target - anything past it is reachable with cursor, not lost.'
        },
        cursor: {
          type: 'string',
          description: 'Continue a previous keyword_search by passing the nextCursor it returned. Windows the SAME ranking without re-running retrieval. Send the other arguments unchanged or omitted; changing them is a new search and is rejected.'
        },
        minScore: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Relevance floor 0-1. May only be STRICTER than the user setting; a lower value is raised back to it.'
        },
        libraryID: {
          type: 'number',
          description: 'Zotero library ID (default: user library)'
        },
      },
      required: []
    }
  },
  {
    name: 'semantic_search',
    category: 'semantic',
    description: [
      'PURE EMBEDDING-SIMILARITY retrieval. One natural-language query is embedded and compared against every indexed passage; no keyword matching takes part at any point.',
      '',
      'WHEN TO USE IT. hybrid_search is the default first step for literature discovery and you should reach for it first - it runs the semantic branch AND the lexical branch and fuses them. Use semantic_search when the lexical branch would only add noise:',
      '1. The user is asking about a CONCEPT or MECHANISM whose vocabulary you cannot pin down - where the right papers may share no surface term with the question.',
      '2. FINE SEARCH after a coarse filter. Run keyword_search first, take its itemKeys, pass them here, and the semantic pass scores only that shortlist.',
      '3. The user explicitly asked for semantic-only retrieval.',
      '',
      'THE QUERY IS THE WHOLE INPUT. Write ONE complete natural-language sentence stating the real research intent as an expert in that sub-field would state it. It is embedded verbatim, so do not reduce it to loose tokens. Writing an English phrasing followed by " / " and the Chinese phrasing is recommended, so the embedding sees both surface forms - retrieval is cross-lingual and the library is bilingual.',
      '',
      'SCORING AND PAGING now match hybrid_search exactly. Passage similarities are aggregated to ONE score per document on the same 0-1 scale; the relevance threshold set by the user is applied BEFORE paging, so no page can contain a document below it and a short final page is never padded; topK is the size of one page. The response carries appliedMinScore, totalRelevant, returned, hasMore and nextCursor - pass nextCursor back as cursor with everything else unchanged to window the SAME ranking rather than searching again.',
      '',
      'WHAT YOU GET BACK. The same lightweight candidate row hybrid_search returns, including fullText - whether that document actually has indexed body text, or whether it was indexed from title and abstract alone. Read fullText before you read the evidence snippets: for a document that is not "indexed", the snippets ARE its title and abstract, not passages from the paper. Abstracts are not shipped back; fetch one with get_item_abstract only for a candidate worth pursuing.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'One complete natural-language sentence describing the information need, embedded as-is for cross-lingual semantic search. Required when starting a new search; omit when following a cursor.'
        },
        domain: {
          type: 'string',
          description: 'The discipline and sub-field you classified the question into.'
        },
        expertRole: {
          type: 'string',
          description: 'The specialist perspective you adopted when writing the query.'
        },
        collectionKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict the search to these collections and their subcollections. Resolved to item keys BEFORE scoring, so it removes work rather than filtering results afterwards. Read the real folder names with get_collections first; include anything whose subject you cannot determine, because personal folder names carry no subject information and often hold the papers that matter.'
        },
        itemKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict the search to these specific documents. This is the coarse-filter-then-fine-search path: run keyword_search first, take the itemKeys it returned, and pass them here so the semantic pass only scores that shortlist. Combined with collectionKeys, the two scopes intersect.'
        },
        topK: {
          type: 'number',
          description: 'Page size: documents per response, capped by the user setting. A ceiling, never a target.'
        },
        cursor: {
          type: 'string',
          description: 'Continue a previous semantic_search by passing the nextCursor it returned. Windows the SAME ranking without re-running retrieval. Send the other arguments unchanged or omitted; changing them is a new search and is rejected.'
        },
        minScore: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Relevance floor 0-1. May only be STRICTER than the user setting; a lower value is raised back to it.'
        },
        language: {
          type: 'string',
          enum: ['zh', 'en', 'all', 'auto'],
          description: 'Keep the "all" default so retrieval stays genuinely cross-lingual; zh/en/auto drop literature written in the other language.'
        },
        libraryID: {
          type: 'number',
          description: 'Zotero library ID (default: user library)'
        },
      },
      required: []
    }
  },
  {
    name: 'find_similar',
    category: 'semantic',
    description: [
      'Find DOCUMENTS in the library that are semantically similar to ONE paper you already have, using several of that paper\'s own passages as the query. Purely semantic: no keywords are involved at any point.',
      '',
      'THE CALL CHAIN, in order. You must do step 1 yourself; this tool does 2-5.',
      '1. YOU pick the representative chunks. Run search_fulltext on the paper you are expanding from and read the passages it returns. Choose the ones that actually characterise the paper for YOUR task — its method, its mechanism, its material system, its findings, or whichever facets matter — and note their chunkId values. This tool does not and cannot judge which passages are representative; that judgement is the part only you can make, and it decides the quality of everything below.',
      '2. Full-index semantic scan with every chunk you passed, as separate query vectors. Their stored vectors are reused directly, so nothing is re-embedded.',
      '3. The query paper itself is excluded from its own results.',
      '4. DOCUMENT-LEVEL aggregation. Chunk scores are folded into ONE score per candidate document: for each of your query chunks, the candidate\'s two best-matching passages are averaged, then those per-chunk-query scores are combined (mostly their mean, plus a smaller weight on the strongest one). A paper therefore scores high by relating to SEVERAL of the facets you supplied, not by owning one lucky passage. The result is on the same 0-1 scale as every other relevance score in this plugin.',
      '5. The user\'s relevance threshold is applied to those document scores, and EVERY document above it is ranked and paged - there is no cap on how many papers may qualify.',
      '',
      'PAGING: 20 documents per page, ordered best first. When hasMore is true, call again with cursor set to nextCursor and nothing else changed; that replays the stored ranking instead of re-scanning the library. Decide as you page whether to keep going or to stop and dig into a promising candidate with get_item_abstract and search_fulltext.',
      '',
      'WHAT COMES BACK: identity, score, the chunkIds that carried the score, and fullText — whether that document has body text in the index, one of: indexed, parse_failed, no_source, not_indexed, unknown. No passage text. To read a candidate, call search_fulltext on its itemKey; a row whose fullText is "parse_failed", "no_source" or "not_indexed" holds only title and abstract and will be refused there, and one that is "unknown" predates the record so its passages are unverified.',
      '',
      'Pass chunks from ONE document only. chunkIds are numbered within their own document, so ids from another paper either fail to resolve or would silently mean different passages.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        itemKey: {
          type: 'string',
          description: 'The paper the query chunks are taken from. It is excluded from its own results. Required when starting a new search; omit it when following a cursor.'
        },
        chunkIds: {
          type: 'array',
          items: { type: 'number' },
          minItems: 1,
          maxItems: MAX_SIMILAR_QUERY_CHUNKS,
          description: `The chunkIds of the passages of THAT paper you judged representative, taken from a search_fulltext call on it. How many to pass is your call — enough to cover the facets you care about. Every id must belong to itemKey; ids from another document are rejected. Hard maximum ${MAX_SIMILAR_QUERY_CHUNKS}, because each additional chunk re-scores the entire index. Required when starting a new search.`
        },
        libraryID: {
          type: 'number',
          description: 'Zotero library ID (default: user library)'
        },
        minScore: {
          type: 'number',
          description: 'Document-level relevance floor 0-1. May only be STRICTER than the user setting; a lower value is raised back to it.'
        },
        topK: {
          type: 'number',
          description: 'Page size. Capped by the user\'s maximum (20); it only lowers the page size and never the number of qualifying documents, which is unlimited.'
        },
        cursor: {
          type: 'string',
          description: 'Continue a previous find_similar. Pass nextCursor exactly as returned; the stored ranking is replayed with no new scan. Do not change itemKey, chunkIds or minScore while paging.'
        }
      },
      required: []
    }
  },
  {
    name: 'semantic_status',
    category: 'semantic',
    description: 'Get the status of the semantic search service including index statistics.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // Ordered reading of one document's indexed body
  {
    name: 'get_document_chunks',
    category: 'semantic',
    description: [
      'Read ONE paper\'s body straight through, in the order the semantic index stored it, one page of chunks at a time.',
      '',
      'This is the reading tool, not a search tool. search_fulltext answers "where in this paper does it say X" and returns the few best-matching passages; get_document_chunks answers "let me read this paper" and returns consecutive passages from wherever you left off. Use it once search_fulltext has shown you the paper is worth reading in full, or when the question is about the argument as a whole rather than about one fact in it.',
      '',
      'CHUNK NUMBERING. Every chunk carries chunkIndex (its 0-based position in reading order) and chunkId (the stable id the index assigned it). chunkId is the one to hand to search_fulltext\'s chunkIds for neighbour context, or to find_similar as a representative passage. The two coincide for a cleanly indexed document and diverge where chunks were dropped, so never compute one from the other.',
      '',
      `PAGING IS MANDATORY. A page is at most ${MAX_DOCUMENT_CHUNKS_PER_PAGE} chunks; there is no way to ask for the whole document in one response, deliberately. The response carries totalChunks, returned, offset, range, hasMore and nextCursor. Pass nextCursor back as cursor with nothing else changed to continue. Stop when the text stops answering the question — a long paper is many pages and reading all of them by reflex is the failure this tool is shaped to prevent.`,
      '',
      'REQUIRES AN INDEXED BODY. A document whose PDF never parsed, or which has no text attachment at all, holds only its title and abstract in the index; this tool refuses it and says which of those two it is rather than handing back the abstract dressed up as body text. Candidate rows from hybrid_search / keyword_search carry the same status in their fullText field, so check it there before calling.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        itemKey: {
          type: 'string',
          description: 'The document to read. Required when starting; omit it when following a cursor.'
        },
        cursor: {
          type: 'string',
          description: 'Continue reading where the previous call stopped. Pass nextCursor exactly as returned and change nothing else.'
        },
        offset: {
          type: 'number',
          minimum: 0,
          description: 'Start at this chunkIndex instead of the beginning (default: 0). Use it to jump; use cursor to continue.'
        },
        limit: {
          type: 'number',
          minimum: 1,
          description: `Chunks per page (default: ${DEFAULT_DOCUMENT_CHUNKS_PER_PAGE}, maximum: ${MAX_DOCUMENT_CHUNKS_PER_PAGE}).`
        },
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
      },
      required: [],
    },
  },
  // Write Tools
  {
    name: 'write_note',
    category: 'write',
    description: 'Create or modify Zotero notes. Supports child notes (attached to items), standalone notes, updating, or appending. Markdown is auto-converted to HTML. Confirm with user before writing.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        action: {
          type: 'string',
          enum: ['create', 'update', 'append'],
          description: 'create: new note, update: replace content, append: add to end'
        },
        parentKey: {
          type: 'string',
          description: 'Item key to attach note to (create action only, omit for standalone note)'
        },
        noteKey: {
          type: 'string',
          description: 'Existing note key (required for update/append actions)'
        },
        content: {
          type: 'string',
          description: 'Note content in HTML or Markdown format. Markdown is auto-converted to HTML for Zotero storage.'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to add to the note'
        }
      },
      required: ['action', 'content']
    }
  },
  {
    name: 'write_tag',
    category: 'write',
    description: 'Add, remove, or replace tags on Zotero items. Works on any item type. Response includes before/after tag lists for verification. Confirm with user before executing.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        action: {
          type: 'string',
          enum: ['add', 'remove', 'set'],
          description: 'add: add tags (keep existing), remove: remove specific tags, set: replace all tags with provided list'
        },
        itemKey: {
          type: 'string',
          description: 'Item key to modify tags on'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to add/remove/set'
        }
      },
      required: ['action', 'itemKey', 'tags']
    }
  },
  {
    name: 'write_metadata',
    category: 'write',
    description: 'Update metadata fields on Zotero items (title, abstract, date, URL, DOI, creators, etc.). Only works on regular items, not notes or attachments. Confirm with user before executing.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        itemKey: {
          type: 'string',
          description: 'Item key to update metadata on'
        },
        fields: {
          type: 'object',
          description: 'Fields to update. Common fields: title, abstractNote, date, url, DOI, language, shortTitle, volume, issue, pages, publisher, place, ISBN, ISSN, extra, rights, series, seriesNumber, edition, numPages, journalAbbreviation, publicationTitle, bookTitle',
          additionalProperties: { type: 'string' }
        },
        creators: {
          type: 'array',
          description: 'Set the creators list (replaces all existing creators). Each creator has creatorType (author/editor/translator/etc.), and either firstName+lastName or name (for organizations).',
          items: {
            type: 'object',
            properties: {
              creatorType: {
                type: 'string',
                description: 'Creator type: author, editor, translator, contributor, bookAuthor, seriesEditor, reviewedAuthor, etc.'
              },
              firstName: { type: 'string', description: 'First name (for individuals)' },
              lastName: { type: 'string', description: 'Last name (for individuals)' },
              name: { type: 'string', description: 'Full name (for organizations, use instead of firstName/lastName)' }
            },
            required: ['creatorType']
          }
        }
      },
      required: ['itemKey']
    }
  },
  {
    name: 'write_item',
    category: 'write',
    description: 'Create a new Zotero item, re-parent existing attachments, or import a local file as an attachment. Common workflows: (1) read PDF → extract metadata → create item → attach PDF via attachmentKeys; (2) convert PDF to Markdown → import the .md file as attachment via import action. Confirm with user before executing.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        action: {
          type: 'string',
          enum: ['create', 'reparent', 'import'],
          description: 'create: create a new item with metadata. reparent: move an attachment under a different parent item. import: import a local file (e.g., Markdown, PDF) as an attachment to an existing item; this action additionally requires the "Allow File Import" preference to be enabled and fails otherwise.'
        },
        itemType: {
          type: 'string',
          description: 'Item type for create action (e.g., journalArticle, book, conferencePaper, thesis, report, webpage, preprint, bookSection, etc.)'
        },
        fields: {
          type: 'object',
          description: 'Metadata fields for create action. Common: title, abstractNote, date, url, DOI, language, volume, issue, pages, publisher, place, publicationTitle, bookTitle, etc.',
          additionalProperties: { type: 'string' }
        },
        creators: {
          type: 'array',
          description: 'Creators for create action. Each: {creatorType, firstName, lastName} or {creatorType, name} for organizations.',
          items: {
            type: 'object',
            properties: {
              creatorType: { type: 'string', description: 'author, editor, translator, contributor, etc.' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              name: { type: 'string', description: 'For organizations' }
            },
            required: ['creatorType']
          }
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to add to the new item'
        },
        attachmentKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'For create: existing standalone attachment keys to re-parent under the new item. For reparent: attachment keys to move.'
        },
        parentKey: {
          type: 'string',
          description: 'For reparent action: the target parent item key to move attachments to'
        },
        filePath: {
          type: 'string',
          description: 'For import action: absolute path to the file to import as an attachment'
        },
        parentItemKey: {
          type: 'string',
          description: 'For import action: Zotero item key of the parent to attach the file to'
        },
        title: {
          type: 'string',
          description: 'For import action: display title for the attachment (defaults to the file name)'
        }
      },
      required: ['action']
    }
  }
  ];
}

/**
 * The catalog after the two preference gates, which is exactly what
 * `tools/list` serves and exactly what `/capabilities` advertises.
 */
export function filterToolCatalog(options: {
  semanticEnabled: boolean;
  writeEnabled: boolean;
  mutatingToolNames: ReadonlySet<string>;
}): ToolDefinition[] {
  return buildToolCatalog().filter((tool) => {
    if (!options.semanticEnabled && SEMANTIC_TOOL_NAMES.has(tool.name)) {
      return false;
    }
    if (!options.writeEnabled && options.mutatingToolNames.has(tool.name)) {
      return false;
    }
    return true;
  });
}
