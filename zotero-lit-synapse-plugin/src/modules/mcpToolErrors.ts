/** Tool failures retain both the MCP error flag and a parseable recovery envelope. */
export function mcpToolError(
  operation: string,
  args: any,
  error: unknown,
): any {
  const cause = error instanceof Error ? error : new Error(String(error));
  const metadata = cause as Error & {
    code?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
  const request = Object.fromEntries(
    [
      "prepareToken",
      "section",
      "offset",
      "limit",
      "taskId",
      "expectedRevision",
      "operationId",
      "itemKey",
      "libraryID",
      "cursor",
      "markdownOffset",
      "markdownLimit",
      "expectedBodyHash",
    ]
      .filter((key) =>
        ["string", "number", "boolean"].includes(typeof args?.[key]),
      )
      .map((key) => [key, args[key]]),
  );
  const payload = {
    ...metadata.details,
    error: cause.name,
    code:
      typeof metadata.code === "string"
        ? metadata.code
        : cause.name === "Error"
          ? "TOOL_EXECUTION_FAILED"
          : cause.name,
    message: cause.message,
    retryable: metadata.retryable === true,
    operation,
    request,
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
