/**
 * Unified Content Extractor for Zotero LitSynapse
 * 
 * This replaces the overlapping functionality of:
 * - get_item_pdf_content
 * - get_item_fulltext  
 * - get_attachment_content
 */

import { PDFProcessor } from "./pdfProcessor";
import { TextFormatter } from "./textFormatter";
import {
  resolveAttachmentContentLimit,
  STANDARD_AGGREGATE_CONTENT_LIMITS,
} from "./contentExtractionDefaults";
import {
  getPDFTextFromMarkdown,
  isGeneratedMarkdownAttachment,
} from "./pdfTextSource";
import { isWikiReadingNoteAttachment } from "./wiki/wikiReadingNote";

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

export interface ContentIncludeOptions {
  pdf?: boolean;
  attachments?: boolean;
  notes?: boolean;
  abstract?: boolean;
  webpage?: boolean;
}

export interface ContentResult {
  itemKey?: string;
  attachmentKey?: string;
  title?: string;
  content: any;
  metadata: {
    extractedAt: string;
    sources: string[];
    totalLength: number;
  };
}

export interface AttachmentContentOptions {
  preserveOriginal?: boolean;
}

export class UnifiedContentExtractor {
  /**
   * Extract content from an item using the former standard defaults.
   */
  async getItemContent(
    itemKey: string,
    include: ContentIncludeOptions = {},
    libraryID: number = Zotero.Libraries.userLibraryID,
  ): Promise<ContentResult> {
    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
      if (!item) {
        throw new Error(`Item with key ${itemKey} not found`);
      }

      ztoolkit.log(`[UnifiedContentExtractor] Getting content for item ${itemKey}`);

      const limits = STANDARD_AGGREGATE_CONTENT_LIMITS;
      const options = {
        pdf: true,
        attachments: true,
        notes: true,
        abstract: true,
        webpage: limits.includeWebpage,
        ...include
      };

      const result: ContentResult = {
        itemKey,
        title: item.getDisplayTitle(),
        content: {},
        metadata: {
          extractedAt: new Date().toISOString(),
          sources: [],
          totalLength: 0,
        }
      };

      // Extract abstract
      if (options.abstract) {
        const abstract = this.extractAbstract(item);
        if (abstract) {
          result.content.abstract = {
            content: abstract,
            length: abstract.length,
            type: 'abstract'
          };
          result.metadata.sources.push('abstract');
          result.metadata.totalLength += abstract.length;
        }
      }

      // Extract attachments (PDF and others).
      if (options.pdf || options.attachments) {
        const attachments = await this.extractAttachments(item, options);
        if (attachments.length > 0) {
          result.content.attachments = attachments;
          result.metadata.sources.push('attachments');
          result.metadata.totalLength += attachments.reduce((sum: number, att: any) => sum + att.length, 0);
        }
      }

      // Extract notes.
      if (options.notes) {
        const notes = await this.extractNotes(item);
        if (notes.length > 0) {
          result.content.notes = notes;
          result.metadata.sources.push('notes');
          result.metadata.totalLength += notes.reduce((sum: number, note: any) => sum + note.length, 0);
        }
      }

      // Extract webpage snapshots (skip snapshots already returned as attachments)
      if (options.webpage) {
        const processedKeys = new Set<string>((result.content.attachments || []).map((a: any) => a.attachmentKey));
        const webpage = await this.extractWebpageContent(item, processedKeys);
        if (webpage) {
          result.content.webpage = webpage;
          result.metadata.sources.push('webpage');
          result.metadata.totalLength += webpage.length;
        }
      }

      ztoolkit.log(`[UnifiedContentExtractor] Extracted ${result.metadata.totalLength} characters from ${result.metadata.sources.length} sources`);
      return result;

    } catch (error) {
      ztoolkit.log(`[UnifiedContentExtractor] Error in getItemContent: ${error}`, "error");
      throw error;
    }
  }

  /**
   * Extract content from one attachment, optionally preserving the full text.
   */
  async getAttachmentContent(
    attachmentKey: string,
    options: AttachmentContentOptions = {},
    libraryID: number = Zotero.Libraries.userLibraryID,
  ): Promise<any> {
    try {
      const attachment = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, attachmentKey);
      if (!attachment?.isAttachment()) {
        throw new Error(`Attachment with key ${attachmentKey} not found`);
      }

      ztoolkit.log(`[UnifiedContentExtractor] Processing attachment: ${attachmentKey}`);

      return await this.processAttachment(
        attachment,
        resolveAttachmentContentLimit(options.preserveOriginal === true),
      );

    } catch (error) {
      ztoolkit.log(`[UnifiedContentExtractor] Error in getAttachmentContent: ${error}`, "error");
      throw error;
    }
  }

  /**
   * Extract abstract from item
   */
  private extractAbstract(item: any): string | null {
    try {
      const abstract = item.getField('abstractNote');
      return abstract && abstract.trim().length > 0 ? abstract.trim() : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract content from the standard number of attachments.
   */
  private async extractAttachments(
    item: any,
    options: ContentIncludeOptions,
  ): Promise<any[]> {
    const attachments = [];
    const attachmentIDs = item.getAttachments();
    const limitedAttachmentIDs = attachmentIDs.slice(
      0,
      STANDARD_AGGREGATE_CONTENT_LIMITS.maxAttachments,
    );

    for (const attachmentID of limitedAttachmentIDs) {
      try {
        const attachment = Zotero.Items.get(attachmentID);
        const contentType = attachment.attachmentContentType;

        // MinerU 生成的 .md 附件与其源 PDF 内容完全重复，
        // PDF 分支返回的就是这份 Markdown 的纯文本。
        if (isGeneratedMarkdownAttachment(attachment)) continue;

        // The Wiki reading note is the model's summary OF this paper, kept on
        // the item; it is not one of the paper's own texts.
        if (isWikiReadingNoteAttachment(attachment)) continue;

        // Filter by type based on options
        const isPDF = this.isPDF(attachment, contentType);
        if (isPDF && !options.pdf) continue;
        if (!isPDF && !options.attachments) continue;

        const attachmentContent = await this.processAttachment(
          attachment,
          STANDARD_AGGREGATE_CONTENT_LIMITS.maxContentLength,
        );
        if (attachmentContent && attachmentContent.content) {
          attachments.push(attachmentContent);
        }
      } catch (error) {
        ztoolkit.log(`[UnifiedContentExtractor] Error extracting attachment ${attachmentID}: ${error}`, "warn");
      }
    }

    return attachments;
  }

  /**
   * Extract the standard number of notes.
   */
  private async extractNotes(item: any): Promise<any[]> {
    const notes = [];
    const noteIDs = item.getNotes();
    const limitedNoteIDs = noteIDs.slice(
      0,
      STANDARD_AGGREGATE_CONTENT_LIMITS.maxNotes,
    );

    for (const noteID of limitedNoteIDs) {
      try {
        const note = Zotero.Items.get(noteID);
        const noteContent = await this.extractNoteContent(note);
        if (noteContent) {
          notes.push(noteContent);
        }
      } catch (error) {
        ztoolkit.log(`[UnifiedContentExtractor] Error extracting note ${noteID}: ${error}`, "warn");
      }
    }

    return notes;
  }

  /**
   * Extract and format one note.
   */
  private async extractNoteContent(note: any): Promise<any> {
    try {
      if (!note || !note.isNote()) {
        return null;
      }

      const noteText = note.getNote();
      if (!noteText || noteText.trim().length === 0) {
        return null;
      }

      // TextFormatter's defaults preserve paragraphs, headings and lists but
      // do not retain emphasis markers.
      const plainText = TextFormatter.htmlToText(noteText);
      const maxLength = STANDARD_AGGREGATE_CONTENT_LIMITS.maxContentLength;
      const finalContent =
        plainText.length > maxLength
          ? this.smartTruncate(plainText, maxLength)
          : plainText;

      const result = {
        noteKey: note.key,
        title: note.getNoteTitle() || 'Untitled Note',
        content: finalContent,
        htmlContent: noteText,
        length: finalContent.length,
        originalLength: plainText.length,
        truncated: finalContent.length < plainText.length,
        dateModified: note.dateModified,
        type: 'note'
      };

      return result;
    } catch (error) {
      ztoolkit.log(`[UnifiedContentExtractor] Error extracting note content: ${error}`, "error");
      return null;
    }
  }

  /**
   * Extract webpage content from snapshots
   */
  private async extractWebpageContent(item: any, skipKeys?: Set<string>): Promise<any> {
    try {
      const url = item.getField('url');
      if (!url) {
        return null;
      }

      // Look for HTML snapshots
      const attachmentIDs = item.getAttachments();
      for (const attachmentID of attachmentIDs) {
        const attachment = Zotero.Items.get(attachmentID);
        if (skipKeys && skipKeys.has(attachment.key)) continue;
        if (attachment.attachmentContentType && attachment.attachmentContentType.includes('html')) {
          const content = await this.extractHTMLText(attachment.getFilePath());
          if (content && content.length > 0) {
            const MAX_WEBPAGE_CHARS = 500000;
            let trimmed = content.trim();
            const truncated = trimmed.length > MAX_WEBPAGE_CHARS;
            if (truncated) trimmed = trimmed.substring(0, MAX_WEBPAGE_CHARS);
            return {
              url,
              filename: attachment.attachmentFilename,
              filePath: attachment.getFilePath(),
              content: trimmed,
              length: trimmed.length,
              truncated,
              type: 'webpage_snapshot',
              extractedAt: new Date().toISOString()
            };
          }
        }
      }

      return null;
    } catch (error) {
      ztoolkit.log(`[UnifiedContentExtractor] Error extracting webpage content: ${error}`, "error");
      return null;
    }
  }

  /**
   * Process one attachment with a fixed character limit.
   */
  private async processAttachment(
    attachment: any,
    maxContentLength: number,
  ): Promise<any> {
    const filePath = attachment.getFilePath();
    const contentType = attachment.attachmentContentType;
    const filename = attachment.attachmentFilename;

    if (!filePath) {
      ztoolkit.log(`[UnifiedContentExtractor] No file path for attachment ${attachment.key}`, "warn");
      return null;
    }

    ztoolkit.log(`[UnifiedContentExtractor] Processing attachment: ${filename} (${contentType})`);

    let content = '';
    let extractionMethod = 'unknown';

    try {
      // Unified extraction logic based on file type
      if (this.isPDF(attachment, contentType)) {
        const pdfText = await this.extractPDFText(filePath, attachment.id);
        content = pdfText.text;
        extractionMethod = pdfText.method;
      } else if (this.isHTML(contentType)) {
        content = await this.extractHTMLText(filePath);
        extractionMethod = 'html_parsing';
      } else if (this.isText(contentType)) {
        content = await this.extractPlainText(filePath);
        extractionMethod = 'text_reading';
      }

      if (!content || content.trim().length === 0) {
        return null;
      }

      let finalContent = content.trim();
      const originalLength = finalContent.length;
      if (maxContentLength > 0 && finalContent.length > maxContentLength) {
        finalContent = this.smartTruncate(finalContent, maxContentLength);
      }

      const result = {
        attachmentKey: attachment.key,
        filename,
        filePath,
        contentType,
        type: this.categorizeAttachmentType(contentType),
        content: finalContent,
        length: finalContent.length,
        originalLength,
        truncated: finalContent.length < originalLength,
        extractionMethod,
        extractedAt: new Date().toISOString()
      };

      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      ztoolkit.log(`[UnifiedContentExtractor] Error processing attachment ${attachment.key}: ${errorMsg}`, "error");

      // Return partial result with error info instead of null
      return {
        attachmentKey: attachment.key,
        filename,
        filePath,
        contentType,
        type: this.categorizeAttachmentType(contentType),
        content: `[Error extracting content: ${errorMsg}]`,
        length: 0,
        originalLength: 0,
        truncated: false,
        extractionMethod: 'error',
        extractedAt: new Date().toISOString(),
        error: errorMsg
      };
    }
  }

  /**
   * Try to get cached fulltext from Zotero's index (much faster than extraction)
   */
  private async getZoteroCachedFulltext(attachmentId: number): Promise<string | null> {
    try {
      if (Zotero.Fulltext && Zotero.Fulltext.getItemContent) {
        const content = await Zotero.Fulltext.getItemContent(attachmentId);
        if (content && content.content && content.content.trim().length > 0) {
          ztoolkit.log(`[UnifiedContentExtractor] Using Zotero cached fulltext (${content.content.length} chars)`);
          return content.content;
        }
      }
      return null;
    } catch (error) {
      ztoolkit.log(`[UnifiedContentExtractor] Zotero fulltext cache not available: ${error}`, "warn");
      return null;
    }
  }

  /**
   * Extract text from PDF - Doc2X/MinerU Markdown first, then Zotero cache,
   * then PDFProcessor. The Markdown step is the shared entry point also used
   * by search_fulltext, so both tools apply the same policy and the same
   * 「允许 MCP 接口即时解析」 switch.
   */
  private async extractPDFText(
    filePath: string,
    attachmentId?: number,
  ): Promise<{ text: string; method: string }> {
    if (attachmentId) {
      const attachment = await Zotero.Items.getAsync(attachmentId);
      if (attachment) {
        const minerU = await getPDFTextFromMarkdown(attachment);
        if (minerU.text) {
          ztoolkit.log(`[UnifiedContentExtractor] Using MinerU markdown (${minerU.text.length} chars)`);
          return { text: minerU.text, method: minerU.method };
        }
        ztoolkit.log(
          `[UnifiedContentExtractor] No MinerU markdown for ${attachment.key} (${minerU.method}), falling back to PDF worker`,
        );
      }
    }

    // First try Zotero's cached fulltext (much faster)
    if (attachmentId) {
      const cachedText = await this.getZoteroCachedFulltext(attachmentId);
      if (cachedText) {
        return {
          text: TextFormatter.formatPDFText(cachedText),
          method: 'zotero_fulltext_cache',
        };
      }
    }

    // Fallback to PDFProcessor (slower, but works for new/unindexed PDFs)
    const processor = new PDFProcessor(ztoolkit);
    try {
      ztoolkit.log(`[UnifiedContentExtractor] Fallback to PDFProcessor for: ${filePath}`);
      const rawText = await processor.extractText(filePath);
      return {
        text: TextFormatter.formatPDFText(rawText),
        method: 'pdf_processor',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      ztoolkit.log(`[UnifiedContentExtractor] PDF extraction failed: ${errorMsg}`, "warn");
      if (errorMsg.includes('timed out')) {
        return {
          text: `[PDF extraction timed out - file may be too large. Try indexing the PDF in Zotero first.]`,
          method: 'pdf_processor_timeout',
        };
      }
      throw error;
    } finally {
      processor.terminate();
    }
  }

  /**
   * Extract text from HTML files
   */
  private async extractHTMLText(filePath: string): Promise<string> {
    try {
      if (!filePath) return '';
      
      const MAX_HTML_CHARS = 2000000; // cap snapshot markup fed to the parser
      let htmlContent = await Zotero.File.getContentsAsync(filePath);
      if (typeof htmlContent === 'string' && htmlContent.length > MAX_HTML_CHARS) {
        ztoolkit.log(`[UnifiedContentExtractor] HTML file is ${htmlContent.length} chars, truncating to ${MAX_HTML_CHARS} before parsing`, 'warn');
        htmlContent = htmlContent.substring(0, MAX_HTML_CHARS);
      }
      return TextFormatter.htmlToText(htmlContent);
    } catch (error) {
      ztoolkit.log(`[UnifiedContentExtractor] Error reading HTML file ${filePath}: ${error}`, "error");
      return '';
    }
  }

  /**
   * Extract text from plain text files
   */
  private async extractPlainText(filePath: string): Promise<string> {
    try {
      if (!filePath) return '';
      
      return await Zotero.File.getContentsAsync(filePath);
    } catch (error) {
      ztoolkit.log(`[UnifiedContentExtractor] Error reading text file ${filePath}: ${error}`, "error");
      return '';
    }
  }

  /**
   * Check if attachment is a PDF
   */
  private isPDF(attachment: any, contentType: string): boolean {
    // Check MIME type
    if (contentType && contentType.includes('pdf')) {
      return true;
    }
    
    // Check file extension
    const filename = attachment.attachmentFilename || '';
    if (filename.toLowerCase().endsWith('.pdf')) {
      return true;
    }
    
    // Check path extension
    const path = attachment.getFilePath() || '';
    if (path.toLowerCase().endsWith('.pdf')) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if attachment is HTML
   */
  private isHTML(contentType: string): boolean {
    return !!(contentType && (contentType.includes('html') || contentType.includes('xml')));
  }

  /**
   * Check if attachment is plain text
   */
  private isText(contentType: string): boolean {
    return !!(contentType && contentType.includes('text') && !contentType.includes('html'));
  }

  /**
   * Categorize attachment type
   */
  private categorizeAttachmentType(contentType: string): string {
    if (!contentType) return 'unknown';
    
    if (contentType.includes('pdf')) return 'pdf';
    if (contentType.includes('html')) return 'html';
    if (contentType.includes('text')) return 'text';
    if (contentType.includes('word') || contentType.includes('document')) return 'document';
    
    return 'other';
  }

  /**
   * Convert structured result to plain text format
   */
  convertToText(result: ContentResult): string {
    const textParts = [];

    if (result.content.abstract) {
      textParts.push(`ABSTRACT:\n${result.content.abstract.content}\n`);
    }

    if (result.content.attachments) {
      for (const att of result.content.attachments) {
        textParts.push(`ATTACHMENT (${att.filename || att.type}):\n${att.content}\n`);
      }
    }

    if (result.content.notes) {
      for (const note of result.content.notes) {
        textParts.push(`NOTE (${note.title}):\n${note.content}\n`);
      }
    }

    if (result.content.webpage) {
      textParts.push(`WEBPAGE:\n${result.content.webpage.content}\n`);
    }

    return textParts.join('\n---\n\n');
  }

  /**
   * Smart truncation that preserves sentence boundaries and meaning
   */
  private smartTruncate(content: string, maxLength: number): string {
    if (!content || content.length <= maxLength) {
      return content;
    }

    // Try to cut at sentence boundaries
    const truncated = content.substring(0, maxLength);
    const lastSentence = Math.max(
      truncated.lastIndexOf('.'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?')
    );
    
    // If we found a sentence boundary in the last 30% of the text, use it
    if (lastSentence > maxLength * 0.7) {
      return truncated.substring(0, lastSentence + 1);
    }
    
    // Otherwise, try to cut at word boundary
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.8) {
      return truncated.substring(0, lastSpace) + '...';
    }
    
    // Fallback: hard truncate
    return truncated + '...';
  }
}
