/**
 * Semantic Text Chunker for Embedding
 *
 * Splits text into semantically meaningful chunks for embedding generation.
 * Features:
 * - Document structure detection (abstract, sections, references)
 * - Whitespace-only preprocessing: no line is ever dropped for being short,
 *   symbol-heavy, repeated or low-scoring
 * - Sentence-level splitting with semantic boundaries
 * - Support for Chinese and English academic papers
 */

declare let ztoolkit: ZToolkit;

import { getHybridSearchSettings } from '../hybridSearchSettings';

// ============== Interfaces ==============

import { findReferencesBoundary } from "../keyword/contentFilters";

/** A Markdown ATX heading occupying a whole paragraph. */
const HEADING_LINE_PATTERN = /^\s{0,3}#{1,6}\s+\S/;

export interface ChunkerOptions {
  maxChunkSize: number;      // Maximum chunk size (characters)
  minChunkSize: number;      // Minimum chunk size
  overlapSentences: number;  // Number of sentences to overlap
  skipReferences: boolean;   // Skip reference section
  qualityThreshold: number;  // Minimum quality score (0-100)
  /**
   * Target size of a chunk built from Markdown paragraphs. Omit to follow the
   * user's "Chunk target length" preference, which is the normal case.
   */
  targetChunkSize?: number;
  /**
   * A paragraph no longer than this may still be appended to a chunk that has
   * already reached the target; a longer one starts the next chunk. Omit to
   * follow the user's "Paragraph append tolerance" preference.
   */
  appendToleranceSize?: number;
}

export interface TextChunk {
  id: number;
  text: string;
  startPos: number;
  endPos: number;
}

export interface SemanticChunk {
  text: string;
  type: 'abstract' | 'keywords' | 'section' | 'paragraph' | 'references';
  title?: string;
  importance: 'high' | 'normal' | 'low';
  quality: number;
}

interface DocumentStructure {
  hasAbstract: boolean;
  abstractStart?: number;
  abstractEnd?: number;
  hasKeywords: boolean;
  keywordsStart?: number;
  keywordsEnd?: number;
  sections: Array<{ level: number; title: string; position: number }>;
  referencesStart: number | null;
}

interface QualityResult {
  score: number;
  issues: string[];
  shouldIndex: boolean;
}

// ============== Text Quality Preprocessor ==============

export class TextQualityPreprocessor {
  /**
   * Normalise whitespace, and nothing else.
   *
   * This used to delete content: lines whose "valid character" ratio fell
   * below 30%, lines of one or two characters that were not digits, lines
   * repeating more than three times, and — through a whole-document quality
   * score — entire documents. Every one of those rules destroyed real body
   * text. `γ′`, `α`, a bare formula, a two-character section heading and a
   * symbol-heavy table row all look like OCR garbage to a character-ratio
   * test, and are all things a materials paper is actually about.
   *
   * What survives is only what cannot carry meaning: line-ending and
   * whitespace normalisation, control characters, and blank / whitespace-only
   * lines. Blank lines are collapsed rather than removed, because one blank
   * line is what separates two Markdown paragraphs and the chunker splits on
   * exactly that — deleting them would fuse the document into a single
   * paragraph and silently change chunking, which must not change here.
   */
  static process(text: string): { text: string; quality: QualityResult } {
    if (!text || text.trim().length === 0) {
      return {
        text: '',
        quality: { score: 0, issues: ['empty'], shouldIndex: false }
      };
    }

    let processed = text;

    // 1. Normalize whitespace
    processed = processed
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u2000-\u200B]/g, ' ')
      .replace(/ {3,}/g, '  ');

    // 2. Remove control characters (keep newlines)
    // The control characters are the point of this regex: PDF text extraction
    // leaves NUL/backspace/vertical-tab noise that must be stripped before the
    // text is chunked and embedded. \x09 (tab) and \x0A/\x0D (newlines) are
    // deliberately excluded from the class.
    // eslint-disable-next-line no-control-regex
    processed = processed.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // 3. Blank-line cleanup: a whitespace-only line becomes empty, and a run
    //    of blank lines collapses to the single blank line that means
    //    "paragraph break". No line carrying content is ever removed.
    processed = processed
      .replace(/^[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 4. Score the result — for the log only, never as a filter.
    const quality = this.assessQuality(processed);

    return { text: processed, quality };
  }

  /**
   * Score text for diagnostics.
   *
   * `shouldIndex` now answers only "is there anything here at all". The score
   * and the issue list are still produced so a badly OCR'd document shows up
   * in the log, but a low score no longer discards it: a paper the user put in
   * the library is a paper the user wants searchable, and a whole-document
   * threshold was silently dropping exactly the scanned and symbol-heavy
   * papers that most need indexing.
   */
  private static assessQuality(text: string): QualityResult {
    const issues: string[] = [];
    let score = 100;

    if (!text || text.trim().length === 0) {
      return { score: 0, issues: ['empty'], shouldIndex: false };
    }
    if (text.length < 50) issues.push('short_document');

    const noSpace = text.replace(/\s/g, '');

    // 1. Valid character ratio (Chinese + English)
    const validChars = (text.match(/[a-zA-Z\u4e00-\u9fa5]/g) || []).length;
    const validRatio = validChars / Math.max(1, noSpace.length);
    if (validRatio < 0.4) {
      score -= 40;
      issues.push(`low_valid_ratio:${(validRatio * 100).toFixed(0)}%`);
    }

    // 2. Punctuation ratio
    const punct = (text.match(/[，。、；：""''！？…—,.;:!?"'\-()[\]]/g) || []).length;
    const punctRatio = punct / text.length;
    if (punctRatio > 0.25) {
      score -= 30;
      issues.push(`high_punct:${(punctRatio * 100).toFixed(0)}%`);
    }

    // 3. Consecutive punctuation (strong OCR failure indicator)
    if (/[，。、；：,.;:]{4,}/.test(text)) {
      score -= 30;
      issues.push('consecutive_punct');
    }

    // 4. Average line length
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 5) {
      const avgLineLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
      if (avgLineLen < 15) {
        score -= 20;
        issues.push(`short_lines:avg${avgLineLen.toFixed(0)}`);
      }
    }

    return {
      score: Math.max(0, score),
      issues,
      // Content, not quality, decides. The score is advisory.
      shouldIndex: text.trim().length > 0
    };
  }
}

// ============== Semantic Text Chunker ==============

export class TextChunker {
  private options: ChunkerOptions;

  constructor(options: Partial<ChunkerOptions> = {}) {
    this.options = {
      maxChunkSize: options.maxChunkSize || 500,
      minChunkSize: options.minChunkSize || 50,
      overlapSentences: options.overlapSentences || 1,
      skipReferences: options.skipReferences ?? true,
      qualityThreshold: options.qualityThreshold || 30
    };
  }

  /**
   * Resolve the paragraph-assembly sizes for this run.
   *
   * Read per call rather than cached in the constructor: the chunker is a
   * long-lived singleton, and a user who changes the target length in
   * Preferences expects the next index build to use it without restarting.
   */
  private resolveParagraphSizes(): { target: number; tolerance: number } {
    if (
      typeof this.options.targetChunkSize === 'number' &&
      typeof this.options.appendToleranceSize === 'number'
    ) {
      return {
        target: this.options.targetChunkSize,
        tolerance: this.options.appendToleranceSize,
      };
    }
    const settings = getHybridSearchSettings();
    return {
      target: this.options.targetChunkSize ?? settings.chunkTargetChars,
      tolerance:
        this.options.appendToleranceSize ?? settings.chunkAppendToleranceChars,
    };
  }

  /**
   * Main entry: chunk a document into embedding units.
   *
   * Chunks follow the Markdown paragraph structure and are emitted in document
   * order, so a chunk's index is its position in the text and neighbouring
   * chunk ids really are neighbouring passages — that ordering is what the
   * document-level deep dive relies on when it expands context around a hit.
   *
   * The pipeline never drops body text: no minimum-length filter, no
   * per-chunk quality filter, no line-level filter in the preprocessor, and an
   * oversized paragraph is split on complete sentence boundaries rather than
   * truncated. The only content deliberately left out is the references list,
   * when skipReferences is on.
   */
  chunk(text: string): string[] {
    const startTime = Date.now();
    ztoolkit.log(`[TextChunker] Starting: input length=${text?.length || 0}`);

    if (!text || !text.trim()) {
      ztoolkit.log(`[TextChunker] Empty text, returning empty`);
      return [];
    }

    // 1. Preprocess and quality check
    const { text: cleanText, quality } = TextQualityPreprocessor.process(text);

    if (!quality.shouldIndex) {
      ztoolkit.log(`[TextChunker] Quality too low (${quality.score}), skipping: ${quality.issues.join(', ')}`);
      return [];
    }

    if (quality.score < 60) {
      ztoolkit.log(`[TextChunker] Low quality warning: ${quality.score}, issues: ${quality.issues.join(', ')}`);
    }

    // 2. Drop the references list, which is citations rather than body text.
    //
    // The boundary now comes from the shared detector. detectStructure's own
    // pattern required the heading to be alone on a line, but body text arrives
    // as MinerU Markdown where it is written `## References` — so this switch was
    // on by default and had never once fired. Every paper's bibliography was
    // being chunked, embedded and returned as evidence.
    const structure = this.detectStructure(cleanText);
    const referencesAt =
      findReferencesBoundary(cleanText) ?? structure.referencesStart;
    const bodyText =
      this.options.skipReferences && referencesAt
        ? cleanText.substring(0, referencesAt)
        : cleanText;
    ztoolkit.log(`[TextChunker] Structure: abstract=${structure.hasAbstract}, sections=${structure.sections.length}, refs=${structure.referencesStart !== null}, bodyChars=${bodyText.length}`);

    // 3. Markdown paragraphs, in document order
    const paragraphs = this.splitIntoParagraphs(bodyText);

    // 4. Assemble paragraphs into target-sized chunks
    const { target, tolerance } = this.resolveParagraphSizes();
    const result = this.assembleParagraphChunks(paragraphs, target, tolerance);

    const elapsed = Date.now() - startTime;
    const avgSize = result.length > 0
      ? Math.round(result.reduce((a, c) => a + c.length, 0) / result.length)
      : 0;
    ztoolkit.log(`[TextChunker] Done: ${result.length} chunks from ${paragraphs.length} paragraphs, target=${target}, tolerance=${tolerance}, avg size=${avgSize}, time=${elapsed}ms`);

    return result;
  }

  /**
   * Split text into Markdown natural paragraphs, preserving document order.
   *
   * A blank line separates paragraphs; an ATX heading is also a boundary even
   * when the author did not leave a blank line around it, so a section title
   * stays attached to the section it introduces instead of to the previous one.
   */
  private splitIntoParagraphs(text: string): string[] {
    const paragraphs: string[] = [];
    for (const block of text.split(/\n\s*\n+/)) {
      if (!block.trim()) continue;
      // A block may still contain headings glued to body lines.
      let current: string[] = [];
      const flush = () => {
        const joined = current.join('\n').trim();
        if (joined) paragraphs.push(joined);
        current = [];
      };
      for (const line of block.split('\n')) {
        if (/^\s{0,3}#{1,6}\s+\S/.test(line)) {
          flush();
          paragraphs.push(line.trim());
          continue;
        }
        current.push(line);
      }
      flush();
    }
    return paragraphs;
  }

  /**
   * Fill chunks paragraph by paragraph.
   *
   * While a chunk is still below the target it keeps taking paragraphs. Once it
   * reaches the target, exactly one more paragraph may join it if that
   * paragraph is within the append tolerance — a short closing paragraph is
   * better kept with its context than stranded alone — and anything longer
   * starts the next chunk. That bounds a chunk at target + tolerance.
   */
  private assembleParagraphChunks(
    paragraphs: string[],
    target: number,
    tolerance: number,
  ): string[] {
    const chunks: string[] = [];
    let buffer = '';

    const flush = () => {
      const trimmed = buffer.trim();
      if (trimmed) chunks.push(trimmed);
      buffer = '';
    };
    /**
     * Whether the open chunk is nothing but heading lines.
     *
     * `## 2. Method` immediately followed by `### 2.1 Setup` is a heading
     * stack, not a section with content. Cutting between them would emit a
     * chunk that says only "2. Method" — an index entry with nothing in it,
     * which costs an embedding and can be returned as a search hit carrying no
     * information. Letting the stack accumulate still leaves the chunk inside
     * exactly one section: the deepest heading in the stack.
     */
    const bufferIsOnlyHeadings = () =>
      buffer
        .split('\n')
        .filter((line) => line.trim())
        .every((line) => HEADING_LINE_PATTERN.test(line));

    for (const paragraph of paragraphs) {
      // A heading ends whatever chunk is open, however short it is, and opens
      // the next one. Sizing is otherwise untouched: the target and the append
      // tolerance still decide every other boundary. This is what keeps a
      // chunk from straddling a section break, so a passage returned by search
      // belongs to exactly one section.
      if (HEADING_LINE_PATTERN.test(paragraph)) {
        flush();
        buffer = paragraph;
        continue;
      }

      // An oversized paragraph is handled on its own so the sentence splitter
      // never has to reason about what is already buffered.
      if (paragraph.length > target + tolerance) {
        // A heading waiting in the buffer belongs to this paragraph. Flushing
        // it here would publish a chunk containing nothing but the heading and
        // then start the section's text in the next one; instead it rides
        // along on the first piece, which is where it introduces content.
        const carriedHeading = buffer.trim() && bufferIsOnlyHeadings() ? buffer.trim() : '';
        if (carriedHeading) buffer = '';
        else flush();
        const pieces = this.splitOversizedParagraph(
          paragraph,
          target,
          tolerance,
        );
        pieces.forEach((piece, pieceIndex) => {
          chunks.push(
            pieceIndex === 0 && carriedHeading
              ? `${carriedHeading}\n\n${piece}`
              : piece,
          );
        });
        continue;
      }

      if (!buffer) {
        buffer = paragraph;
        // A single paragraph that already fills the chunk has nothing to gain
        // from waiting for the next one.
        if (buffer.length >= target) flush();
        continue;
      }

      if (buffer.length < target) {
        const combined = buffer.length + 2 + paragraph.length;
        if (combined <= target) {
          buffer = `${buffer}\n\n${paragraph}`;
          continue;
        }
        // Crossing the target: take the paragraph only if it is small enough
        // to count as a tail, otherwise let it open the next chunk.
        if (paragraph.length <= tolerance) {
          buffer = `${buffer}\n\n${paragraph}`;
          flush();
          continue;
        }
        flush();
        buffer = paragraph;
        continue;
      }

      // buffer already at or past the target
      if (paragraph.length <= tolerance) {
        buffer = `${buffer}\n\n${paragraph}`;
        flush();
        continue;
      }
      flush();
      buffer = paragraph;
    }

    flush();
    return chunks;
  }

  /**
   * Split a paragraph that is longer than target + tolerance.
   *
   * Sentences are kept whole: pieces accumulate until the target is reached and
   * then close. A single sentence longer than the whole budget is emitted as
   * one piece rather than cut mid-sentence — unless it carries no sentence
   * punctuation at all (a table row, a formula dump, an unpunctuated OCR run),
   * in which case it is broken at the nearest safe boundary. Every branch
   * concatenates back to the input, so no body text is lost.
   */
  private splitOversizedParagraph(
    paragraph: string,
    target: number,
    tolerance: number,
  ): string[] {
    const sentences = this.extractSentences(paragraph).filter(s => s.trim());
    if (sentences.length <= 1) {
      return this.hardSplit(paragraph, target + tolerance);
    }

    const pieces: string[] = [];
    let buffer = '';
    for (const sentence of sentences) {
      if (!buffer) {
        buffer = sentence;
      } else if (buffer.length + 1 + sentence.length <= target) {
        buffer = `${buffer} ${sentence}`;
      } else {
        pieces.push(buffer);
        buffer = sentence;
      }
      if (buffer.length >= target) {
        pieces.push(buffer);
        buffer = '';
      }
    }
    if (buffer.trim()) pieces.push(buffer);

    // A sentence longer than the budget on its own still has to be broken, or
    // the embedding API would reject the chunk and the passage would vanish.
    const bounded: string[] = [];
    for (const piece of pieces) {
      if (piece.length > target + tolerance) {
        bounded.push(...this.hardSplit(piece, target + tolerance));
      } else {
        bounded.push(piece);
      }
    }
    return bounded;
  }

  /**
   * Last-resort split for text with no usable sentence boundaries.
   * Prefers a punctuation or whitespace boundary near the limit and, unlike the
   * legacy character splitter, never drops a short remainder.
   */
  private hardSplit(text: string, limit: number): string[] {
    const pieces: string[] = [];
    const breakChars = [' ', '，', ',', '、', '；', ';', '：', ':', '\n', ')', '）'];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(start + limit, text.length);
      if (end < text.length) {
        const floor = start + Math.floor(limit * 0.6);
        for (let i = end - 1; i > floor; i--) {
          if (breakChars.includes(text[i])) {
            end = i + 1;
            break;
          }
        }
      }
      const piece = text.slice(start, end).trim();
      if (piece) pieces.push(piece);
      start = end;
    }

    return pieces;
  }

  /**
   * Chunk with full metadata
   */
  chunkWithMetadata(text: string): SemanticChunk[] {
    if (!text || text.trim().length < this.options.minChunkSize) {
      return [];
    }

    const { text: cleanText, quality } = TextQualityPreprocessor.process(text);
    if (!quality.shouldIndex) return [];

    const structure = this.detectStructure(cleanText);
    const units = this.splitByStructure(cleanText, structure);
    return this.balanceChunks(units);
  }

  /**
   * Legacy interface: chunk with positions
   */
  chunkWithPositions(text: string): TextChunk[] {
    const chunks = this.chunk(text);
    const result: TextChunk[] = [];
    let searchStart = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const startPos = text.indexOf(chunkText.substring(0, Math.min(50, chunkText.length)), searchStart);
      const endPos = startPos >= 0 ? startPos + chunkText.length : searchStart + chunkText.length;

      result.push({
        id: i,
        text: chunkText,
        startPos: startPos >= 0 ? startPos : searchStart,
        endPos
      });

      searchStart = startPos >= 0 ? startPos + 1 : searchStart + 1;
    }

    return result;
  }

  /**
   * Detect document structure (abstract, sections, references)
   */
  private detectStructure(text: string): DocumentStructure {
    const structure: DocumentStructure = {
      hasAbstract: false,
      hasKeywords: false,
      sections: [],
      referencesStart: null
    };

    // Detect abstract (Chinese and English)
    const abstractPatterns = [
      /^(摘\s*要|Abstract|ABSTRACT)[：:\s]*\n?([\s\S]*?)(?=\n\s*\n|关键词|Keywords|Key\s*words|1\s*[.、]|一[、．.]|Introduction|引言)/im,
      /(摘\s*要|Abstract)[：:\s]*([\s\S]{50,800}?)(?=\n\s*\n)/im
    ];

    for (const pattern of abstractPatterns) {
      const match = text.match(pattern);
      if (match) {
        structure.hasAbstract = true;
        structure.abstractStart = match.index!;
        structure.abstractEnd = match.index! + match[0].length;
        break;
      }
    }

    // Detect keywords
    const keywordsMatch = text.match(
      /^(关键词|Keywords|Key\s*words)[：:\s]*([\s\S]*?)(?=\n\s*\n|\n[一二三四五1-9])/im
    );
    if (keywordsMatch) {
      structure.hasKeywords = true;
      structure.keywordsStart = keywordsMatch.index!;
      structure.keywordsEnd = keywordsMatch.index! + keywordsMatch[0].length;
    }

    // Detect section headers (Chinese numbered, Arabic numbered, Markdown)
    const sectionPatterns: Array<{ pattern: RegExp; levelFn: (m: string) => number }> = [
      {
        pattern: /^([一二三四五六七八九十]+)[、.．]\s*(.{2,50})$/gm,
        levelFn: () => 1
      },
      {
        pattern: /^(\d+)[.．]\s*(.{2,50})$/gm,
        levelFn: (m) => m.length === 1 ? 1 : 2
      },
      {
        pattern: /^(\d+\.\d+)[.．]?\s*(.{2,50})$/gm,
        levelFn: () => 2
      },
      {
        pattern: /^(#{1,3})\s*(.{2,50})$/gm,
        levelFn: (m) => m.length
      },
    ];

    for (const { pattern, levelFn } of sectionPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        structure.sections.push({
          level: levelFn(match[1]),
          title: (match[2] || match[0]).trim(),
          position: match.index
        });
      }
    }

    // Sort sections by position
    structure.sections.sort((a, b) => a.position - b.position);

    // Detect references section
    const refPatterns = [
      /^(参考文献|References|Bibliography|REFERENCES)\s*$/im,
      /\n(参考文献|References)\s*\n/i
    ];
    for (const pattern of refPatterns) {
      const match = text.match(pattern);
      if (match) {
        structure.referencesStart = match.index!;
        break;
      }
    }

    return structure;
  }

  /**
   * Split text by document structure into semantic units
   */
  private splitByStructure(text: string, structure: DocumentStructure): SemanticChunk[] {
    const units: SemanticChunk[] = [];
    let processedEnd = 0;

    // 1. Abstract as high-importance unit
    if (structure.hasAbstract && structure.abstractEnd) {
      const abstractText = text.substring(structure.abstractStart || 0, structure.abstractEnd).trim();
      if (abstractText.length >= this.options.minChunkSize) {
        units.push({
          text: abstractText,
          type: 'abstract',
          importance: 'high',
          quality: 100
        });
        processedEnd = Math.max(processedEnd, structure.abstractEnd);
      }
    }

    // 2. Keywords (optional, often useful for search)
    if (structure.hasKeywords && structure.keywordsEnd) {
      const keywordsText = text.substring(structure.keywordsStart!, structure.keywordsEnd).trim();
      if (keywordsText.length >= 20) {
        units.push({
          text: keywordsText,
          type: 'keywords',
          importance: 'normal',
          quality: 100
        });
        processedEnd = Math.max(processedEnd, structure.keywordsEnd);
      }
    }

    // 3. Body content - by sections or paragraphs
    const bodyStart = processedEnd;
    const bodyEnd = structure.referencesStart || text.length;

    if (structure.sections.length > 0) {
      // Has section structure
      const bodySections = structure.sections.filter(
        s => s.position >= bodyStart && s.position < bodyEnd
      );

      for (let i = 0; i < bodySections.length; i++) {
        const section = bodySections[i];
        const nextPos = bodySections[i + 1]?.position || bodyEnd;
        const sectionText = text.substring(section.position, nextPos).trim();

        if (sectionText.length >= this.options.minChunkSize) {
          units.push({
            text: sectionText,
            type: 'section',
            title: section.title,
            importance: 'normal',
            quality: 90
          });
        }
      }

      // Content before first section
      if (bodySections.length > 0 && bodySections[0].position > bodyStart) {
        const preText = text.substring(bodyStart, bodySections[0].position).trim();
        if (preText.length >= this.options.minChunkSize) {
          units.push({
            text: preText,
            type: 'paragraph',
            importance: 'normal',
            quality: 80
          });
        }
      }
    } else {
      // No section structure, split by paragraphs
      const bodyText = text.substring(bodyStart, bodyEnd);
      const paragraphs = bodyText.split(/\n\s*\n+/);

      for (const para of paragraphs) {
        const trimmed = para.trim();
        if (trimmed.length >= this.options.minChunkSize) {
          units.push({
            text: trimmed,
            type: 'paragraph',
            importance: 'normal',
            quality: 80
          });
        }
      }
    }

    // 4. References (low importance, optionally skip)
    if (structure.referencesStart && !this.options.skipReferences) {
      const refText = text.substring(structure.referencesStart).trim();
      if (refText.length >= this.options.minChunkSize) {
        units.push({
          text: refText,
          type: 'references',
          importance: 'low',
          quality: 60
        });
      }
    }

    return units;
  }

  /**
   * Balance chunk sizes: merge small, split large
   */
  private balanceChunks(units: SemanticChunk[]): SemanticChunk[] {
    const chunks: SemanticChunk[] = [];

    for (const unit of units) {
      if (unit.text.length <= this.options.maxChunkSize) {
        // Size OK, keep as is
        chunks.push(unit);
      } else {
        // Too large, split by sentences
        const subChunks = this.splitBySentences(unit);
        chunks.push(...subChunks);
      }
    }

    // Merge consecutive small chunks of same type
    const merged: SemanticChunk[] = [];
    let buffer: SemanticChunk | null = null;

    for (const chunk of chunks) {
      if (!buffer) {
        buffer = chunk;
        continue;
      }

      // Try to merge if same type and combined size is OK
      const canMerge = buffer.type === chunk.type
        && buffer.importance === chunk.importance
        && buffer.text.length + chunk.text.length + 2 <= this.options.maxChunkSize;

      if (canMerge) {
        buffer = {
          ...buffer,
          text: buffer.text + '\n\n' + chunk.text,
          quality: Math.min(buffer.quality, chunk.quality)
        };
      } else {
        if (buffer.text.length >= this.options.minChunkSize) {
          merged.push(buffer);
        }
        buffer = chunk;
      }
    }

    if (buffer && buffer.text.length >= this.options.minChunkSize) {
      merged.push(buffer);
    }

    return merged;
  }

  /**
   * Split unit by sentences with overlap
   */
  private splitBySentences(unit: SemanticChunk): SemanticChunk[] {
    const chunks: SemanticChunk[] = [];
    const sentences = this.extractSentences(unit.text);

    if (sentences.length === 0) {
      // Fallback: force split by characters
      return this.forceSplitByChars(unit);
    }

    let currentSentences: string[] = [];
    let currentLength = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];

      if (currentLength + sentence.length > this.options.maxChunkSize && currentSentences.length > 0) {
        // Save current chunk
        chunks.push({
          text: currentSentences.join(' '),
          type: unit.type,
          title: unit.title,
          importance: unit.importance,
          quality: unit.quality
        });

        // Overlap: keep last N sentences
        const overlap = currentSentences.slice(-this.options.overlapSentences);
        currentSentences = [...overlap];
        currentLength = overlap.reduce((s, sent) => s + sent.length + 1, 0);
      }

      currentSentences.push(sentence);
      currentLength += sentence.length + 1;
    }

    // Last chunk
    if (currentSentences.length > 0 && currentLength >= this.options.minChunkSize) {
      chunks.push({
        text: currentSentences.join(' '),
        type: unit.type,
        title: unit.title,
        importance: unit.importance,
        quality: unit.quality
      });
    }

    return chunks;
  }

  /**
   * Extract sentences (Chinese and English)
   */
  private extractSentences(text: string): string[] {
    // Split by sentence-ending punctuation
    const sentences = text
      .split(/(?<=[。！？.!?;；])\s*/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    // If no sentences found (no punctuation), split by newlines
    if (sentences.length <= 1 && text.length > this.options.maxChunkSize) {
      return text
        .split(/\n+/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    }

    return sentences;
  }

  /**
   * Force split by characters when sentence split fails
   */
  private forceSplitByChars(unit: SemanticChunk): SemanticChunk[] {
    const chunks: SemanticChunk[] = [];
    const text = unit.text;
    const { maxChunkSize } = this.options;
    const overlap = 50;

    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxChunkSize, text.length);

      // Try to find a good break point
      if (end < text.length) {
        const breakChars = [' ', '，', ',', '。', '.', '、', ';', '；', '\n'];
        for (let i = end - 1; i >= start + maxChunkSize - 100 && i >= start; i--) {
          if (breakChars.includes(text[i])) {
            end = i + 1;
            break;
          }
        }
      }

      const chunkText = text.slice(start, end).trim();
      if (chunkText.length >= this.options.minChunkSize) {
        chunks.push({
          text: chunkText,
          type: unit.type,
          title: unit.title,
          importance: unit.importance,
          quality: unit.quality - 10 // Lower quality for force-split
        });
      }

      start = end - overlap;
      if (start >= text.length - overlap) break;
    }

    return chunks;
  }

  /**
   * Estimate token count
   */
  estimateTokens(text: string): number {
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars * 1.5 + otherChars / 4);
  }

  /**
   * Detect primary language
   */
  detectLanguage(text: string): 'zh' | 'en' {
    const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    return totalChars > 0 && chineseChars / totalChars > 0.3 ? 'zh' : 'en';
  }
}

// ============== Singleton Factory ==============

let chunkerInstance: TextChunker | null = null;

export function getTextChunker(options?: Partial<ChunkerOptions>): TextChunker {
  if (!chunkerInstance || options) {
    chunkerInstance = new TextChunker(options);
  }
  return chunkerInstance;
}

export function resetTextChunker(): void {
  chunkerInstance = null;
}
