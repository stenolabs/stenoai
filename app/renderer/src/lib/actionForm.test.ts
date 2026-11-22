import { describe, expect, it } from 'vitest';
import { formFields, fromFormState, parseArgumentsJson, toFormState } from './actionForm';
import type { JsonSchema } from './ipc';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', title: 'Title' },
    description: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'high'] },
    estimate: { type: 'integer' },
    labels: { type: 'array', items: { type: 'string' } },
    urgent: { type: 'boolean' },
  },
  required: ['title'],
};

describe('formFields', () => {
  it('builds a form for flat simple schemas, required first', () => {
    const fields = formFields(schema, { title: 'A' });
    expect(fields?.map((f) => [f.key, f.kind])).toEqual([
      ['title', 'string'],
      ['description', 'text'],
      ['priority', 'enum'],
      ['estimate', 'integer'],
      ['labels', 'stringList'],
      ['urgent', 'boolean'],
    ]);
    expect(fields?.[0]?.label).toBe('Title');
  });

  it('falls back to raw JSON for nested schemas or values the form cannot show', () => {
    expect(formFields({ type: 'object', properties: { a: { type: 'object' } } }, {})).toBeNull();
    expect(formFields(schema, { unknown: 1 })).toBeNull();
    expect(formFields(schema, { estimate: 1.5 })).toBeNull();
    expect(formFields(schema, { priority: 'urgent' })).toBeNull();
    expect(formFields(null, {})).toBeNull();
  });
});

describe('form state round trip', () => {
  it('keeps values, omits empty optionals, parses numbers and lists', () => {
    const fields = formFields(schema, { title: 'A', estimate: 3, labels: ['x', 'y'] })!;
    const state = toFormState(fields, { title: 'A', estimate: 3, labels: ['x', 'y'] });
    expect(state).toMatchObject({ title: 'A', estimate: '3', labels: 'x\ny', urgent: false });
    expect(fromFormState(fields, { ...state, title: 'B' }, { title: 'A' })).toEqual({
      title: 'B',
      estimate: 3,
      labels: ['x', 'y'],
    });
  });

  it('keeps an unparsable number as text so validation reports it', () => {
    const fields = formFields(schema, {})!;
    expect(fromFormState(fields, { title: 'A', estimate: 'abc' }, {})).toEqual({
      title: 'A',
      estimate: 'abc',
    });
  });

  it('parses raw JSON objects only', () => {
    expect(parseArgumentsJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgumentsJson('[1]')).toBeNull();
    expect(parseArgumentsJson('nope')).toBeNull();
  });
});
