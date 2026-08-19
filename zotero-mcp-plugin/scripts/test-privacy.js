/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = {
  DataDirectory: { dir: "" },
  Prefs: { get: () => false },
};

const { describePrivateText, redactAbsolutePaths, sanitizeForPrivacy } =
  await import("../src/utils/privacy.ts");

const pathCases = [
  [
    "D:\\My Documents\\Secret Paper.pdf",
    "[redacted-path]",
  ],
  [
    "File not found: D:/Research Projects/Grant 2027/budget notes.pdf",
    "File not found: [redacted-path]",
  ],
  [
    'Could not open "C:\\Users\\Alice Smith\\Zotero\\private draft.pdf"',
    'Could not open "[redacted-path]"',
  ],
  [
    "Cannot read /Users/Alice Smith/Zotero/storage/private draft.pdf",
    "Cannot read [redacted-path]",
  ],
  [
    "Open file:///D:/Research Projects/private draft.pdf",
    "Open [redacted-path]",
  ],
  [
    'Cannot scan "D:\\My Documents\\Archive"',
    'Cannot scan "[redacted-path]"',
  ],
  [
    "/Users/Alice Smith/Zotero/storage",
    "[redacted-path]",
  ],
  [
    'Cannot scan "\\\\research-server\\Shared Papers\\Archive"',
    'Cannot scan "[redacted-path]"',
  ],
  [
    "file:///D:/Research Projects/Archive",
    "[redacted-path]",
  ],
];

for (const [input, expected] of pathCases) {
  assert.equal(
    redactAbsolutePaths(input, ""),
    expected,
    `the complete local path must be hidden: ${input}`,
  );
}

const remote = "Download https://example.com/Research Projects/paper.pdf";
assert.equal(
  redactAbsolutePaths(remote, ""),
  remote,
  "remote URLs are useful evidence and must not be mistaken for local paths",
);

const relative = "Open Research Projects/Archive to continue";
assert.equal(
  redactAbsolutePaths(relative, ""),
  relative,
  "relative paths and ordinary prose must remain readable",
);

const structured = sanitizeForPrivacy({
  attachmentPath: "D:\\My Documents\\Secret Paper.pdf",
  message: "File not found: D:\\My Documents\\Secret Paper.pdf",
});
assert.deepEqual(structured, {
  attachmentPath: "",
  message: "File not found: [redacted-path]",
});

const requestBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "write_note",
    arguments: { content: "confidential research result" },
  },
});
const diagnostic = describePrivateText(requestBody);
assert.match(diagnostic, /^\d+ chars; content omitted$/);
assert.doesNotMatch(diagnostic, /write_note|confidential|research result/);

console.log("Privacy redaction and logging tests passed");
