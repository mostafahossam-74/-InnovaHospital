// Shared zod helpers.
import { z } from "zod";

/**
 * Optional versions of create-schema fields, for PATCH bodies. Defaults are
 * removed first: in zod 4 a default still applies inside .optional(), so a
 * partial update would otherwise fill omitted fields with their defaults and
 * overwrite stored values. Checks must come before .default() in the field
 * definitions, because removing the default also removes checks added after it.
 */
export function patchFields<T extends Record<string, z.ZodType>>(fields: T): { [K in keyof T]: z.ZodOptional<z.ZodType> } {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) =>
    [k, (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : v).optional()])) as { [K in keyof T]: z.ZodOptional<z.ZodType> };
}
