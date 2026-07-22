import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseCommandAnswer, type QuestionDefinition } from "../workflows/question-validation";

const MAX_OUTPUT_BYTES = 8_192;
const COMMAND_CHANNEL = "command" as const;

export interface WorkflowSelectorItem {
  readonly workflowId: string;
  readonly name: string;
  readonly description: string;
  readonly useWhen: string;
  readonly avoidWhen?: string;
  readonly tags: readonly string[];
  readonly adapter: string;
  readonly profile: string;
  readonly activationHash?: string;
  readonly source: "current" | "stale" | "missing" | "invalid";
  readonly archivedLinks: readonly Readonly<{ workflowSessionId: string; piSessionId: string; activationHash: string }> [];
  readonly state: "available" | "active" | "archived" | "stale" | "orphaned" | "invalid" | "resumable";
  readonly resumable: boolean;
  readonly selectable: boolean;
  readonly diagnostics: readonly string[];
  readonly diagnostic?: string;
}

export interface WorkflowCheckpointAction {
  readonly kind: "default";
  readonly checkpointId: string;
  readonly policy: "required" | "optional" | "none";
  readonly enabled: boolean;
  readonly defaultsRevision: number;
}
export interface WorkflowApprovalAction {
  readonly requestId: string;
  readonly checkpointId: string;
  readonly requestSequence: number;
  readonly digest: string;
  readonly workspaceHash: string;
}

export interface WorkflowCommandServices {
  readonly configured: boolean;
  listWorkflows(ctx?: ExtensionCommandContext): Promise<readonly WorkflowSelectorItem[]>;
  select(input: { workflowId: string; fresh?: true; from?: string | "last" }, ctx?: ExtensionCommandContext): Promise<string>;
  status(ctx?: ExtensionCommandContext): Promise<string>;
  exit(ctx?: ExtensionCommandContext): Promise<string>;
  cancel?(reason?: string, ctx?: ExtensionCommandContext): Promise<string>;
  reload(ctx?: ExtensionCommandContext): Promise<string>;
  checkpoints?(input?: { checkpointId: string; enabled: boolean; expectedDefaultsRevision?: number }, ctx?: ExtensionCommandContext): Promise<string>;
  checkpointActions?(ctx?: ExtensionCommandContext): Promise<readonly WorkflowCheckpointAction[]>;
  approvalActions?(ctx?: ExtensionCommandContext): Promise<readonly WorkflowApprovalAction[]>;
  decideApproval?(input: { requestId: string; expectedRequestSequence: number; digest: string; expectedWorkspaceHash: string; decision: "approved" | "denied" }, ctx?: ExtensionCommandContext): Promise<string>;
  readQuestion?(questionId: string, ctx?: ExtensionCommandContext): Promise<Readonly<{ definition: QuestionDefinition }>>;
  answer?(input: { questionId: string; value: unknown; channel: typeof COMMAND_CHANNEL }, ctx?: ExtensionCommandContext): Promise<string>;
  clearHandoff(ctx?: ExtensionCommandContext): Promise<string>;
  recover?(orphanSessionId: string, ctx?: ExtensionCommandContext): Promise<string>;
}

type Severity = "info" | "warning" | "error";

function bounded(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  let result = text;
  while (Buffer.byteLength(result, "utf8") > MAX_OUTPUT_BYTES - 32) result = result.slice(0, Math.max(0, result.length - 128));
  return `${result}\n[output truncated]`;
}

function present(ctx: ExtensionCommandContext, message: unknown, severity: Severity = "info"): void {
  const text = bounded(message);
  if (ctx.hasUI) ctx.ui.notify(text, severity);
  else console.log(text);
}

function tokens(args: string): string[] {
  return String(args || "").trim().split(/\s+/u).filter(Boolean);
}

function selectorDescription(item: WorkflowSelectorItem): string {
  const activation = item.activationHash ? `snapshot: ${item.activationHash.slice(0, 12)}` : "snapshot: unavailable";
  const archives = item.archivedLinks.length ? `archives: ${item.archivedLinks.map((link) => `${link.workflowSessionId}/${link.piSessionId}/${link.activationHash.slice(0, 12)}`).join(",")}` : "archives: none";
  const details = [item.description, `use: ${item.useWhen}`, item.avoidWhen ? `avoid: ${item.avoidWhen}` : "", item.tags.length ? `tags: ${item.tags.join(",")}` : "", `${item.adapter}/${item.profile}`, item.state, `source: ${item.source}`, activation, archives, item.diagnostics.join(", ") || item.diagnostic || ""].filter(Boolean);
  return bounded(details.join(" · ")).replaceAll("\n", " ");
}

async function chooseWorkflow(ctx: ExtensionCommandContext, services: WorkflowCommandServices, fresh: boolean): Promise<string | undefined> {
  const workflows = [...await services.listWorkflows(ctx)].sort((left, right) => left.workflowId.localeCompare(right.workflowId));
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const rows = workflows.slice(0, 100).map((item) => `${item.workflowId} — ${item.name} — ${selectorDescription(item)}`);
    present(ctx, `${rows.join("\n") || "No workflows available."}\nUsage: /hive:select <workflow-id> [--fresh] [--from <run-id|last>]`, workflows.length > 100 ? "warning" : "info");
    return undefined;
  }
  if (!workflows.length) {
    present(ctx, "No workflows available.", "warning");
    return undefined;
  }
  const available = (item: WorkflowSelectorItem) => item.selectable || (!fresh && item.resumable);
  const labels = workflows.map((item) => `${available(item) ? "" : "[unavailable] "}${item.workflowId} — ${item.name} — ${selectorDescription(item)}`);
  const selected = await ctx.ui.select("Select workflow", labels);
  const index = selected === undefined ? -1 : labels.indexOf(selected);
  const item = index < 0 ? undefined : workflows[index];
  if (!item) return undefined;
  if (!available(item)) {
    present(ctx, item.diagnostic || `Workflow ${item.workflowId} is unavailable for ${fresh ? "a fresh activation" : "selection"}.`, "warning");
    return undefined;
  }
  return item.workflowId;
}

function parseSelect(args: string): { workflowId?: string; fresh?: true; from?: string | "last" } {
  const parts = tokens(args);
  const result: { workflowId?: string; fresh?: true; from?: string | "last" } = {};
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part === "--fresh") {
      if (result.fresh) throw new Error("--fresh may be specified only once");
      result.fresh = true;
    } else if (part === "--from") {
      if (result.from !== undefined) throw new Error("--from may be specified only once");
      const source = parts[++index];
      if (!source || source.startsWith("--")) throw new Error("--from requires an exact run ID or last");
      result.from = source;
    } else if (part.startsWith("--")) throw new Error(`Unknown option: ${part}`);
    else if (result.workflowId) throw new Error(`Unexpected argument: ${part}`);
    else result.workflowId = part;
  }
  return result;
}

function register(pi: ExtensionAPI, name: string, description: string, handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>, onSettled?: (ctx: ExtensionCommandContext) => void): void {
  pi.registerCommand(name, {
    description,
    handler: async (args, ctx) => {
      try { await handler(args, ctx); }
      catch (error) { present(ctx, error, "error"); }
      finally {
        try { onSettled?.(ctx); }
        catch { /* UI restoration failures must never reject a handled command. */ }
      }
    },
  });
}

export function registerWorkflowCommands(pi: ExtensionAPI, services: WorkflowCommandServices, onSettled?: (ctx: ExtensionCommandContext) => void): void {
  if (!services.configured) return;

  const bind = (name: string, description: string, handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>): void => register(pi, name, description, handler, onSettled);

  bind("hive:select", "Select or resume a configured workflow", async (args, ctx) => {
    const parsed = parseSelect(args);
    const workflowId = parsed.workflowId ?? await chooseWorkflow(ctx, services, parsed.fresh === true);
    if (!workflowId) return;
    present(ctx, await services.select({ workflowId, ...(parsed.fresh ? { fresh: true as const } : {}), ...(parsed.from ? { from: parsed.from } : {}) }, ctx));
  });
  bind("hive:status", "Show selected workflow status", async (args, ctx) => {
    if (tokens(args).length) throw new Error("Usage: /hive:status");
    present(ctx, await services.status(ctx));
    if (ctx.mode !== "tui" || !ctx.hasUI || !services.approvalActions || !services.decideApproval) return;
    const approvals = await services.approvalActions(ctx);
    if (!approvals.length) return;
    const labels = approvals.map((approval) => `${approval.requestId} — ${approval.checkpointId} — ${approval.digest.slice(0, 19)}…`);
    const selected = await ctx.ui.select("Pending exact-digest approvals", labels);
    const index = selected === undefined ? -1 : labels.indexOf(selected);
    const approval = index < 0 ? undefined : approvals[index];
    if (!approval) return;
    const rawDecision = await ctx.ui.select(`Decide ${approval.requestId}`, ["Approve", "Deny"]);
    if (!rawDecision) return;
    const decision = rawDecision === "Approve" ? "approved" as const : "denied" as const;
    const confirmed = await ctx.ui.confirm(`${rawDecision} ${approval.checkpointId}`, `Bind ${decision} to exact digest ${approval.digest}?`);
    if (!confirmed) return;
    present(ctx, await services.decideApproval({ requestId: approval.requestId, expectedRequestSequence: approval.requestSequence, digest: approval.digest, expectedWorkspaceHash: approval.workspaceHash, decision }, ctx));
  });
  bind("hive:exit", "Return to the linked normal chat session", async (args, ctx) => {
    if (tokens(args).length) throw new Error("Usage: /hive:exit");
    present(ctx, await services.exit(ctx));
  });
  const cancel = services.cancel;
  if (cancel) bind("hive:cancel", "Cancel the open workflow run", async (args, ctx) => present(ctx, await cancel(String(args || "").trim() || undefined, ctx)));
  bind("hive:reload", "Create a fresh validated workflow activation", async (args, ctx) => {
    if (tokens(args).length) throw new Error("Usage: /hive:reload");
    present(ctx, await services.reload(ctx));
  });
  const checkpoints = services.checkpoints;
  if (checkpoints) bind("hive:checkpoints", "List or set an optional next-run checkpoint", async (args, ctx) => {
    const parts = tokens(args);
    if (!parts.length) {
      present(ctx, await checkpoints(undefined, ctx));
      if (ctx.mode !== "tui" || !ctx.hasUI || !services.checkpointActions) return;
      const actions = await services.checkpointActions(ctx);
      if (!actions.length) return;
      const labels = actions.map((action) => `${action.checkpointId} — ${action.policy} — ${action.enabled ? "on" : "off"}`);
      const selected = await ctx.ui.select("Next-run checkpoint defaults", labels);
      const index = selected === undefined ? -1 : labels.indexOf(selected);
      const action = index < 0 ? undefined : actions[index];
      if (!action) return;
      if (action.policy !== "optional") return present(ctx, `Checkpoint ${action.checkpointId} is ${action.policy} and cannot be changed.`, "warning");
      const enabled = !action.enabled;
      if (!await ctx.ui.confirm(`${enabled ? "Enable" : "Disable"} ${action.checkpointId}`, `Apply this optional checkpoint default to the next run at revision ${action.defaultsRevision}?`)) return;
      present(ctx, await checkpoints({ checkpointId: action.checkpointId, enabled, expectedDefaultsRevision: action.defaultsRevision }, ctx));
      return;
    }
    if (parts.length !== 2 || !["on", "off"].includes(parts[1]!)) throw new Error("Usage: /hive:checkpoints [<checkpoint-id> on|off]");
    present(ctx, await checkpoints({ checkpointId: parts[0]!, enabled: parts[1] === "on" }, ctx));
  });
  const readQuestion = services.readQuestion; const answer = services.answer;
  if (readQuestion && answer) bind("hive:answer", "Answer one exact pending workflow question", async (args, ctx) => {
    const match = String(args || "").trim().match(/^(\S+)(?:\s+([\s\S]+))?$/u);
    if (!match?.[1]) throw new Error("Usage: /hive:answer <question-id> [value]");
    const questionId = match[1];
    const { definition } = await readQuestion(questionId, ctx);
    let value: unknown;
    if (match[2]?.trim()) value = parseCommandAnswer(definition, match[2].trim());
    else if (ctx.mode === "tui" && ctx.hasUI) {
      if (definition.kind === "confirm") {
        const selected = await ctx.ui.select(definition.prompt, ["Yes", "No"]);
        if (selected !== undefined) value = selected === "Yes";
      } else if (definition.kind === "single") {
        const labels = definition.choices!.map((choice) => `${choice.label} (${choice.value})`);
        const selected = await ctx.ui.select(definition.prompt, labels);
        const index = selected === undefined ? -1 : labels.indexOf(selected);
        if (index >= 0) value = definition.choices![index]!.value;
      } else {
        const hint = definition.kind === "multi" ? definition.choices!.map((choice) => choice.value).join(",") : "";
        const entered = await ctx.ui.input(definition.prompt, hint);
        if (entered !== undefined && entered.length) value = parseCommandAnswer(definition, entered);
      }
    }
    if (value === undefined) throw new Error("An explicit schema-valid value is required outside interactive TUI mode");
    present(ctx, await answer({ questionId, value, channel: COMMAND_CHANNEL }, ctx));
  });
  bind("hive:handoff-clear", "Clear the exact staged handoff while idle", async (args, ctx) => {
    if (tokens(args).length) throw new Error("Usage: /hive:handoff-clear");
    present(ctx, await services.clearHandoff(ctx));
  });
  const recover = services.recover;
  if (recover) bind("hive:recover", "Recover an orphaned workflow session", async (args, ctx) => {
    const parts = tokens(args);
    if (parts.length !== 1) throw new Error("Usage: /hive:recover <orphan-session-id>");
    present(ctx, await recover(parts[0]!, ctx));
  });
  // W27 owns the legacy cutover. Until then registerCommands remains the sole
  // owner of hive:doctor and hive:observe*, so these workflow surfaces coexist
  // without duplicate slash-command registrations.
}
