import type { TelemetryRegistryRow } from "../../shared/telemetry";

export type Subscriber = ReadableStreamDefaultController<Uint8Array>;

export type Source = {
  logPath: string;
  offset: number;
  meta: TelemetryRegistryRow;
  statePath: string;
  stateMtimeMs: number;
};
