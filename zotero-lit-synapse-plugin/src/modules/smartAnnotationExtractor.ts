/**
 * Smart Annotation Extractor for Zotero LitSynapse
 * 
 * Handles PDF annotations, highlights, notes with intelligent content management
 * Replaces the overlapping functionality of:
 * - get_annotation_by_id
 * - get_annotations_batch
 * - get_item_notes 
 * - complex search_annotations
 */

import { AnnotationService } from './annotationService';

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

/**
 * Maximum marks one page may return, whatever the caller asks for.
 *
 * A well-read PDF holds hundreds of highlights, so full-text responses remain
 * paged even though individual marks are no longer shortened.
 */
export const MAX_ANNOTATIONS_PER_PAGE = 100;

export function resolveAnnotationPageSize(
  requested: unknown,
  fallback: number,
): number {
  const value = Number(requested);
  if (!Number.isFinite(value) || value < 1) {
    return Math.min(MAX_ANNOTATIONS_PER_PAGE, Math.max(1, fallback));
  }
  return Math.min(MAX_ANNOTATIONS_PER_PAGE, Math.floor(value));
}

/** Every itemKey the caller named, in one list, de-duplicated. */
export function resolveAnnotationItemKeys(params: {
  itemKey?: unknown;
  itemKeys?: unknown;
}): string[] {
  const keys: string[] = [];
  if (Array.isArray(params.itemKeys)) {
    for (const key of params.itemKeys) {
      if (typeof key === 'string' && key.trim()) keys.push(key.trim());
    }
  }
  if (typeof params.itemKey === 'string' && params.itemKey.trim()) {
    keys.push(params.itemKey.trim());
  }
  return Array.from(new Set(keys));
}

/** True only when a search parameter has a non-empty filtering value. */
export function hasEffectiveAnnotationSearchFilter(params: {
  q?: unknown;
  colors?: unknown;
  tags?: unknown;
}): boolean {
  if (typeof params.q === 'string' && params.q.trim().length > 0) return true;
  for (const values of [params.colors, params.tags]) {
    if (
      Array.isArray(values) &&
      values.some(
        (value) => typeof value === 'string' && value.trim().length > 0,
      )
    ) {
      return true;
    }
  }
  return false;
}

export interface SmartAnnotationOptions {
  libraryID?: number;
  types?: string[];
  colors?: string[];    // Filter by annotation colors (e.g., ['#ffd400', '#ff6666'])
  tags?: string[];      // Filter by tags
  minRelevance?: number;
  limit?: number;
  offset?: number;
}

export interface AnnotationResult {
  id: string;
  type: 'note' | 'highlight' | 'annotation' | 'ink' | 'text' | 'image';
  content: string;
  color?: string;        // Annotation color (hex code like '#ffd400')
  colorName?: string;    // Human-readable color name
  tags?: string[];       // Tags attached to this annotation
  importance?: number;
  keywords?: string[];
  page?: number;
  dateModified: string;
  itemKey: string;
  /** This mark's own key, for get_annotations(annotationIds). */
  annotationKey: string;
  /**
   * The PDF/attachment the mark sits on. Absent for notes.
   *
   * Attachment keys are not item keys. This one exists so a caller that
   * genuinely wants the file can have it, and so nothing has to overload
   * `sourceItemKey` to carry it.
   */
  attachmentKey?: string;
  /**
   * The document this mark was read from, and the key to continue with.
   *
   * Authoritative: hand it straight to get_annotations(itemKeys),
   * get_item_details, search_fulltext or get_document_chunks. Before this
   * existed the only key on a row was `parentKey`, which was the attachment
   * key for a highlight and the item key for a note -- one field, two
   * meanings, and every document-level tool silently found nothing when handed
   * the wrong one.
   *
   * Null for a mark with no document above it, rather than a stand-in that
   * those same tools would reject just as quietly.
   */
  sourceItemKey: string | null;
  /** Set exactly when sourceItemKey is null. */
  noSourceItemReason?: 'standalone_note' | 'standalone_attachment';
}

export interface SmartAnnotationResponse {
  includedCount: number;
  metadata: {
    extractedAt: string;
    processingTime: string;
    /** Every document this page's marks were read from, in the order asked. */
    sourceItemKeys?: string[];
    /** Set when the candidate set hit the safety limit before ranking. */
    warning?: string;
    /** Every source that could not be read or was truncated. */
    warnings?: string[];
    pagination?: {
      total: number;          // 总结果数
      offset: number;         // 当前偏移量
      limit: number;          // 当前限制
      hasMore: boolean;       // 是否有更多结果
      nextOffset?: number;    // 下一页偏移量（如果有更多）
    };
    stats: {
      foundCount: number;     // 找到的原始数量
      filteredCount: number; // 过滤后数量
      returnedCount: number; // 实际返回数量
    };
  };
  data: AnnotationResult[];
}

export class SmartAnnotationExtractor {
  private annotationService: AnnotationService;

  // Common Zotero annotation colors with their names
  private static readonly COLOR_MAP: Record<string, string[]> = {
    '#ffd400': ['yellow', 'question', '黄色'],
    '#ff6666': ['red', 'error', 'important', '红色'],
    '#5fb236': ['green', 'agree', '绿色'],
    '#2ea8e5': ['blue', 'info', '蓝色'],
    '#a28ae5': ['purple', 'definition', '紫色'],
    '#e56eee': ['magenta', 'pink', '粉色'],
    '#f19837': ['orange', 'todo', '橙色'],
    '#aaaaaa': ['gray', 'grey', '灰色'],
  };

  constructor() {
    this.annotationService = new AnnotationService();
  }

  /**
   * Match color by hex code or name
   */
  private matchColor(annotationColor: string, filterColor: string): boolean {
    if (!annotationColor) return false;

    const normalizedAnnotationColor = annotationColor.toLowerCase();
    const normalizedFilter = filterColor.toLowerCase();

    // Direct hex match
    if (normalizedAnnotationColor === normalizedFilter) {
      return true;
    }

    // Name-based matching
    for (const [hexColor, names] of Object.entries(SmartAnnotationExtractor.COLOR_MAP)) {
      if (normalizedAnnotationColor === hexColor) {
        // Check if filter matches any name for this color
        if (names.some(name => name.includes(normalizedFilter) || normalizedFilter.includes(name))) {
          return true;
        }
      }
      // Also check if filter is a hex code that matches
      if (normalizedFilter === hexColor && normalizedAnnotationColor === hexColor) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get human-readable color name from hex code
   */
  private getColorName(hexColor: string): string {
    if (!hexColor) return '';
    const normalizedHex = hexColor.toLowerCase();
    const names = SmartAnnotationExtractor.COLOR_MAP[normalizedHex];
    return names ? names[0] : hexColor;
  }

  /**
   * Read the marks on documents the caller already names.
   *
   * `itemKeys` reads ALL of them. It used to accept the parameter and then use
   * `itemKeys?.[0]`, so "compare my highlights across these five papers"
   * quietly answered about the first paper and looked like a complete answer.
   */
  async getAnnotations(params: {
    libraryID?: number;
    itemKey?: string;
    itemKeys?: string[];
    annotationId?: string;
    annotationIds?: string[];
    types?: string[];
    colors?: string[];      // Filter by colors (e.g., ['#ffd400', 'yellow'])
    tags?: string[];        // Filter by tags
    limit?: number;
    offset?: number;
  }): Promise<SmartAnnotationResponse> {
    const startTime = Date.now();

    try {
      ztoolkit.log(`[SmartAnnotationExtractor] getAnnotations called with params: ${JSON.stringify(params)}`);

      const itemKeys = resolveAnnotationItemKeys(params);

      const options: SmartAnnotationOptions = {
        libraryID: params.libraryID,
        types: params.types || ['note', 'highlight', 'annotation'],
        colors: params.colors,  // Color filter (hex codes or names)
        tags: params.tags,      // Tag filter
        limit: resolveAnnotationPageSize(params.limit, 20),
        offset: params.offset || 0
      };

      let annotations: any[] = [];
      const warnings: string[] = [];

      // Route to different retrieval methods
      if (params.annotationId) {
        annotations = await this.getById(params.annotationId, options.libraryID);
      } else if (params.annotationIds) {
        annotations = await this.getByIds(params.annotationIds, options.libraryID);
      } else if (itemKeys.length > 0) {
        for (const key of itemKeys) {
          // Rows arrive with sourceItemKey already resolved from the item
          // hierarchy by AnnotationService, which is the authority. Stamping
          // the requested key over it here would paper over a mismatch rather
          // than surface it.
          const retrieved = await this.getByItem(key, options);
          annotations.push(...retrieved.annotations);
          warnings.push(...retrieved.warnings);
        }
      } else {
        throw new Error('Must provide itemKeys, itemKey, annotationId, or annotationIds');
      }

      // Apply type filtering
      if (options.types && options.types.length > 0) {
        annotations = annotations.filter(ann => options.types!.includes(ann.type));
      }

      // Apply color filtering
      if (options.colors && options.colors.length > 0) {
        annotations = annotations.filter(ann => {
          if (!ann.color) return false;
          return options.colors!.some(filterColor =>
            this.matchColor(ann.color, filterColor)
          );
        });
      }

      // Apply tag filtering
      if (options.tags && options.tags.length > 0) {
        annotations = annotations.filter(ann => {
          if (!ann.tags || ann.tags.length === 0) return false;
          return options.tags!.some(filterTag =>
            ann.tags.some((tag: string) => tag.toLowerCase().includes(filterTag.toLowerCase()))
          );
        });
      }

      // Paginate before formatting so full-text marks stay bounded by count.
      const totalCount = annotations.length;
      const paginatedAnnotations = annotations.slice(
        options.offset!,
        options.offset! + options.limit!,
      );

      // Format every mark in full; pagination is the response-size guard.
      const processed = this.processAnnotations(paginatedAnnotations);

      const processingTime = `${Date.now() - startTime}ms`;
      ztoolkit.log(`[SmartAnnotationExtractor] Completed in ${processingTime}, processed ${processed.includedCount} of ${totalCount} annotations (paginated: ${paginatedAnnotations.length})`);

      // Calculate pagination info
      const hasMore = options.offset! + options.limit! < totalCount;
      const nextOffset = hasMore ? options.offset! + options.limit! : undefined;

      return {
        ...processed,
        metadata: {
          extractedAt: new Date().toISOString(),
          sourceItemKeys: itemKeys,
          ...(warnings.length > 0 ? { warnings } : {}),
          processingTime,
          pagination: {
            total: totalCount,
            offset: options.offset!,
            limit: options.limit!,
            hasMore,
            nextOffset
          },
          stats: {
            foundCount: totalCount,
            filteredCount: paginatedAnnotations.length,
            returnedCount: processed.includedCount
          }
        }
      };

    } catch (error) {
      ztoolkit.log(`[SmartAnnotationExtractor] Error in getAnnotations: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * Search the library's marks, ranking the whole candidate set.
   *
   * Two things were wrong with the retrieval here, and they compounded.
   *
   * The query path asked AnnotationService for `limit: '100'` and then scored,
   * filtered, sorted and paginated whatever came back. The comment called it
   * "get more results to score and filter", but 100 is not "more" — it is a
   * hard cut applied BEFORE ranking, by relevance the ranker had not computed
   * yet. In a library with 400 matching highlights the best one was routinely
   * outside the window, and the caller was handed a confidently ranked page
   * that had never seen it. Ranking a truncated candidate set is worse than
   * not ranking at all, because the output looks authoritative.
   *
   * The filter-only path did the opposite and paged through everything in
   * batches of 100, which is correct but was written separately.
   *
   * Both paths now request the full candidate set the same way, and the only
   * truncation left is the page the caller actually asked for, applied after
   * ranking.
   */
  async searchAnnotations(query: string, options: {
    libraryID?: number;
    itemKeys?: string[];
    itemKey?: string;
    types?: string[];
    colors?: string[];      // Filter by colors
    tags?: string[];        // Filter by tags
    minRelevance?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<SmartAnnotationResponse> {
    const startTime = Date.now();

    try {
      ztoolkit.log(`[SmartAnnotationExtractor] searchAnnotations called: "${query || '(filter only)'}"`);

      const hasQuery = Boolean(query && query.trim().length > 0);
      const itemKeys = resolveAnnotationItemKeys(options);

      const searchOptions: SmartAnnotationOptions = {
        libraryID: options.libraryID,
        types: options.types || ['note', 'highlight', 'annotation'],
        colors: options.colors,  // Color filter
        tags: options.tags,      // Tag filter
        minRelevance: hasQuery ? (options.minRelevance ?? 0.1) : 0, // No relevance filter when no query
        limit: resolveAnnotationPageSize(options.limit, 15),
        offset: options.offset || 0
      };

      // EVERY candidate in scope, then rank, then page. `itemKeys` is scanned
      // in full — using only the first one, as this did, silently answered
      // about one document while reporting on all of them.
      const scopes: Array<string | undefined> =
        itemKeys.length > 0 ? itemKeys : [undefined];
      const annotations: any[] = [];
      let truncated = false;
      const warnings = new Set<string>();

      for (const scopeItemKey of scopes) {
        const batchSize = 100;
        let currentOffset = 0;
        let more = true;
        while (more) {
          const batchResult = await this.annotationService.searchAnnotations({
            libraryID: searchOptions.libraryID,
            ...(hasQuery ? { q: query } : {}),
            ...(scopeItemKey ? { itemKey: scopeItemKey } : {}),
            type: searchOptions.types,
            limit: String(batchSize),
            offset: String(currentOffset),
          });
          // Same as above: AnnotationService resolves sourceItemKey from the
          // hierarchy, including for the unscoped library-wide search where
          // there is no requested key to fall back on.
          const batch = batchResult.results || [];
          annotations.push(...batch);
          for (const warning of batchResult.warnings ?? []) {
            warnings.add(String(warning));
          }

          more = batchResult.pagination?.hasMore || false;
          currentOffset += batchSize;

          // Safety limit to prevent an unbounded loop on a corrupt count.
          // Reaching it is reported rather than hidden, because a ranking over
          // a truncated candidate set is exactly the failure above.
          if (currentOffset > 10000) {
            ztoolkit.log(`[SmartAnnotationExtractor] Reached safety limit of 10000 annotations`);
            truncated = true;
            warnings.add(
              'The candidate set hit the 10000-annotation safety limit, so this ranking may not have seen every matching mark. Narrow the search with itemKeys, colors or tags.',
            );
            break;
          }
        }
      }

      ztoolkit.log(`[SmartAnnotationExtractor] Collected ${annotations.length} candidate annotations across ${scopes.length} scope(s)`);

      // Debug: log annotation colors
      ztoolkit.log(`[SmartAnnotationExtractor] Got ${annotations.length} annotations, checking colors...`);
      const colorCounts: Record<string, number> = {};
      annotations.forEach(ann => {
        const c = ann.color || '(no color)';
        colorCounts[c] = (colorCounts[c] || 0) + 1;
      });
      ztoolkit.log(`[SmartAnnotationExtractor] Color distribution: ${JSON.stringify(colorCounts)}`);

      // Apply relevance scoring and filtering (only when query exists)
      let scoredAnnotations = annotations.map(ann => ({
        ...ann,
        relevance: hasQuery ? this.calculateRelevance(ann, query) : 1.0, // All relevant when no query
        importance: this.calculateImportance(ann)
      })).filter(ann => ann.relevance >= searchOptions.minRelevance!);

      // Apply color filtering
      if (searchOptions.colors && searchOptions.colors.length > 0) {
        ztoolkit.log(`[SmartAnnotationExtractor] Filtering by colors: ${JSON.stringify(searchOptions.colors)}`);
        const beforeCount = scoredAnnotations.length;
        scoredAnnotations = scoredAnnotations.filter(ann => {
          const color = ann.color;
          if (!color) return false;
          const matches = searchOptions.colors!.some(filterColor =>
            this.matchColor(color, filterColor)
          );
          return matches;
        });
        ztoolkit.log(`[SmartAnnotationExtractor] Color filter: ${beforeCount} -> ${scoredAnnotations.length} annotations`);
      }

      // Apply tag filtering
      if (searchOptions.tags && searchOptions.tags.length > 0) {
        scoredAnnotations = scoredAnnotations.filter(ann => {
          if (!ann.tags || ann.tags.length === 0) return false;
          return searchOptions.tags!.some(filterTag =>
            ann.tags.some((tag: string) => tag.toLowerCase().includes(filterTag.toLowerCase()))
          );
        });
      }

      // Sort by combined relevance and importance
      scoredAnnotations.sort((a, b) => {
        const scoreA = (a.relevance * 0.7) + (a.importance * 0.3);
        const scoreB = (b.relevance * 0.7) + (b.importance * 0.3);
        return scoreB - scoreA;
      });

      // Page AFTER ranking, so the page is the top of the whole candidate set
      // rather than the top of an arbitrary first hundred.
      const totalCount = scoredAnnotations.length;
      const paginatedAnnotations = scoredAnnotations.slice(
        searchOptions.offset!,
        searchOptions.offset! + searchOptions.limit!,
      );

      // Format every mark in full; pagination is the response-size guard.
      const processed = this.processAnnotations(paginatedAnnotations);

      const processingTime = `${Date.now() - startTime}ms`;
      ztoolkit.log(`[SmartAnnotationExtractor] Search completed in ${processingTime}, found ${processed.includedCount} relevant results of ${totalCount} total (paginated: ${paginatedAnnotations.length})`);

      // Calculate pagination info
      const hasMore = searchOptions.offset! + searchOptions.limit! < totalCount;
      const nextOffset = hasMore ? searchOptions.offset! + searchOptions.limit! : undefined;

      return {
        ...processed,
        metadata: {
          extractedAt: new Date().toISOString(),
          sourceItemKeys: itemKeys,
          ...(warnings.size > 0 ? { warnings: Array.from(warnings) } : {}),
          ...(truncated
            ? {
                warning:
                  'The candidate set hit the 10000-annotation safety limit, so this ranking may not have seen every matching mark. Narrow the search with itemKeys, colors or tags.',
              }
            : {}),
          processingTime,
          pagination: {
            total: totalCount,
            offset: searchOptions.offset!,
            limit: searchOptions.limit!,
            hasMore,
            nextOffset
          },
          stats: {
            foundCount: annotations.length,
            filteredCount: totalCount, // 已过滤过相关性的数量
            returnedCount: processed.includedCount
          }
        }
      };

    } catch (error) {
      ztoolkit.log(`[SmartAnnotationExtractor] Error in searchAnnotations: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * Get annotation by single ID
   */
  private async getById(annotationId: string, libraryID?: number): Promise<any[]> {
    const annotation = await this.annotationService.getAnnotationById(annotationId, libraryID);
    return annotation ? [annotation] : [];
  }

  /**
   * Get annotations by multiple IDs
   */
  private async getByIds(annotationIds: string[], libraryID?: number): Promise<any[]> {
    return await this.annotationService.getAnnotationsByIds(annotationIds, libraryID);
  }

  /**
   * Get annotations by item (PDF annotations + notes)
   */
  private async getByItem(
    itemKey: string,
    options: SmartAnnotationOptions,
  ): Promise<{ annotations: any[]; warnings: string[] }> {
    const annotations: any[] = [];
    const warnings: string[] = [];

    // Get notes if requested
    if (options.types!.includes('note')) {
      try {
        const notes = await this.annotationService.getAllNotes(itemKey, options.libraryID);
        annotations.push(...notes);
      } catch (error) {
        ztoolkit.log(`[SmartAnnotationExtractor] Error getting notes for ${itemKey}: ${error}`, 'warn');
        warnings.push(`Notes for ${itemKey} could not be read: ${error}`);
      }
    }

    // Get PDF annotations if requested
    const pdfTypes = ['highlight', 'annotation', 'ink', 'text', 'image'];
    if (options.types!.some(type => pdfTypes.includes(type))) {
      try {
        const pdfAnnotations = await this.annotationService.getPDFAnnotations(itemKey, options.libraryID);
        // Filter by requested PDF annotation types
        const filteredPdfAnnotations = pdfAnnotations.filter(ann => options.types!.includes(ann.type));
        annotations.push(...filteredPdfAnnotations);
      } catch (error) {
        ztoolkit.log(`[SmartAnnotationExtractor] Error getting PDF annotations for ${itemKey}: ${error}`, 'warn');
        warnings.push(`PDF annotations for ${itemKey} could not be read: ${error}`);
      }
    }

    return { annotations, warnings };
  }

  /** Format one already-paged response without shortening any mark. */
  private processAnnotations(
    annotations: any[],
  ): Pick<SmartAnnotationResponse, 'includedCount' | 'data'> {
    const data = annotations.map((annotation) =>
      this.formatAnnotation({
        ...annotation,
        importance:
          annotation.importance ?? this.calculateImportance(annotation),
      }),
    );

    return {
      includedCount: data.length,
      data,
    };
  }

  /**
   * Calculate importance score for an annotation
   */
  private calculateImportance(annotation: any): number {
    let score = 0;

    // Content length score (longer content is often more important)
    const contentLength = (annotation.content || '').length;
    score += Math.min(contentLength, 500) / 500 * 0.3;

    // Type-based scoring
    const typeScores = { 
      note: 0.4,      // Notes are usually more important
      highlight: 0.3, // Highlights are selective
      annotation: 0.2,
      ink: 0.15,
      text: 0.25,
      image: 0.1
    };
    score += typeScores[annotation.type as keyof typeof typeScores] || 0.2;

    // Has comment (user added thoughts)
    if (annotation.comment && annotation.comment.trim()) {
      score += 0.2;
    }

    // Recency score (more recent = more important)
    const daysSinceModified = (Date.now() - new Date(annotation.dateModified).getTime()) / (1000 * 60 * 60 * 24);
    score += Math.max(0, (30 - daysSinceModified) / 30) * 0.1;

    return Math.min(score, 1.0);
  }

  /**
   * Calculate relevance score for search
   */
  private calculateRelevance(annotation: any, query: string): number {
    const lowerQuery = query.toLowerCase();
    let score = 0;

    // Exact match in content
    if (annotation.content?.toLowerCase().includes(lowerQuery)) {
      score += 0.6;
    }

    // Exact match in comment
    if (annotation.comment?.toLowerCase().includes(lowerQuery)) {
      score += 0.4;
    }

    // Word-based matching
    const queryWords = lowerQuery.split(/\s+/).filter(w => w.length > 1);
    const contentWords = (annotation.content + ' ' + (annotation.comment || '')).toLowerCase().split(/\s+/);
    
    const matches = queryWords.filter(qw => 
      contentWords.some(cw => cw.includes(qw) || qw.includes(cw))
    ).length;
    
    if (queryWords.length > 0) {
      score += (matches / queryWords.length) * 0.3;
    }

    return Math.min(score, 1.0);
  }

  /** Format one annotation without shortening its text. */
  private formatAnnotation(annotation: any): AnnotationResult {
    const originalContent =
      annotation.type === 'note'
        ? annotation.content || annotation.text || ''
        : annotation.text || annotation.content || '';
    const comment = annotation.comment || '';
    const content =
      comment && comment !== originalContent
        ? `${originalContent}\n\nComment: ${comment}`
        : originalContent;
    const base: AnnotationResult = {
      id: annotation.id,
      type: annotation.type,
      content,
      color: annotation.color,
      colorName: this.getColorName(annotation.color),
      tags: annotation.tags || [],
      keywords: this.extractKeywords(content, 8),
      importance: annotation.importance,
      itemKey: annotation.itemKey,
      annotationKey: annotation.annotationKey || annotation.itemKey,
      ...(annotation.attachmentKey
        ? { attachmentKey: annotation.attachmentKey }
        : {}),
      sourceItemKey: annotation.sourceItemKey ?? null,
      ...(annotation.noSourceItemReason
        ? { noSourceItemReason: annotation.noSourceItemReason }
        : {}),
      page: annotation.page,
      dateModified: annotation.dateModified
    };

    return base;
  }

  /**
   * Extract keywords from text
   */
  private extractKeywords(text: string, maxCount: number): string[] {
    if (!text) return [];
    
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      '的', '了', '在', '是', '和', '与', '或', '但', '然而', '因此', '所以', '这', '那', '有', '没有'
    ]);
    
    const words = text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 1 && !stopWords.has(word));
    
    const wordCount = new Map<string, number>();
    words.forEach(word => {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    });
    
    return Array.from(wordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxCount)
      .map(([word]) => word);
  }

}
