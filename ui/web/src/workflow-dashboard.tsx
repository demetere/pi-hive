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
type View = ApiResource | "overview" | "evidence" | "cost" | "model-mix" | "knowledge-bundles" | "knowledge-jobs" | "knowledge-proposals";
type Theme = "dark" | "light";

interface ResourcePage { readonly items: readonly JsonRecord[]; readonly nextCursor: string | null }
interface Credentials { readonly token: string; readonly csrf: string }
interface SseFrame { readonly event: string; readonly data: string; readonly id?: string }

const NAV_GROUPS: readonly { readonly label: string; readonly views: readonly View[] }[] = [
  { label: "Mission control", views: ["overview", "projects", "workflows", "sessions", "runs"] },
  { label: "Execution", views: ["nodes", "tasks", "activity", "history"] },
  { label: "Governance", views: ["artifacts", "evidence", "checkpoints", "questions", "approvals"] },
  { label: "Knowledge", views: ["knowledge-bundles", "knowledge-jobs", "knowledge-proposals"] },
  { label: "Insights", views: ["cost", "model-mix", "usage"] },
];

const TITLES: Readonly<Record<View, string>> = {
  overview: "Overview", projects: "Projects", workflows: "Workflows", sessions: "Sessions", runs: "Runs", nodes: "Topology", tasks: "Tasks", artifacts: "Artifacts",
  evidence: "Evidence", checkpoints: "Checkpoints", questions: "Questions", approvals: "Approvals", "knowledge-bundles": "Knowledge bundles",
  "knowledge-jobs": "Knowledge jobs", "knowledge-proposals": "Knowledge proposals", knowledge: "Knowledge", cost: "Cost", "model-mix": "Model mix", usage: "Usage", activity: "Activity", history: "History",
};

const SUBTITLES: Readonly<Record<View, string>> = {
  overview: "Live workflow health, topology, activity, and usage at a glance.", projects: "Configured project identities visible to the workflow projection.", workflows: "Selected workflow definitions and their current state.", sessions: "Linked Pi sessions carrying workflow execution state.", runs: "Durable workflow runs and their terminal or active status.", nodes: "The current hierarchical agent topology for projected runs.", tasks: "Delegated work owned by workflow nodes.", artifacts: "Bound artifact workspaces without exposing private content.", evidence: "Verified event references projected from authoritative journals.", checkpoints: "Artifact checkpoint requests and current decisions.", questions: "Durable human questions awaiting exact typed answers.", approvals: "Human approval controls with exact request provenance.", "knowledge-bundles": "Bounded knowledge updates available to workflows.", "knowledge-jobs": "Durable enrichment work and model attribution.", "knowledge-proposals": "Human-reviewed knowledge changes awaiting decisions.", knowledge: "Projected knowledge lifecycle state.", cost: "Provider-confirmed and explicitly separated estimated spend.", "model-mix": "Token usage grouped by model and precision.", usage: "Authoritative token and cost counters by precision.", activity: "The newest projected workflow events.", history: "Bounded durable workflow event history.",
};

const DISPLAY_FIELDS: Readonly<Record<View, readonly string[]>> = {
  overview: [],
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
  if (view === "overview") throw new Error("Overview is composed from bounded API v1 resources");
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
  if (view === "overview") {
    const overviewViews = ["projects", "workflows", "sessions", "runs", "nodes", "tasks", "questions", "approvals", "activity", "usage"] as const;
    const pages = await Promise.all(overviewViews.map(async (sourceView) => ({ sourceView, page: await fetchPage(sourceView) })));
    return {
      items: pages.flatMap(({ sourceView, page }) => page.items.map((item) => ({ ...item, dashboardView: sourceView }))).slice(0, MAX_RENDERED_ITEMS),
      nextCursor: null,
    };
  }
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
  const keys = view === "overview" ? ["workflowId", "runId", "sessionId", "projectId", "nodeId", "taskId", "eventId"] : view === "projects" ? ["projectId"] : view === "workflows" ? ["workflowId", "sessionId"] : view === "sessions" ? ["sessionId"] : view === "runs" ? ["runId"]
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

function statusTone(status: string | undefined): "running" | "done" | "waiting" | "error" | "idle" {
  const value = status?.toLowerCase() ?? "";
  if (/error|fail|blocked|cancel/u.test(value)) return "error";
  if (/complete|done|approved|ready|recorded/u.test(value)) return "done";
  if (/run|active|current|started|progress/u.test(value)) return "running";
  if (/pending|wait|pause|question|human/u.test(value)) return "waiting";
  return "idle";
}
function StatusBadge({ status }: { status: string | undefined }) {
  if (!status) return null;
  const tone = statusTone(status);
  return <span className={`record-status ${tone}`}><i aria-hidden="true" />{status.replaceAll("_", " ")}</span>;
}
function EvidenceRefs({ record }: { record: JsonRecord }) {
  const refs = Array.isArray(record.refs) ? record.refs.filter((value): value is string => typeof value === "string" && Boolean(value)) : [];
  return refs.length ? <div className="evidence-refs"><h3>Verified references</h3><ul aria-label="Evidence references">{refs.map((ref) => <li key={ref}><code>{ref}</code></li>)}</ul></div> : null;
}
function RecordCard({ view, record, onChanged }: { view: View; record: JsonRecord; onChanged(): void }) {
  const id = identity(view, record); const heading = `${view}-${id}`.replace(/[^A-Za-z0-9_-]/gu, "-");
  const status = stringField(record, "status");
  return <article className={`workflow-card workflow-card-${view}`} aria-labelledby={heading}><div className="record-card-head"><div><span className="record-kind">{TITLES[view]}</span><h2 id={heading}>{id}</h2></div><StatusBadge status={status} /></div><DisplayFields view={view} record={record} />
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
  const scope = (item: JsonRecord) => [stringField(item, "projectId"), stringField(item, "sessionId"), stringField(item, "runId")].map((value) => value ?? "").join("\0");
  const entityKey = (item: JsonRecord, nodeId = stringField(item, "nodeId") ?? "unknown") => `${scope(item)}\0${nodeId}`;
  const nodeItems = [...new Map(items.filter((item) => Boolean(stringField(item, "nodeId"))).map((item) => [entityKey(item), item])).values()];
  const byParent = new Map<string, JsonRecord[]>(); const ids = new Set(nodeItems.map((item) => entityKey(item)));
  for (const item of nodeItems) { const parent = stringField(item, "parentNodeId"); const candidate = parent ? entityKey(item, parent) : ""; const key = parent && ids.has(candidate) ? candidate : ""; byParent.set(key, [...(byParent.get(key) ?? []), item]); }
  const rendered = new Set<string>();
  const render = (parent: string, ancestors: ReadonlySet<string>): React.ReactNode => {
    const children = (byParent.get(parent) ?? []).filter((item) => !rendered.has(entityKey(item)));
    if (!children.length) return null;
    return <ul>{children.map((item) => { const key = entityKey(item); rendered.add(key); const cyclic = ancestors.has(key); const next = new Set(ancestors); next.add(key); return <li key={key}><RecordCard view="nodes" record={item} onChanged={() => {}} />{cyclic ? null : render(key, next)}</li>; })}</ul>;
  };
  const roots = render("", new Set());
  const disconnected = nodeItems.filter((item) => { const id = stringField(item, "nodeId") ?? ""; return id && !rendered.has(entityKey(item)); });
  return <section aria-label="Topology hierarchy" className="workflow-tree">{roots}{disconnected.length ? <ul>{disconnected.map((item) => { const key = entityKey(item); if (rendered.has(key)) return null; rendered.add(key); return <li key={key}><RecordCard view="nodes" record={item} onChanged={() => {}} />{render(key, new Set([key]))}</li>; })}</ul> : null}</section>;
}

function relativeTime(value: string | undefined): string {
  if (!value) return "—";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return value;
  const seconds = Math.max(0, Math.floor(elapsed / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function eventLabel(record: JsonRecord): string {
  return (stringField(record, "eventType") ?? "workflow.event").replaceAll(".", " · ").replaceAll("_", " ");
}
function ActivityFeed({ items, compact = false }: { items: readonly JsonRecord[]; compact?: boolean }) {
  const visible = compact ? items.slice(0, 12) : items;
  return <section className={`activity-feed${compact ? " compact" : ""}`} aria-label={compact ? "Recent activity" : "Activity events"}>{visible.map((item, index) => {
    const id = stringField(item, "eventId") ?? `event-${index}`; const status = stringField(item, "status");
    const actor = stringField(item, "agentName") ?? stringField(item, "agentId") ?? stringField(item, "nodeId") ?? stringField(item, "producer") ?? "workflow";
    return <article className="activity-row" key={id}><i className={`activity-rail ${statusTone(status ?? stringField(item, "eventType"))}`} aria-hidden="true" /><time dateTime={stringField(item, "timestamp")}>{relativeTime(stringField(item, "timestamp"))}</time><div><div className="activity-row-title"><strong>{actor}</strong><span>{eventLabel(item)}</span></div><p>{stringField(item, "workflowId") ?? stringField(item, "runId") ?? stringField(item, "sessionId") ?? id}</p></div><span className="event-sequence">#{numberField(item, "sequence") ?? index + 1}</span></article>;
  })}</section>;
}
function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "run" | "brand" | "done" | "warn" }) {
  return <article className={`kpi${tone ? ` kpi-${tone}` : ""}`}><div className="kpi-top"><span className="kpi-label">{label}</span><i className="kpi-signal" aria-hidden="true" /></div><div className="kpi-val">{value}</div><div className="kpi-sub">{sub}</div></article>;
}
function Overview({ items, onNavigate }: { items: readonly JsonRecord[]; onNavigate(view: View): void }) {
  const inView = (view: View) => items.filter((item) => item.dashboardView === view);
  const projects = inView("projects"); const workflows = inView("workflows"); const sessions = inView("sessions"); const runs = inView("runs"); const nodes = inView("nodes"); const tasks = inView("tasks"); const questions = inView("questions"); const approvals = inView("approvals"); const activity = inView("activity"); const usage = inView("usage")[0] ?? {};
  const activeRuns = runs.filter((item) => statusTone(stringField(item, "status")) === "running").length;
  const pendingHuman = [...questions, ...approvals].filter((item) => statusTone(stringField(item, "status")) === "waiting").length;
  const estimatedTokens = (numberField(usage, "estimatedInputTokens") ?? 0) + (numberField(usage, "estimatedOutputTokens") ?? 0);
  const confirmedTokens = (numberField(usage, "providerConfirmedInputTokens") ?? 0) + (numberField(usage, "providerConfirmedOutputTokens") ?? 0);
  const confirmedCost = (numberField(usage, "providerConfirmedCostMicroUsd") ?? 0) / 1_000_000;
  const latest = activity.map((item) => stringField(item, "timestamp")).filter((value): value is string => Boolean(value)).sort().at(-1);
  return <>
    <section className="kpis dashboard-kpis" aria-label="Workflow summary">
      <Kpi label="Running" value={activeRuns.toLocaleString("en-US")} sub={`${runs.length} total runs`} tone="run" />
      <Kpi label="Sessions" value={sessions.length.toLocaleString("en-US")} sub={`${workflows.length} workflows`} />
      <Kpi label="Agents" value={nodes.length.toLocaleString("en-US")} sub={`${tasks.length} delegated tasks`} tone="done" />
      <Kpi label="Human input" value={pendingHuman.toLocaleString("en-US")} sub="pending decisions" tone={pendingHuman ? "warn" : undefined} />
      <Kpi label="Tokens" value={(confirmedTokens || estimatedTokens).toLocaleString("en-US")} sub={confirmedTokens ? "provider confirmed" : "estimated"} />
      <Kpi label="Total cost" value={`$${confirmedCost.toFixed(4)}`} sub={latest ? `updated ${relativeTime(latest)}` : "no usage yet"} tone="brand" />
    </section>
    <section className="widgets dashboard-widgets">
      <section className="widget topology-widget"><div className="w-head"><div><span className="widget-eyebrow">Live structure</span><h2 className="w-title">Session topology</h2></div><div className="w-tools"><span className="legend-pill running"><i />running</span><span className="legend-pill waiting"><i />waiting</span><button type="button" onClick={() => onNavigate("nodes")}>Open Topology</button></div></div><div className="topology-canvas">{nodes.length ? <Topology items={nodes} /> : <div className="overview-empty"><HiveMark compact /><strong>No topology yet</strong><span>Select a workflow and send a message to start a run.</span></div>}</div></section>
      <section className="widget activity-widget"><div className="w-head"><div><span className="widget-eyebrow">Streaming</span><h2 className="w-title">Activity</h2></div><div className="w-tools"><span className="live-indicator"><i />live</span><button type="button" onClick={() => onNavigate("activity")}>View all</button></div></div>{activity.length ? <ActivityFeed items={activity} compact /> : <div className="overview-empty small"><strong>Waiting for events</strong><span>Workflow activity will appear here in real time.</span></div>}</section>
      <section className="widget workflow-widget"><div className="w-head"><div><span className="widget-eyebrow">Catalog</span><h2 className="w-title">Workflows</h2></div><div className="w-tools"><button type="button" onClick={() => onNavigate("workflows")}>Explore</button></div></div><div className="overview-workflow-list">{workflows.slice(0, 6).map((item) => <button type="button" key={identity("workflows", item)} onClick={() => onNavigate("workflows")}><span><i className={`dot ${statusTone(stringField(item, "status"))}`} />{stringField(item, "workflowId") ?? "workflow"}</span><StatusBadge status={stringField(item, "status")} /></button>)}{!workflows.length && <div className="overview-empty small"><strong>No projected workflows</strong><span>Run /hive:select inside Pi.</span></div>}</div></section>
      <section className="widget usage-widget"><div className="w-head"><div><span className="widget-eyebrow">Precision separated</span><h2 className="w-title">Cost &amp; tokens</h2></div><div className="w-tools"><button type="button" onClick={() => onNavigate("cost")}>Inspect usage</button></div></div><div className="usage-bars"><div><span>Provider confirmed</span><b>{confirmedTokens.toLocaleString("en-US")}</b><i><em style={{ width: `${Math.min(100, confirmedTokens ? 100 : 0)}%` }} /></i></div><div><span>Estimated</span><b>{estimatedTokens.toLocaleString("en-US")}</b><i><em style={{ width: `${Math.min(100, estimatedTokens && !confirmedTokens ? 100 : confirmedTokens ? estimatedTokens / confirmedTokens * 100 : 0)}%` }} /></i></div></div></section>
    </section>
    {!projects.length && !workflows.length && <p className="overview-footnote">The dashboard is connected. Select a workflow in Pi to populate this project.</p>}
  </>;
}

function NavIcon({ view }: { view: View }) {
  const common = { width: 17, height: 17, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.45, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (view === "overview") return <svg {...common}><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></svg>;
  if (["projects", "workflows", "sessions", "runs"].includes(view)) return <svg {...common}><rect x="2" y="3" width="12" height="4" rx="1.5" /><rect x="2" y="10" width="12" height="3" rx="1.5" /></svg>;
  if (["nodes", "tasks"].includes(view)) return <svg {...common}><circle cx="8" cy="3" r="1.7" /><circle cx="3.5" cy="12" r="1.7" /><circle cx="12.5" cy="12" r="1.7" /><path d="M8 4.8v2.5M3.5 10.2V8h9v2.2" /></svg>;
  if (["activity", "history", "evidence"].includes(view)) return <svg {...common}><path d="M1.5 8h3l1.4-4 3 8 1.7-5 1.1 1H14.5" /></svg>;
  if (["questions", "approvals", "checkpoints"].includes(view)) return <svg {...common}><path d="M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z" /><path d="M6.6 6.2A1.6 1.6 0 0 1 8.2 4.8c1 0 1.8.6 1.8 1.5 0 1.2-1.7 1.3-1.7 2.7M8.3 11.3h.01" /></svg>;
  if (["knowledge-bundles", "knowledge-jobs", "knowledge-proposals", "knowledge"].includes(view)) return <svg {...common}><path d="M3 2.5h7.5A2.5 2.5 0 0 1 13 5v8.5H5A2 2 0 0 1 3 11.5v-9Z" /><path d="M5 13.5v-9h8M6.5 7h4M6.5 9.5h3" /></svg>;
  if (["cost", "model-mix", "usage"].includes(view)) return <svg {...common}><path d="M8 1.8v12.4M11 4.2H6.6a2 2 0 1 0 0 4h2.8a2 2 0 1 1 0 4H4.7" /></svg>;
  return <svg {...common}><path d="M3 2.5h7l3 3v8H3z" /><path d="M10 2.5v3h3M5.5 9h5M5.5 11.5h4" /></svg>;
}
function HiveMark({ compact = false }: { compact?: boolean }) {
  return <span className={`hive-mark${compact ? " compact" : ""}`} aria-hidden="true"><svg width={compact ? 20 : 24} height={compact ? 20 : 24} viewBox="0 0 24 24" fill="none"><path d="m12 2.8 7.7 4.5v9L12 20.8l-7.7-4.5v-9L12 2.8Z" stroke="currentColor" strokeWidth="1.7" /><circle cx="12" cy="12" r="3.2" fill="currentColor" /><path d="M12 5.2v3.1M17.7 8.6 15 10.1M17.7 15.4 15 13.9M6.3 15.4 9 13.9M6.3 8.6 9 10.1" stroke="var(--brand-contrast)" strokeWidth="1.1" /></svg></span>;
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

function initialTheme(): Theme {
  try { return window.localStorage.getItem("hive-theme") === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}

export default function WorkflowDashboard({ embedded = false }: { embedded?: boolean }) {
  const [view, setView] = useState<View>("overview"); const viewRef = useRef<View>(view); viewRef.current = view;
  const [items, setItems] = useState<readonly JsonRecord[]>([]); const [summaryItems, setSummaryItems] = useState<readonly JsonRecord[]>([]); const [cursor, setCursor] = useState<string | null>(null); const cursorRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false); const [error, setError] = useState<string>(); const [resync, setResync] = useState(false); const [streamState, setStreamState] = useState<"connecting" | "live" | "resyncing">("connecting"); const [theme, setTheme] = useState<Theme>(initialTheme); const [now, setNow] = useState(() => new Date()); const generation = useRef(0);
  const load = useCallback(async (append = false) => {
    const requestedView = view; const currentGeneration = ++generation.current; if (append) setLoadingMore(true); else setLoading(true); setError(undefined);
    try { const page = await fetchPage(requestedView, append ? cursorRef.current ?? undefined : undefined); if (generation.current !== currentGeneration || viewRef.current !== requestedView) return; setItems((prior) => (append ? [...prior, ...page.items] : page.items).slice(0, MAX_RENDERED_ITEMS)); if (requestedView === "overview") setSummaryItems(page.items); cursorRef.current = page.nextCursor; setCursor(page.nextCursor); }
    catch (reason) { if (generation.current === currentGeneration) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (generation.current === currentGeneration) { setLoading(false); setLoadingMore(false); } }
  }, [view]);
  useEffect(() => { document.documentElement.dataset.theme = theme; try { window.localStorage.setItem("hive-theme", theme); } catch { /* storage unavailable */ } }, [theme]);
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1_000); return () => window.clearInterval(timer); }, []);
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
  const content = useMemo(() => view === "overview" && items.length ? <Overview items={items} onNavigate={setView} />
    : view === "nodes" && items.length ? <Topology items={items} />
      : view === "activity" || view === "history" ? items.length ? <ActivityFeed items={items} /> : null
        : view === "cost" && items[0] ? <CostSummary record={items[0]} />
          : view === "model-mix" && items.length ? <ModelMixSummary items={items} />
            : items.length ? <section className="workflow-grid" aria-label={title}>{items.map((item, index) => <RecordCard key={`${identity(view, item)}-${index}`} view={view} record={item} onChanged={() => void load(false)} />)}</section> : null, [items, load, title, view]);
  const landmarkContent = <><div className="workflow-title"><div><span className="page-eyebrow">Mission control / {title}</span><h1>{title}</h1><p>{SUBTITLES[view]}</p></div><button className="refresh-button" type="button" onClick={() => void load(false)} disabled={loading}><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M13.5 5.5A5.8 5.8 0 1 0 14 9" /><path d="M13.5 2v3.5H10" /></svg>Refresh</button></div><div className="workflow-state sr-status" role="status" aria-live="polite">{stateText}</div>
    {error ? <section className="workflow-error" role="alert"><p>{error}</p><button type="button" onClick={() => void load(false)}>Retry {title}</button></section> : loading && !items.length ? <div className="workflow-skeleton" aria-hidden="true"><i /><i /><i /></div> : !items.length ? <div className="workflow-empty"><HiveMark compact /><strong>No {title.toLowerCase()} available</strong><span>The dashboard is connected and waiting for projected workflow state.</span></div> : content}
    {cursor && !loading && !error && <button className="load-more" type="button" disabled={loadingMore || items.length >= MAX_RENDERED_ITEMS} onClick={() => void load(true)}>{loadingMore ? "Loading…" : items.length >= MAX_RENDERED_ITEMS ? "Display limit reached" : `Load more ${title}`}</button>}</>;
  if (embedded) return <div className="workflow-dashboard workflow-dashboard-embedded"><section id="workflow-content" tabIndex={-1} aria-label="Workflow dashboard content">{landmarkContent}</section></div>;
  const project = summaryItems.find((item) => item.dashboardView === "projects"); const projectLabel = stringField(project ?? {}, "projectLabel") ?? stringField(project ?? {}, "projectId") ?? "Local project";
  const navCount = (entry: View): number | undefined => entry === "overview" ? undefined : summaryItems.filter((item) => item.dashboardView === entry).length || undefined;
  return <div className="workflow-dashboard dashboard-frame"><a className="skip-link" href="#workflow-content">Skip to content</a><aside className="dashboard-sidebar"><div className="sidebar-brand"><HiveMark /><div><strong>pi-hive</strong><span>Mission control</span></div></div><div className="project-scope"><i aria-hidden="true" /><span>{projectLabel}</span><small>API v1</small></div><nav aria-label="Workflow dashboard views">{NAV_GROUPS.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.views.map((entry) => <button type="button" aria-label={TITLES[entry]} aria-current={entry === view ? "page" : undefined} key={entry} onClick={() => setView(entry)}><NavIcon view={entry} /><span>{TITLES[entry]}</span>{navCount(entry) !== undefined && <small aria-hidden="true">{navCount(entry)}</small>}</button>)}</div>)}</nav><div className="sidebar-footer"><div className="connection-card"><span><i className={streamState} aria-hidden="true" />{streamState === "live" ? "Connected" : streamState === "connecting" ? "Connecting" : "Resyncing"}</span><code>localhost:43191</code></div><div className="theme-switch" aria-label="Dashboard theme"><button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>Dark</button><button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Light</button></div></div></aside><div className="dashboard-main"><header className="dashboard-topbar"><div><span className={`topbar-live ${streamState}`}><i />{streamState}</span><span className="topbar-divider" /><span className="topbar-project">{projectLabel}</span></div><time dateTime={now.toISOString()}>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></header><main id="workflow-content" tabIndex={-1}>{landmarkContent}</main></div></div>;
}
