// The Claude study agent's request schema and number check (no API calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonSchema, unsupported, type AgentTask } from "../src/studies/agent.ts";

const REJECTED = ["maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];

test("structured-output schemas carry no keywords the API rejects", () => {
  const keys = (n: unknown, acc: [string, unknown][] = []): [string, unknown][] => {
    if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) { acc.push([k, v]); keys(v, acc); }
    return acc;
  };
  for (const task of ["dictionary", "hypotheses", "plan", "interpret", "manuscript"] as AgentTask[]) {
    for (const [k, v] of keys(jsonSchema(task))) {
      assert.ok(!REJECTED.includes(k), `${task}: ${k}`);
      if (k === "minItems") assert.ok((v as number) <= 1, `${task}: minItems ${v}`);
    }
  }
});

test("numbers quoted exactly from the source pass, invented ones do not", () => {
  assert.deepEqual(unsupported("p = 0.000002, OR 1.42", { p_value: 0.000002, or: 1.4213 }), []);
  assert.deepEqual(unsupported("p = 0.000002 and 7.3", { p_value: 0.000002 }), [7.3]);
});
