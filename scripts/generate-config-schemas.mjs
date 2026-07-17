#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentFrontmatterV1Schema,
  ManifestV1Schema,
  WorkflowV1Schema,
} from "../src/config/schema.ts";

const root = join(import.meta.dirname, "..");
const outputDirectory = join(root, "schemas");

const definitions = [
  {
    file: "hive-manifest-v1.schema.json",
    id: "urn:pi-hive:schema:hive-manifest:1",
    title: "pi-hive Manifest Schema v1",
    schema: ManifestV1Schema,
  },
  {
    file: "hive-agent-frontmatter-v1.schema.json",
    id: "urn:pi-hive:schema:hive-agent-frontmatter:1",
    title: "pi-hive Agent Frontmatter Schema v1",
    schema: AgentFrontmatterV1Schema,
  },
  {
    file: "hive-workflow-v1.schema.json",
    id: "urn:pi-hive:schema:hive-workflow:1",
    title: "pi-hive Workflow Schema v1",
    schema: WorkflowV1Schema,
  },
];

function portableReference(value) {
  return value.includes(":") || value.startsWith("#")
    ? value
    : `urn:pi-hive:schema:definition:${value}:1`;
}

function portableJson(value) {
  if (Array.isArray(value)) return value.map(portableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      (key === "$id" || key === "$ref") && typeof entry === "string"
        ? portableReference(entry)
        : portableJson(entry),
    ]));
  }
  return value;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

export function generateConfigSchemas() {
  return Object.fromEntries(definitions.map((definition) => {
    const document = sortJson({
      ...portableJson(definition.schema),
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: definition.id,
      title: definition.title,
    });
    return [definition.file, `${JSON.stringify(document, null, 2)}\n`];
  }));
}

function main() {
  const check = process.argv.includes("--check");
  const generated = generateConfigSchemas();
  const stale = [];
  if (!check) mkdirSync(outputDirectory, { recursive: true });

  for (const [file, content] of Object.entries(generated)) {
    const path = join(outputDirectory, file);
    if (check) {
      let current;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        stale.push(file);
        continue;
      }
      if (current !== content) stale.push(file);
    } else {
      writeFileSync(path, content);
      console.log(`generated schemas/${file}`);
    }
  }

  if (stale.length > 0) {
    console.error(`Config schema artifacts are stale or missing: ${stale.join(", ")}. Run just config-schema-build.`);
    process.exitCode = 1;
  } else if (check) {
    console.log("✓ committed config schemas match the TypeBox authority");
  }
}

main();
