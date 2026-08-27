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
import { MAX_SEARCH_INDEX_BUILD_ITEMS } from "./semantic/searchIndexBuilder";

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
  | "wiki"
  | "write";

export const WIKI_TOOL_NAMES: ReadonlySet<string> = new Set([
  "wiki_prepare_update",
  "wiki_commit",
  "wiki_search",
  "wiki_get_page",
  "wiki_get_claim",
  "wiki_status",
  "wiki_export",
  "wiki_record_concepts",
  "wiki_list_concepts",
  "wiki_export_concepts",
  "wiki_reverify",
  "wiki_build_from_paper",
  "wiki_set_reading_expert",
  "wiki_update_reading_note",
  "wiki_get_reading_note",
  "wiki_finish_reading",
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
      'DEFAULT FIRST STEP for locating literature. Runs keyword retrieval and semantic vector retrieval in parallel, gates each one against ITS OWN user-configured relevance threshold on ITS OWN scale, unions whatever survives, and ranks the union by weighted Reciprocal Rank Fusion. Clearing either threshold on its own is enough to appear in the results: a branch can admit a document but can never veto one.',
      '',
      'The keyword branch reads the metadata of the whole library (title, abstract, creators, publication title, tags, extra) AND the body text of every document in the plugin\'s keyword index. The semantic branch reads the indexed passages. Neither branch scans Zotero\'s full-text cache or opens a PDF on the fly, so body coverage on both sides is exactly what has been indexed — metadata.bodyKeywords reports the keyword index\'s share, and each row\'s fullText field reports the semantic index\'s.',
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
      'SCORING - read this before you interpret any number in the response. The two branches are never compared against each other. Each is filtered on its OWN scale: the keyword branch on normalised BM25F, the semantic branch on cosine similarity, each against its own user-configured threshold. The survivors are UNIONED - clearing either threshold on its own is enough to appear, and a branch can admit a document but can never veto one, so a paper the keyword branch never found is still returned if the semantic branch rates it, and vice versa. The ranking is then weighted Reciprocal Rank Fusion over where each document placed WITHIN each branch that admitted it: score = keywordWeight/(rrfK + keywordRank) + semanticWeight/(rrfK + semanticRank), with an absent branch contributing nothing rather than a penalty. A document both branches admit therefore collects two contributions and outranks single-branch documents at comparable ranks.',
      '',
      'CONSEQUENCE FOR HOW YOU READ THE ROWS: `score` is that RRF value. It is a POSITION, not a relevance - it is a small number (a document first in both branches lands near 0.033 at the default k=60) and comparing it against 0.6, or against a score from another search, or against a score from keyword_search or semantic_search, is meaningless. When you need to know how relevant a document actually is, read normalizedKeywordScore and normalizedSemanticScore, which are real 0-1 relevances on their own branch scale and are exactly what the thresholds were applied to. A MISSING one means that branch did not admit the document - not that it scored zero, and not that the document is weak. Do not re-sort the list by anything else: re-sorting a rank fusion undoes the fusion. And at most the user-configured number of documents is returned, which is an upper bound and NOT a target: a weakly related paper is never added to make the list longer.',
      '',
      'WHAT YOU GET BACK: a LIGHTWEIGHT candidate row per surviving document — itemKey, title, creators, year, venue, the language it is written in, the RRF score plus each branch\'s own relevance, which of your keywords matched which fields, and a short snippet from its best-matching passages. A document the keyword branch matched in its BODY also carries bodyEvidence: the passages that contained your terms, with their chunkIds. Read it whenever matchedFields is just ["body"] — that row has nothing in its title or abstract to judge it by, and the passage is the whole reason it is here. That is a shortlist to triage, not a reading pile.',
      '',
      'ABSTRACTS ARE NOT RETURNED, on purpose. They are still indexed, still searched by the keyword branch, and still part of what produced this ranking — they are simply not shipped back, because most candidates never need to be read in full. Judge each row from its title, score, matched keywords and snippet. Only for a paper you are seriously considering going deeper on, call get_item_abstract with that one itemKey. Reading every candidate\'s abstract is the exact behaviour this design removes: 20 candidates does not mean 20 abstracts.',
      '',
      'SCOPE: by default this searches the entire library. When the user question is clearly confined to part of their collection, call get_collections FIRST, read the real folder names, and pass the relevant ones as collectionKeys — the scope is applied before scoring, so it cuts the work rather than filtering the results afterwards. Judge each collection by what it plainly is: include what the user named, include what obviously relates, exclude only what obviously does not, and INCLUDE anything you cannot classify. Personal folder names carry no subject information — "待读", "综述", "课题资料", "论文写作" — yet often hold exactly the papers that matter, so uncertainty means include, never exclude. When most of the structure is opaque to you, or the question spans several fields, skip collectionKeys and search everything: a scope that misses a paper is a worse outcome than a scan that costs a little more.',
      '',
      'PAGING: topK is the size of ONE page, not the depth of the search. The response carries a pagination block: appliedKeywordMinScore and appliedSemanticMinScore (the two floors these results were gated by), totalRelevant (how many documents at least one branch admitted — often more than one page), returned, hasMore and nextCursor. Gating happens BEFORE paging, so a later page can never contain a document both branches rejected, and a short last page is never padded out. To read further, call hybrid_search again with cursor set to nextCursor and everything else unchanged; that returns the next window of the SAME ranking rather than a fresh search. Page on when the bottom of a page is still relevant, or when the user asked for a comprehensive sweep or a literature review — not by reflex. Never lower either floor to make more results appear.',
      '',
      'THEN: having read one paper\'s abstract, redo the expert analysis for THAT paper — re-fit domain and expertRole to what it actually studies, write a query and keywords out of its own subject matter, in the language that paper is written in — and call search_fulltext with its single itemKey. Answer from the stage-1 rows alone when the user only asks which literature is relevant.',
      '',
      'AFTER YOU ANSWER, RECORD WHAT YOU READ. For every paper whose passages you genuinely read and used, call wiki_update_reading_note with that itemKey, the chunkIds you used, the domain and expertRole you searched it with, and the paper\'s whole reading note rewritten to include what you just learned. Then update the Wiki from those notes with wiki_prepare_update and wiki_commit. That is how a conversation leaves anything behind: the note is the library\'s memory of the paper, and the Wiki is what the next question can retrieve. Skip both only when the turn genuinely read nothing new.',
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
          description: `Lexical probes for the keyword branch, derived from your domain analysis of the question rather than from its wording: the core concepts and mechanism, precise Chinese AND English terms of art, standard technical translations, accepted synonyms, field abbreviations, and closely coupled concepts with a clear professional link to the research intent. For best results, it is recommended to provide 5-12 relevant Chinese and/or English keywords. Fewer or more keywords are still allowed within the implemented input limit of 1 to ${MAX_HYBRID_KEYWORDS} entries. Always supply both scripts regardless of the language the user asked in. Do not pad with generic or weakly related words — keyword coverage is part of the score, so filler actively hurts ranking. All keywords are matched together in one pass over title, abstract, creator, publicationTitle, tags, extra AND the indexed body text, scored with BM25F — per-field weights, per-field length normalisation, saturating repeat counts — plus a bonus for covering more DISTINCT keywords, so a broad word cannot outrank a discriminative phrase. A document whose body carries your terms is retrieved even when its title and abstract do not, provided it is in the keyword index; body coverage is partial and is reported in metadata.bodyKeywords. Omitting this makes the server fall back to mechanically splitting the query: it can only probe the language the user typed in, is scored at a lower weight, and the response is flagged with keywordSource "fallback" plus an explicit warning.`
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
          description: 'Continue a previous hybrid_search: pass the nextCursor it returned, exactly as given. The cursor names one already-ranked, already-gated result set, and returns the next page of THAT set — it does not re-run retrieval, so pages cannot duplicate, drop or reorder documents. Send it with query, keywords, domain, expertRole, minKeywordScore and minSemanticScore either unchanged or omitted; changing any of them is a different search and is rejected. Omit cursor to start a new search.'
        },
        minKeywordScore: {
          type: 'number',
          description: 'Keyword-branch relevance floor 0-1, on the normalised BM25F scale. Gates the keyword branch ONLY: a document below it contributes no keyword rank, but the semantic branch can still admit it. May only be STRICTER than the user setting; a lower value is raised back to it.'
        },
        minSemanticScore: {
          type: 'number',
          description: 'Semantic-branch relevance floor 0-1, on the cosine-similarity scale. Gates the semantic branch ONLY, under the same rule. Raise this and lower nothing when you want fewer, more certain matches; the two floors are independent, so tightening one does not touch the other.'
        },
        language: {
          type: 'string',
          enum: ['zh', 'en', 'all', 'auto'],
          description: 'Semantic branch language filter. Keep the "all" default for genuinely cross-lingual recall; "zh"/"en" restrict the index to that language and "auto" restricts it to the detected query language, both of which drop literature written in the other language. Only set this when the user explicitly asks for one language.'
        },
        rrfK: {
          type: 'number',
          description: 'Reciprocal Rank Fusion rank constant (default: 60). RRF now decides the whole ranking, and k controls how quickly the advantage of a better rank flattens out: a small k makes the top few positions dominate, a large k flattens the list towards the branch weights. It is one shared constant on purpose — expressing a preference for a branch is what keywordWeight and semanticWeight are for, and doing it with two different k values would tangle "how much do I trust this branch" together with "how much does placing first matter". Leave it alone unless you have a specific reason.'
        },
        keywordWeight: {
          type: 'number',
          description: "The keyword branch's weight in the RRF sum: score = keywordWeight/(k + keywordRank) + semanticWeight/(k + semanticRank). Non-negative. Defaults to the user's setting, so omit it unless this particular question calls for leaning one way; 0 disables the branch entirely, so it can then neither rank nor admit a document. It does NOT change either threshold — a branch you down-weight still admits the same documents, they just count for less."

        },
        semanticWeight: {
          type: 'number',
          description: "The semantic branch's weight in the same RRF sum, under the same rules and with the same default."

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
        relevanceScoring: { type: 'boolean', description: 'Enable relevance scoring' },
        sort: {
          type: 'string',
          enum: ['relevance', 'date', 'title', 'year'],
          description: 'Sort order'
        },
        limit: { type: 'number', description: 'Maximum results to return (default: 200)' },
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
      'RETURNS: title, creators (with roles), date and year, item type, publication title, volume, issue, pages, DOI, URL, language, tags, abstract/note availability, one row per attachment — key, filename, content type, size, and whether its text can be read — and collections: every folder this document is filed in, with key, name and full path. That last one is filing, not content, and it is the only way to see that a paper sits in five folders at once (or in none) without listing every collection in the library and inverting it.',
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
      'WHERE THE TEXT CAME FROM. Every response names its source in textSource.method, because the same PDF yields materially different text depending on which path produced it. Best structure first: doc2x (Doc2X Markdown), mineru_cache (a MinerU/Doc2X Markdown that already existed — no parsing), mineru_attachment (a Markdown file an earlier MinerU parse left on the item), mineru (parsed by MinerU during this call), markdown_attachment (a Markdown or text file attached to the item directly), zotero_fulltext_cache (Zotero\'s own extracted text index — flat, no layout), pdf_processor (the bundled PDF worker, used when no Markdown path produced text — also flat), html_parsing, text_reading. When no text could be produced, method says why: pdf_processor_timeout, mineru_disabled, mineru_on_demand_disabled, mineru_failed, mineru_error, no_text. Never present zotero_fulltext_cache or pdf_processor output as though it preserved tables or headings.',
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
        limit: { type: 'number', description: 'Maximum results to return (default: 100).' },
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
      'ONE MORE FIELD, AND ONLY WHEN IT MATTERS: alsoIn. A row carries it when the document is ALSO filed in collections other than this one, and it lists those other collections (collectionKey, name, path) — never the folder you are currently in. Its absence means the document is filed here and nowhere else. That is the field to read before reorganising anything: move_items_to_collection takes an item OUT of every collection it names, so a row with alsoIn is exactly the case where moving it loses a filing somebody meant to keep.',
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
    name: 'move_items_to_collection',
    category: 'write',
    description: [
      'MOVE items into one collection, taking them OUT of every other collection they are currently filed in. This is the tool for reorganising a library; add_items_to_collection only ever adds, so a library reorganised with it accumulates old filings instead of losing them.',
      '',
      'MOVE MEANS MOVE. After this call each item is filed in exactly one place: toCollectionKey. If the user wants a document to stay in several folders — a paper that genuinely belongs to both a project and a reading list — do NOT use this tool for it; use add_items_to_collection, which leaves existing filings alone.',
      '',
      'ALL OR NOTHING. Every key is checked before anything is written: items that do not exist, items in the trash, and child notes or attachments (which cannot be filed in a collection at all) abort the whole batch. Nothing is written, and the call comes back as a tool ERROR — not as a result you have to inspect — whose message names every offending key and why it was refused. Fix or drop them and call again. The write itself runs in one transaction, so a failure mid-way leaves the library untouched rather than half-reorganised.',
      '',
      'ALWAYS DRY RUN FIRST on a batch you have not shown the user. dryRun: true runs the identical preflight and returns the identical plan — which items, which filings each one loses — without writing anything and without prompting the user. Show them that plan, get their agreement, then repeat the call without dryRun.',
      '',
      'BATCH BY DESTINATION. itemKeys takes many items, and one call is one confirmation prompt for the user. Sorting a hundred papers into six folders is six calls, not a hundred.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        toCollectionKey: {
          type: 'string',
          description: 'Key of the collection the items should end up in. It must already exist — create it with create_collection first if needed.'
        },
        itemKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Item keys to move. Top-level items only; a child note or attachment key aborts the batch.'
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, validate and return the plan without writing anything and without prompting the user. Use it to show the user what a batch would do before doing it. A dry run whose preflight fails fails the same way the real call would - as a tool error naming the offending keys - because there is no plan to show.'
        },
      },
      required: ['toCollectionKey', 'itemKeys'],
    },
  },
  {
    name: 'merge_items',
    category: 'write',
    description: [
      'MERGE duplicate records: one survivor per group, everything else folded into it and trashed. This is how a duplicated document is removed from a library, and it is NOT the same as deleting the extra copies.',
      '',
      'WHY MERGE RATHER THAN DELETE. Zotero\'s merge moves the losing records\' attachments, notes and annotations onto the survivor, unions their collection memberships, and records a `dc:replaces` relation so a citation in an existing manuscript that points at a losing key still resolves to the survivor. Deleting throws all three away, and the broken citation only surfaces the next time the document is refreshed. There is deliberately no delete tool here.',
      '',
      'CHOOSING THE SURVIVOR. Omit masterItemKey and the most complete record wins — DOI, abstract and venue weigh most, then creators and attachments, with ties broken by how widely the record is filed and then by which was added first, so the same batch always plans the same way. The plan states which record won and on what grounds. Pass masterItemKey to override it for a group.',
      '',
      'ALL OR NOTHING AT THE PREFLIGHT. Missing items, trashed items, child notes or attachments, a group of fewer than two distinct items, a group mixing item types (Zotero cannot merge those), a master that is not in its own group, or one key appearing in two groups — any of these rejects the WHOLE batch with nothing written. That comes back as a tool ERROR, not as a result you have to inspect, and its message names the group and the reason for every problem it found.',
      '',
      'PARTIAL APPLICATION IS POSSIBLE AFTER PREFLIGHT, unlike move_items_to_collection. Each group is merged atomically on its own, so a failure part-way through leaves earlier groups fully merged. That is NOT an error — real work was done and the receipt is the answer: the response reports applied: "partial", lists mergedGroups, and names the group it stopped at. Re-request the remainder.',
      '',
      'ALWAYS DRY RUN FIRST. dryRun: true runs the identical preflight and returns the identical plan — survivor, reason, what each losing record contributes — writing nothing and raising no confirmation prompt. Merging is the one operation here that is genuinely hard to undo: show the user the plan and get agreement before running it for real.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: {
          type: 'number',
          description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
        },
        groups: {
          type: 'array',
          description: 'One entry per set of duplicates. Many groups can be merged in a single call, which is also a single confirmation prompt for the user.',
          items: {
            type: 'object',
            properties: {
              itemKeys: {
                type: 'array',
                items: { type: 'string' },
                description: 'The duplicate records, at least two, all of the same item type.'
              },
              masterItemKey: {
                type: 'string',
                description: 'Optional: the record that must survive. Must be one of itemKeys. Omit to let the most complete record win.'
              },
            },
            required: ['itemKeys'],
          },
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, validate and return the plan without merging anything and without prompting the user. A dry run whose preflight fails fails the same way the real call would - as a tool error naming the problems - because there is no plan to show.'
        },
      },
      required: ['groups'],
    },
  },
  {
    name: 'search_fulltext',
    category: 'semantic',
    description: [
      'SECOND-STAGE retrieval: a hybrid search inside the full text of ONE document located by hybrid_search. Same shape as hybrid_search - keyword matching and vector semantic retrieval, each gated against its own user threshold, the survivors unioned, the union ranked by weighted Reciprocal Rank Fusion - except the candidates are the passages (chunks) of a single paper instead of the whole library. It reads that paper\'s INDEXED passages; a document with no semantic index is refused rather than parsed on the fly.',
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
      'CONTEXT EXPANSION is a SEPARATE call, not a later stage of this one. Ranking ends at the RRF list above; nothing is expanded automatically. Read the returned passages first and stop when the evidence is sufficient. Only when a passage is clearly missing its cause, its consequence, its experimental conditions or its mechanism context, call this tool AGAIN with chunkIds set to the chunkId(s) of that passage - that call performs no retrieval and no ranking at all, it just returns those passages plus their immediate neighbours in reading order, within the radius the user allows. The decision to expand is yours; never request neighbours by default and never ask for the whole document.',
      '',
      "SCORING follows the same RULE as hybrid_search, one level down, on a scale of its own. Each branch is gated separately against the SAME two user settings hybrid_search uses, and the survivors are UNIONED — a passage only has to clear ONE of the two to be returned, so a passage your keywords miss still comes back when the embedding rates it, and a passage the embedding rates low still comes back when it literally carries your terms. Ranking is then weighted Reciprocal Rank Fusion over each passage's rank within each branch that admitted it.",
      '',
      "What differs from hybrid_search is what the keyword number MEANS. At library level the keyword branch is BM25F over a document's fields; inside one paper every candidate is a single passage with one field, so it is scored by term specificity across THIS paper's own passages, field weight, how many distinct keywords the passage covers, and saturating repeat counts, then mapped into 0-1. Term specificity is therefore computed over a handful of chunks rather than a whole library, which compresses it towards the middle of its range. Treat a chunk-level keyword score as comparable to other chunks of the same paper, not to a document-level score from hybrid_search or keyword_search.",
      '',
      "`score` is the RRF value: a position, not a relevance, and not comparable across tools or across searches. Read normalizedKeywordScore and normalizedSemanticScore for how relevant a passage actually is; a MISSING one means that branch did not admit the passage, not that it scored zero.",
      '',
      "Result counts are capped by the user's preferences and both floors are floors you cannot lower. The cap is a ceiling, not a quota, so a document with only one good passage returns one passage.",
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
        minKeywordScore: {
          type: 'number',
          description: 'Keyword-branch floor 0-1 for this document\'s passages. NOT the BM25F scale hybrid_search uses: inside one paper the keyword branch scores each passage by term specificity across THIS paper\'s own passages, then maps it into 0-1, so the same number is a different quantity here - see SCORING. Gates the keyword branch only; the semantic branch can still admit a passage below it. Same user setting, and same "stricter only" rule, as hybrid_search.'
        },
        minSemanticScore: {
          type: 'number',
          description: 'Semantic-branch floor 0-1 for this document\'s passages, on the cosine scale. Gates the semantic branch only, under the same rule.'
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
      'LEXICAL-ONLY retrieval: literal term matching, no embeddings, nothing scored semantically. It searches the metadata fields of the WHOLE library — title, abstract, creators, publication title, tags, extra — AND the body text of every document that is in the keyword index.',
      '',
      'BODY COVERAGE IS PARTIAL, AND THAT IS THE ONE THING TO KNOW BEFORE READING A RESULT. Body matching reads the plugin\'s own keyword index. It does not scan Zotero\'s full-text cache, does not open PDFs, and does not reach a document the user has not indexed yet. Metadata coverage is the whole library; body coverage is whatever is indexed. So a document can be missing here because nobody indexed its body, NOT because its body lacks your terms — check metadata.bodyKeywords (indexedDocuments vs metadataCollectionSize) before concluding the library has nothing.',
      '',
      'A body hit is a first-class hit: a document whose title, abstract and tags contain none of your keywords still enters the ranking on its body alone. Those rows come back with matchedFields ["body"] and a bodyEvidence array naming the passages that carried the terms — read it, because for a body-only row it is the only thing that says why the document is in front of you.',
      '',
      'WHEN TO USE IT. Two cases, and they are the only two.',
      '1. The user named something exact - a term of art, an author, an abbreviation, a compound, a standard number - and you want every document that literally contains it, including ones a semantic query would rank low.',
      '2. COARSE FILTER before a fine search. Run keyword_search to reduce the library to a defensible shortlist, take the itemKeys it returned, and pass them to semantic_search as itemKeys. The semantic pass then scores only that shortlist. This is the cheap way to ask a conceptual question of a precisely delimited subset.',
      'For ordinary literature discovery, hybrid_search is still the default first step - it runs this branch AND the semantic branch, gates each on its own threshold and rank-fuses the union, so calling both separately is strictly more work for a worse ranking.',
      '',
      `KEYWORDS ARE THE WHOLE INPUT. Pass the terms a specialist in the sub-field would actually search on, covering BOTH Chinese and English: core concepts, mechanism and governing variables, standard technical translations, accepted synonyms, the abbreviations of the field. The library is bilingual and this tool searches all of it, so restricting yourself to the language the user typed in silently halves recall. Around 5-12 keywords is the recommendation; 1 to ${MAX_HYBRID_KEYWORDS} is accepted. Do not pad the list - every keyword must be defensible as a term of art, because generic words dilute the coverage score and push the right papers down.`,
      '',
      'SCORING. BM25F over the fields above, with body as one of those fields. Every keyword is matched in one pass; each field has its own weight and its own length normalisation, so a term in a title counts for more than the same term buried in a long body, and repeating one term saturates instead of accumulating without limit. On top of that, matching several DISTINCT keywords beats matching one keyword many times. The raw score is unbounded, so it is mapped into 0-1 by a saturating curve.',
      '',
      'The floor applied here is the user\'s KEYWORD relevance threshold - the same setting, on the same normalised BM25F scale, that gates hybrid_search\'s keyword branch. It is not shared with the semantic threshold: the two scales are different and are never compared. Filtering happens before paging, so no page can contain a document below the floor and a short final page is never padded.',
      '',
      'WHAT YOU GET BACK. The same lightweight candidate row hybrid_search returns - itemKey, title, creators, year, venue, language, score, which keywords matched which fields, whether an abstract exists, and fullText (whether that document has indexed body text) - plus bodyEvidence on any row that matched in the body. Here, and ONLY here among the retrieval tools, score is a real 0-1 relevance: one branch means there is nothing to fuse, so the number is this document\'s normalised BM25F score and is exactly what the threshold was applied to. (hybrid_search and search_fulltext report a rank-fusion score instead, which is a position, not a relevance - do not carry a number from one tool to the other.) Abstracts are not shipped back; fetch one with get_item_abstract for a paper worth pursuing.',
      '',
      'bodyEvidence entries carry chunkId, which of your keywords that passage contained, how many times, and the passage text. occurrences is evidence strength for YOU to read - it takes no part in ranking. To read around one of those passages, pass its chunkId to search_fulltext.',
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
          description: 'Restrict the lexical scan to these specific documents — the shortlist you already hold, from an earlier search or from browsing. Applied BEFORE scoring, so it removes work rather than filtering results afterwards. This is not the coarse-filter path: that one runs keyword_search first and passes ITS itemKeys to semantic_search. Combined with collectionKeys, the two scopes intersect.'
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
      'WHEN TO USE IT. hybrid_search is the default first step for literature discovery and you should reach for it first - it runs the semantic branch AND the lexical branch, gates each on its own threshold and rank-fuses the union. Use semantic_search when the lexical branch would only add noise:',
      '1. The user is asking about a CONCEPT or MECHANISM whose vocabulary you cannot pin down - where the right papers may share no surface term with the question.',
      '2. FINE SEARCH after a coarse filter. Run keyword_search first, take its itemKeys, pass them here, and the semantic pass scores only that shortlist.',
      '3. The user explicitly asked for semantic-only retrieval.',
      '',
      'THE QUERY IS THE WHOLE INPUT. Write ONE complete natural-language sentence stating the real research intent as an expert in that sub-field would state it. It is embedded verbatim, so do not reduce it to loose tokens. Writing an English phrasing followed by " / " and the Chinese phrasing is recommended, so the embedding sees both surface forms - retrieval is cross-lingual and the library is bilingual.',
      '',
      'SCORING AND PAGING. Passage similarities are aggregated to ONE cosine score per document, and the floor applied is the user\'s SEMANTIC relevance threshold - the same setting, on the same cosine scale, that gates hybrid_search\'s semantic branch. It is not shared with the keyword threshold; the two scales are different and are never compared. Because there is only one branch here there is nothing to fuse, so score is a real 0-1 relevance and is exactly what the threshold was applied to - unlike hybrid_search and search_fulltext, whose score is a rank-fusion position. Never carry a number between the two kinds of tool. Filtering happens BEFORE paging, so no page can contain a document below the floor and a short final page is never padded; topK is the size of one page. The response carries appliedMinScore, totalRelevant, returned, hasMore and nextCursor - pass nextCursor back as cursor with everything else unchanged to window the SAME ranking rather than searching again.',
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
      '4. DOCUMENT-LEVEL aggregation. Chunk scores are folded into ONE score per candidate document: for each of your query chunks, the candidate\'s two best-matching passages are averaged, then those per-chunk-query scores are combined (mostly their mean, plus a smaller weight on the strongest one). A paper therefore scores high by relating to SEVERAL of the facets you supplied, not by owning one lucky passage. The result is a 0-1 cosine relevance on the same scale as semantic_search, and the floor applied to it is the user\'s SEMANTIC relevance threshold. It is NOT comparable to hybrid_search\'s or search_fulltext\'s score, which is a rank-fusion position rather than a relevance.',
      '5. The user\'s relevance threshold is applied to those document scores, and EVERY document above it is ranked and paged - there is no cap on how many papers may qualify.',
      '',
      'PAGING: ordered best first, one page at a time. The page size is the user\'s configured MAXIMUM NUMBER OF DOCUMENTS - there is no fixed count here, and topK can only lower it. That cap bounds one page, never how many documents qualify, which is unlimited. When hasMore is true, call again with cursor set to nextCursor and nothing else changed; that replays the stored ranking instead of re-scanning the library. Decide as you page whether to keep going or to stop and dig into a promising candidate with get_item_abstract and search_fulltext.',
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
          description: 'Page size. Capped by the user\'s configured maximum number of documents; a larger value is lowered to it. It only lowers the page size and never the number of qualifying documents, which is unlimited.'
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
  {
    name: 'build_search_index',
    category: 'semantic',
    description: 'Explicitly build or refresh the unified search index for one or more Zotero documents. One targeted lifecycle builds both semantic vectors and the keyword index from the same extraction and chunks, while preserving the existing build lock, pause/reset fences, failure journal, chunk settings and compatibility checks. Returns semantic, keyword and full-text status for every item; parse_failed, no_source and partial failures are never reported as success.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        itemKeys: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_SEARCH_INDEX_BUILD_ITEMS,
          items: { type: 'string' },
        },
      },
      required: ['itemKeys'],
    },
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
  {
    name: 'wiki_prepare_update',
    category: 'wiki',
    description: [
      'Search existing Wiki Page, Concept/Alias, Claim keyword and Claim embedding candidates before proposing a controlled Wiki update. This tool never writes. CREATE_PAGE requires the short-lived prepareToken returned here.',
      '',
      'PREFER WHAT ALREADY EXISTS. The candidates come back so that a second question about the same subject EXTENDS the Page, Claim and Concept it already produced instead of creating a near-duplicate beside it. Look for the match before you propose anything new; a Wiki that grows a parallel Page every few turns is worth less than one Page that got better.',
      '',
      'pendingWikiWriteUp lists papers whose reading notes have moved ahead of the Wiki. Those are what this update owes: each stays closed to further question-driven reading until a commit cites it.',
      '',
      'AFTER A FULL-TEXT READ, this call asks for one more thing before it will start the write-up: wikiReview, a pass over the WHOLE Wiki with the finished paper in hand. It is refused once and asked for by name, so you will be told when it is needed rather than having to guess.',
      '',
      'wikiReview is accepted ONLY once every chunk has been delivered, the whole-paper synthesis is recorded, AND wiki_record_concepts final true has completed. Sent earlier it is refused and nothing is stored — the order is finalSynthesis, terminology final, then the five-axis Wiki review. Committing what you have read so far is still allowed while a paper is unfinished; just leave wikiReview out of those calls.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        proposedPageTitles: {
          type: 'array',
          maxItems: 2,
          items: { type: 'string' },
          description: 'Exact canonical Page titles being considered. The returned prepareToken authorizes only these titles; defaults to query.'
        },
        wikiReview: {
          type: 'object',
          description: 'The whole-Wiki review, accepted only after every chunk has been delivered, wiki_update_reading_note finalSynthesis has been recorded, AND wiki_record_concepts final true has completed — sent before that it is refused and nothing is stored. With the complete paper in hand, say what it means for what the Wiki ALREADY holds, on all five axes. This is not a summary of what you are about to add: it is a correction pass over a Wiki that has been growing incrementally, page by page and question by question, and has therefore drifted. "Nothing to change here, because ..." is a real answer to any axis and is the commonest one. Answered once and remembered; a retry does not re-ask.',
          properties: {
            pages: {
              type: 'string',
              description: 'Does an existing Page need adjusting, splitting or retitling in light of the complete paper, or does a new one need creating? Name the Pages.'
            },
            claims: {
              type: 'string',
              description: 'Which existing Claims does the complete reading confirm, qualify, merge, correct or contradict? A Claim written from chunk 20 that chunk 140 turns out to bound is the case this exists for.'
            },
            evidence: {
              type: 'string',
              description: 'Which Claims are thin on Evidence, and which Evidence gathered mid-read can now be re-cited at full-paper depth? Name what you will attach.'
            },
            concepts: {
              type: 'string',
              description: 'Which terms need adding, correcting, completing or de-duplicating — including two Concepts written turns apart that turn out to be one?'
            },
            relations: {
              type: 'string',
              description: 'Which links between Concepts and Claims should now be drawn, and which drawn earlier no longer hold?'
            }
          },
          required: ['pages', 'claims', 'evidence', 'concepts', 'relations']
        }
      },
      required: ['query']
    }
  },
  {
    name: 'wiki_commit',
    category: 'wiki',
    description: [
      'Apply only controlled Wiki actions. The plugin validates pages, claims, Zotero documents, actual indexed chunks, excerpts, duplicates, versions and the two-page creation ceiling. It never accepts SQL. When automatic Wiki writing is disabled, Zotero asks the user to confirm this Wiki-only database update.',
      '',
      'ZOTERO NOTE STATUS IS SEPARATE. A commit that completes an open full-text reading session also tries to mark its Markdown reading note completed. That small Zotero write uses the Zotero write permission and confirmation; if it is not authorized, the Wiki commit and session close still succeed and noteStatusWrite reports not_authorized.',
      '',
      'SETTLING WHAT A QUESTION READ. Chunks read while answering a question owe the Wiki something until this call accounts for them, ONE BY ONE. A chunk is settled by an Evidence excerpt quoting it, or by a SKIP action naming it with a reason — and citing one chunk of the five a question read settles that one only. Whatever is left unsettled keeps its paper closed to further question-driven reading; the Claims you did write are still committed and permanent. wiki_prepare_update lists exactly which chunk ids are outstanding.',
      '',
      'A SKIP that carries itemKey, chunkIds and reason is how you record that read text established nothing the Wiki did not already hold — a restated definition, a caption confirming a known number, a paragraph of related work. That is a legitimate and common outcome, and a whole turn may be settled this way. What it is not is a formality: the reason must say what those passages actually establish and which Page, Claim, Concept or relation already covers it. "Nothing new" is refused, because it is exactly what a reader who checked nothing would also write. One reason may cover a group of chunks; you are never asked to explain each chunk separately. Every reason is kept in the reading ledger permanently.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        prepareToken: {
          type: 'string',
          description: 'Required when actions contain CREATE_PAGE. Obtain it from wiki_prepare_update for the same library.'
        },
        actions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'SKIP',
                  'ATTACH_EVIDENCE',
                  'ADD_CLAIM',
                  'UPDATE_CLAIM',
                  'CREATE_PAGE',
                  'LINK_RELATION',
                  'MARK_CONFLICT'
                ]
              },
              ref: { type: 'string' },
              itemKey: { type: 'string' },
              chunkIds: {
                type: 'array',
                items: { type: 'integer', minimum: 0 },
                description: 'SKIP only: the chunk ids of this paper whose reading needs no Wiki entry. Every id must currently owe the Wiki — wiki_prepare_update lists them as pendingWikiWriteUp.'
              },
              reason: {
                type: 'string',
                description: 'SKIP only, required with chunkIds: what those passages establish, and which existing Page, Claim, Concept or relation already holds it. At least 40 characters and it must argue rather than assert — "nothing new", "already known" and their equivalents are refused. One reason covers the whole group.'
              },
              pageId: {},
              claimId: {},
              expectedVersion: { type: 'integer' },
              canonicalTitle: { type: 'string' },
              primaryConceptRef: { type: 'string' },
              primaryConcept: { type: 'object' },
              claimText: { type: 'string' },
              claimType: {
                type: 'string',
                enum: [
                  'definition',
                  'mechanism',
                  'model',
                  'condition',
                  'comparison',
                  'limitation',
                  'consensus',
                  'conflict'
                ]
              },
              epistemicStatus: {
                type: 'string',
                enum: [
                  'provisional',
                  'supported',
                  'corroborated',
                  'disputed'
                ]
              },
              coverageLevel: {
                type: 'string',
                enum: [
                  'chunk_local',
                  'section_read',
                  'paper_reviewed',
                  'cross_paper',
                  'partial',
                  'incomplete'
                ]
              },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              evidence: {
                type: 'array',
                minItems: 1,
                description: 'The exact chunks actually used for this Claim in this turn, quoted from the paper itself. Every chunk cited here must already be recorded as READ — delivered by wiki_build_from_paper, or named in a wiki_update_reading_note readChunkIds call — because a Claim may only rest on something the paper\'s reading note already accounts for. An excerpt from an unread chunk is refused by name. Never quote a reading note as Evidence: the note is your memory of the paper, the chunk is the paper. Do not claim paper_reviewed unless every ordered document chunk was actually read in a full-text pass.',
                items: {
                  type: 'object',
                  properties: {
                    libraryID: { type: 'number' },
                    itemKey: { type: 'string' },
                    chunkIdSnapshot: { type: 'integer', minimum: 0 },
                    excerpt: { type: 'string' },
                    evidenceRole: {
                      type: 'string',
                      enum: ['SUPPORTS', 'CONTRADICTS', 'QUALIFIES', 'EXAMPLE']
                    },
                    readDepth: {
                      type: 'string',
                      enum: [
                        'chunk_local',
                        'section_read',
                        'paper_reviewed',
                        'cross_paper'
                      ]
                    }
                  },
                  required: [
                    'itemKey',
                    'chunkIdSnapshot',
                    'excerpt',
                    'evidenceRole',
                    'readDepth'
                  ]
                }
              },
              sourceConceptId: {},
              targetConceptId: {},
              predicate: { type: 'string' }
            },
            required: ['action']
          }
        }
      },
      required: ['actions']
    }
  },
  {
    name: 'wiki_search',
    category: 'wiki',
    description: 'Search Alias/Concept, Claim keyword and CPU embedding indexes, Relations and one-hop neighbors, then resolve valid Evidence to a distinct-document ranking. itemKeys is applied before Claim scoring. limit caps final documents, never Claims. normalizedWikiScore is query relevance; evidenceConfidence, readDepth and epistemicStatus remain separate reliability fields.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        query: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
        itemKeys: { type: 'array', items: { type: 'string' } },
        minScore: { type: 'number', minimum: 0, maximum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['query']
    }
  },
  {
    name: 'wiki_get_page',
    category: 'wiki',
    description: 'Get one Wiki Page with all Claims and traceable Evidence.',
    inputSchema: {
      type: 'object',
      properties: { pageId: { type: 'integer' } },
      required: ['pageId']
    }
  },
  {
    name: 'wiki_get_claim',
    category: 'wiki',
    description: 'Get one atomic Wiki Claim with epistemic state, coverage and all Evidence links.',
    inputSchema: {
      type: 'object',
      properties: { claimId: { type: 'integer' } },
      required: ['claimId']
    }
  },
  {
    name: 'wiki_status',
    category: 'wiki',
    description: 'Report independent Wiki database counts and Evidence relink state.',
    inputSchema: {
      type: 'object',
      properties: { libraryID: { type: 'number' } }
    }
  },
  {
    name: 'wiki_export',
    category: 'wiki',
    description: 'Export the authoritative Wiki state as derived Markdown. Markdown is not used as the data source.',
    inputSchema: {
      type: 'object',
      properties: { libraryID: { type: 'number' } }
    }
  },
  {
    name: 'wiki_record_concepts',
    category: 'wiki',
    description: [
      'Record the professional concepts you recognised while ACTUALLY READING a paper - DRX, CET, columnar grain, dislocation density - into the independent concept library. This is not keyword extraction: a concept goes in only when the text you read establishes what it means in this field.',
      '',
      'WHEN TO CALL. Calls WITHOUT final are STAGED on the open reading session: they are checked and held, nothing is written, and the user is not asked to confirm anything. Use them to note candidates as you read. Then call ONCE with final true after the whole paper has been delivered and synthesised; that call writes everything you staged plus everything you pass to it, in a single database write and a single confirmation. Read the paper, understand it, decide which terms are genuinely concepts of the field, then write. wiki_prepare_update refuses to start the write-up until the final pass has happened. A paper that introduced nothing new is answered with an empty concepts list and noConceptsReason.',
      '',
      'ONE CONCEPT, MANY TERMS. A concept entity has one primary term and any number of alias terms, and EVERY term has the same three fields: zh (Chinese full name), en (English full name), abbr (abbreviation). Put every name for the same thing in ONE entity - the server decides which is primary and files the rest as aliases. Do not submit "动态再结晶" and "Dynamic Recrystallization" as two concepts.',
      '',
      'THE ONE HARD RULE: abbr may never be the only field. A term needs zh or en. If you cannot confirm which full name an abbreviation expands to, leave abbr out - the term is stored incomplete and can be completed by a later paper. Guessing is worse than missing.',
      '',
      'YOU MAY COMPLETE A TERM FROM YOUR OWN KNOWLEDGE, and you must say so. If a paper writes only "Dynamic Recrystallization" and you are confident of the standard Chinese term and abbreviation, submit zh 动态再结晶, en Dynamic Recrystallization, abbr DRX - and mark origins accordingly: literature for what the paper itself states, ai for what you supplied. The default for an unmarked field is ai, never literature. Only mark a field literature when the text you read actually contains it. If you are not confident, leave the field empty; a later paper can fill it. A field you marked ai is later upgraded to literature when a paper confirms it, and REPLACED when a paper contradicts it - so an honest ai mark costs nothing and a false literature mark is permanent.',
      '',
      'NAMES ARE NEVER OVERWRITTEN AWAY. If the library holds 动态再结晶 / Dynamic Recrystallization and this paper writes Dynamic Recrystallisation, both spellings are kept as two term rows of the same concept. Submit what the paper actually says; do not normalise it to what the library already has.',
      '',
      'DEDUPLICATION happens on the server, on FULL names only. A term whose Chinese or English full name the library already knows joins that concept instead of founding a second one, and its sources are added rather than replacing anything. A shared abbreviation alone never merges two concepts, because the same letters mean different things in different subfields.',
      '',
      'TO SAY TWO EXISTING CONCEPTS ARE ONE, put both names in the SAME term - zh 晶粒长大 and en grain growth in one term group. That is a claim about one term and it fuses them. Listing them as two separate terms of one entity does NOT: aliases of a concept differ from one another all the time, so that grouping is too weak to act on, and both concepts are left standing with a warning. A fusion is also refused when the two contradict each other anywhere, or when both already own a knowledge page.',
      '',
      'SOURCES. itemKey is required and must be a real Zotero document; it defaults to the paper currently open for reading. excerpt and chunkIdSnapshot are optional, and are verified against the live index when given - an excerpt that cannot be found is dropped with a warning while the document link is kept. Recording a concept from a second paper ADDS a source to the existing concept; it never duplicates it.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        itemKey: {
          type: 'string',
          description: 'Zotero paper source for every concept that does not carry its own valid sources. It may be omitted only when the open reading session supplies the real Zotero itemKey or every submitted concept/term already names a valid Zotero source; source-free concepts are rejected.'
        },
        final: {
          type: 'boolean',
          description: 'The whole-paper pass. Writes everything staged plus this call, once. Required before wiki_prepare_update.'
        },
        noConceptsReason: {
          type: 'string',
          description: 'Required with final true when nothing at all is left to write.'
        },
        concepts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              conceptType: { type: 'string' },
              description: {
                type: 'string',
                description: 'One sentence on what this concept means, from the paper. Optional.'
              },
              primaryTerm: {
                type: 'object',
                properties: {
                  zh: { type: 'string', description: 'Chinese full name, e.g. 动态再结晶' },
                  en: { type: 'string', description: 'English full name, e.g. Dynamic Recrystallization' },
                  abbr: { type: 'string', description: 'Abbreviation, e.g. DRX. Never on its own.' },
                  origins: {
                    type: 'object',
                    description: 'Per-field provenance. Unmarked fields count as ai.',
                    properties: {
                      zh: { type: 'string', enum: ['literature', 'ai'] },
                      en: { type: 'string', enum: ['literature', 'ai'] },
                      abbr: { type: 'string', enum: ['literature', 'ai'] }
                    }
                  },
                  origin: {
                    type: 'string',
                    enum: ['literature', 'ai'],
                    description: 'Shorthand when every field of this term has the same provenance.'
                  },
                  sources: { type: 'array', items: { type: 'object' } }
                }
              },
              terms: {
                type: 'array',
                description: 'Alias terms, each with the same zh / en / abbr / origins shape.',
                items: {
                  type: 'object',
                  properties: {
                    zh: { type: 'string' },
                    en: { type: 'string' },
                    abbr: { type: 'string' },
                    origins: {
                      type: 'object',
                      properties: {
                        zh: { type: 'string', enum: ['literature', 'ai'] },
                        en: { type: 'string', enum: ['literature', 'ai'] },
                        abbr: { type: 'string', enum: ['literature', 'ai'] }
                      }
                    },
                    origin: { type: 'string', enum: ['literature', 'ai'] },
                    sources: { type: 'array', items: { type: 'object' } }
                  }
                }
              },
              sources: {
                type: 'array',
                description: 'Sources for every term of this concept that names none of its own.',
                items: {
                  type: 'object',
                  properties: {
                    itemKey: { type: 'string' },
                    chunkIdSnapshot: { type: 'integer', minimum: 0 },
                    excerpt: { type: 'string' }
                  },
                  required: ['itemKey']
                }
              }
            }
          }
        }
      },
      required: ['concepts']
    }
  },
  {
    name: 'wiki_list_concepts',
    category: 'wiki',
    description: 'List the independent concept library: every concept entity with its primary term, its alias terms (each as Chinese name / English name / abbreviation) and the documents each term was recognised in. Read this before recording concepts to see what the library already knows.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        query: {
          type: 'string',
          description: 'Optional filter matched against every term of every concept.'
        },
        limit: { type: 'integer', minimum: 1, maximum: 500 }
      }
    }
  },
  {
    name: 'wiki_export_concepts',
    category: 'wiki',
    description: 'Export the whole concept library as Markdown: one section per concept, a 序号 / 中文术语 / 英文术语 / 简称 table of its primary and alias terms, and the source documents behind each numbered term. The same content is appended to wiki_export.',
    inputSchema: {
      type: 'object',
      properties: { libraryID: { type: 'number' } }
    }
  },
  {
    name: 'wiki_reverify',
    category: 'wiki',
    description: 'Relink pending or stale Evidence against the current search index: exact chunk hash first, then same-item excerpt relocation. Only a genuinely deleted Zotero source becomes source_deleted.',
    inputSchema: {
      type: 'object',
      properties: { libraryID: { type: 'number' } }
    }
  },
  {
    name: 'wiki_build_from_paper',
    category: 'wiki',
    description: [
      'Read ONE explicitly user-requested Zotero paper for a Wiki build. Never call automatically or in a batch. It invokes no LLM and writes no Wiki content.',
      '',
      'TWO PHASES. The first call names the paper (itemKey, DOI, URL or title) and returns NO body text: it returns the metadata and abstract and asks you to generate this paper\'s expert reader with wiki_set_reading_expert. Chunks start only after that. This order is deliberate — a persona written after reading half the paper just describes what you already found.',
      '',
      'PAGING. Once the expert exists, each call returns one page of chunks and the reading note as it currently stands. Pass cursor set to pagination.nextCursor from the previous response and change nothing else. pagination reports totalChunks, the range just returned, deliveredChunks / remainingChunks, readChunkRanges and unreadChunkRanges, a coverageMap drawn as filled and hollow squares, and coverageComplete once every chunk has been delivered.',
      '',
      'IT CONTINUES WHATEVER QUESTIONS ALREADY READ. If the user has been asking about this paper, part of it is already read and it already has a reading note. This does not start over: the same session, the same chunk ledger and the same note carry forward, and paging walks the chunks NOBODY HAS READ rather than the paper front to back. A page can therefore be discontinuous — 41-44 then 46-60, with 45 left out because a question already read it. Read pagination.deliveredChunkIndexes, not the range, when you attribute an excerpt to a chunk; pagination.skippedAlreadyReadChunkIndexes names what was left out, and its content is already in the reading note with its chunk citations. To see a skipped chunk again, ask for it by offset. carriedOverFromQuestionAnswering says how much was inherited. Extend the existing note — never replace it with a fresh summary, and keep the chunk citations already in it. The one thing still asked for is a deliberate expert profile: the reader a question assembled on the fly is provisional, and reading a paper end to end deserves a considered one.',
      '',
      'INTEGRATION GATE. After each page, rewrite the WHOLE reading note with wiki_update_reading_note — merging the new text into one continuous account of the paper and correcting whatever the new text overtakes. Do not write per-page notes: "new in chunks 8-15" headings are refused. At most one delivered batch may be outstanding; asking for another page while two are is refused. A batch that genuinely adds nothing can be answered with unchanged: true and unchangedReason, but not twice in a row. Re-reading a chunk you were already given (to quote Evidence) is free and never counts against the gate.',
      '',
      'ONE PAPER AT A TIME. Starting a different paper while this one is unfinished is refused. Finish the open one first through the fixed chain: read it out; rewrite the note with finalSynthesis true; call wiki_record_concepts with final true; call wiki_prepare_update with the five-axis Wiki Review covering pages, claims, evidence, concepts and relations; then wiki_commit. Or use wiki_finish_reading with outcome "skipped" to close it without a Wiki write.',
      '',
      'READ DEPTH. Evidence submitted with read_depth paper_reviewed or cross_paper is stored at section_read unless BOTH pagination.coverageComplete is true for that paper AND the whole-paper final synthesis has been recorded. Delivery is not understanding. Coverage accumulated by answering questions never qualifies on its own, however complete it becomes: only a full-text read can do the synthesis, and only the synthesis unlocks whole-paper depth.',
      '',
      'THIS IS NOT THE TOOL FOR ANSWERING A QUESTION. It reads one paper end to end, on explicit user request, and takes the library\'s single reading slot while it does. To answer a question, use hybrid_search then search_fulltext, and record what you actually read with wiki_update_reading_note and readChunkIds — that path takes no slot, works across several papers at once, and feeds this same note.',
      '',
      'RESUMING. The reading note lives as a Markdown attachment on the Zotero item, so a restart, a dropped connection or a context compaction loses nothing. Call this tool without a cursor (or wiki_get_reading_note) and it hands back the note, the expert and the chunk to resume at.',
      '',
      'includeAllChunks has been removed. It returned an entire paper in one response and made long papers unreadable; calling with it now returns an error explaining the paged replacement.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        userRequested: { type: 'boolean' },
        itemKey: { type: 'string' },
        doi: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        cursor: {
          type: 'string',
          description: 'pagination.nextCursor from the previous call, to continue reading the same paper.'
        },
        offset: {
          type: 'number',
          description: '0-based chunk index to start this page at. Prefer cursor. Use it to re-read a chunk when quoting Evidence.'
        },
        limit: {
          type: 'number',
          description: `Chunks per page, 1 to ${MAX_DOCUMENT_CHUNKS_PER_PAGE} (default ${DEFAULT_DOCUMENT_CHUNKS_PER_PAGE}).`
        },
        includeReadingNote: {
          type: 'boolean',
          description: 'Return the reading note markdown with this page. Defaults to true when no cursor was passed (which is what resuming looks like) and false while paging.'
        }
      },
      required: ['userRequested']
    }
  },
  {
    name: 'wiki_set_reading_expert',
    category: 'wiki',
    description: [
      'Generate the one domain expert who reads the paper currently open for Wiki reading, from its title, metadata and abstract, and create its persistent Markdown reading note on the Zotero item.',
      '',
      'Called once per paper, before any body text is delivered. persona says who is reading it — field, sub-speciality, what they already know that lets them judge this work. focus lists 2 to 8 things this paper in particular makes worth watching for.',
      '',
      'focus sets PRIORITY, never scope. The server attaches a standing mandate you cannot edit: anything important the paper establishes outside those areas must be captured too and flagged as outside the initial focus. An expert who only ever finds what they were looking for has not read the paper.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        itemKey: {
          type: 'string',
          description: 'Optional guard: fails if a different paper is the open one.'
        },
        persona: {
          type: 'string',
          description: "Who is reading this paper and why they are the right reader for it. At least 20 characters."
        },
        focus: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 8,
          description: 'What this paper in particular makes worth watching for.'
        }
      },
      required: ['persona', 'focus']
    }
  },
  {
    name: 'wiki_update_reading_note',
    category: 'wiki',
    description: [
      'Replace a paper\'s reading note with your current understanding of the whole paper. This is how reading is actually recorded, in BOTH ways a paper gets read: batch by batch during a wiki_build_from_paper pass, and passage by passage while answering the user\'s questions.',
      '',
      'AFTER ANSWERING A QUESTION FROM A PAPER, CALL THIS. Retrieval gave you passages; you read some of them and used them to answer. Send itemKey, readChunkIds (the chunkId of every passage you ACTUALLY read and used — never the ones you skimmed past or that turned out irrelevant), the domain and expertRole you gave search_fulltext, and the whole rewritten note. Those chunks are then recorded as read for that paper, and the note becomes the long-term memory of everything the library has ever learned from it. Do this for EVERY paper the turn genuinely read: three papers read means three calls. Then update the Wiki from what you wrote. Retrieval is not reading, so a chunk you did not use must not be listed — the count it feeds is what the server will and will not stand behind.',
      '',
      'ORDER IS FIXED: note first, Wiki second. A paper whose last reading is still only in its note refuses to be read again until a wiki_commit cites it. The note is where understanding accumulates; the Wiki is where it becomes usable by anything other than this conversation.',
      '',
      'CITE THE CHUNKS IN THE TEXT. Every fact, parameter, result, mechanism and figure in the note names the chunk it came from, written in the prose — "melt-pool depth reaches 1.2 mm (chunk 42)". Without the number the trail back to the source is lost, and a Claim built on this note still has to quote the paper\'s own chunk. Citations go in sentences, never in headings: a heading naming chunks is a page log and is refused separately.',
      '',
      'IT ONLY GROWS. This note is a progressive reading, not a summary that gets re-summarised. Restructure it, merge duplicated passages, correct what later text overtakes — but a confirmed fact, with its chunk citation, stays until the paper itself contradicts it. A rewrite that loses more than a tenth of the note is refused, because the failure this catches is invisible one turn at a time: compress a little every turn and by the twentieth question everything read on page 3 is gone.',
      '',
      'SEND THE WHOLE NOTE, every time. Not a diff, not only the new part. Rewriting is the point: add, delete, merge, move, correct. When a later section overturns something an earlier one implied, rewrite that passage rather than leaving both standing. The note must always read as one continuous, self-consistent account of the paper.',
      '',
      'NOT A PAGE LOG. Headings like "Chunks 8-15", "本页新增" or "New in this batch" are refused with the offending lines named. Chunks are how the text is transported; they are not a way to organise knowledge.',
      '',
      'NO FIXED TEMPLATE. Structure it as this paper deserves, but keep what a reader would need to reproduce the work: research question, materials and objects, the full method chain, models/equations and their parameters, experimental conditions, key results, mechanisms, variable relationships, validation, contribution, scope and limits. Do not compress the method chain into a summary sentence.',
      '',
      'unchanged: true (with unchangedReason) records that a batch — references, acknowledgements, a repeated caption — leaves the account intact. It cannot be used twice in a row and cannot be used for the final synthesis.',
      '',
      'CITE PER BLOCK, NOT PER DOCUMENT. Every paragraph and every bullet that states a fact, a parameter, a result, a mechanism or a conclusion names the chunk it came from. One citation somewhere in the note no longer satisfies this. The number also has to resolve: a chunk this paper actually has, and one this reading has actually been given. Cite the number the page reported — chunkIndex and chunkId are both accepted.',
      '',
      'WHEN A SENTENCE NAMES SEVERAL CHUNKS, EACH ONE HAS TO CARRY IT ON ITS OWN. Two chunks discussing the same instrument are not joint support for a sentence about what that instrument achieves; they are two facts, and fusing them states a relationship neither chunk asserts. If one of the chunks only shares the topic, leave it out and make the sentence smaller. Prefer one mechanism per sentence over one elegant sentence per section.',
      '',
      'KEEP THE PAPER\'S OWN STRENGTH. This is the failure that survives a complete reading, so it is worth stating flatly: do not convert "difficult" into "cannot", "can be a solution" into "eliminates", "notably unique" into "irreplaceable", "high efficiency" into "maximises", "proposed" or "preliminary" into a finished capability, or "may" into "will". Do not widen a subject: a capability demonstrated for one imaging mode is not a capability of the whole technique family, and the family\'s merits are not that one mode\'s. Do not drop the limits — a difficulty, a failure condition, a boundary, a negative result, an item in a numbered list of essential points — because they are what makes the rest usable. A number keeps the conditions it was measured or calculated under.',
      '',
      'finalSynthesis: true is the whole-paper pass, available only once every chunk has been delivered THROUGH A FULL-TEXT READ. It is followed by wiki_record_concepts final true, then wiki_prepare_update with the five-axis Wiki Review, then wiki_commit. It is required before the terminology final pass or Wiki write-up can begin, and before Evidence can be stored at paper_reviewed or cross_paper depth. It is refused on a paper read only by questions, however much of it they have accumulated: whole-paper depth names an act — reading it through, then reconciling it as one thing — that scattered passages never perform. Open it with wiki_build_from_paper, which continues this same note and asks only for what questions never reached.',
      '',
      'THE FINAL SYNTHESIS IS CHECKED AGAINST THE CHUNKS BEFORE IT IS WRITTEN, and that pass alone is — the batch integrations are not. The server reads the note you submit and lists back every sentence that reaches: absolute wording, a direction or a number, a negation, several chunks fused into one claim, a technique named that appears in none of the chunks it cites, a flat statement whose source hedged, an enumeration shorter than the one it summarises. Nothing is written on that call. You then either (a) send synthesisAudit with a VERBATIM quotation from each chunk that sentence cites — copied out of the chunk, not out of your note — or (b) rewrite the sentence at the strength the paper used, which removes it from the list and costs nothing. Option (b) is usually the right one. Deciding whether a quotation actually supports a sentence is yours; the server only checks that the quotation is really in that chunk, character for character.',
      '',
      'The note is your reading memory, never Evidence. Claims still need excerpts quoted from the paper\'s own chunks — and wiki_commit refuses an excerpt from a chunk that was never recorded as read here, which is the other half of "note first, Wiki second".'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        itemKey: {
          type: 'string',
          description: 'Optional guard: fails if a different paper is the open one.'
        },
        markdown: {
          type: 'string',
          description: 'The ENTIRE reading note as it now stands. The machine-maintained metadata block is written by the server; anything you include of it is ignored.'
        },
        unchanged: {
          type: 'boolean',
          description: 'This batch leaves the account of the paper intact. Requires unchangedReason; not allowed twice in a row.'
        },
        unchangedReason: {
          type: 'string',
          description: 'What was in the batch that changes nothing.'
        },
        finalSynthesis: {
          type: 'boolean',
          description: 'The whole-paper pass, once every chunk has been delivered by a full-text read. Not available on a paper read only through questions. The note submitted with it is checked sentence by sentence against the chunks it cites before anything is written; see synthesisAudit.'
        },
        synthesisAudit: {
          type: 'array',
          description: 'Proof for the sentences the final-synthesis check flagged. Send it only on a finalSynthesis call, and only after a previous call listed those sentences — the list names them exactly, and an entry matching no flagged sentence is reported back rather than ignored. One entry per sentence you chose to keep as written; omit entries for sentences you rewrote instead, since a rewritten sentence is re-checked and usually is not flagged at all.',
          items: {
            type: 'object',
            properties: {
              sentence: {
                type: 'string',
                description: 'The sentence exactly as it stands in the markdown you are submitting on THIS call. Matched after whitespace normalisation, so reformatting is safe but rewording is not — if you reworded it, drop the entry and let the check re-read it.'
              },
              support: {
                type: 'array',
                description: 'One quotation per chunk the sentence cites. All of them are required: a sentence citing three chunks needs three quotations, because each cited chunk has to carry the sentence on its own. If a chunk cannot carry it, remove that chunk from the citation rather than quoting around it.',
                items: {
                  type: 'object',
                  properties: {
                    chunkId: { type: 'integer', minimum: 0, description: 'The chunk this quotation is copied from.' },
                    quote: { type: 'string', description: 'VERBATIM text from that chunk, at least 40 characters. Copy it from the chunk itself — re-reading a chunk you were already given is free and does not count against the integration gate — never from the reading note, which is your paraphrase. It is checked character for character after whitespace normalisation, exactly as Evidence excerpts are, and a near miss is refused with the divergence pointed out.' }
                  },
                  required: ['chunkId', 'quote']
                }
              }
            },
            required: ['sentence', 'support']
          }
        },
        readChunkIds: {
          type: 'array',
          items: { type: 'integer', minimum: 0 },
          description: 'The chunkId of every passage you ACTUALLY read and used to answer this turn, from search_fulltext or get_document_chunks on this same paper. Sending them is what records reading; retrieval alone records nothing. List only what you used — a passage that came back and was skimmed past is not reading, and this count is what the server will stand behind. Repeats are free and never double-counted, so re-reading a chunk to check a quotation costs nothing. Omit entirely while paging through wiki_build_from_paper: those chunks were booked when they were handed over.'
        },
        domain: {
          type: 'string',
          description: 'The discipline and sub-field you read this paper as, the same one you passed to search_fulltext. Used to give a question-driven reading a reader, so you are not asked to compose a persona per question. Ignored once the paper has a deliberate expert profile.'
        },
        expertRole: {
          type: 'string',
          description: 'The specialist perspective you read it from, the same one you passed to search_fulltext.'
        }
      },
      required: []
    }
  },
  {
    name: 'wiki_get_reading_note',
    category: 'wiki',
    description: 'Read back a paper\'s Wiki reading note, its expert profile and its exact reading progress. This is the recovery path: after a Zotero restart, an MCP disconnect or a context compaction, call it to get the note, the expert and the chunk index to resume at, then continue with wiki_build_from_paper — never start the paper over. Without itemKey it reports the paper currently open in the library.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        itemKey: {
          type: 'string',
          description: 'A specific paper, open or already finished. Omit for whatever is open.'
        },
        includeMarkdown: {
          type: 'boolean',
          description: 'Include the note body. Default true.'
        }
      },
      required: []
    }
  },
  {
    name: 'wiki_finish_reading',
    category: 'wiki',
    description: 'Close the paper currently open for Wiki reading without creating or changing Wiki Pages, Claims, Concepts or relations, so the next paper can be started. Use outcome "skipped" for the normal case — the paper was read and judged not worth a Wiki page — and "failed" when reading could not be completed. Closing the Wiki reading state never depends on Zotero write permission; the tool separately tries to stamp the retained Markdown reading note with the terminal status, and reports noteStatusWrite not_authorized when that Zotero write is unavailable. A paper written up with wiki_commit closes itself and does not need this call.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryID: { type: 'number' },
        itemKey: {
          type: 'string',
          description: 'Optional guard: fails if a different paper is the open one.'
        },
        outcome: { type: 'string', enum: ['skipped', 'failed'] },
        note: { type: 'string', description: 'Why, for the reading log.' }
      },
      required: ['outcome']
    }
  },
  // Write Tools
  {
    name: 'write_note',
    category: 'write',
    description: 'Create or modify Zotero notes. Supports child notes (attached to items), standalone notes, updating, or appending. Markdown is auto-converted to HTML. Confirm with user before writing. EMPTY CONTENT IS AN ERASE, and only action "update" accepts it: passing "" there clears the note (the note itself remains — delete it in Zotero if it should be gone), and the response reports cleared: true with how many characters were erased. create and append refuse empty content, because there it can only mean your content generation came back empty.',
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
          description: 'Note content in HTML or Markdown format. Markdown is auto-converted to HTML for Zotero storage. Required, and a string: omitting it is an error, and so is passing a number. An EMPTY string is a value rather than an omission and means "erase" — accepted only by action "update", refused by create and append. Whitespace-only counts as empty.'
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
 * The catalog after the feature and Zotero-write gates, which is exactly what
 * `tools/list` serves and exactly what `/capabilities` advertises.
 */
export function filterToolCatalog(options: {
  wikiEnabled?: boolean;
  writeEnabled: boolean;
  mutatingToolNames: ReadonlySet<string>;
}): ToolDefinition[] {
  return buildToolCatalog().filter((tool) => {
    if (options.wikiEnabled === false && WIKI_TOOL_NAMES.has(tool.name)) {
      return false;
    }
    if (!options.writeEnabled && options.mutatingToolNames.has(tool.name)) {
      return false;
    }
    return true;
  });
}
