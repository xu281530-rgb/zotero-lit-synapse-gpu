import type { GpuVectorPrecision } from "./gpuVectorBackend";

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
  | { phase: "disabled"; backend: "cpu"; precision: GpuVectorPrecision }
  | { phase: "preparing"; precision?: GpuVectorPrecision }
  | {
      phase: "loading";
      loaded: number;
      total: number;
      precision: GpuVectorPrecision;
    }
  | {
      phase: "available";
      backend: "gpu";
      vectors: number;
      device: string;
      precision: GpuVectorPrecision;
      deviceBytes: number;
    }
  | {
      phase: "fallback";
      backend: "cpu";
      precision: GpuVectorPrecision;
      code: GpuVectorFailureCode;
      reason: string;
      preferenceEnabled: boolean;
    };

export type GpuVectorStatusListener = (status: GpuVectorStatus) => void;

export class GpuVectorStatusController {
  private status: GpuVectorStatus = {
    phase: "disabled",
    backend: "cpu",
    precision: "int8",
  };
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
    precision: GpuVectorPrecision,
  ): void {
    this.set({
      phase: "fallback",
      backend: "cpu",
      precision,
      code,
      reason,
      preferenceEnabled,
    });
  }

  subscribe(listener: GpuVectorStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
}
