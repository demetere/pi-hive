// ── Mental-model spine ───────────────────────────────────────────────────────
//
// The single source of truth for the mental-model contract. A mental model has
// a HARD SPINE (always present, always shaped this way) and a SOFT BODY (pinned
// category names, free content underneath). The distiller prompt is told this
// contract; `normalizeMentalModelSpine` is a mechanical safety net that runs on
// the distiller's raw output so a soft miss can never corrupt the spine.
//
// Normalization works on raw text, never a parse→reserialize round-trip: the
// YAML-lite loader is lossy (it uppercases kebab keys and flattens inline
// arrays), so re-emitting the whole document would mangle the free body. We only
// patch spine lines and append missing spine keys; the body is left byte-exact.

/** Top-level keys that must exist in every mental model. */
export const SPINE_KEYS = ["metadata", "risk_patterns", "observations", "open_questions"] as const;

/** Required keys under `metadata`. */
export const METADATA_KEYS = ["owner", "purpose", "updated"] as const;

/**
 * Pinned top-level category names for the soft body. The distiller should route
 * role-specific knowledge under one of these and only invent a new key as a last
 * resort. Used by the prompt; not mechanically enforced (the body is free).
 */
export const BODY_CATEGORIES: { name: string; holds: string }[] = [
  { name: "domain_map", holds: "Architecture, stack, system facts, key files and their roles." },
  { name: "conventions", holds: "Rules, standards, idioms the code follows." },
  { name: "principles", holds: "How this role operates (its own operating rules)." },
  { name: "evaluation", holds: "The role's review lens or matrix — what it inspects and how it judges quality." },
  { name: "routing", holds: "Delegation: what this agent handles vs. escalates; team topology for the orchestrator." },
  { name: "patterns", holds: "Reusable sequences and approaches that worked." },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Patch the value of a top-level `key:` line living under a parent block.
 * Only rewrites a line at exactly `indent` spaces; leaves the rest untouched.
 * Returns the text unchanged if the key is not found at that indent.
 */
function patchNestedValue(text: string, parent: string, key: string, value: string): string {
  const lines = text.split("\n");
  let inParent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) inParent = line.replace(/:.*$/, "").trim() === parent;
    else if (inParent && new RegExp(`^  ${key}:`).test(line)) {
      lines[i] = `  ${key}: ${value}`;
      return lines.join("\n");
    }
  }
  return text;
}

function hasTopLevelKey(text: string, key: string): boolean {
  return new RegExp(`^${key}:`, "m").test(text);
}

function hasMetadataChildKey(text: string, key: string): boolean {
  const lines = text.split("\n");
  let inMeta = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inMeta = line.replace(/:.*$/, "").trim() === "metadata";
    else if (inMeta && new RegExp(`^  ${key}:`).test(line)) return true;
  }
  return false;
}

/**
 * Guarantee the hard spine on a distilled mental model.
 *
 * - Forces `metadata.owner` to the real agent name (the model is told to do
 *   this, but ownership must never drift).
 * - Stamps `metadata.updated` with today's date.
 * - Backfills any missing spine key (`metadata`, `risk_patterns`, `observations`,
 *   `open_questions`) and missing `metadata.purpose` with a minimal valid stub.
 *
 * The soft body and any well-formed spine content are left exactly as written.
 *
 * @param raw The distiller's emitted YAML text.
 * @param owner The agent name that must own this file.
 * @returns Valid YAML whose spine is correct.
 */
export function normalizeMentalModelSpine(raw: string, owner: string): string {
  let text = raw.replace(/\s+$/, "");

  // Ensure metadata block exists, with required children in canonical order.
  const defaults: Record<string, string> = {
    owner: `  owner: ${owner}`,
    purpose: `  purpose: "Durable mental model for ${owner}."`,
    updated: `  updated: "${todayIso()}"`,
  };
  if (!hasTopLevelKey(text, "metadata")) {
    text = `metadata:\n${METADATA_KEYS.map((k) => defaults[k]).join("\n")}\n\n${text}`;
  } else {
    // Patch the values that already exist (owner/updated must be forced).
    if (hasMetadataChildKey(text, "owner")) text = patchNestedValue(text, "metadata", "owner", owner);
    if (hasMetadataChildKey(text, "updated")) text = patchNestedValue(text, "metadata", "updated", `"${todayIso()}"`);
    // Backfill any missing children once, in canonical order, right after `metadata:`.
    const missingMeta = METADATA_KEYS.filter((k) => !hasMetadataChildKey(text, k)).map((k) => defaults[k]);
    if (missingMeta.length) text = text.replace(/^metadata:\n/m, `metadata:\n${missingMeta.join("\n")}\n`);
  }

  // Backfill missing spine keys with empty-but-valid defaults.
  const stubs: Record<string, string> = {
    risk_patterns: "risk_patterns: {}",
    observations: "observations: []",
    open_questions: "open_questions: []",
  };
  const missing = ["risk_patterns", "observations", "open_questions"]
    .filter((key) => !hasTopLevelKey(text, key))
    .map((key) => stubs[key]);
  if (missing.length) text = `${text}\n\n${missing.join("\n")}`;

  return `${text}\n`;
}
