'use strict';

/**
 * Connectors offered on the Connect page under "Turn meetings into actions".
 *
 * Vendor servers are reached with OAuth 2.1 and discovered at run time
 * (mcp-oauth.js), so an entry here is only a URL plus registration quirks:
 *   - noDcrCache: register a fresh client on every sign-in (Atlassian asks
 *     clients not to cache the DCR client_id).
 *   - staticClient: a client we registered with the vendor ourselves, used only
 *     when the server offers neither CIMD nor DCR. HubSpot and Asana need one
 *     ("MCP auth app" / "MCP app") and we have not registered yet, so they are
 *     listed as coming soon and refuse to connect.
 *
 * Endpoints checked 2026-11-22 (Atlassian moved from /v1/mcp/authv2 to /v2/mcp).
 */

const CONNECTORS = Object.freeze([
  {
    id: 'linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    status: 'available',
  },
  {
    id: 'notion',
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    status: 'available',
  },
  {
    id: 'atlassian',
    name: 'Jira and Confluence',
    url: 'https://mcp.atlassian.com/v2/mcp',
    auth: 'oauth',
    status: 'available',
    noDcrCache: true,
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    url: 'https://mcp.hubspot.com',
    auth: 'oauth',
    status: 'needs-registration',
    staticClient: null,
  },
  {
    id: 'asana',
    name: 'Asana',
    url: 'https://mcp.asana.com/v2/mcp',
    auth: 'oauth',
    status: 'needs-registration',
    staticClient: null,
  },
]);

/**
 * Static per-vendor OAuth clients, keyed by connector id. Empty until Steno is
 * registered with HubSpot and Asana; an entry is { clientId, clientSecret? }.
 */
const STATIC_CLIENTS = Object.freeze({
  hubspot: null,
  asana: null,
});

function connectorById(id) {
  const c = CONNECTORS.find((x) => x.id === id);
  if (!c) return null;
  return { ...c, staticClient: STATIC_CLIENTS[c.id] || c.staticClient || null };
}

function publicCatalogue() {
  return CONNECTORS.map(({ id, name, url, auth, status }) => ({ id, name, url, auth, status }));
}

module.exports = { CONNECTORS, STATIC_CLIENTS, connectorById, publicCatalogue };
