import type { HiveEvent, Snapshot } from "./types";

export interface InitialData {
  events: HiveEvent[];
  states: Snapshot[];
}

async function jsonOr<T>(request: Promise<Response>, fallback: T): Promise<T> {
  try {
    const response = await request;
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

export async function fetchInitialData(): Promise<InitialData> {
  const [ev, st] = await Promise.all([
    jsonOr<{ events: HiveEvent[] }>(fetch("/events"), { events: [] }),
    jsonOr<{ states: Snapshot[] }>(fetch("/states"), { states: [] }),
  ]);
  return { events: ev.events || [], states: st.states || [] };
}

export async function deleteSessionRemote(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteProjectRemote(project: string): Promise<boolean> {
  try {
    const res = await fetch(`/projects/${encodeURIComponent(project)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export function openEventStream(): EventSource {
  return new EventSource("/stream");
}
