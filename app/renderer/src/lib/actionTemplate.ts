/**
 * The renderer's copy of fillTemplate in app/mcp-simple-actions.js: turns a
 * simple action's flat fields into the vendor payload, so "Show what will be
 * sent" shows exactly what Approve sends. Keep the two in step; both are
 * tested against the same cases.
 *
 *   "{{key}}"                      the argument's value (left out when empty)
 *   { "$lookup": key, "map": {} }  map[value], or the value itself
 */
const MISSING: unique symbol = Symbol();

const isEmpty = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && !v.trim());

export function fillTemplate(template: unknown, args: Record<string, unknown>): unknown {
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 12) return node;
    if (typeof node === 'string') {
      const m = /^\{\{([A-Za-z0-9_]+)\}\}$/.exec(node);
      if (!m) return node;
      return isEmpty(args[m[1]!]) ? MISSING : args[m[1]!];
    }
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1)).filter((n) => n !== MISSING);
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.$lookup === 'string') {
        const v = args[obj.$lookup];
        if (isEmpty(v)) return MISSING;
        const map = obj.map && typeof obj.map === 'object' ? (obj.map as Record<string, unknown>) : {};
        return Object.hasOwn(map, String(v)) ? map[String(v)] : v;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
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
