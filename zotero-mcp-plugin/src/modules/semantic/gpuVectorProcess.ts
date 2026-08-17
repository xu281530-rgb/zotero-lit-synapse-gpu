import {
  GPU_PROTOCOL_VERSION,
  MAX_GPU_HEADER_BYTES,
  MAX_GPU_PAYLOAD_BYTES,
  decodeGpuFrame,
  encodeGpuFrame,
  type GpuFrame,
  type GpuFrameHeader,
} from "./gpuVectorProtocol";

declare const ChromeUtils: any;

interface SubprocessPipe {
  read(length?: number): Promise<ArrayBuffer>;
  write(data: ArrayBuffer | ArrayBufferView | string): Promise<unknown>;
  close(force?: boolean): Promise<unknown>;
}

interface SubprocessHandle {
  pid: number;
  stdin: SubprocessPipe;
  stdout: SubprocessPipe;
  stderr?: SubprocessPipe;
  wait(): Promise<{ exitCode: number }>;
  kill(timeout?: number): Promise<{ exitCode: number }>;
}

export class GpuProcessError extends Error {
  readonly code:
    | "PROCESS_START_FAILED"
    | "PROCESS_EXITED"
    | "INVALID_FRAME"
    | "TIMEOUT";

  constructor(
    message: string,
    code:
      | "PROCESS_START_FAILED"
      | "PROCESS_EXITED"
      | "INVALID_FRAME"
      | "TIMEOUT",
  ) {
    super(message);
    this.name = "GpuProcessError";
    this.code = code;
  }
}

export interface GpuVectorProcessOptions {
  executable: string;
  workdir: string;
  onExit?: (exitCode: number) => void;
}

export class GpuVectorProcess {
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private stopping = false;
  private readonly process: SubprocessHandle;
  private readonly onExit?: (exitCode: number) => void;

  private constructor(
    process: SubprocessHandle,
    onExit?: (exitCode: number) => void,
  ) {
    this.process = process;
    this.onExit = onExit;
    void process.wait().then(({ exitCode }) => {
      if (!this.stopping) this.onExit?.(exitCode);
    });
  }

  static async launch(
    options: GpuVectorProcessOptions,
  ): Promise<GpuVectorProcess> {
    try {
      const { Subprocess } = ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      );
      const inherited = Subprocess.getEnvironment();
      const environment: Record<string, string> = {
        PATH: options.workdir,
      };
      for (const name of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
        if (typeof inherited[name] === "string") {
          environment[name] = inherited[name];
        }
      }
      const process = (await Subprocess.call({
        command: options.executable,
        arguments: ["--stdio"],
        environment,
        environmentAppend: false,
        stderr: "pipe",
        workdir: options.workdir,
      })) as SubprocessHandle;
      return new GpuVectorProcess(process, options.onExit);
    } catch (error) {
      throw new GpuProcessError(
        `Unable to start vector-gpu.exe: ${String(
          (error as any)?.message || error,
        )}`,
        "PROCESS_START_FAILED",
      );
    }
  }

  request(
    type: string,
    fields: Record<string, unknown> = {},
    payload: Uint8Array = new Uint8Array(0),
    timeoutMs = 30000,
  ): Promise<GpuFrame> {
    const requestId = `gpu-${Date.now()}-${++this.sequence}`;
    const operation = this.queue.then(() =>
      this.exchange(type, requestId, fields, payload, timeoutMs),
    );
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async exchange(
    type: string,
    requestId: string,
    fields: Record<string, unknown>,
    payload: Uint8Array,
    timeoutMs: number,
  ): Promise<GpuFrame> {
    const frame = encodeGpuFrame(
      { protocol: GPU_PROTOCOL_VERSION, type, requestId, ...fields },
      payload,
    );
    const operation = (async () => {
      await this.process.stdin.write(frame);
      const response = await this.readFrame();
      if (response.header.requestId !== requestId) {
        throw new GpuProcessError(
          `GPU response requestId mismatch (${response.header.requestId})`,
          "INVALID_FRAME",
        );
      }
      if (response.header.ok !== true) {
        const error = new Error(
          String(response.header.message || "GPU request failed"),
        ) as Error & { code?: string };
        error.code = String(response.header.code || "UNKNOWN");
        throw error;
      }
      return response;
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new GpuProcessError(
                `GPU request ${type} timed out after ${timeoutMs} ms`,
                "TIMEOUT",
              ),
            );
          }, Math.max(1, timeoutMs));
        }),
      ]);
    } catch (error) {
      if ((error as any)?.code === "TIMEOUT") {
        this.stopping = true;
        void this.process.kill(0);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readFrame(): Promise<GpuFrame> {
    try {
      const prefix = await this.readExact(4);
      const headerLength = new DataView(
        prefix.buffer,
        prefix.byteOffset,
        prefix.byteLength,
      ).getUint32(0, true);
      if (headerLength > MAX_GPU_HEADER_BYTES) {
        throw new GpuProcessError(
          "GPU response header exceeds the protocol limit",
          "INVALID_FRAME",
        );
      }
      const header = await this.readExact(headerLength);
      const payloadPrefix = await this.readExact(4);
      const payloadLength = new DataView(
        payloadPrefix.buffer,
        payloadPrefix.byteOffset,
        payloadPrefix.byteLength,
      ).getUint32(0, true);
      if (payloadLength > MAX_GPU_PAYLOAD_BYTES) {
        throw new GpuProcessError(
          "GPU response payload exceeds the protocol limit",
          "INVALID_FRAME",
        );
      }
      const payload = await this.readExact(payloadLength);
      const bytes = new Uint8Array(8 + headerLength + payloadLength);
      bytes.set(prefix, 0);
      bytes.set(header, 4);
      bytes.set(payloadPrefix, 4 + headerLength);
      bytes.set(payload, 8 + headerLength);
      return decodeGpuFrame(bytes);
    } catch (error) {
      if (error instanceof GpuProcessError) throw error;
      throw new GpuProcessError(
        `GPU process closed or returned an invalid frame: ${String(
          (error as any)?.message || error,
        )}`,
        "PROCESS_EXITED",
      );
    }
  }

  private async readExact(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = new Uint8Array(
        await this.process.stdout.read(length - offset),
      );
      if (chunk.byteLength === 0) {
        throw new GpuProcessError(
          "GPU process closed its output pipe",
          "PROCESS_EXITED",
        );
      }
      if (chunk.byteLength > length - offset) {
        throw new GpuProcessError(
          "GPU process returned more bytes than requested",
          "INVALID_FRAME",
        );
      }
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      await this.request("shutdown", {}, new Uint8Array(0), 1000);
    } catch {
      // Forced termination below is the shutdown fallback.
    }
    try {
      await this.process.stdin.close(true);
    } catch {
      // Best effort: the pipe is already gone if the child exited on shutdown.
    }
    try {
      await this.process.kill(0);
    } catch {
      // Best effort: the child may have exited already.
    }
  }
}
