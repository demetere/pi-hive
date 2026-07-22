import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_VERSION = 1;
const PAGE_SIZE = 100;
const MAX_RENDERED_ITEMS = 500;
const MAX_SSE_FRAME_BYTES = 65_536;
const MAX_SSE_BUFFER_BYTES = 131_072;
const RECONNECT_MS = 250;
const CLAIMED_IDENTITY = "local-dashboard";

type JsonRecord = Record<string, unknown>;
type ApiResource = "projects" | "workflows" | "sessions" | "runs" | "nodes" | "tasks" | "artifacts" | "checkpoints" | "questions" | "approvals" | "knowledge" | "usage" | "activity" | "history";
type View = ApiResource | "evidence" | "cost" | "model-mix" | "knowledge-bundles" | "knowledge-jobs" | "knowledge-proposals";

interface ResourcePage { readonly items: readonly JsonRecord[]; readonly nextCursor: string | null }
interface Credentials { readonly token: string; readonly csrf: string }
interface SseFrame { readonly event: string; readonly data: string; readonly id?: string }

const WORKFLOW_VIEWS: readonly View[] = [
  "projects", "workflows", "sessions", "runs", "nodes", "tasks", "artifacts", "evidence", "checkpoints", "questions", "approvals",
  "knowledge-bundles", "knowledge-jobs", "knowledge-proposals", "cost", "model-mix", "usage", "activity", "history",
];

const TITLES: Readonly<Record<View, string>> = {
  projects: "Projects", workflows: "Workflows", sessions: "Sessions", runs: "Runs", nodes: "Topology", tasks: "Tasks", artifacts: "Artifacts",
  evidence: "Evidence", checkpoints: "Checkpoints", questions: "Questions", approvals: "Approvals", "knowledge-bundles": "Knowledge bundles",
  "knowledge-jobs": "Knowledge jobs", "knowledge-proposals": "Knowledge proposals", knowledge: "Knowledge", cost: "Cost", "model-mix": "Model mix", usage: "Usage", activity: "Activity", history: "History",
};

const DISPLAY_FIELDS: Readonly<Record<View, readonly string[]>> = {
  projects: ["projectId", "projectLabel", "status", "eventType", "timestamp"],
  workflows: ["workflowId", "status", "eventType", "timestamp"],
  sessions: ["projectId", "sessionId", "workflowId", "status", "eventType", "timestamp"],
  runs: ["projectId", "sessionId", "workflowId", "runId", "status", "eventType", "timestamp"],
  nodes: ["nodeId", "parentNodeId", "agentId", "agentName", "status", "eventType", "timestamp"],
  tasks: ["taskId", "nodeId", "agentId", "status", "eventType", "timestamp"],
  artifacts: ["workspaceId", "adapterId", "adapterVersion", "profileId", "profileVersion", "status", "eventType", "timestamp"],
  evidence: ["eventId", "eventType", "timestamp", "producer", "sequence", "projectId", "sessionId", "runId", "nodeId", "taskId", "workspaceId"],
  checkpoints: ["approvalId", "checkpointId", "workspaceId", "status", "eventType", "timestamp"],
  questions: ["questionId", "nodeId", "taskId", "status", "eventType", "timestamp"],
  approvals: ["approvalId", "checkpointId", "workspaceId", "status", "eventType", "timestamp"],
  "knowledge-bundles": ["knowledgeUpdateId", "status", "eventType", "timestamp"],
  "knowledge-jobs": ["knowledgeJobId", "nodeId", "agentId", "modelId", "status", "operation", "eventType", "timestamp"],
  "knowledge-proposals": ["knowledgeProposalId", "knowledgeUpdateId", "status", "operation", "eventType", "timestamp"],
  knowledge: ["knowledgeJobId", "knowledgeUpdateId", "status", "operation", "eventType", "timestamp"],
  cost: ["estimatedCostMicroUsd", "providerConfirmedCostMicroUsd"],
  "model-mix": ["modelId", "usagePrecision", "usageInputTokens", "usageOutputTokens", "usageCostMicroUsd"],
  usage: ["estimatedInputTokens", "estimatedOutputTokens", "estimatedCostMicroUsd", "providerConfirmedInputTokens", "providerConfirmedOutputTokens", "providerConfirmedCostMicroUsd"],
  activity: ["eventId", "eventType", "timestamp", "producer", "sequence", "projectId", "sessionId", "workflowId", "runId", "nodeId", "taskId", "status", "operation"],
  history: ["eventId", "eventType", "timestamp", "producer", "sequence", "projectId", "sessionId", "workflowId", "runId", "nodeId", "taskId", "status", "operation"],
};

function isRecord(value: unknown): value is JsonRecord { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requireV1(value: unknown, label = "response"): JsonRecord {
  if (!isRecord(value) || value.apiVersion !== API_VERSION) throw new Error(`Dashboard API version is missing or incompatible in ${label}`);
  return value;
}
function records(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.filter(isRecord) : []; }
function stringField(record: JsonRecord, key: string): string | undefined { return typeof record[key] === "string" && record[key] ? record[key] as string : undefined; }
function numberField(record: JsonRecord, key: string): number | undefined { return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : undefined; }

let bootstrapPromise: Promise<Credentials> | undefined;
async function bootstrap(): Promise<Credentials> {
  bootstrapPromise ||= fetch("/bootstrap.json", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
    if (!response.ok) throw new Error(`Dashboard bootstrap failed (${response.status})`);
    const body = await response.json() as unknown;
    if (!isRecord(body) || typeof body.token !== "string" || !body.token || typeof body.csrfToken !== "string" || !body.csrfToken) throw new Error("Dashboard bootstrap credentials are missing");
    return { token: body.token, csrf: body.csrfToken };
  }).catch((error: unknown) => { bootstrapPromise = undefined; throw error; });
  return bootstrapPromise;
}
async function requestHeaders(write = false, stream = false): Promise<Headers> {
  const credentials = await bootstrap();
  const headers = new Headers({ accept: stream ? "text/event-stream" : "application/json", authorization: `Bearer ${credentials.token}`, "x-pi-hive-api-version": String(API_VERSION) });
  if (write) { headers.set("content-type", "application/json"); headers.set("x-pi-hive-csrf", credentials.csrf); }
  return headers;
}

function resourceFor(view: View): ApiResource {
  if (view === "evidence" || view === "model-mix") return "history";
  if (view === "cost") return "usage";
  if (view === "knowledge-bundles" || view === "knowledge-jobs" || view === "knowledge-proposals") return "knowledge";
  return view;
}
function belongsToView(view: View, record: JsonRecord): boolean {
  const proposal = Boolean(stringField(record, "knowledgeProposalId"));
  const job = Boolean(stringField(record, "knowledgeJobId"));
  const bundle = Boolean(stringField(record, "knowledgeUpdateId"));
  if (view === "knowledge-proposals") return proposal;
  if (view === "knowledge-jobs") return job && !proposal;
  if (view === "knowledge-bundles") return bundle && !proposal && !job;
  if (view === "evidence") return Array.isArray(record.refs) && record.refs.some((value) => typeof value === "string" && value);
  if (view === "model-mix") return typeof record.usagePrecision === "string";
  return true;
}
function historyRecord(record: JsonRecord): JsonRecord {
  const dimensions = isRecord(record.dimensions) ? record.dimensions : {};
  const usage = isRecord(record.usage) ? record.usage : {};
  return { eventId: record.eventId, eventType: record.eventType, timestamp: record.timestamp, producer: record.producer, sequence: record.sequence, status: record.status, operation: record.operation,
    projectId: dimensions.projectId, sessionId: dimensions.sessionId, workflowId: dimensions.workflowId, runId: dimensions.runId, nodeId: dimensions.nodeId, taskId: dimensions.taskId, workspaceId: dimensions.workspaceId,
    modelId: dimensions.modelId, refs: Array.isArray(record.refs) ? record.refs.filter((value) => typeof value === "string") : [],
    usagePrecision: usage.precision, usageInputTokens: usage.inputTokens, usageOutputTokens: usage.outputTokens, usageCostMicroUsd: usage.costMicroUsd };
}
function usageRecord(usage: JsonRecord): JsonRecord {
  const estimated = isRecord(usage.estimated) ? usage.estimated : {};
  const confirmed = isRecord(usage.providerConfirmed) ? usage.providerConfirmed : {};
  return {
    estimatedInputTokens: estimated.inputTokens, estimatedOutputTokens: estimated.outputTokens, estimatedCostMicroUsd: estimated.costMicroUsd,
    providerConfirmedInputTokens: confirmed.inputTokens, providerConfirmedOutputTokens: confirmed.outputTokens, providerConfirmedCostMicroUsd: confirmed.costMicroUsd,
  };
}
async function fetchPage(view: View, cursor?: string): Promise<ResourcePage> {
  const resource = resourceFor(view);
  const query = new URLSearchParams();
  if (resource !== "usage") {
    query.set("limit", String(view === "model-mix" ? MAX_RENDERED_ITEMS : PAGE_SIZE));
    if (cursor) query.set("cursor", cursor);
    if (view === "model-mix") query.set("eventType", "budget.model.usage.recorded");
  }
  const path = `/api/v1/${resource}${query.size ? `?${query}` : ""}`;
  const response = await fetch(path, { headers: await requestHeaders(), credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`${TITLES[view]} request failed (${response.status})`);
  const body = requireV1(await response.json(), path);
  if (resource === "usage") {
    if (!isRecord(body.usage)) throw new Error("Invalid API v1 usage response");
    return { items: [usageRecord(body.usage)], nextCursor: null };
  }
  if (!Array.isArray(body.items) || typeof body.hasMore !== "boolean") throw new Error(`Invalid API v1 ${resource} page`);
  if (!["activity", "history"].includes(resource) && body.resource !== resource) throw new Error(`API v1 resource mismatch for ${resource}`);
  const nextCursor = body.hasMore && typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null;
  const items = records(body.items)
    .map((item) => resource === "activity" || resource === "history" ? historyRecord(item) : item)
    .filter((item) => belongsToView(view, item));
  return { items, nextCursor };
}

function operationId(): string { return globalThis.crypto?.randomUUID?.() ?? `dashboard-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
async function postControl(path: string, body: JsonRecord): Promise<void> {
  const response = await fetch(path, { method: "POST", headers: await requestHeaders(true), credentials: "same-origin", body: JSON.stringify({ ...body, operationId: operationId() }) });
  let value: unknown;
  try { value = await response.json(); } catch { value = undefined; }
  if (!response.ok) {
    const api = requireV1(value, path);
    const error = isRecord(api.error) && typeof api.error.message === "string" ? api.error.message : `Control rejected (${response.status})`;
    throw new Error(error);
  }
  requireV1(value, path);
}
async function fetchDetail(kind: "questions" | "approvals" | "knowledge", record: JsonRecord, id: string): Promise<JsonRecord> {
  const query = new URLSearchParams({ projectId: String(record.projectId), sessionId: String(record.sessionId), runId: String(record.runId) });
  const response = await fetch(`/api/v1/${kind}/${encodeURIComponent(id)}?${query}`, { headers: await requestHeaders(), credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`${kind} detail failed (${response.status})`);
  const body = requireV1(await response.json(), `${kind} detail`);
  if (!isRecord(body.object)) throw new Error(`Invalid API v1 ${kind} detail`);
  return body.object;
}

function identity(view: View, record: JsonRecord): string {
  const keys = view === "projects" ? ["projectId"] : view === "workflows" ? ["workflowId", "sessionId"] : view === "sessions" ? ["sessionId"] : view === "runs" ? ["runId"]
    : view === "nodes" ? ["nodeId"] : view === "tasks" ? ["taskId"] : view === "artifacts" ? ["workspaceId"] : view === "questions" ? ["questionId"]
      : view === "approvals" || view === "checkpoints" ? ["approvalId", "checkpointId"] : view === "knowledge-jobs" ? ["knowledgeJobId"]
        : view === "knowledge-proposals" ? ["knowledgeProposalId", "knowledgeUpdateId"] : view === "knowledge-bundles" ? ["knowledgeUpdateId"] : ["eventId", "knowledgeJobId", "knowledgeUpdateId"];
  for (const key of keys) { const value = stringField(record, key); if (value) return value; }
  return view === "usage" ? "Usage totals" : view === "cost" ? "Cost summary" : "unknown";
}
function fieldLabel(value: string): string { return value.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase(); }
function displayValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString("en-US");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return undefined;
}
function DisplayFields({ view, record }: { view: View; record: JsonRecord }) {
  const entries = DISPLAY_FIELDS[view].map((key) => [key, displayValue(record[key])] as const).filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  return <dl>{entries.map(([key, value]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{value}</dd></div>)}</dl>;
}

interface QuestionDefinition { readonly kind: "single" | "multi" | "text" | "confirm"; readonly required: boolean; readonly choices: readonly { value: string; label: string }[]; readonly validation?: JsonRecord }
function questionDefinition(detail: JsonRecord): QuestionDefinition | undefined {
  const definition = isRecord(detail.definition) ? detail.definition : detail;
  if (!["single", "multi", "text", "confirm"].includes(String(definition.kind)) || typeof definition.required !== "boolean") return undefined;
  const choices = Array.isArray(definition.choices) ? definition.choices.filter(isRecord).flatMap((choice) => typeof choice.value === "string" && typeof choice.label === "string" ? [{ value: choice.value, label: choice.label }] : []) : [];
  return { kind: definition.kind as QuestionDefinition["kind"], required: definition.required, choices, ...(isRecord(definition.validation) ? { validation: definition.validation } : {}) };
}

function QuestionControl({ record, onChanged }: { record: JsonRecord; onChanged(): void }) {
  const id = stringField(record, "questionId")!;
  const [detail, setDetail] = useState<JsonRecord>(); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false);
  const [text, setText] = useState(""); const [single, setSingle] = useState(""); const [multi, setMulti] = useState<readonly string[]>([]);
  useEffect(() => { let active = true; void fetchDetail("questions", record, id).then((value) => { if (active) setDetail(value); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); return () => { active = false; }; }, [id, record]);
  const definition = detail ? questionDefinition(detail) : undefined;
  const send = async (value: unknown) => {
    setPending(true); setError(undefined);
    try { await postControl("/api/v1/controls/questions/answer", { projectId: record.projectId, sessionId: record.sessionId, runId: record.runId, questionId: id, expectedState: "pending", value, claimedIdentity: CLAIMED_IDENTITY }); onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  if (error && !definition) return <p role="alert">{error}</p>;
  if (!definition) return <p role="status">Loading typed answer controls…</p>;
  const alert = error ? <p role="alert">{error}</p> : null;
  if (definition.kind === "confirm") return <>{alert}<div className="workflow-controls" aria-label={`Answer ${id}`}><button disabled={pending} onClick={() => void send(true)}>Answer yes</button><button disabled={pending} onClick={() => void send(false)}>Answer no</button></div></>;
  if (definition.kind === "single") return <>{alert}<form onSubmit={(event) => { event.preventDefault(); if (single) void send(single); }}><label htmlFor={`single-${id}`}>Choice for {id}</label><select id={`single-${id}`} value={single} required={definition.required} disabled={pending} onChange={(event) => setSingle(event.target.value)}><option value="">Select one</option>{definition.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select><button disabled={pending || !single}>Submit choice</button></form></>;
  if (definition.kind === "multi") return <>{alert}<form onSubmit={(event) => { event.preventDefault(); void send(multi); }}><fieldset><legend>Choices for {id}</legend>{definition.choices.map((choice) => <label key={choice.value}><input type="checkbox" checked={multi.includes(choice.value)} disabled={pending} onChange={(event) => setMulti(event.target.checked ? [...multi, choice.value] : multi.filter((value) => value !== choice.value))} />{choice.label}</label>)}</fieldset><button disabled={pending || (definition.required && !multi.length)}>Submit choices</button></form></>;
  const maximum = numberField(definition.validation ?? {}, "maxLength") ?? 32_768;
  return <>{alert}<form onSubmit={(event) => { event.preventDefault(); void send(text); }}><label htmlFor={`text-${id}`}>Text answer for {id}</label><textarea id={`text-${id}`} value={text} required={definition.required} maxLength={maximum} disabled={pending} onChange={(event) => setText(event.target.value)} /><button disabled={pending || (definition.required && !text)}>Submit text</button></form></>;
}

function ApprovalControl({ record, onChanged }: { record: JsonRecord; onChanged(): void }) {
  const id = stringField(record, "approvalId"); const [detail, setDetail] = useState<JsonRecord>(); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false);
  useEffect(() => { let active = true; if (id) void fetchDetail("approvals", record, id).then((value) => { if (active) setDetail(value); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); return () => { active = false; }; }, [id, record]);
  if (!id) return null;
  const decide = async (decision: "approved" | "denied") => { if (!detail) return; setPending(true); setError(undefined); try { await postControl("/api/v1/controls/approvals/decide", { projectId: record.projectId, sessionId: record.sessionId, runId: record.runId, requestId: id, expectedRequestSequence: detail.requestSequence, digest: detail.digest, expectedWorkspaceHash: detail.requestWorkspaceHash, decision }); onChanged(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setPending(false); } };
  return <>{detail && !detail.decision && <div className="workflow-controls" aria-label={`Decide ${id}`}><button disabled={pending} onClick={() => void decide("approved")}>Approve {id}</button><button disabled={pending} onClick={() => void decide("denied")}>Deny {id}</button></div>}{!detail && !error && <p role="status">Loading approval provenance…</p>}{error && <p role="alert">{error}</p>}</>;
}
function KnowledgeControl({ record, onChanged }: { record: JsonRecord; onChanged(): void }) {
  const id = stringField(record, "knowledgeProposalId"); const [detail, setDetail] = useState<JsonRecord>(); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false);
  useEffect(() => { let active = true; if (id) void fetchDetail("knowledge", record, id).then((value) => { if (active) setDetail(value); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); return () => { active = false; }; }, [id, record]);
  if (!id) return null;
  const decide = async (decision: "approve" | "deny") => { setPending(true); setError(undefined); try { await postControl("/api/v1/controls/knowledge/decide", { projectId: record.projectId, sessionId: record.sessionId, runId: record.runId, proposalId: id, expectedState: "pending", decision, claimedIdentity: CLAIMED_IDENTITY }); onChanged(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setPending(false); } };
  return <>{detail && detail.state === "pending" && <div className="workflow-controls" aria-label={`Decide ${id}`}><button disabled={pending} onClick={() => void decide("approve")}>Approve {id}</button><button disabled={pending} onClick={() => void decide("deny")}>Deny {id}</button></div>}{!detail && !error && <p role="status">Loading proposal provenance…</p>}{error && <p role="alert">{error}</p>}</>;
}

function EvidenceRefs({ record }: { record: JsonRecord }) {
  const refs = Array.isArray(record.refs) ? record.refs.filter((value): value is string => typeof value === "string" && Boolean(value)) : [];
  return refs.length ? <div><h3>Verified references</h3><ul aria-label="Evidence references">{refs.map((ref) => <li key={ref}><code>{ref}</code></li>)}</ul></div> : null;
}
function RecordCard({ view, record, onChanged }: { view: View; record: JsonRecord; onChanged(): void }) {
  const id = identity(view, record); const heading = `${view}-${id}`.replace(/[^A-Za-z0-9_-]/gu, "-");
  return <article className="workflow-card" aria-labelledby={heading}><h2 id={heading}>{id}</h2><DisplayFields view={view} record={record} />
    {view === "evidence" && <EvidenceRefs record={record} />}
    {view === "questions" && record.status === "pending" && <QuestionControl record={record} onChanged={onChanged} />}
    {view === "approvals" && record.status === "pending" && <ApprovalControl record={record} onChanged={onChanged} />}
    {view === "knowledge-proposals" && record.status === "pending" && <KnowledgeControl record={record} onChanged={onChanged} />}
  </article>;
}
function CostSummary({ record }: { record: JsonRecord }) {
  const dollars = (micro: number | undefined) => `$${((micro ?? 0) / 1_000_000).toFixed(6)}`;
  return <section className="workflow-grid" aria-label="Cost summary">
    <article className="workflow-card"><h2>Provider-confirmed cost</h2><p>{dollars(numberField(record, "providerConfirmedCostMicroUsd"))}</p><p>Authoritative provider billing when available.</p></article>
    <article className="workflow-card"><h2>Estimated cost</h2><p>{dollars(numberField(record, "estimatedCostMicroUsd"))}</p><p>Separately labelled local estimates; never merged with confirmed cost.</p></article>
  </section>;
}
function ModelMixSummary({ items }: { items: readonly JsonRecord[] }) {
  const rows = new Map<string, { confirmed: number; estimated: number; calls: number }>();
  for (const item of items) {
    const model = stringField(item, "modelId") ?? "unattributed"; const prior = rows.get(model) ?? { confirmed: 0, estimated: 0, calls: 0 };
    const tokens = (numberField(item, "usageInputTokens") ?? 0) + (numberField(item, "usageOutputTokens") ?? 0);
    if (item.usagePrecision === "provider-confirmed") prior.confirmed += tokens; else prior.estimated += tokens;
    prior.calls += 1; rows.set(model, prior);
  }
  return <section aria-label="Model mix summary" className="workflow-card"><h2>Usage by model</h2><table><thead><tr><th scope="col">Model</th><th scope="col">Provider-confirmed tokens</th><th scope="col">Estimated tokens</th><th scope="col">Usage records</th></tr></thead><tbody>{[...rows].sort(([a], [b]) => a.localeCompare(b)).map(([model, value]) => <tr key={model}><th scope="row">{model}</th><td>{value.confirmed.toLocaleString("en-US")}</td><td>{value.estimated.toLocaleString("en-US")}</td><td>{value.calls.toLocaleString("en-US")}</td></tr>)}</tbody></table></section>;
}
function Topology({ items }: { items: readonly JsonRecord[] }) {
  const byParent = new Map<string, JsonRecord[]>(); const ids = new Set(items.map((item) => stringField(item, "nodeId")).filter((value): value is string => Boolean(value)));
  for (const item of items) { const parent = stringField(item, "parentNodeId"); const key = parent && ids.has(parent) ? parent : ""; byParent.set(key, [...(byParent.get(key) ?? []), item]); }
  const rendered = new Set<string>();
  const render = (parent: string, ancestors: ReadonlySet<string>): React.ReactNode => {
    const children = (byParent.get(parent) ?? []).filter((item) => !rendered.has(stringField(item, "nodeId") ?? ""));
    if (!children.length) return null;
    return <ul>{children.map((item) => { const id = stringField(item, "nodeId") ?? "unknown"; rendered.add(id); const cyclic = ancestors.has(id); const next = new Set(ancestors); next.add(id); return <li key={id}><RecordCard view="nodes" record={item} onChanged={() => {}} />{cyclic ? null : render(id, next)}</li>; })}</ul>;
  };
  const roots = render("", new Set());
  const disconnected = items.filter((item) => { const id = stringField(item, "nodeId") ?? ""; return id && !rendered.has(id); });
  return <section aria-label="Topology hierarchy" className="workflow-tree">{roots}{disconnected.length ? <ul>{disconnected.map((item) => { const id = stringField(item, "nodeId")!; if (rendered.has(id)) return null; rendered.add(id); return <li key={id}><RecordCard view="nodes" record={item} onChanged={() => {}} />{render(id, new Set([id]))}</li>; })}</ul> : null}</section>;
}

function parseSseFrame(raw: string): SseFrame | undefined {
  let event = "message", id: string | undefined; const data: string[] = [];
  for (const line of raw.replaceAll("\r\n", "\n").split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":"); const field = colon < 0 ? line : line.slice(0, colon); const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "event") event = value; else if (field === "id" && !value.includes("\0")) id = value; else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n"), ...(id ? { id } : {}) } : undefined;
}
function sleep(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); }); }

export default function WorkflowDashboard({ embedded = false }: { embedded?: boolean }) {
  const [view, setView] = useState<View>("workflows"); const viewRef = useRef<View>(view); viewRef.current = view;
  const [items, setItems] = useState<readonly JsonRecord[]>([]); const [cursor, setCursor] = useState<string | null>(null); const cursorRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false); const [error, setError] = useState<string>(); const [resync, setResync] = useState(false); const [streamState, setStreamState] = useState<"connecting" | "live" | "resyncing">("connecting"); const generation = useRef(0);
  const load = useCallback(async (append = false) => {
    const requestedView = view; const currentGeneration = ++generation.current; if (append) setLoadingMore(true); else setLoading(true); setError(undefined);
    try { const page = await fetchPage(requestedView, append ? cursorRef.current ?? undefined : undefined); if (generation.current !== currentGeneration || viewRef.current !== requestedView) return; setItems((prior) => (append ? [...prior, ...page.items] : page.items).slice(0, MAX_RENDERED_ITEMS)); cursorRef.current = page.nextCursor; setCursor(page.nextCursor); }
    catch (reason) { if (generation.current === currentGeneration) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (generation.current === currentGeneration) { setLoading(false); setLoadingMore(false); } }
  }, [view]);
  useEffect(() => { setItems([]); cursorRef.current = null; setCursor(null); void load(false); }, [load]);
  useEffect(() => {
    const controller = new AbortController(); let lastEventId: string | undefined; let fatal = false;
    const run = async () => {
      while (!controller.signal.aborted && !fatal) {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          setStreamState(lastEventId ? "resyncing" : "connecting"); const streamHeaders = await requestHeaders(false, true); if (lastEventId) streamHeaders.set("last-event-id", lastEventId);
          const response = await fetch("/api/v1/stream", { headers: streamHeaders, credentials: "same-origin", cache: "no-store", signal: controller.signal });
          if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) throw new Error(`Workflow stream failed (${response.status})`);
          reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let hello = false; let versionEstablished = false; let reconnectRequested = false;
          while (!controller.signal.aborted) {
            const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
            if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_BUFFER_BYTES) throw new Error("Workflow stream buffer exceeded its bound");
            while (true) {
              const normalized = buffer.replaceAll("\r\n", "\n"); const end = normalized.indexOf("\n\n"); if (end < 0) break;
              const raw = normalized.slice(0, end); buffer = normalized.slice(end + 2); if (new TextEncoder().encode(raw).byteLength > MAX_SSE_FRAME_BYTES) throw new Error("Workflow stream frame exceeded its bound");
              const frame = parseSseFrame(raw); if (!frame) continue;
              let data: unknown; try { data = JSON.parse(frame.data); } catch { throw new Error("Workflow stream frame contains invalid JSON"); }
              if (frame.event === "hello") { requireV1(data, "workflow stream hello"); hello = true; versionEstablished = true; setStreamState("live"); setResync(false); continue; }
              if (frame.event === "resync-required") { requireV1(data, "workflow stream resync"); versionEstablished = true; lastEventId = undefined; setResync(true); setStreamState("resyncing"); void load(false); reconnectRequested = true; continue; }
              if (frame.event === "workflow") { if (!hello) { fatal = true; throw new Error("Workflow stream did not establish API v1 before events"); } if (!isRecord(data) || data.schemaVersion !== 1) throw new Error("Invalid workflow stream event"); if (frame.id) lastEventId = frame.id; void load(false); }
            }
            if (reconnectRequested) break;
          }
          if (!versionEstablished && !controller.signal.aborted) { fatal = true; throw new Error("Workflow stream API version hello is missing"); }
        } catch (reason) { if (!controller.signal.aborted) { const message = reason instanceof Error ? reason.message : String(reason); setResync(true); setStreamState("resyncing"); if (/API version|establish|hello is missing/iu.test(message)) { fatal = true; setError(message); } } }
        finally { try { await reader?.cancel(); } catch { /* closed */ } }
        if (!controller.signal.aborted && !fatal) await sleep(RECONNECT_MS, controller.signal);
      }
    };
    void run(); return () => controller.abort("dashboard unmounted or view changed");
  }, [load]);

  const title = TITLES[view]; const stateText = loading ? `Loading ${title}…` : error ? `${title} unavailable.` : resync ? `Resynchronizing ${title} from API v1.` : `${items.length} ${title.toLowerCase()} loaded; stream ${streamState}.`;
  const content = useMemo(() => view === "nodes" && items.length ? <Topology items={items} />
    : view === "cost" && items[0] ? <CostSummary record={items[0]} />
      : view === "model-mix" && items.length ? <ModelMixSummary items={items} />
        : items.length ? <section className="workflow-grid" aria-label={title}>{items.map((item, index) => <RecordCard key={`${identity(view, item)}-${index}`} view={view} record={item} onChanged={() => void load(false)} />)}</section> : null, [items, load, title, view]);
  const landmarkContent = <><div className="workflow-title"><div><h1>{title}</h1><p>Bounded, allowlisted workflow state. This dashboard cannot launch workflows or edit configuration.</p></div><button type="button" onClick={() => void load(false)} disabled={loading}>Refresh</button></div><div className="workflow-state" role="status" aria-live="polite">{stateText}</div>
    {error ? <section className="workflow-error" role="alert"><p>{error}</p><button type="button" onClick={() => void load(false)}>Retry {title}</button></section> : loading && !items.length ? <div className="workflow-skeleton" aria-hidden="true"><i /><i /><i /></div> : !items.length ? <p className="workflow-empty">No {title.toLowerCase()} available.</p> : content}
    {cursor && !loading && !error && <button className="load-more" type="button" disabled={loadingMore || items.length >= MAX_RENDERED_ITEMS} onClick={() => void load(true)}>{loadingMore ? "Loading…" : items.length >= MAX_RENDERED_ITEMS ? "Display limit reached" : `Load more ${title}`}</button>}</>;
  return <div className={`workflow-dashboard${embedded ? " workflow-dashboard-embedded" : ""}`}><a className="skip-link" href="#workflow-content">Skip to content</a>{!embedded && <header><div><strong>pi-hive</strong><span>Workflow observation &amp; exact human controls</span></div><span className="api-badge">API v1</span></header>}<div className="workflow-shell">
    <nav aria-label="Workflow dashboard views">{WORKFLOW_VIEWS.filter((entry) => entry !== "knowledge").map((entry) => <button type="button" aria-current={entry === view ? "page" : undefined} key={entry} onClick={() => setView(entry)}>{TITLES[entry]}</button>)}</nav>
    {embedded ? <section id="workflow-content" tabIndex={-1} aria-label="Workflow dashboard content">{landmarkContent}</section> : <main id="workflow-content" tabIndex={-1}>{landmarkContent}</main>}
  </div></div>;
}
