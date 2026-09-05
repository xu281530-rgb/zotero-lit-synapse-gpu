/* eslint-env node */

const runStats = {
  failures: 0,
  lastError: undefined,
  attachments: 0,
};

export class PDFProcessor {
  async extractText(filePath) {
    const control = globalThis.__minerUIndexRecoveryTest;
    control?.events?.push(`pdfWorker:${filePath}`);
    return control?.pdfWorkerText ?? "";
  }

  terminate() {}
}

export function getMinerUService() {
  return {
    resetRunStats() {
      runStats.failures = 0;
      runStats.lastError = undefined;
      runStats.attachments = 0;
    },
    getRunStats() {
      return { ...runStats };
    },
    async getIndexTextForAttachment(_attachment, options) {
      const control = globalThis.__minerUIndexRecoveryTest;
      const phase = options?.allowParse === true ? "parse" : "reuse";
      control?.events?.push(`minerU:${phase}`);
      control?.options?.push({ ...options });
      return control?.results?.shift() ?? null;
    },
    recordIndexFallback(attachment, message) {
      const control = globalThis.__minerUIndexRecoveryTest;
      control?.fallbacks?.push({ attachment, message });
      runStats.failures += 1;
      runStats.lastError = message;
    },
    getConfig() {
      return {
        enabled: false,
        mode: "local",
        baseURL: "",
        modelVersion: "",
        language: "auto",
        enableOCR: true,
        enableFormula: true,
        enableTable: true,
        timeoutSeconds: 60,
        maxFileSizeMB: 100,
        apiToken: "",
      };
    },
  };
}

export function getOriginalPDFAttachmentsForItem() {
  return globalThis.__minerUIndexRecoveryTest?.originalPDFs ?? [];
}

export function markdownToIndexText(value) {
  return String(value ?? "");
}
