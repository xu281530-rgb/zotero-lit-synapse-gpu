/* eslint-env node */

/**
 * A Zotero item/attachment/file layer real enough to test the reading note
 * against.
 *
 * The note is a FILE on an ITEM, and both halves are where it can break: an
 * attachment that cannot be found again after a restart, a write that tears
 * halfway through and destroys a document that is only ever rewritten whole.
 * Stubbing `IOUtils` with an in-memory map would test neither, so this fake
 * writes to a real temp directory through the same `tmpPath` rename contract
 * Firefox's IOUtils provides, and can be told to die between the temp write
 * and the rename.
 */

import fs from "node:fs";
import path from "node:path";

export function createZoteroFake({ rootDir }) {
  const dataDir = path.join(rootDir, "zotero-data");
  const storageDir = path.join(dataDir, "storage");
  fs.mkdirSync(storageDir, { recursive: true });

  const control = {
    /** Set to an Error to make the next write throw AFTER the temp file. */
    crashNextWriteBeforeRename: null,
    writes: 0,
    renames: 0,
  };

  const IOUtils = {
    async makeDirectory(target, options = {}) {
      fs.mkdirSync(target, { recursive: options.createAncestors !== false });
    },
    async writeUTF8(target, data, options = {}) {
      control.writes += 1;
      const tmpPath = options.tmpPath ?? null;
      if (!tmpPath) {
        fs.writeFileSync(target, data, "utf8");
        return;
      }
      fs.writeFileSync(tmpPath, data, "utf8");
      if (control.crashNextWriteBeforeRename) {
        const error = control.crashNextWriteBeforeRename;
        control.crashNextWriteBeforeRename = null;
        throw error;
      }
      fs.renameSync(tmpPath, target);
      control.renames += 1;
    },
    async readUTF8(target) {
      return fs.readFileSync(target, "utf8");
    },
    async remove(target, options = {}) {
      try {
        fs.rmSync(target, { force: false, recursive: false });
      } catch (error) {
        if (!options.ignoreAbsent) throw error;
      }
    },
  };

  const PathUtils = { join: (...parts) => path.join(...parts) };

  let nextId = 1;
  const byId = new Map();
  const byLibraryKey = new Map();
  let keyCounter = 0;

  function mintKey(prefix) {
    keyCounter += 1;
    return `${prefix}${String(keyCounter).padStart(4, "0")}`;
  }

  function register(item) {
    byId.set(item.id, item);
    byLibraryKey.set(`${item.libraryID}:${item.key}`, item);
    return item;
  }

  function createPaper({
    libraryID = 1,
    key,
    title = `Paper ${key}`,
    abstract = "",
    fields = {},
    creators = [],
    tags = [],
    itemType = "journalArticle",
  }) {
    const attachmentIds = [];
    const values = { title, abstractNote: abstract, ...fields };
    const item = {
      id: nextId++,
      key,
      libraryID,
      itemType,
      deleted: false,
      dateModified: "2026-01-01 00:00:00",
      isRegularItem: () => true,
      isAttachment: () => false,
      getField: (name) => values[name] ?? "",
      setField: (name, value) => {
        values[name] = value;
      },
      getCreators: () => creators,
      getTags: () => tags,
      getAttachments: () => [...attachmentIds],
      _attachmentIds: attachmentIds,
    };
    return register(item);
  }

  function createAttachment({
    parent,
    title,
    filePath,
    contentType = "text/markdown",
  }) {
    const key = mintKey("ATT");
    const attachment = {
      id: nextId++,
      key,
      libraryID: parent.libraryID,
      parentItemID: parent.id,
      deleted: false,
      dateModified: new Date().toISOString(),
      attachmentContentType: contentType,
      attachmentFilename: path.basename(filePath),
      attachmentSyncState: 0,
      isRegularItem: () => false,
      isAttachment: () => true,
      isPDFAttachment: () => contentType === "application/pdf",
      getField: (name) => (name === "title" ? title : ""),
      getFilePath: () => filePath,
      getFilePathAsync: async () => filePath,
      saveTx: async () => {
        attachment.dateModified = new Date().toISOString();
      },
    };
    parent._attachmentIds.push(attachment.id);
    return register(attachment);
  }

  const Zotero = {
    Libraries: { userLibraryID: 1 },
    DataDirectory: { dir: dataDir },
    Sync: { Storage: { Local: { SYNC_STATE_TO_UPLOAD: 1 } } },
    Items: {
      async getAsync(id) {
        return byId.get(Number(id)) ?? null;
      },
      get(id) {
        return byId.get(Number(id)) ?? null;
      },
      async getByLibraryAndKeyAsync(libraryID, key) {
        return byLibraryKey.get(`${libraryID}:${key}`) ?? null;
      },
    },
    Attachments: {
      async importFromFile({ file, parentItemID, title, contentType }) {
        const parent = byId.get(Number(parentItemID));
        if (!parent) throw new Error(`No parent item ${parentItemID}`);
        const key = mintKey("ATT");
        const dir = path.join(storageDir, key);
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, path.basename(file));
        fs.copyFileSync(file, target);
        const attachment = {
          id: nextId++,
          key,
          libraryID: parent.libraryID,
          parentItemID: parent.id,
          deleted: false,
          dateModified: new Date().toISOString(),
          attachmentContentType: contentType ?? "text/markdown",
          attachmentFilename: path.basename(target),
          attachmentSyncState: 0,
          isRegularItem: () => false,
          isAttachment: () => true,
          isPDFAttachment: () => false,
          getField: (name) => (name === "title" ? title : ""),
          getFilePath: () => target,
          getFilePathAsync: async () => target,
          saveTx: async () => {
            attachment.dateModified = new Date().toISOString();
          },
        };
        parent._attachmentIds.push(attachment.id);
        return register(attachment);
      },
    },
  };

  return {
    Zotero,
    IOUtils,
    PathUtils,
    control,
    createPaper,
    createAttachment,
    dataDir,
    storageDir,
    /** Install everything the plugin reads off the global scope. */
    install() {
      globalThis.Zotero = Zotero;
      globalThis.IOUtils = IOUtils;
      globalThis.PathUtils = PathUtils;
      globalThis.ztoolkit = { log: () => undefined };
      return Zotero;
    },
  };
}
