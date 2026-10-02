import i18next from 'eslint-plugin-i18next';
import tsParser from '@typescript-eslint/parser';
import tseslint from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import {
  IGNORED_FILES,
  COPY_ATTRIBUTES,
  RENDERED_NODE_ATTRIBUTES,
  NON_COPY_PATTERNS,
  isCopy,
  readsAsCopy,
} from '../scripts/i18n-copy-rules.mjs';

// eslint-plugin-i18next's `jsx-only` mode covers JSX text and selected literal
// attributes, but it does not report interpolated templates in either position:
// `<span>{`Hello ${name}`}</span>` and `title={`Delete ${name}`}` both passed. This
// companion rule closes that syntactic hole while keeping the same JSX-only scope. It
// intentionally stops at functions and calls: the inventory ratchet owns broader
// callback, helper, and indirect ReactNode recall without turning this blocking rule
// into a fragile data-flow analyser. Direct rendered-node literals remain precise enough
// to block here without treating data-shaped props such as `action={context}` as copy.
const noInterpolatedLiteral = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      hardcoded: 'Interpolated user-facing text must use the i18n lookup.',
    },
  },
  create(context) {
    const copyBearingJsxOwner = (node) => {
      let child = node;
      let current = node.parent;
      while (current) {
        if (current.type === 'JSXAttribute' && current.value === child) {
          const name = current.name?.type === 'JSXIdentifier' ? current.name.name : '';
          if (COPY_ATTRIBUTES.includes(name)) return 'copy';
          if (RENDERED_NODE_ATTRIBUTES.includes(name)) return 'rendered-node';
          return false;
        }
        if (current.type === 'JSXExpressionContainer') {
          if (current.expression !== child) return false;
          const owner = current.parent;
          if (owner?.type === 'JSXAttribute') {
            const name = owner.name?.type === 'JSXIdentifier' ? owner.name.name : '';
            if (COPY_ATTRIBUTES.includes(name)) return 'copy';
            if (RENDERED_NODE_ATTRIBUTES.includes(name)) return 'rendered-node';
            return false;
          }
          return owner?.type === 'JSXElement' || owner?.type === 'JSXFragment' ? 'copy' : false;
        }

        // These wrappers leave the expression's rendered value intact. Every function,
        // call, member access, variable, or other expression boundary deliberately stops
        // here; the inventory ratchet covers those broader rendered-copy paths.
        const transparent =
          (['TSAsExpression', 'TSTypeAssertion', 'ChainExpression', 'ParenthesizedExpression'].includes(current.type)
            && current.expression === child)
          || (current.type === 'ConditionalExpression'
            && (current.consequent === child || current.alternate === child))
          || (current.type === 'LogicalExpression'
            && ((current.operator === '&&' && current.right === child)
              || (['||', '??'].includes(current.operator)
                && (current.left === child || current.right === child))));
        if (!transparent) return false;
        child = current;
        current = current.parent;
      }
      return false;
    };

    return {
      Literal(node) {
        if (
          typeof node.value === 'string'
          && readsAsCopy(node.value)
          && copyBearingJsxOwner(node) === 'rendered-node'
        ) {
          context.report({ node, messageId: 'hardcoded' });
        }
      },
      TemplateLiteral(node) {
        // A template can be entirely dynamic (`${done} / ${total}` or `${title}`). The
        // interpolation itself needs no translation; flag only text authored between the
        // expressions, using the same definition of human copy as the literal rule.
        const owner = copyBearingJsxOwner(node);
        const authoredParts = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
        const hasLiteralCopy = authoredParts.some((part) => isCopy(part));
        const renderedNodeText = authoredParts.join('{{…}}');
        const hasRenderedNodeCopy = readsAsCopy(renderedNodeText);
        if (
          (node.expressions.length > 0 && owner === 'copy' && hasLiteralCopy)
          || (owner === 'rendered-node' && hasRenderedNodeCopy)
        ) {
          context.report({ node, messageId: 'hardcoded' });
        }
      },
    };
  },
};

// i18n gate config — deliberately SEPARATE from eslint.config.mjs.
//
// `no-literal-string` fires on every user-facing string in a codebase that has no
// i18n yet - 751 of them today. Putting it in the main config would
// make `npm run lint:renderer` permanently red, and this repo's own history says what
// happens next: eslint.config.mjs documents four react-hooks rules that were downgraded
// to `warn` for exactly that reason, where they are now write-only.
//
// So the rule lives here at `error` and is run by scripts/i18n-lint-gate.mjs, which
// compares per-file counts against renderer/i18n-lint-baseline.json and fails only when
// a count diverges. New hardcoded copy is blocked from day one; the pre-existing 751
// are a burn-down number rather than a wall. Once the i18n migration drains the baseline,
// this config can fold into the main one as a plain global `error`.
export default [
  { ignores: IGNORED_FILES },
  {
    files: ['**/*.{ts,tsx}'],
    // The rule set below is deliberately limited to copy detection. The TypeScript and
    // hooks plugins are registered but left switched off: the codebase carries
    // `eslint-disable` comments for their rules, and ESLint 9 reports a directive for an
    // undefined rule as an error, which would show up as a phantom gate failure.
    plugins: {
      i18next,
      'steno-i18n': { rules: { 'no-interpolated-literal': noInterpolatedLiteral } },
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // Match the main config: this codebase carries intentional disable directives that
    // aren't active rules here, and reporting them would be noise from an unrelated gate.
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          // 'jsx-only', not 'jsx-text-only': the latter skips JSX attributes entirely,
          // so `placeholder="Search notes"` would never be seen. 'jsx-only' covers JSX
          // text plus the attributes listed below, and still leaves plain TypeScript
          // string literals alone — those are overwhelmingly ids, keys and class names.
          mode: 'jsx-only',
          // Attributes that carry copy a user actually reads. Everything else
          // (className, data-*, variant, href, …) stays out by omission.
          'jsx-attributes': { include: COPY_ATTRIBUTES },
          words: { exclude: NON_COPY_PATTERNS },
        },
      ],
      'steno-i18n/no-interpolated-literal': 'error',
    },
  },
];
