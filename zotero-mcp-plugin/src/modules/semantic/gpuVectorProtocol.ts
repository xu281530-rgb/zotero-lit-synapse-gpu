export const GPU_PROTOCOL_VERSION = "vector-gpu/2";
export const MAX_GPU_HEADER_BYTES = 8 * 1024 * 1024;
export const MAX_GPU_PAYLOAD_BYTES = 32 * 1024 * 1024;

export interface GpuFrameHeader {
  protocol: typeof GPU_PROTOCOL_VERSION;
  type: string;
  requestId: string;
  [key: string]: unknown;
}

export interface GpuFrame {
  header: GpuFrameHeader;
  payload: Uint8Array;
}

/** Incrementally reconstruct frames from arbitrarily fragmented pipe reads. */
export class GpuFrameDecoder {
  private buffered = new Uint8Array(0);

  get bufferedBytes(): number {
    return this.buffered.byteLength;
  }

  push(chunk: Uint8Array): GpuFrame[] {
    if (chunk.byteLength > 0) {
      const combined = new Uint8Array(
        this.buffered.byteLength + chunk.byteLength,
      );
      combined.set(this.buffered);
      combined.set(chunk, this.buffered.byteLength);
      this.buffered = combined;
    }

    const frames: GpuFrame[] = [];
    for (;;) {
      if (this.buffered.byteLength < 4) break;
      const view = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset,
        this.buffered.byteLength,
      );
      const headerLength = view.getUint32(0, true);
      if (headerLength > MAX_GPU_HEADER_BYTES) {
        throw new Error("GPU protocol header is too large");
      }
      if (this.buffered.byteLength < 8 + headerLength) break;
      const payloadLength = view.getUint32(4 + headerLength, true);
      if (payloadLength > MAX_GPU_PAYLOAD_BYTES) {
        throw new Error("GPU protocol payload is too large");
      }
      const frameLength = 8 + headerLength + payloadLength;
      if (this.buffered.byteLength < frameLength) break;
      frames.push(decodeGpuFrame(this.buffered.slice(0, frameLength)));
      this.buffered = this.buffered.slice(frameLength);
    }
    return frames;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeGpuFrame(
  header: GpuFrameHeader,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const headerBytes = encoder.encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_GPU_HEADER_BYTES) {
    throw new Error("GPU protocol header is too large");
  }
  if (payload.byteLength > MAX_GPU_PAYLOAD_BYTES) {
    throw new Error("GPU protocol payload is too large");
  }

  const frame = new Uint8Array(8 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, headerBytes.byteLength, true);
  frame.set(headerBytes, 4);
  view.setUint32(4 + headerBytes.byteLength, payload.byteLength, true);
  frame.set(payload, 8 + headerBytes.byteLength);
  return frame;
}

export function decodeGpuFrame(frame: Uint8Array): GpuFrame {
  if (frame.byteLength < 8) {
    throw new Error("GPU protocol frame is truncated");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const headerLength = view.getUint32(0, true);
  if (headerLength > MAX_GPU_HEADER_BYTES) {
    throw new Error("GPU protocol header is too large");
  }
  if (frame.byteLength < 8 + headerLength) {
    throw new Error("GPU protocol frame is truncated before payload length");
  }
  const payloadLength = view.getUint32(4 + headerLength, true);
  if (payloadLength > MAX_GPU_PAYLOAD_BYTES) {
    throw new Error("GPU protocol payload is too large");
  }
  const expectedLength = 8 + headerLength + payloadLength;
  if (frame.byteLength !== expectedLength) {
    throw new Error(
      frame.byteLength < expectedLength
        ? "GPU protocol frame is truncated"
        : "GPU protocol frame contains trailing bytes",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(frame.subarray(4, 4 + headerLength)));
  } catch (error) {
    throw new Error(`GPU protocol header is invalid JSON: ${error}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("GPU protocol header must be an object");
  }
  const header = parsed as GpuFrameHeader;
  if (
    header.protocol !== GPU_PROTOCOL_VERSION ||
    typeof header.type !== "string" ||
    typeof header.requestId !== "string"
  ) {
    throw new Error("GPU protocol header has an invalid envelope");
  }

  return {
    header,
    payload: frame.slice(8 + headerLength),
  };
}
