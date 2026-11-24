'use strict';

// Simple actions (mcp-simple-actions.js): detection against live tool lists,
// prefetch through a mocked read tool, translation templates, light argument
// repair and tool-name repair.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sa = require('./mcp-simple-actions');
const { validateArguments } = require('./mcp-schema');
const { NOTION_LIKE_TOOLS } = require('../e2e/fixtures/mock-mcp-server');

const LIVE_NOTION = path.join(__dirname, '..', 'e2e', 'fixtures', 'notion-tools.json');
const noRead = async () => { throw new Error('no reads expected'); };

test('fillTemplate: values, empty fields left out, lookups, literals (same cases as actionTemplate.test.ts)', () => {
  const tpl = { pages: [{ properties: { title: '{{title}}' }, content: '{{content}}' }] };
  assert.deepEqual(sa.fillTemplate(tpl, { title: 'Website content cleanup', content: '- Defence' }), {
    pages: [{ properties: { title: 'Website content cleanup' }, content: '- Defence' }],
  });
  assert.deepEqual(sa.fillTemplate(tpl, { title: 'T', content: '  ' }), { pages: [{ properties: { title: 'T' } }] });
  const jira = { cloudId: 'site-1', projectKey: { $lookup: 'project', map: { 'Web (WEB)': 'WEB' } }, team: { $lookup: 'team', map: {} } };
  assert.deepEqual(sa.fillTemplate(jira, { project: 'Web (WEB)', team: 'Eng' }), { cloudId: 'site-1', projectKey: 'WEB', team: 'Eng' });
  assert.deepEqual(sa.fillTemplate(jira, {}), { cloudId: 'site-1' });
  assert.deepEqual(sa.fillTemplate(jira, { project: 'constructor' }).projectKey, 'constructor', 'no prototype lookups');
});

test('Notion: create_page from the live 77-tool list, translated to notion-create-pages', async () => {
  const tools = JSON.parse(fs.readFileSync(LIVE_NOTION, 'utf8'));
  assert.equal(tools.length, 77);
  const [page, ...rest] = await sa.buildSimpleActions({ kind: 'notion', tools, read: noRead });
  assert.equal(rest.length, 0, 'comments need a grounded page id, so only create_page');
  assert.equal(page.id, 'create_page');
  assert.equal(page.vendorTool, 'notion-create-pages');
  assert.deepEqual(page.schema.required, ['title']);
  const call = sa.translate(page, { title: 'Website content cleanup', content: '- Defence\n- Law enforcement' });
  assert.deepEqual(call, {
    tool: 'notion-create-pages',
    arguments: { pages: [{ properties: { title: 'Website content cleanup' }, content: '- Defence\n- Law enforcement' }] },
  });
  const vendor = tools.find((t) => t.name === 'notion-create-pages');
  assert.deepEqual(validateArguments(vendor.inputSchema, call.arguments), [], 'the vendor schema accepts the translation');
});

test('Notion: missing vendor tool falls back to the generic path', async () => {
  const tools = NOTION_LIKE_TOOLS.filter((t) => t.name !== 'notion-create-pages');
  assert.deepEqual(await sa.buildSimpleActions({ kind: 'notion', tools, read: noRead }), []);
  assert.deepEqual(await sa.buildSimpleActions({ kind: 'custom', tools: NOTION_LIKE_TOOLS, read: noRead }), []);
  assert.equal(sa.hasSimpleActions('custom'), false);
});

const LINEAR_TOOLS = [
  { name: 'list_teams', readOnly: true, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  {
    name: 'save_issue',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' }, team: { type: 'string', description: 'Team name or ID' }, description: { type: 'string' } },
    },
  },
];

test('Linear: teams prefetched into an enum, team name sent as its id', async () => {
  const reads = [];
  const read = async (name, args) => {
    reads.push([name, args]);
    return JSON.stringify({ teams: [{ id: 't-eng', name: 'Engineering', key: 'ENG' }, { id: 't-des', name: 'Design', key: 'DES' }] });
  };
  const [issue] = await sa.buildSimpleActions({ kind: 'linear', tools: LINEAR_TOOLS, read });
  assert.deepEqual(reads, [['list_teams', {}]]);
  assert.equal(issue.vendorTool, 'save_issue');
  assert.deepEqual(issue.schema.properties.team.enum, ['Engineering', 'Design']);
  assert.equal(issue.schema.properties.team.default, 'Engineering');
  const call = sa.translate(issue, { title: 'Trim the Defence page', team: 'Design' });
  assert.deepEqual(call, { tool: 'save_issue', arguments: { title: 'Trim the Defence page', team: 't-des' } });
  assert.equal(Object.hasOwn(call.arguments, 'id'), false, 'never an update');
});

test('Linear: a failing prefetch gives no simple action (generic path)', async () => {
  const logs = [];
  const out = await sa.buildSimpleActions({ kind: 'linear', tools: LINEAR_TOOLS, read: async () => { throw new Error('401'); }, log: (m) => logs.push(m) });
  assert.deepEqual(out, []);
  assert.match(logs[0], /linear unavailable/);
});

test('Jira: cloudId, projects and issue types prefetched; translated to createJiraIssue', async () => {
  const tools = [
    { name: 'getAccessibleAtlassianResources', readOnly: true, inputSchema: { type: 'object', properties: {} } },
    { name: 'listJiraProjects', readOnly: true, inputSchema: { type: 'object', properties: { cloudId: { type: 'string' } }, required: ['cloudId'] } },
    { name: 'listJiraProjectIssueTypesMetadata', readOnly: true, inputSchema: { type: 'object', properties: { cloudId: { type: 'string' }, projectIdOrKey: { type: 'string' } } } },
    {
      name: 'createJiraIssue',
      inputSchema: {
        type: 'object',
        properties: { cloudId: { type: 'string' }, projectKey: { type: 'string' }, issueTypeName: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' } },
        required: ['cloudId', 'projectKey', 'issueTypeName', 'summary'],
      },
    },
  ];
  const replies = {
    getAccessibleAtlassianResources: [{ id: 'cloud-1', name: 'acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work', 'write:jira-work'] }],
    listJiraProjects: { values: [{ id: '1', key: 'WEB', name: 'Website' }, { id: '2', key: 'OPS', name: 'Ops' }] },
    listJiraProjectIssueTypesMetadata: { issueTypes: [{ name: 'Bug' }, { name: 'Task' }, { name: 'Sub-task', subtask: true }] },
  };
  const reads = [];
  const read = async (name, args) => { reads.push([name, args]); return `Result:\n${JSON.stringify(replies[name])}`; };
  const [issue] = await sa.buildSimpleActions({ kind: 'atlassian', tools, read });
  assert.deepEqual(reads.map((r) => r[0]), ['getAccessibleAtlassianResources', 'listJiraProjects', 'listJiraProjectIssueTypesMetadata']);
  assert.deepEqual(reads[2][1], { cloudId: 'cloud-1', projectIdOrKey: 'WEB' });
  assert.deepEqual(issue.schema.properties.project.enum, ['Website (WEB)', 'Ops (OPS)']);
  assert.deepEqual(issue.schema.properties.issue_type.enum, ['Bug', 'Task']);
  assert.equal(issue.schema.properties.issue_type.default, 'Task');
  const args = sa.coerceArguments(issue.schema, { summary: 'Trim Defence page', project: 'ops (OPS)' });
  assert.deepEqual(sa.translate(issue, args), {
    tool: 'createJiraIssue',
    arguments: { cloudId: 'cloud-1', projectKey: 'OPS', issueTypeName: 'Task', summary: 'Trim Defence page' },
  });
});

test('coerceArguments: defaults, enum case, list to bullets, unknown keys dropped', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { title: { type: 'string' }, content: { type: 'string' }, team: { type: 'string', enum: ['Eng', 'Design'], default: 'Eng' } },
  };
  assert.deepEqual(sa.coerceArguments(schema, { title: 'T', content: ['Defence', ' Law enforcement '], team: 'design', parent: { page_id: 'x' } }), {
    title: 'T', content: '- Defence\n- Law enforcement', team: 'Design',
  });
  assert.equal(sa.coerceArguments(schema, { title: 'T' }).team, 'Eng');
});

test('extractRecords: bare arrays, wrapped lists, prose around JSON, garbage', () => {
  assert.deepEqual(sa.extractRecords('[{"id":"a","name":"A"}]'), [{ id: 'a', name: 'A' }]);
  assert.equal(sa.extractRecords('{"data":{"teams":{"nodes":[{"id":"a","name":"A"}]}}}')[0].id, 'a');
  assert.equal(sa.extractRecords('Teams:\n{"teams":[{"id":"a","name":"A"}]}').length, 1);
  assert.deepEqual(sa.extractRecords('nothing here'), []);
});

test('resolveToolName: exact, case/separator-insensitive, unique suffix, ambiguity', () => {
  const names = ['notion-create-pages', 'notion-create-comment', 'create_page'];
  assert.equal(sa.resolveToolName('create_page', names), 'create_page');
  assert.equal(sa.resolveToolName('Create-Page', names), 'create_page');
  assert.equal(sa.resolveToolName('create_pages', ['notion-create-pages', 'notion-update-page']), 'notion-create-pages');
  assert.equal(sa.resolveToolName('NotionCreateComment', names), 'notion-create-comment');
  assert.equal(sa.resolveToolName('create', names), null);
  assert.equal(sa.resolveToolName('', names), null);
  assert.equal(sa.resolveToolName('pages', ['a-pages', 'b-pages']), null);
});
