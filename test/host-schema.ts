import type { ExtensionAPI, Schema } from "../src/omp.js";

type SchemaIssue = { path: PropertyKey[]; message: string };
export type FakeSchema = Omit<Schema, "safeParse"> & {
  shape?: Record<string, Schema>;
  description?: string;
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { message: string; issues: SchemaIssue[] } };
};
type Validation = (value: unknown) => SchemaIssue[];
const fakeSchema = (validate: Validation, fields: Pick<FakeSchema, "shape" | "description"> = {}): FakeSchema => ({
  ...fields,
  safeParse: value => {
    const issues = validate(value);
    return issues.length === 0 ? { success: true, data: value } : {
      success: false, error: { issues, message: issues.map(({ path, message }) => `${path.map(String).join(".")}: ${message}`).join("; ") },
    };
  },
  optional: () => fakeSchema(value => value === undefined ? [] : validate(value), fields),
  describe: description => fakeSchema(validate, { ...fields, description }),
});
function fieldIssues(schema: Schema, value: unknown, key: PropertyKey): SchemaIssue[] {
  const result = (schema as FakeSchema).safeParse(value);
  return result.success ? [] : result.error.issues.map(issue => ({ ...issue, path: [key, ...issue.path] }));
}
const expected = (condition: boolean, type: string): SchemaIssue[] =>
  condition ? [] : [{ path: [], message: `expected ${type}` }];
const schemaObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validates the types supported by the registered schema builder without correcting or removing fixture arguments. */
export const zod: ExtensionAPI["zod"] = {
  object: shape => fakeSchema(value => schemaObject(value)
    ? Object.entries(shape).flatMap(([key, schema]) => fieldIssues(schema, value[key], key)) : expected(false, "an object"), { shape }),
  array: element => fakeSchema(value => Array.isArray(value)
    ? value.flatMap((item, index) => fieldIssues(element, item, index)) : expected(false, "an array")),
  string: () => fakeSchema(value => expected(typeof value === "string", "a string")),
  number: () => fakeSchema(value => expected(typeof value === "number" && Number.isFinite(value), "a finite number")),
  enum: values => fakeSchema(value => expected(typeof value === "string" && values.includes(value), values.join(" or "))),
  union: members => fakeSchema(value => {
    const issues: SchemaIssue[] = [];
    for (const member of members) {
      const parsed = (member as FakeSchema).safeParse(value);
      if (parsed.success) return [];
      issues.push(...parsed.error.issues);
    }
    return issues;
  }),
  record: schema => fakeSchema(value => schemaObject(value)
    ? Object.entries(value).flatMap(([key, item]) => fieldIssues(schema, item, key)) : expected(false, "a record")),
  unknown: () => fakeSchema(() => []),
};
