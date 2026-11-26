import type { JsonSchema } from './ipc';

/**
 * Turn an MCP tool's input schema into a simple form for the action card.
 *
 * Only flat objects whose fields are strings, numbers, booleans, string enums
 * or lists of strings get a form. Anything else (nested objects, unions,
 * arguments the schema does not describe) gets no form: the card shows the
 * arguments read-only and sends them as proposed, so the form can never
 * silently drop or reshape a value. The main process validates the final
 * arguments against the full schema either way.
 */

export type FieldKind =
  | 'string'
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'stringList';

export interface FormField {
  key: string;
  label: string;
  description: string;
  kind: FieldKind;
  required: boolean;
  options: string[];
}

export type FormState = Record<string, string | boolean>;

const LONG_TEXT_KEYS = /^(description|body|text|content|message|notes?|details|summary|comment)$/i;

function primaryType(schema: JsonSchema): string | null {
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== 'null');
    return types.length === 1 ? (types[0] ?? null) : null;
  }
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.enum)) return 'string';
  return null;
}

/** "parent_page_id" / "dueDate" → "Parent page id" / "Due date". */
export function humanizeKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return key;
  const text = words.join(' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fieldFor(key: string, schema: JsonSchema, required: boolean): FormField | null {
  const type = primaryType(schema);
  const base = {
    key,
    label: typeof schema.title === 'string' && schema.title ? schema.title : humanizeKey(key),
    description: typeof schema.description === 'string' ? schema.description : '',
    required,
    options: [] as string[],
  };
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.every((v) => typeof v === 'string')) return null;
    return { ...base, kind: 'enum', options: schema.enum as string[] };
  }
  if (type === 'string') {
    const long =
      LONG_TEXT_KEYS.test(key) || (typeof schema.maxLength === 'number' && schema.maxLength > 200);
    return { ...base, kind: long ? 'text' : 'string' };
  }
  if (type === 'number' || type === 'integer' || type === 'boolean') return { ...base, kind: type };
  if (
    type === 'array' &&
    schema.items &&
    primaryType(schema.items) === 'string' &&
    !Array.isArray(schema.items.enum)
  ) {
    return { ...base, kind: 'stringList' };
  }
  return null;
}

/** Fields for a schema, or null when no form can represent it faithfully. */
export function formFields(
  schema: JsonSchema | null,
  args: Record<string, unknown>
): FormField[] | null {
  if (!schema || typeof schema !== 'object') return null;
  const type = primaryType(schema);
  if (type !== null && type !== 'object') return null;
  const props = schema.properties;
  if (!props || typeof props !== 'object' || Object.keys(props).length === 0) return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields: FormField[] = [];
  for (const [key, sub] of Object.entries(props)) {
    if (!sub || typeof sub !== 'object') return null;
    const field = fieldFor(key, sub, required.has(key));
    if (!field) return null;
    fields.push(field);
  }
  // A proposed value the form cannot show as-is → no form.
  for (const [key, value] of Object.entries(args)) {
    const field = fields.find((f) => f.key === key);
    if (!field) return null;
    if (!representable(field, value)) return null;
  }
  // Required first, then the schema's order.
  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
}

function representable(field: FormField, value: unknown): boolean {
  if (value === undefined || value === null) return !field.required || field.kind !== 'boolean';
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'stringList':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && !v.includes('\n'));
    case 'enum':
      return typeof value === 'string' && field.options.includes(value);
    default:
      return typeof value === 'string';
  }
}

export function toFormState(fields: FormField[], args: Record<string, unknown>): FormState {
  const state: FormState = {};
  for (const f of fields) {
    const v = args[f.key];
    if (f.kind === 'boolean') state[f.key] = v === true;
    else if (f.kind === 'stringList') state[f.key] = Array.isArray(v) ? v.join('\n') : '';
    else state[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return state;
}

/**
 * Form state → arguments. Empty optional fields are left out; a number field
 * that does not parse is kept as text so validation reports it rather than
 * the value quietly changing. Booleans are included only when required or on.
 */
export function fromFormState(
  fields: FormField[],
  state: FormState,
  original: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = state[f.key];
    if (f.kind === 'boolean') {
      if (raw === true || f.required || Object.hasOwn(original, f.key)) out[f.key] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw : '';
    if (text.trim() === '' && !f.required) continue;
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(text);
      out[f.key] = text.trim() !== '' && Number.isFinite(n) ? n : text;
    } else if (f.kind === 'stringList') {
      out[f.key] = text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      out[f.key] = text;
    }
  }
  return out;
}
