/* eslint-env node */

/**
 * Tell a FAILED tool call apart from a successful one, the way a client does.
 *
 * This lives in one place because three test scripts had each grown their own
 * copy, and all three copies went stale together. They decided a call had
 * failed by testing whether the text began with "Error executing " — the shape
 * the server used to produce. The server now answers a failure with the
 * structured envelope from `mcpToolError` (isError plus a JSON body carrying
 * code/message/operation), so the prefix never matched, every failure was read
 * back as a SUCCESSFUL result, and the assertions that exist precisely to stop
 * a rejected write from looking like a completed one had stopped testing
 * anything. Three suites were red for a reason that had nothing to do with the
 * behaviour they guard.
 *
 * `isError` alone cannot be the discriminator: write_note, write_tag,
 * write_metadata and write_item mark a receipt whose `success` is false with
 * `isError` too, and that receipt is a real result the tests read fields out
 * of. The envelope is what identifies a failure, and only the envelope carries
 * `operation` alongside `code` and `message`.
 */

/** Does this parsed payload have the shape mcpToolError produces? */
export function isToolErrorEnvelope(payload) {
  return (
    payload !== null &&
    typeof payload === "object" &&
    typeof payload.message === "string" &&
    typeof payload.code === "string" &&
    typeof payload.operation === "string"
  );
}

/**
 * Normalise one tools/call response.
 *
 * Returns `{ error, isError: true }` for a failed call — `error` being the
 * human-readable message, which is what the assertions match against — and
 * `{ result, isError }` for a call that produced a result, failed receipts
 * included.
 */
export function readToolResult(body) {
  const text = body.result.content[0].text;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // A non-JSON body can only be a failure: every tool answers JSON.
    return { error: text, isError: body.result.isError === true, payload: text };
  }
  if (body.result.isError && isToolErrorEnvelope(payload)) {
    return { error: payload.message, isError: true, payload };
  }
  return { result: payload, isError: body.result.isError === true };
}
