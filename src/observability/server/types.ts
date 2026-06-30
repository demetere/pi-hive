export type Subscriber = ReadableStreamDefaultController<Uint8Array>;

export type Source = {
  logPath: string;
  offset: number;
  meta: Record<string, any>;
  statePath: string;
  stateMtimeMs: number;
};
