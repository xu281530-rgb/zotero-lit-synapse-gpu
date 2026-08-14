export type GpuVectorFailureCode =
  | "NO_CUDA_DEVICE"
  | "DRIVER_INCOMPATIBLE"
  | "OUT_OF_MEMORY"
  | "DIMENSION_MISMATCH"
  | "RESOURCE_CORRUPT"
  | "PROCESS_START_FAILED"
  | "PROCESS_EXITED"
  | "INVALID_FRAME"
  | "TIMEOUT"
  | "UNSUPPORTED_PLATFORM"
  | "INDEX_UNSUPPORTED"
  | "UNKNOWN";

export type GpuVectorStatus =
  | { phase: "disabled" }
  | { phase: "preparing" }
  | { phase: "loading"; loaded: number; total: number }
  | { phase: "available"; vectors: number; device: string }
  | {
      phase: "fallback";
      code: GpuVectorFailureCode;
      reason: string;
      preferenceEnabled: boolean;
    };

export type GpuVectorStatusListener = (status: GpuVectorStatus) => void;

export class GpuVectorStatusController {
  private status: GpuVectorStatus = { phase: "disabled" };
  private listeners = new Set<GpuVectorStatusListener>();

  get(): GpuVectorStatus {
    return this.status;
  }

  set(status: GpuVectorStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  fallback(
    code: GpuVectorFailureCode,
    reason: string,
    preferenceEnabled: boolean,
  ): void {
    this.set({ phase: "fallback", code, reason, preferenceEnabled });
  }

  subscribe(listener: GpuVectorStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
}
