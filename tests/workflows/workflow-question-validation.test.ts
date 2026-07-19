import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QUESTION_LIMITS,
  normalizeQuestionDefinition,
  parseCommandAnswer,
  validateQuestionAnswer,
} from "../../src/workflows/question-validation.ts";

const single = normalizeQuestionDefinition({
  prompt: "Which database?",
  kind: "single",
  choices: [
    { value: "postgres", label: "PostgreSQL" },
    { value: "sqlite", label: "SQLite" },
  ],
  required: true,
});
const multi = normalizeQuestionDefinition({
  prompt: "Select targets",
  kind: "multi",
  choices: [
    { value: "api", label: "API" },
    { value: "web", label: "Web" },
    { value: "cli", label: "CLI" },
  ],
  validation: { minItems: 1, maxItems: 2 },
  required: true,
});
const text = normalizeQuestionDefinition({
  prompt: "Name the release",
  kind: "text",
  validation: { minLength: 3, maxLength: 12, pattern: "^[a-z-]+$" },
  required: true,
});
const confirm = normalizeQuestionDefinition({ prompt: "Proceed?", kind: "confirm", required: true });

test("question definitions are exact, typed, bounded, and reject executable UI fields", () => {
  assert.equal(single.kind, "single");
  assert.equal(Object.isFrozen(single.choices), true);
  for (const malformed of [
    { prompt: "x", kind: "single", choices: [{ value: "a", label: "A" }], required: true, html: "<script>" },
    { prompt: "x", kind: "single", choices: [{ value: "a", label: "A", action: "run" }], required: true },
    { prompt: "x", kind: "single", choices: [{ value: "a", label: "A" }, { value: "a", label: "Again" }], required: true },
    { prompt: "x", kind: "single", choices: [], required: true },
    { prompt: "x", kind: "text", choices: [{ value: "a", label: "A" }], required: true },
    { prompt: "x", kind: "confirm", validation: { minLength: 1 }, required: true },
    { prompt: "x", kind: "text", validation: { pattern: "^(a|aa)+$" }, required: true },
    { prompt: "x", kind: "multi", choices: [{ value: "a", label: "A" }], validation: { minItems: 2, maxItems: 1 }, required: true },
    { prompt: "x", kind: "unknown", required: true },
    { prompt: "x".repeat(QUESTION_LIMITS.promptBytes + 1), kind: "text", required: true },
    { prompt: "x", kind: "single", choices: Array.from({ length: QUESTION_LIMITS.choices + 1 }, (_, index) => ({ value: String(index), label: String(index) })), required: true },
  ]) assert.throws(() => normalizeQuestionDefinition(malformed), /question|choice|validation|unknown|limit|kind/i);
});

test("text patterns use an anchored linear-time grammar under maximum adversarial input", () => {
  const beganRejection = performance.now();
  for (const pattern of ["a{32768}b", "^a*a*a*a*a*b$", "^(a|aa)+$", "^(a+)+$", "^([a-z]+|[a-z0-9]+)+$"]) {
    assert.throws(() => normalizeQuestionDefinition({ prompt: "safe?", kind: "text", validation: { pattern }, required: true }), /pattern|anchor|complexity/i);
  }
  assert.ok(performance.now() - beganRejection < 50, "high-cost unanchored patterns must reject without attempting a maximum answer match");

  const safe = normalizeQuestionDefinition({ prompt: "release", kind: "text", validation: { pattern: "^a{32768}b$" }, required: true });
  const beganMatch = performance.now();
  assert.throws(() => validateQuestionAnswer(safe, "a".repeat(QUESTION_LIMITS.textAnswerBytes)), /pattern/i);
  assert.ok(performance.now() - beganMatch < 100, "maximum-size anchored failure must remain strictly bounded");
});

test("question text rejects unsafe C0 controls while preserving bounded structured whitespace", () => {
  for (const unsafe of ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u001f"]) {
    assert.throws(() => normalizeQuestionDefinition({ prompt: `unsafe${unsafe}`, kind: "text", required: true }), /invalid|limit|control/i);
  }
  const whitespace = normalizeQuestionDefinition({ prompt: `${"\n".repeat(QUESTION_LIMITS.promptBytes - 1)}x`, kind: "text", required: true });
  assert.equal(Buffer.byteLength(whitespace.prompt, "utf8"), QUESTION_LIMITS.promptBytes);
  assert.equal(validateQuestionAnswer(whitespace, "\t\n\r"), "\t\n\r");
  assert.throws(() => validateQuestionAnswer(whitespace, `safe\u0001unsafe`), /control|type|length/i);
});

test("all answer kinds validate exact typed values and optional questions accept only explicit null", () => {
  assert.equal(validateQuestionAnswer(single, "postgres"), "postgres");
  assert.deepEqual(validateQuestionAnswer(multi, ["web", "api"]), ["api", "web"]);
  assert.equal(validateQuestionAnswer(text, "release-one"), "release-one");
  assert.equal(validateQuestionAnswer(confirm, true), true);
  for (const [definition, answer] of [
    [single, "mysql"], [single, ["postgres"]], [multi, []], [multi, ["api", "api"]],
    [multi, ["api", "web", "cli"]], [text, "UP"], [text, "way-too-long-release"], [confirm, "yes"],
  ] as const) assert.throws(() => validateQuestionAnswer(definition, answer), /answer|choice|validation|type|length|selection/i);
  assert.throws(() => validateQuestionAnswer(text, null), /required/i);
  const optional = normalizeQuestionDefinition({ prompt: "Anything else?", kind: "text", required: false });
  assert.equal(validateQuestionAnswer(optional, null), null);
  assert.throws(() => validateQuestionAnswer(optional, undefined), /answer|undefined/i);
});

test("command answers parse by durable kind without treating ordinary prose as an implicit answer", () => {
  assert.equal(parseCommandAnswer(single, "postgres"), "postgres");
  assert.deepEqual(parseCommandAnswer(multi, "api, web"), ["api", "web"]);
  assert.deepEqual(parseCommandAnswer(multi, '["web","api"]'), ["api", "web"]);
  assert.equal(parseCommandAnswer(confirm, "yes"), true);
  assert.equal(parseCommandAnswer(confirm, "false"), false);
  assert.equal(parseCommandAnswer(text, "release-one"), "release-one");
  assert.throws(() => parseCommandAnswer(confirm, "maybe"), /confirm|answer/i);
  assert.throws(() => parseCommandAnswer(text, ""), /value|required/i);
});

test("command answers encode explicit null, literal null, and empty text without ambiguity for every optional kind", () => {
  const optionalSingle = normalizeQuestionDefinition({
    prompt: "Single?", kind: "single", choices: [{ value: "null", label: "Literal null" }, { value: "other", label: "Other" }], required: false,
  });
  const optionalMulti = normalizeQuestionDefinition({
    prompt: "Multi?", kind: "multi", choices: [{ value: "null", label: "Literal null" }, { value: "other", label: "Other" }], required: false,
  });
  const optionalText = normalizeQuestionDefinition({ prompt: "Text?", kind: "text", required: false });
  const optionalConfirm = normalizeQuestionDefinition({ prompt: "Confirm?", kind: "confirm", required: false });

  for (const definition of [optionalSingle, optionalMulti, optionalText, optionalConfirm]) {
    assert.equal(parseCommandAnswer(definition, "null"), null);
    assert.throws(() => parseCommandAnswer(definition, ""), /explicit|null|value|required/i);
  }
  assert.equal(parseCommandAnswer(optionalSingle, '"null"'), "null");
  assert.deepEqual(parseCommandAnswer(optionalMulti, '["null"]'), ["null"]);
  assert.deepEqual(parseCommandAnswer(optionalMulti, "[]"), []);
  assert.equal(parseCommandAnswer(optionalText, '"null"'), "null");
  assert.equal(parseCommandAnswer(optionalText, '""'), "");
  assert.equal(parseCommandAnswer(optionalConfirm, "false"), false);
  assert.throws(() => parseCommandAnswer(optionalConfirm, '"null"'), /confirm|answer/i);
});
