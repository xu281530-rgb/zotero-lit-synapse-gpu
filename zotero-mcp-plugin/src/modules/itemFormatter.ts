declare let ztoolkit: ZToolkit;

/**
 * Formats a single Zotero item into a brief JSON object for search results.
 * @param item The Zotero.Item object to format.
 * @returns A JSON object with essential item details.
 */
export function formatItemBrief(item: Zotero.Item): Record<string, any> {
  return {
    key: item.key,
    libraryID: item.libraryID,
    title: item.getField("title") || "No Title",
    creators: item
      .getCreators()
      .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
      .join(", "),
    date: item.getField("date")?.match(/\d{4}/)?.[0] || "", // Extract year
  };
}

/**
 * The metadata every caller of this formatter gets when it does not ask for
 * something narrower.
 *
 * `abstractNote` and `notes` used to be in here, which is how a metadata
 * lookup came to ship a paper's abstract and the user's private note bodies:
 * `get_item_details`, `get_collection_items` and `search_library` all default
 * to this list, so every one of them returned content none of them was for. A
 * 200-item collection listing carried 200 abstracts and every note body in it.
 *
 * Both are now availability flags (`hasAbstract`, `abstractChars`,
 * `noteCount`) and the text comes from the tool that exists to return it —
 * get_item_abstract and get_annotations respectively.
 */
export const DEFAULT_ITEM_FIELDS = [
  "title",
  "creators",
  "date",
  "itemType",
  "publicationTitle",
  "volume",
  "issue",
  "pages",
  "DOI",
  "url",
  "language",
  "tags",
  "hasAbstract",
  "noteCount",
  "attachments",
];

/**
 * Formats a single Zotero item into a detailed JSON object.
 * @param item The Zotero.Item object to format.
 * @param fields Optional array of fields to include in the output.
 * @returns A JSON object representing the item.
 */
export async function formatItem(
  item: Zotero.Item,
  fields?: string[],
): Promise<Record<string, any>> {
  const fieldsToExport: string[] = fields ?? DEFAULT_ITEM_FIELDS;
  const formattedItem: Record<string, any> = {
    key: item.key,
    libraryID: item.libraryID,
    itemType: item.itemType,
    zoteroUrl: `zotero://select/library/items/${item.key}`,
  };

  // 安全的字符串获取函数 - 与其他模块保持一致
  function safeGetString(value: any): string {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  for (const field of fieldsToExport) {
    try {
      switch (field) {
        case "attachments":
          try {
            const attachmentIds = item.getAttachments(false);
            const attachments = Zotero.Items.get(attachmentIds);
            const processedAttachments = [];
            
            for (const attachment of attachments) {
              try {
                if (!attachment || !attachment.isAttachment()) {
                  continue;
                }
                
                // 安全地获取各个字段
                const attachmentData: any = {
                  key: attachment.key || '',
                  linkMode: attachment.attachmentLinkMode || 0,
                  // Renamed from `hasFulltext`, because that is not what it
                  // measured: it checks the file's extension and content type,
                  // so it said true for every PDF including ones that had
                  // never parsed and had no text anywhere. The honest claim is
                  // "this file type could yield text". Whether the plugin
                  // actually HAS the text is the item-level `fullText` field,
                  // resolved from the semantic index.
                  hasExtractableText: false,
                  size: 0
                };
                
                // 安全地处理每个字段
                try {
                  attachmentData.title = safeGetString(attachment.getField("title"));
                } catch (e) {
                  attachmentData.title = "";
                  ztoolkit.log(`[ItemFormatter] Error getting attachment title: ${e}`, "error");
                }
                
                try {
                  attachmentData.path = safeGetString(attachment.getFilePath());
                } catch (e) {
                  attachmentData.path = "";
                  ztoolkit.log(`[ItemFormatter] Error getting attachment path: ${e}`, "error");
                }
                
                try {
                  attachmentData.contentType = safeGetString(attachment.attachmentContentType);
                } catch (e) {
                  attachmentData.contentType = "";
                  ztoolkit.log(`[ItemFormatter] Error getting attachment contentType: ${e}`, "error");
                }
                
                try {
                  attachmentData.filename = safeGetString(attachment.attachmentFilename);
                } catch (e) {
                  attachmentData.filename = "";
                  ztoolkit.log(`[ItemFormatter] Error getting attachment filename: ${e}`, "error");
                }
                
                try {
                  attachmentData.url = safeGetString(attachment.getField("url"));
                } catch (e) {
                  attachmentData.url = "";
                  ztoolkit.log(`[ItemFormatter] Error getting attachment url: ${e}`, "error");
                }
                
                try {
                  attachmentData.hasExtractableText = hasExtractableText(attachment);
                } catch (e) {
                  ztoolkit.log(`[ItemFormatter] Error checking extractable text: ${e}`, "error");
                }
                
                try {
                  attachmentData.size = await getAttachmentSize(attachment);
                } catch (e) {
                  ztoolkit.log(`[ItemFormatter] Error getting attachment size: ${e}`, "error");
                }
                
                // 只添加有效的附件
                if (attachmentData.key) {
                  processedAttachments.push(attachmentData);
                }
                
              } catch (e) {
                ztoolkit.log(
                  `[ItemFormatter] Error processing attachment: ${e}`,
                  "error",
                );
                // 继续处理下一个附件，不要因为一个附件的错误影响整个流程
                continue;
              }
            }
            
            formattedItem[field] = processedAttachments;
          } catch (e) {
            ztoolkit.log(
              `[ItemFormatter] Error getting attachments: ${e}`,
              "error",
            );
            formattedItem[field] = [];
          }
          break;
        case "creators":
          try {
            formattedItem[field] = item.getCreators().map((creator) => ({
              firstName: safeGetString(creator.firstName),
              lastName: safeGetString(creator.lastName),
              creatorType: safeGetString(
                Zotero.CreatorTypes.getName(creator.creatorTypeID)
              ) || "unknown",
            }));
          } catch (e) {
            ztoolkit.log(
              `[ItemFormatter] Error getting creators: ${e}`,
              "error",
            );
            formattedItem[field] = [];
          }
          break;
        case "tags":
          try {
            formattedItem[field] = item
              .getTags()
              .map((tag) => safeGetString(tag.tag));
          } catch (e) {
            ztoolkit.log(`[ItemFormatter] Error getting tags: ${e}`, "error");
            formattedItem[field] = [];
          }
          break;
        case "notes":
          try {
            formattedItem[field] = item
              .getNotes(false)
              .map((noteId: number) => {
                try {
                  const note = Zotero.Items.get(noteId);
                  return note ? safeGetString(note.getNote()) : "";
                } catch (e) {
                  ztoolkit.log(
                    `[ItemFormatter] Error getting note ${noteId}: ${e}`,
                    "error",
                  );
                  return "";
                }
              })
              .filter((note) => note);
          } catch (e) {
            ztoolkit.log(`[ItemFormatter] Error getting notes: ${e}`, "error");
            formattedItem[field] = [];
          }
          break;
        case "date":
          try {
            formattedItem[field] = safeGetString(item.getField("date"));
            // Callers overwhelmingly want the publication year, and every
            // other tool in this plugin reports one; deriving it here keeps
            // them from parsing Zotero's free-form date strings themselves.
            formattedItem.year =
              safeGetString(item.getField("date")).match(/\d{4}/)?.[0] || "";
          } catch (e) {
            ztoolkit.log(`[ItemFormatter] Error getting date: ${e}`, "error");
            formattedItem[field] = "";
          }
          break;
        case "itemType":
          // NOT the default branch. `getField("itemType")` returns "" in
          // Zotero — itemType is a property, not a field — so falling through
          // to `default:` overwrote the correct value set above with an empty
          // string. Every get_item_details response reported itemType: "".
          formattedItem[field] = safeGetString(item.itemType);
          break;
        case "hasAbstract":
          // Availability, not content: what get_item_abstract WOULD return.
          try {
            const abstract = safeGetString(item.getField("abstractNote")).trim();
            formattedItem.hasAbstract = abstract.length > 0;
            formattedItem.abstractChars = abstract.length;
          } catch (e) {
            ztoolkit.log(`[ItemFormatter] Error probing abstract: ${e}`, "error");
            formattedItem.hasAbstract = false;
            formattedItem.abstractChars = 0;
          }
          break;
        case "noteCount":
          // Likewise: how many notes exist, never their bodies.
          try {
            formattedItem.noteCount = item.getNotes(false).length;
          } catch (e) {
            ztoolkit.log(`[ItemFormatter] Error counting notes: ${e}`, "error");
            formattedItem.noteCount = 0;
          }
          break;
        case "collections":
          try {
            const collectionIDs = item.getCollections() || [];
            formattedItem.collections = (
              Zotero.Collections.get(collectionIDs) as unknown as any[]
            )
              .filter(Boolean)
              .map((collection: any) => ({
                collectionKey: collection.key,
                name: collection.name,
                path: collectionPath(collection),
              }));
          } catch (e) {
            ztoolkit.log(
              `[ItemFormatter] Error getting collections: ${e}`,
              "error",
            );
            formattedItem.collections = [];
          }
          break;
        default:
          try {
            const value = item.getField(field);
            formattedItem[field] = safeGetString(value);
          } catch (e) {
            // Field doesn't exist or can't be accessed, skip silently
            formattedItem[field] = "";
          }
          break;
      }
    } catch (e) {
      ztoolkit.log(
        `[ItemFormatter] Error processing field ${field}: ${e}`,
        "error",
      );
      formattedItem[field] = null;
    }
  }

  return formattedItem;
}

/**
 * "Library/Parent/Child" for one collection, so a caller reading an item's
 * collections can see where it sits without walking the tree itself.
 */
function collectionPath(collection: any): string {
  const segments: string[] = [];
  const seen = new Set<string>();
  let current: any = collection;
  while (current && !seen.has(current.key)) {
    seen.add(current.key);
    segments.unshift(current.name || current.key);
    try {
      const parentKey = current.parentKey;
      current = parentKey
        ? Zotero.Collections.getByLibraryAndKey(current.libraryID, parentKey)
        : null;
    } catch {
      current = null;
    }
  }
  return segments.join("/");
}

/**
 * Check if an attachment has extractable text content
 */
function hasExtractableText(attachment: Zotero.Item): boolean {
  try {
    if (!attachment.isAttachment()) return false;
    
    const contentType = attachment.attachmentContentType || "";
    const path = attachment.getFilePath() || "";
    
    // Check for PDF files
    if (contentType.includes("pdf") || path.toLowerCase().endsWith(".pdf")) {
      return true;
    }
    
    // Check for text files
    if (contentType.includes("text") || 
        [".txt", ".md", ".html", ".htm", ".xml"].some(ext => path.toLowerCase().endsWith(ext))) {
      return true;
    }
    
    return false;
  } catch (error) {
    ztoolkit.log(`[ItemFormatter] Error checking extractable text: ${error}`, "error");
    return false;
  }
}

/**
 * Get attachment file size
 */
async function getAttachmentSize(attachment: Zotero.Item): Promise<number> {
  try {
    if (!attachment.isAttachment()) return 0;
    
    const path = attachment.getFilePath();
    if (!path) return 0;
    
    // Try to get file size using OS.File
    if (typeof OS !== "undefined" && OS.File && OS.File.stat) {
      try {
        const stat = await OS.File.stat(path);
        return (stat as any).size || 0;
      } catch (e) {
        ztoolkit.log(`[ItemFormatter] OS.File.stat failed: ${e}`, "error");
      }
    }
    
    // Fallback: try to use nsIFile
    try {
      const file = (Components.classes as any)["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsIFile);
      file.initWithPath(path);
      if (file.exists()) {
        return file.fileSize || 0;
      }
    } catch (e) {
      ztoolkit.log(`[ItemFormatter] nsIFile method failed: ${e}`, "error");
    }
    
    return 0;
  } catch (error) {
    ztoolkit.log(`[ItemFormatter] Error getting attachment size: ${error}`, "error");
    return 0;
  }
}

/**
 * Formats an array of Zotero items into an array of JSON objects.
 * @param items An array of Zotero.Item objects to format.
 * @param fields Optional array of fields to include in the output for each item.
 * @returns An array of JSON objects representing the items.
 */
export async function formatItems(
  items: Zotero.Item[],
  fields?: string[],
): Promise<Array<Record<string, any>>> {
  ztoolkit.log(`[ItemFormatter] formatItems called with ${items.length} items, fields: ${fields?.join(", ") || "default"}`);
  
  try {
    const results = await Promise.all(items.map(async (item, index) => {
      try {
        ztoolkit.log(`[ItemFormatter] Processing item ${index + 1}/${items.length}: ${item.key} (${item.getField("title") || "No title"})`);
        const formatted = await formatItem(item, fields);
        ztoolkit.log(`[ItemFormatter] Successfully formatted item ${item.key}`);
        return formatted;
      } catch (error) {
        ztoolkit.log(`[ItemFormatter] Error formatting item ${item.key}: ${error}`, "error");
        // 返回基础信息而不是跳过
        return {
          key: item.key || '',
          title: 'Error formatting item',
          error: true,
          errorMessage: error instanceof Error ? error.message : String(error)
        };
      }
    }));
    
    ztoolkit.log(`[ItemFormatter] formatItems completed: ${results.length} items formatted`);
    return results;
  } catch (error) {
    ztoolkit.log(`[ItemFormatter] Fatal error in formatItems: ${error}`, "error");
    throw error;
  }
}
