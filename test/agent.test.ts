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

test("p < 0.001 and SHA-256 are allowed; the same numbers elsewhere are not", () => {
  const src = { p_value: 0.000002 };
  assert.deepEqual(unsupported("Mortality differed (p < 0.001). Record numbers were hashed with HMAC-SHA-256.", src), []);
  assert.deepEqual(unsupported("P≤0.001; P <= .001; sha256 digests", src), []);
  assert.deepEqual(unsupported("The rate fell by 0.001 in 256 patients.", src), [0.001, 256]);
  assert.deepEqual(unsupported("p = 0.001", src), [0.001]);
});

test("list markers are allowed; bracketed numbers in a sentence are not", () => {
  const src = { p_value: 0.03 };
  const limits = "Limitations: (1) Small sample. (6) Weights were fixed; (7) No sensitivity analyses.\n(8) Single centre.\n9. Coding not assessed.\n10) Short follow-up.";
  assert.deepEqual(unsupported(limits, src), []);
  assert.deepEqual(unsupported("Few events (27 deaths in total) occurred.", src), [27]);
  assert.deepEqual(unsupported("Deaths (27) were rare.", src), [27]);
  assert.deepEqual(unsupported("The cost rose. (6)", src), [6]);
  assert.deepEqual(unsupported("9. 47 patients died.", src), [9, 47]); // "9." before a number is not taken as a marker
});
