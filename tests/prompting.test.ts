import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSkillMenu, skillName } from "../src/core/prompting.ts";

test("skillName uses parent directory for Agent Skills SKILL.md files", () => {
  assert.equal(skillName({ path: ".agents/skills/go-security/SKILL.md" }), "go-security");
  assert.equal(skillName({ path: "C:\\skills\\imed-backend-map\\SKILL.md" }), "imed-backend-map");
  assert.equal(skillName({ path: ".pi/hive/knowledge/review.md" }), "review");
});

test("renderSkillMenu tells agents to pass exact load_skill keys", () => {
  const menu = renderSkillMenu([
    {
      path: ".agents/skills/go-security/SKILL.md",
      useWhen: "Auditing Go backend code — locating modules, handlers, and where authz checks belong.",
    },
  ]);

  assert.match(menu, /load_skill with the exact skill key/);
  assert.match(menu, /go-security: call load_skill with name "go-security"/);
  assert.doesNotMatch(menu, /^- SKILL:/m);
  assert.match(menu, /Do not pass a natural-language query/);
});
