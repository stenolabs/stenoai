'use strict';

/**
 * Simple actions: a tiny, flat catalogue of plain actions per known connector
 * (Notion, Linear, Jira), each with a translator to the vendor's real tool
 * call.
 *
 * Why: vendor MCP servers expose dozens of tools with deep schemas (Notion:
 * 77 tools, ~26k characters). Small local models cannot pick one out and fill
 * it: gemma4:e2b put a tool's description in "tool" and invented nested
 * arguments; qwen3.5:9b called "create_pages" with Notion block JSON. Given
 * create_page(title, content) instead, both get it right.
 *
 *   model sees        create_page { title, content }
 *   user edits        the same flat fields on the action card
 *   Approve sends     notion-create-pages { pages: [{ properties: { title }, content }] }
 *
 * The translation is a declarative template (fillTemplate), stored on the
 * card, so "Show what will be sent" renders the exact vendor payload from the
 * user's edited fields (app/renderer/src/lib/actionTemplate.ts is the
 * renderer's copy of fillTemplate) and approve() sends what was shown.
 *
 * A connector is recognised by its connection kind AND by the vendor tool
 * being in the live tools/list: names are matched, never assumed, and when
 * the tool is missing the connection falls back to the generic path. Values
 * a model cannot know (Linear teams, the Atlassian cloudId, Jira projects and
 * issue types) are prefetched with the vendor's read tools at suggestion
 * time and offered as enums, so the card shows them as dropdowns.
 *
 * Pure apart from the injected `read(toolName, args) -> text`.
 */

const MAX_ENUM = 50;

/** Lowercase letters and digits only: "notion-create-pages" == "NotionCreatePages". */
function normName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The first tool (in candidate order) the server lists. Destructive tools are
 * skipped unless the candidate says the wrapper only ever creates.
 */
function findTool(tools, candidates) {
  const list = Array.isArray(tools) ? tools : [];
  for (const c of candidates) {
    const want = normName(typeof c === 'string' ? c : c.name);
    const allowDestructive = typeof c === 'object' && c.createOnly === true;
    const hit = list.find((t) => normName(t.name) === want && (!t.destructive || allowDestructive));
    if (hit) return hit;
  }
  return null;
}

/** The schema's own spelling of the first candidate property it has, or null. */
function pickProp(schema, candidates) {
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const c of candidates) {
    const key = Object.keys(props).find((k) => normName(k) === normName(c));
    if (key) return key;
  }
  return null;
}

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
const MISSING = Symbol('missing');

/**
 * Fill a translation template with the simple action's arguments.
 *   "{{key}}"                      the argument's value (left out when empty)
 *   { "$lookup": key, "map": {} }  map[value], or the value itself
 * Anything else is copied as is. Mirrored in the renderer's actionTemplate.ts.
 */
function fillTemplate(template, args) {
  const a = args && typeof args === 'object' ? args : {};
  const walk = (node, depth) => {
    if (depth > 12) return node;
    if (typeof node === 'string') {
      const m = /^\{\{([A-Za-z0-9_]+)\}\}$/.exec(node);
      if (!m) return node;
      return isEmpty(a[m[1]]) ? MISSING : a[m[1]];
    }
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1)).filter((n) => n !== MISSING);
    if (node && typeof node === 'object') {
      if (typeof node.$lookup === 'string') {
        const v = a[node.$lookup];
        if (isEmpty(v)) return MISSING;
        const map = node.map && typeof node.map === 'object' ? node.map : {};
        return Object.hasOwn(map, String(v)) ? map[String(v)] : v;
      }
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const filled = walk(v, depth + 1);
        if (filled !== MISSING) out[k] = filled;
      }
      return out;
    }
    return node;
  };
  const out = walk(template, 0);
  return out === MISSING ? {} : out;
}

/** The vendor call for a simple action and its (user-edited) arguments. */
function translate(action, args) {
  return { tool: action.vendorTool, arguments: fillTemplate(action.template, args) };
}

/**
 * Light repairs before a proposal is checked: schema defaults for missing
 * fields, enum values matched ignoring case, a list of strings for a string
 * field joined as bullet lines, unknown keys dropped when the schema is
 * closed. Mirrors action_suggest.coerce_arguments.
 */
function coerceArguments(schema, args) {
  if (!schema || typeof schema !== 'object' || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const out = { ...args };
  for (const [key, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object') continue;
    if (isEmpty(out[key]) && prop.default !== undefined) {
      out[key] = prop.default;
      continue;
    }
    if (!Object.hasOwn(out, key)) continue;
    const v = out[key];
    if (Array.isArray(prop.enum) && typeof v === 'string' && !prop.enum.includes(v)) {
      const m = prop.enum.filter((e) => typeof e === 'string' && e.trim().toLowerCase() === v.trim().toLowerCase());
      if (m.length === 1) out[key] = m[0];
    }
    if (prop.type === 'string' && Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      out[key] = v.map((x) => x.trim()).filter(Boolean).map((x) => `- ${x}`).join('\n');
    } else if (prop.type === 'string' && typeof v === 'number') {
      out[key] = String(v);
    }
  }
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(out)) if (!Object.hasOwn(props, k)) delete out[k];
  }
  return out;
}

/**
 * Records from a read tool's text result: the first array of objects with a
 * name, found breadth-first in the JSON (servers wrap lists differently:
 * a bare array, { teams: [...] }, { values: [...] }, { data: { nodes } }).
 */
function extractRecords(text) {
  let data;
  if (typeof text !== 'string') data = text;
  else {
    try {
      data = JSON.parse(text);
    } catch (_) {
      const start = text.search(/[[{]/);
      if (start === -1) return [];
      try { data = JSON.parse(text.slice(start)); } catch (_e) { return []; }
    }
  }
  const queue = [data];
  for (let seen = 0; queue.length && seen < 500; seen += 1) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length && objs.some((x) => typeof x.name === 'string' || typeof x.displayName === 'string')) return objs;
      queue.push(...node);
    } else if (node && typeof node === 'object') {
      queue.push(...Object.values(node));
    }
  }
  return [];
}

const nameOf = (r) => String(r.name || r.displayName || '').trim().slice(0, 120);

function enumField(names, description, preferred) {
  const unique = [...new Set(names.filter(Boolean))].slice(0, MAX_ENUM);
  const def = unique.includes(preferred) ? preferred : unique[0];
  return { type: 'string', enum: unique, default: def, description };
}

// ── connectors ────────────────────────────────────────────────────────────

async function notionActions({ tools }) {
  const vendor = findTool(tools, ['notion-create-pages', 'create-pages']);
  if (!vendor || !pickProp(vendor.inputSchema, ['pages'])) return [];
  return [{
    id: 'create_page',
    title: 'Create page',
    description: 'Create a new private page in Notion.',
    vendorTool: vendor.name,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Page title' },
        content: { type: 'string', description: 'Page body in Markdown: short paragraphs or a bulleted list' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    template: { pages: [{ properties: { title: '{{title}}' }, content: '{{content}}' }] },
  }];
  // Comments need an existing page id, which a note never grounds: not offered.
}

async function linearActions({ tools, read }) {
  const vendor = findTool(tools, ['create_issue', 'createIssue', { name: 'save_issue', createOnly: true }]);
  if (!vendor) return [];
  const s = vendor.inputSchema;
  const titleKey = pickProp(s, ['title']);
  const teamKey = pickProp(s, ['team', 'teamId', 'team_id']);
  if (!titleKey || !teamKey) return [];
  const descKey = pickProp(s, ['description', 'body']);
  let teams = [];
  const lister = findTool(tools, ['list_teams', 'listTeams', 'get_teams']);
  if (lister) {
    teams = extractRecords(await read(lister.name, {}))
      .map((r) => ({ id: typeof r.id === 'string' ? r.id : null, name: nameOf(r) }))
      .filter((t) => t.name);
  }
  const map = Object.fromEntries(teams.filter((t) => t.id).map((t) => [t.name, t.id]));
  const team = teams.length
    ? enumField(teams.map((t) => t.name), 'Linear team')
    : { type: 'string', minLength: 1, description: 'Linear team name or key' };
  return [{
    id: 'create_issue',
    title: 'Create issue',
    description: 'Create a new Linear issue.',
    vendorTool: vendor.name,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 250, description: 'Issue title' },
        ...(descKey ? { description: { type: 'string', description: 'Issue description in Markdown' } } : {}),
        team,
      },
      required: ['title', 'team'],
      additionalProperties: false,
    },
    template: {
      [titleKey]: '{{title}}',
      ...(descKey ? { [descKey]: '{{description}}' } : {}),
      [teamKey]: { $lookup: 'team', map },
    },
  }];
}

async function atlassianActions({ tools, read }) {
  const vendor = findTool(tools, ['createJiraIssue']);
  if (!vendor) return [];
  const s = vendor.inputSchema;
  const cloudKey = pickProp(s, ['cloudId']);
  const projectKey = pickProp(s, ['projectKey', 'project_key', 'project']);
  const typeKey = pickProp(s, ['issueTypeName', 'issueType', 'issue_type']);
  const summaryKey = pickProp(s, ['summary', 'title']);
  const descKey = pickProp(s, ['description', 'body']);
  const resources = findTool(tools, ['getAccessibleAtlassianResources']);
  const projectsTool = findTool(tools, ['listJiraProjects', 'getVisibleJiraProjects']);
  if (!cloudKey || !projectKey || !typeKey || !summaryKey || !resources || !projectsTool) return [];

  const sites = extractRecords(await read(resources.name, {}));
  const site = sites.find((r) => (r.scopes || []).some((x) => /jira/i.test(String(x)))) || sites[0];
  const cloudId = site && typeof site.id === 'string' ? site.id : null;
  if (!cloudId) return [];

  const projectArgs = { [pickProp(projectsTool.inputSchema, ['cloudId']) || 'cloudId']: cloudId };
  const actionProp = pickProp(projectsTool.inputSchema, ['action']);
  if (actionProp && (projectsTool.inputSchema.properties[actionProp].enum || []).includes('create')) projectArgs[actionProp] = 'create';
  const projects = extractRecords(await read(projectsTool.name, projectArgs))
    .filter((p) => typeof p.key === 'string' && nameOf(p))
    .slice(0, MAX_ENUM);
  if (!projects.length) return [];
  const label = (p) => `${nameOf(p)} (${p.key})`;

  // Issue types of the first project: listed with it, or from the metadata tool.
  let types = Array.isArray(projects[0].issueTypes) ? projects[0].issueTypes : [];
  const typesTool = findTool(tools, ['listJiraProjectIssueTypesMetadata', 'getJiraProjectIssueTypesMetadata']);
  if (!types.length && typesTool) {
    const ts = typesTool.inputSchema;
    types = extractRecords(await read(typesTool.name, {
      [pickProp(ts, ['cloudId']) || 'cloudId']: cloudId,
      [pickProp(ts, ['projectIdOrKey', 'projectKey', 'project']) || 'projectIdOrKey']: projects[0].key,
    }));
  }
  const typeNames = types.filter((t) => t.subtask !== true).map(nameOf).filter(Boolean);
  const issueType = typeNames.length
    ? enumField(typeNames, 'Jira issue type', 'Task')
    : { type: 'string', minLength: 1, default: 'Task', description: 'Jira issue type' };

  return [{
    id: 'create_issue',
    title: 'Create issue',
    description: 'Create a new Jira issue.',
    vendorTool: vendor.name,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 250, description: 'Issue summary' },
        ...(descKey ? { description: { type: 'string', description: 'Issue description' } } : {}),
        project: enumField(projects.map(label), 'Jira project'),
        issue_type: issueType,
      },
      required: ['summary', 'project', 'issue_type'],
      additionalProperties: false,
    },
    template: {
      [cloudKey]: cloudId,
      [projectKey]: { $lookup: 'project', map: Object.fromEntries(projects.map((p) => [label(p), p.key])) },
      [typeKey]: '{{issue_type}}',
      [summaryKey]: '{{summary}}',
      ...(descKey ? { [descKey]: '{{description}}' } : {}),
    },
  }];
}

const BUILDERS = { notion: notionActions, linear: linearActions, atlassian: atlassianActions };

/** True when a connection kind has simple actions (the vendor tools may still be missing). */
function hasSimpleActions(kind) {
  return Object.hasOwn(BUILDERS, kind);
}

/**
 * The simple actions a connection offers, given its live tools and a
 * `read(toolName, args) -> text` for the prefetch. [] when the kind is not
 * known, a vendor tool is missing, or a prefetch fails: the caller then uses
 * the generic path for that connection.
 */
async function buildSimpleActions({ kind, tools, read, log = () => {} }) {
  const builder = BUILDERS[kind];
  if (!builder) return [];
  try {
    return await builder({ tools: tools || [], read });
  } catch (e) {
    log(`[actions] simple actions for ${kind} unavailable (${e?.code || e?.name || 'error'})`);
    return [];
  }
}

/**
 * A model's tool reference resolved against real names: exact, then ignoring
 * case and separators, then a unique suffix ("create_pages" for
 * "notion-create-pages"). Mirrors action_suggest.resolve_tool.
 */
function resolveToolName(ref, names) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const list = (names || []).filter((n) => typeof n === 'string');
  if (list.includes(ref.trim())) return ref.trim();
  const want = normName(ref);
  if (!want) return null;
  const same = list.filter((n) => normName(n) === want);
  if (same.length) return same.length === 1 ? same[0] : null;
  if (want.length < 5) return null;
  const stem = want.replace(/s$/, '');
  const suffix = list.filter((n) => normName(n).endsWith(want) || normName(n).replace(/s$/, '').endsWith(stem));
  return suffix.length === 1 ? suffix[0] : null;
}

module.exports = {
  normName,
  findTool,
  pickProp,
  fillTemplate,
  translate,
  coerceArguments,
  extractRecords,
  buildSimpleActions,
  hasSimpleActions,
  resolveToolName,
};
