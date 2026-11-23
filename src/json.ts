/** A value that YAML frontmatter can hold once parsed with the YAML 1.2 core schema. */
export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
