export const QUESTION_LIMITS = Object.freeze({
  promptBytes: 16_384,
  questions: 128,
  choices: 64,
  choiceValueBytes: 1_024,
  choiceLabelBytes: 1_024,
  choicesBytes: 32_768,
  textAnswerBytes: 32_768,
  patternBytes: 256,
  idBytes: 256,
  identityBytes: 1_024,
  reasonBytes: 2_048,
  operationIdBytes: 256,
  dtoItems: 40,
  dtoBytes: 65_536,
  cursorBytes: 512,
});

export type QuestionKind = "single" | "multi" | "text" | "confirm";
export type QuestionAnswerValue = string | readonly string[] | boolean | null;

export interface QuestionChoice {
  readonly value: string;
  readonly label: string;
}
export interface QuestionTextValidation {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}
export interface QuestionMultiValidation {
  readonly minItems?: number;
  readonly maxItems?: number;
}
export type QuestionValidation = QuestionTextValidation | QuestionMultiValidation;
export interface QuestionDefinition {
  readonly prompt: string;
  readonly kind: QuestionKind;
  readonly choices?: readonly QuestionChoice[];
  readonly validation?: QuestionValidation;
  readonly required: boolean;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const keys = Object.keys(value);
  const permitted = new Set(allowed);
  if (required.some((key) => !(key in value)) || keys.some((key) => !permitted.has(key))) throw new Error(`${label} has unknown or missing fields`);
}
function hasUnsafeC0Control(value: string): boolean {
  // Preserve ordinary structured whitespace while rejecting controls whose
  // six-byte JSON escapes can amplify an otherwise bounded persisted value.
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
  });
}
function boundedString(value: unknown, label: string, bytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || Buffer.byteLength(value, "utf8") > bytes || hasUnsafeC0Control(value)) {
    throw new Error(`${label} is invalid or exceeds its byte limit`);
  }
  return value;
}
function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} is invalid`);
  return Number(value);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function safePattern(pattern: string): RegExp {
  // Closed linear-time subset: the whole expression is anchored, atoms are
  // literals, character classes, or dot, and at most one atom is quantified.
  // Whole-input anchoring prevents native RegExp from retrying a large fixed
  // repetition at every answer offset (for example a{32768}b).
  let trailingBackslashes = 0;
  for (let index = pattern.length - 2; index >= 0 && pattern[index] === "\\"; index--) trailingBackslashes++;
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || trailingBackslashes % 2 === 1) {
    throw new Error("Question text validation pattern must be anchored to the complete answer");
  }
  let index = 1;
  const end = pattern.length - 1;
  let quantifiers = 0;
  while (index < end) {
    const character = pattern[index];
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (!escaped || !/[dDsSwW\\.^$*+?()[\]{}|-]/u.test(escaped)) throw new Error("Question text validation pattern is outside the safe grammar");
      index += 2;
    } else if (character === "[") {
      index++;
      if (pattern[index] === "^") index++;
      let members = 0;
      while (index < end && pattern[index] !== "]") {
        if (pattern[index] === "\\") {
          if (index + 1 >= end) throw new Error("Question text validation pattern is invalid");
          index += 2;
        } else index++;
        members++;
      }
      if (!members || pattern[index] !== "]") throw new Error("Question text validation pattern is invalid");
      index++;
    } else {
      if ("()|^$*+?{}[]".includes(character)) throw new Error("Question text validation pattern is outside the safe grammar");
      index++;
    }
    if (index < end && "*+?".includes(pattern[index])) { quantifiers++; index++; }
    else if (index < end && pattern[index] === "{") {
      const match = /^\{([0-9]+)(?:,([0-9]*))?\}/u.exec(pattern.slice(index, end));
      if (!match) throw new Error("Question text validation pattern is invalid");
      const minimum = Number(match[1]);
      const maximum = match[2] === undefined ? minimum : match[2] === "" ? QUESTION_LIMITS.textAnswerBytes : Number(match[2]);
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum || maximum > QUESTION_LIMITS.textAnswerBytes) throw new Error("Question text validation pattern repetition is invalid");
      quantifiers++; index += match[0].length;
    }
    if (quantifiers > 1) throw new Error("Question text validation pattern exceeds the bounded-complexity grammar");
  }
  try { return new RegExp(pattern, "u"); } catch { throw new Error("Question text validation pattern is invalid"); }
}

export function normalizeQuestionDefinition(value: unknown): QuestionDefinition {
  if (!plainRecord(value)) throw new Error("Question definition must be an object");
  exactKeys(value, ["prompt", "kind", "choices", "validation", "required"], ["prompt", "kind", "required"], "Question definition");
  const prompt = boundedString(value.prompt, "Question prompt", QUESTION_LIMITS.promptBytes);
  const kind = value.kind;
  if (kind !== "single" && kind !== "multi" && kind !== "text" && kind !== "confirm") throw new Error("Question kind is invalid");
  if (typeof value.required !== "boolean") throw new Error("Question required flag is invalid");

  let choices: readonly QuestionChoice[] | undefined;
  if (kind === "single" || kind === "multi") {
    if (!Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > QUESTION_LIMITS.choices) throw new Error("Question choices are invalid or exceed their limit");
    const seen = new Set<string>();
    const normalized = value.choices.map((raw, index) => {
      if (!plainRecord(raw)) throw new Error(`Question choice ${index} must be an object`);
      exactKeys(raw, ["value", "label"], ["value", "label"], `Question choice ${index}`);
      const choiceValue = boundedString(raw.value, `Question choice ${index} value`, QUESTION_LIMITS.choiceValueBytes);
      const label = boundedString(raw.label, `Question choice ${index} label`, QUESTION_LIMITS.choiceLabelBytes);
      if (seen.has(choiceValue)) throw new Error("Question choice values must be unique");
      seen.add(choiceValue);
      return { value: choiceValue, label };
    });
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > QUESTION_LIMITS.choicesBytes) throw new Error("Question choices exceed their aggregate byte limit");
    choices = normalized;
  } else if (value.choices !== undefined) throw new Error(`Question choices are not valid for ${kind}`);

  let validation: QuestionValidation | undefined;
  if (kind === "text") {
    if (value.validation !== undefined) {
      if (!plainRecord(value.validation)) throw new Error("Question text validation must be an object");
      exactKeys(value.validation, ["minLength", "maxLength", "pattern"], [], "Question text validation");
      const minLength = value.validation.minLength === undefined ? 0 : boundedInteger(value.validation.minLength, "Question text minLength", 0, QUESTION_LIMITS.textAnswerBytes);
      const maxLength = value.validation.maxLength === undefined ? QUESTION_LIMITS.textAnswerBytes : boundedInteger(value.validation.maxLength, "Question text maxLength", 0, QUESTION_LIMITS.textAnswerBytes);
      if (minLength > maxLength) throw new Error("Question text validation length range is invalid");
      const pattern = value.validation.pattern === undefined ? undefined : boundedString(value.validation.pattern, "Question text pattern", QUESTION_LIMITS.patternBytes);
      if (pattern !== undefined) safePattern(pattern);
      validation = { ...(value.validation.minLength !== undefined ? { minLength } : {}), ...(value.validation.maxLength !== undefined ? { maxLength } : {}), ...(pattern !== undefined ? { pattern } : {}) };
    }
  } else if (kind === "multi") {
    if (value.validation !== undefined) {
      if (!plainRecord(value.validation)) throw new Error("Question multi validation must be an object");
      exactKeys(value.validation, ["minItems", "maxItems"], [], "Question multi validation");
      const minItems = value.validation.minItems === undefined ? (value.required ? 1 : 0) : boundedInteger(value.validation.minItems, "Question multi minItems", 0, choices!.length);
      const maxItems = value.validation.maxItems === undefined ? choices!.length : boundedInteger(value.validation.maxItems, "Question multi maxItems", 0, choices!.length);
      if (minItems > maxItems) throw new Error("Question multi validation selection range is invalid");
      validation = { ...(value.validation.minItems !== undefined ? { minItems } : {}), ...(value.validation.maxItems !== undefined ? { maxItems } : {}) };
    }
  } else if (value.validation !== undefined) throw new Error(`Question validation is not valid for ${kind}`);

  return deepFreeze({ prompt, kind, ...(choices ? { choices } : {}), ...(validation ? { validation } : {}), required: value.required });
}

export function validateQuestionAnswer(definitionInput: QuestionDefinition, answer: unknown): QuestionAnswerValue {
  const definition = normalizeQuestionDefinition(definitionInput);
  if (answer === undefined) throw new Error("Question answer must be explicit; undefined is invalid");
  if (answer === null) {
    if (definition.required) throw new Error("Question answer is required");
    return null;
  }
  if (definition.kind === "confirm") {
    if (typeof answer !== "boolean") throw new Error("Confirm question answer must be boolean");
    return answer;
  }
  if (definition.kind === "text") {
    if (typeof answer !== "string" || Buffer.byteLength(answer, "utf8") > QUESTION_LIMITS.textAnswerBytes || hasUnsafeC0Control(answer)) throw new Error("Text question answer has an invalid type, control character, or byte length");
    const validation = definition.validation as QuestionTextValidation | undefined;
    const min = validation?.minLength ?? (definition.required ? 1 : 0);
    const max = validation?.maxLength ?? QUESTION_LIMITS.textAnswerBytes;
    if (answer.length < min || answer.length > max) throw new Error("Text question answer fails length validation");
    if (validation?.pattern && !safePattern(validation.pattern).test(answer)) throw new Error("Text question answer fails pattern validation");
    return answer;
  }
  const allowed = new Set(definition.choices!.map((choice) => choice.value));
  if (definition.kind === "single") {
    if (typeof answer !== "string" || !allowed.has(answer)) throw new Error("Single question answer must name one valid choice");
    return answer;
  }
  if (!Array.isArray(answer) || answer.some((entry) => typeof entry !== "string" || !allowed.has(entry))) throw new Error("Multi question answer must be an array of valid choices");
  if (new Set(answer).size !== answer.length) throw new Error("Multi question answer choices must be unique");
  const validation = definition.validation as QuestionMultiValidation | undefined;
  const min = validation?.minItems ?? (definition.required ? 1 : 0);
  const max = validation?.maxItems ?? definition.choices!.length;
  if (answer.length < min || answer.length > max) throw new Error("Multi question answer fails selection validation");
  return deepFreeze([...answer].sort());
}

export function parseCommandAnswer(definition: QuestionDefinition, raw: string): QuestionAnswerValue {
  if (typeof raw !== "string" || !raw.length) throw new Error("Question command value is required; use explicit null for an omitted optional answer");
  const trimmed = raw.trim();
  // Command encoding is deliberately unambiguous: bare `null` is the optional
  // null value, while JSON strings represent colliding literal text (including
  // `"null"` and `""`). Existing unquoted non-colliding values remain valid.
  if (!definition.required && trimmed === "null") return null;
  if (definition.kind === "confirm") {
    const normalized = trimmed.toLowerCase();
    if (["true", "yes", "y", "1"].includes(normalized)) return true;
    if (["false", "no", "n", "0"].includes(normalized)) return false;
    throw new Error("Confirm question command answer must be yes/no or true/false");
  }
  if (definition.kind === "multi") {
    let answer: unknown;
    if (trimmed.startsWith("[")) {
      try { answer = JSON.parse(raw); } catch { throw new Error("Multi question command answer must be JSON or comma-separated choices"); }
    } else answer = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
    return validateQuestionAnswer(definition, answer);
  }
  if (trimmed.startsWith('"')) {
    let answer: unknown;
    try { answer = JSON.parse(trimmed); } catch { throw new Error(`${definition.kind === "text" ? "Text" : "Single"} question command answer has invalid JSON string encoding`); }
    if (typeof answer !== "string") throw new Error(`${definition.kind === "text" ? "Text" : "Single"} question command answer must be a JSON string`);
    return validateQuestionAnswer(definition, answer);
  }
  return validateQuestionAnswer(definition, raw);
}
