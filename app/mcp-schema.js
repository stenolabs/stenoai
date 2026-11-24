'use strict';

/**
 * A small JSON Schema validator for MCP tool input schemas.
 *
 * Suggested actions are checked twice against the tool's `inputSchema`: when
 * the model proposes them (a proposal that does not fit is shown with its
 * problems, never silently "fixed"), and again on Approve with the arguments
 * the user edited. The server validates as well; this check is so the user
 * sees what is wrong before anything leaves the device.
 *
 * Supported: type (incl. unions), enum, const, required, properties,
 * additionalProperties (false or schema), items, min/maxLength, pattern,
 * minimum/maximum, exclusiveMinimum/Maximum, min/maxItems, anyOf/oneOf/allOf.
 * Anything else (local $ref, formats) is accepted rather than guessed at.
 */

const MAX_DEPTH = 24;

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

function validate(schema, value, path = '$', depth = 0, errors = []) {
  if (depth > MAX_DEPTH || schema === true || schema === undefined || schema === null) return errors;
  if (schema === false) {
    errors.push({ path, message: 'is not allowed' });
    return errors;
  }
  if (typeof schema !== 'object') return errors;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push({ path, message: `must be ${types.join(' or ')}` });
      return errors;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errors.push({ path, message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}` });
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} characters` });
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) errors.push({ path, message: 'does not match the expected format' });
      } catch (_) { /* an invalid pattern is the server's problem */ }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push({ path, message: `must be >= ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push({ path, message: `must be <= ${schema.maximum}` });
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push({ path, message: `needs at least ${schema.minItems} items` });
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push({ path, message: `allows at most ${schema.maxItems} items` });
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, depth + 1, errors));
    }
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, message: 'is required' });
      }
    }
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) {
        validate(props[key], v, `${path}.${key}`, depth + 1, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: 'is not an allowed field' });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(schema.additionalProperties, v, `${path}.${key}`, depth + 1, errors);
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validate(sub, value, path, depth + 1, errors);
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[keyword]) && schema[keyword].length) {
      const passing = schema[keyword].filter((sub) => validate(sub, value, path, depth + 1, []).length === 0).length;
      if (passing === 0) errors.push({ path, message: 'does not match any allowed shape' });
      else if (keyword === 'oneOf' && passing > 1) errors.push({ path, message: 'matches more than one allowed shape' });
    }
  }
  return errors;
}

/** Errors for tool arguments; the root must be an object. */
function validateArguments(inputSchema, args) {
  if (typeOf(args) !== 'object') return [{ path: '$', message: 'must be an object' }];
  return validate(inputSchema && typeof inputSchema === 'object' ? inputSchema : { type: 'object' }, args);
}

/**
 * A copy of a tool's schema small enough to put in a prompt: descriptions are
 * clipped and deep nesting is cut off. Never sent to the tool, only the model.
 */
function compactSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  if (depth > 4) return { type: schema.type };
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'description' && typeof v === 'string') out[k] = v.slice(0, 200);
    else if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).slice(0, 40).map(([pk, pv]) => [pk, compactSchema(pv, depth + 1)]));
    } else if (['items', 'additionalProperties'].includes(k)) out[k] = compactSchema(v, depth + 1);
    else if (['anyOf', 'oneOf', 'allOf'].includes(k) && Array.isArray(v)) out[k] = v.slice(0, 6).map((s) => compactSchema(s, depth + 1));
    else if (['type', 'enum', 'const', 'required', 'minLength', 'maxLength', 'minimum', 'maximum', 'format', 'default', 'title', 'minItems', 'maxItems'].includes(k)) out[k] = v;
  }
  return out;
}

module.exports = { validate, validateArguments, compactSchema, typeOf };
