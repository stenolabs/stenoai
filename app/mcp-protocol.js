'use strict';

const SUPPORTED_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
];

const MODERN_VERSION = '2026-07-28';
const LEGACY_FALLBACK_VERSION = '2025-03-26';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error,
  };
}

function responseResult(id, result, includeResultType) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      ...(includeResultType ? { resultType: 'complete' } : {}),
      ...result,
    },
  };
}

function truncate(value, max = 192) {
  if (typeof value !== 'string') {
    return '';
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function decodeHeaderValue(raw) {
  if (typeof raw !== 'string') {
    return raw;
  }

  const match = raw.match(/^=\?base64\?([A-Za-z0-9+/=]+)\?=$/);
  if (!match) {
    return raw;
  }

  const token = match[1];

  if (token.length % 4 === 1) {
    throw new Error('Invalid MCP base64 header value');
  }

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(token)) {
    throw new Error('Invalid MCP base64 header value');
  }

  try {
    return Buffer.from(token, 'base64').toString('utf8');
  } catch {
    throw new Error('Invalid MCP base64 header value');
  }
}

function getHeader(headers, name) {
  if (!isObject(headers)) {
    return undefined;
  }
  const value = headers[name];
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  return value;
}

function hasHeader(headers, name) {
  if (!isObject(headers)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(headers, name);
}

function isNotification(body) {
  return !isObject(body) || !Object.prototype.hasOwnProperty.call(body, 'id');
}

function resolveProtocolVersion(legacyBody) {
  const requested = legacyBody && legacyBody.params && legacyBody.params.protocolVersion;
  if (typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested)) {
    return requested;
  }
  return MODERN_VERSION;
}

async function handleRpc({ headers = {}, body, tools = [], callTool, serverInfo } = {}) {
  if (!isObject(body)) {
    return {
      status: 400,
      body: jsonRpcError(null, -32600, 'Invalid Request'),
    };
  }

  const isLegacy = !hasHeader(headers, 'mcp-protocol-version');
  if (!isLegacy) {
    let protocolVersion;
    try {
      protocolVersion = getHeader(headers, 'mcp-protocol-version');
    } catch {
      return {
        status: 400,
        body: jsonRpcError(body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null, -32020, 'Header mismatch for MCP-Protocol-Version'),
      };
    }

    if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
      return {
        status: 400,
        body: jsonRpcError(body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null, -32020, 'Header mismatch for MCP-Protocol-Version'),
      };
    }

    if (!SUPPORTED_VERSIONS.includes(protocolVersion)) {
      return {
        status: 400,
        body: jsonRpcError(
          body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null,
          -32022,
          'Unsupported MCP protocol version',
          {
            supported: SUPPORTED_VERSIONS,
            requested: truncate(protocolVersion),
          }
        ),
      };
    }

    let headerMethod;
    try {
      headerMethod = decodeHeaderValue(getHeader(headers, 'mcp-method'));
    } catch {
      return {
        status: 400,
        body: jsonRpcError(
          body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null,
          -32020,
          'Header mismatch for Mcp-Method'
        ),
      };
    }

    const bodyMethod = isObject(body) ? body.method : undefined;
    if (typeof bodyMethod !== 'string' || typeof headerMethod !== 'string' || bodyMethod !== headerMethod) {
      return {
        status: 400,
        body: jsonRpcError(
          body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null,
          -32020,
          'Header mismatch for Mcp-Method'
        ),
      };
    }

    if (bodyMethod === 'tools/call') {
      let headerName;
      try {
        headerName = decodeHeaderValue(getHeader(headers, 'mcp-name'));
      } catch {
        return {
          status: 400,
          body: jsonRpcError(
            body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null,
            -32020,
            'Header mismatch for Mcp-Name'
          ),
        };
      }

      const declaredName = isObject(body) ? (body.params && body.params.name) : undefined;
      if (typeof headerName !== 'string' || typeof declaredName !== 'string' || headerName !== declaredName) {
        return {
          status: 400,
          body: jsonRpcError(
            body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null,
            -32020,
            'Header mismatch for Mcp-Name'
          ),
        };
      }
    }

    const metaVersion =
      isObject(body) && isObject(body.params) && isObject(body.params._meta)
        ? body.params._meta['io.modelcontextprotocol/protocolVersion']
        : undefined;
    if (typeof metaVersion === 'string' && metaVersion !== protocolVersion) {
      return {
        status: 400,
        body: jsonRpcError(
          body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null,
          -32020,
          'Header mismatch for MCP-Protocol-Version with body params._meta'
        ),
      };
    }

    if (isNotification(body)) {
      return {
        status: 202,
        body: null,
      };
    }

    const includeResultType = protocolVersion === MODERN_VERSION;

    if (bodyMethod === 'server/discover') {
      return {
        status: 200,
        body: responseResult(
          body.id,
          {
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: {
              tools: {},
            },
            _meta: {
              'io.modelcontextprotocol/serverInfo': {
                ...(isObject(serverInfo) ? serverInfo : {}),
              },
            },
          },
          includeResultType
        ),
      };
    }

    if (bodyMethod === 'tools/list') {
      return {
        status: 200,
        body: responseResult(body.id, { tools: Array.isArray(tools) ? tools : [] }, includeResultType),
      };
    }

    if (bodyMethod === 'ping') {
      return {
        status: 200,
        body: responseResult(body.id, {}, includeResultType),
      };
    }

    if (bodyMethod === 'tools/call') {
      const toolName = body && body.params ? body.params.name : undefined;
      const tool = Array.isArray(tools) ? tools.find((item) => item && item.name === toolName) : undefined;
      if (!tool) {
        // Choosing tool-level failure here keeps transports with always-200 success for tool calls,
        // while surfacing tool execution failure in result.isError (preferred when tool metadata is authoritative).
        return {
          status: 200,
          body: responseResult(
            body.id,
            {
              content: [
                {
                  type: 'text',
                  text: 'Unknown tool',
                },
              ],
              isError: true,
            },
            includeResultType
          ),
        };
      }

      const toolParams = isObject(body && body.params) ? body.params.arguments : undefined;
      try {
        const toolResult = await callTool(toolName, toolParams || {});

        const normalizedContent =
          isObject(toolResult) && Array.isArray(toolResult.content)
            ? toolResult.content
            : [
                {
                  type: 'text',
                  text:
                    isObject(toolResult) && typeof toolResult.content === 'string'
                      ? toolResult.content
                      : 'OK',
                },
              ];

        return {
          status: 200,
          body: responseResult(
            body.id,
            {
              content: normalizedContent,
              ...(isObject(toolResult) && isObject(toolResult.structuredContent)
                ? { structuredContent: toolResult.structuredContent }
                : {}),
              ...(isObject(toolResult) && toolResult.isError ? { isError: true } : {}),
            },
            includeResultType
          ),
        };
      } catch (error) {
        return {
          status: 200,
          body: responseResult(
            body.id,
            {
              content: [
                {
                  type: 'text',
                  text: 'Tool execution failed',
                },
              ],
              isError: true,
            },
            includeResultType
          ),
        };
      }
    }

    return {
      status: 404,
      body: jsonRpcError(
        body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null,
        -32601,
        'Method not found'
      ),
    };
  }

  // Legacy era: no header metadata validation.
  if (isNotification(body)) {
    return {
      status: 202,
      body: null,
    };
  }

  const method = isObject(body) ? body.method : undefined;
  const id = body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null;

  if (method === 'initialize') {
    const protocolVersion = resolveProtocolVersion(body);
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          ...(isObject(serverInfo)
            ? {
                serverInfo,
              }
            : {}),
        },
      },
    };
  }

  if (typeof method === 'string' && method.startsWith('notifications/')) {
    return {
      status: 202,
      body: null,
    };
  }

  return {
    status: 404,
    body: jsonRpcError(id, -32601, 'Method not found'),
  };
}

module.exports = {
  SUPPORTED_VERSIONS,
  MODERN_VERSION,
  LEGACY_FALLBACK_VERSION,
  decodeHeaderValue,
  handleRpc,
};
