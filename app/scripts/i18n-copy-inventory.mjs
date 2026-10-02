#!/usr/bin/env node
// English copy inventory.
//
// WHY THIS EXISTS. The i18n migration rewrites hundreds of hardcoded strings into t()
// lookups. That edit is supposed to be pure motion — same words, new home. In PR #494 it
// was not: 'Nothing to process' silently became 'Nothing was recorded.', and three e2e
// specs went red for a reason nobody could read off the diff. Roughly two thirds of this
// app's copy is pinned by no test at all, so the same rewrite elsewhere would land unseen.
//
// This script writes every English string the renderer shows into a checked-in file. CI
// regenerates it and fails if it is stale. The review rule for the migration then fits in
// one sentence: the inventory diff must show strings MOVING, never CHANGING. Afterwards it
// keeps working as an ordinary copy changelog — an intentional wording change shows up as
// a one-file diff in the PR that makes it.
//
// It witnesses; it never blocks a legitimate copy edit.
//
//   node scripts/i18n-copy-inventory.mjs           # check (CI) — fails if stale
//   node scripts/i18n-copy-inventory.mjs --update  # rewrite the inventory
//
// SCOPE, honestly stated: this reads JSX text and copy-bearing JSX attributes, including
// visible callback, helper, and ReactNode branches below them. That broad recall is
// deliberate: the blocking ESLint rule only owns syntactically direct JSX templates.
// It does NOT see strings assembled at runtime from fragments, copy that lives in the
// Electron main process, or text the Python backend emits. Coverage is a floor, not a
// proof of completeness.
//
// Translation lookups are resolved against locales/en.json so the inventory stays
// comparable across the migration boundary. Before migration a file lists its literals;
// afterwards it lists the same English words, now reached through typed keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  IGNORED_FILES,
  COPY_ATTRIBUTES,
  RENDERED_NODE_ATTRIBUTES,
  isCopy,
  definitelyNotCopy,
  readsAsCopy,
  globToRegExp,
  decodeEntities,
  toPosixPath,
} from './i18n-copy-rules.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(APP_DIR, 'renderer/src');
const INVENTORY = path.resolve(APP_DIR, '../docs/i18n/copy-inventory.json');
const ENGLISH_CATALOGUE = path.join(SRC_DIR, 'i18n/locales/en.json');
const update = process.argv.includes('--update');

function ignored(relPath) {
  const posix = toPosixPath(relPath);
  return IGNORED_FILES.some((pattern) => globToRegExp(pattern).test(posix));
}

function sourceFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(APP_DIR, full);
    if (entry.isDirectory()) {
      if (!ignored(rel)) sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !ignored(rel)) {
      acc.push(full);
    }
  }
  return acc;
}

// Record what the user actually sees. JSX collapses whitespace, so the inventory must too
// — otherwise a reflowed line reads as a copy change and the "moved, not changed" rule
// stops meaning anything. Entities are decoded for the same reason: React renders `&amp;`
// as `&`, so storing the entity would make untouched copy look edited during the migration.
const normalize = (text) => decodeEntities(text.replace(/\s+/g, ' ').trim());

export function collectFromSource(file, catalogue = {}) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );

  // An imported named `t` establishes a direct translation lookup even through a
  // re-export. Namespace calls stay restricted to the canonical renderer i18n module,
  // including explicit /index imports. A namespace `.t()` from another module fails
  // closed instead of silently dropping its argument as a dotted technical key. The same
  // applies to `.t()` reached through default imports, named objects, or props. Local
  // functions named `t` remain ordinary code unless they are imported.
  const translationCallees = new Set();
  const translationNamespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const imports = statement.importClause?.namedBindings;
    if (!imports) continue;
    if (ts.isNamedImports(imports)) {
      for (const element of imports.elements) {
        if ((element.propertyName ?? element.name).text === 't') {
          translationCallees.add(element.name.text);
        }
      }
      continue;
    }
    const canonicalI18nModule = /^(?:@\/i18n|\.{1,2}\/(?:.*\/)?i18n)(?:\/index(?:\.[cm]?[jt]sx?)?)?$/.test(
      moduleName
    );
    if (ts.isNamespaceImport(imports)) {
      if (canonicalI18nModule) {
        translationNamespaces.add(imports.name.text);
      }
    }
  }

  // Two partitions, not two files: `copy` is the contract a migration diff must hold,
  // `uncertain` is the safety net. One diff for a reviewer to read, and an uncertain-only
  // change in a styling PR is a five-second glance.
  //
  // Multisets, not Sets. Deduplicating hid the very edit this file exists to catch: if a
  // string appears twice in a file and one occurrence becomes another string already
  // present there, a Set-backed inventory does not change at all.
  const copy = new Map();
  const uncertain = new Map();
  const record = (text, certain) => {
    const bucket = certain || readsAsCopy(text) ? copy : uncertain;
    bucket.set(text, (bucket.get(text) ?? 0) + 1);
  };

  const addTranslation = (node, certain) => {
    if (!ts.isCallExpression(node)) {
      return false;
    }
    const directLookup =
      ts.isIdentifier(node.expression) && translationCallees.has(node.expression.text);
    const propertyLookup =
      ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't';
    const namespaceLookup =
      propertyLookup &&
      ts.isIdentifier(node.expression.expression) &&
      translationNamespaces.has(node.expression.expression.text);
    if (propertyLookup && !namespaceLookup) {
      throw new Error(
        `${file}: ${node.expression.getText(source)}() cannot be verified as a translation lookup; ` +
          'import a named t or the canonical i18n namespace'
      );
    }
    if (!directLookup && !namespaceLookup) return false;

    const [keyNode] = node.arguments;
    if (!keyNode || (!ts.isStringLiteral(keyNode) && !ts.isNoSubstitutionTemplateLiteral(keyNode))) {
      throw new Error(`${file}: translation keys must be static string literals`);
    }
    const value = catalogue[keyNode.text];
    if (typeof value !== 'string') {
      throw new Error(`${file}: missing English translation for ${JSON.stringify(keyNode.text)}`);
    }

    // Match the inventory's template-literal representation. Parameter names are an
    // implementation detail, so i18n's {{name}} token becomes one stable placeholder.
    const text = normalize(value.replace(/\{\{\s*[A-Za-z_][\w.-]*\s*\}\}/g, '{{…}}'));
    const accept = certain ? isCopy : (candidate) => !definitelyNotCopy(candidate);
    if (accept(text)) record(text, certain);
    return true;
  };

  // Position settles most of it. These node types hold strings that are never rendered:
  // module specifiers, member names, object keys, enum members, literal types, switch
  // labels and equality comparisons. Skipping the subtree beats filtering its text later.
  const isStructural = (node) =>
    ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isLiteralTypeNode(node) ||
    (ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind)) ||
    (ts.isCallExpression(node) &&
      ['require', 'import'].includes(node.expression.getText(source)));

  // `{ 'some-key': value }` — the key is structure, the value may well be copy.
  const isObjectKey = (node) =>
    node.parent &&
    (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) &&
    node.parent.name === node;

  // `case 'saved': return <p>All changes saved</p>` — the label is structure, but the body
  // is ordinary code that often renders copy. Skipping the whole CaseClause (as an earlier
  // revision did) silently dropped every string inside a switch.
  const isCaseLabel = (node) => {
    let child = node;
    let parent = node.parent;
    while (
      parent &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === child
    ) {
      child = parent;
      parent = parent.parent;
    }
    return parent && ts.isCaseClause(parent) && parent.expression === child;
  };

  // `items['technical-key']` has a structural string argument, but the expression may
  // also be followed by a callback with visible copy. Skip only that key, never the whole
  // access expression, so `promise.then(() => 'Saved')` remains reachable.
  const isElementAccessArgument = (node) =>
    node.parent && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node;

  const addLiteral = (node, accept, certain = false) => {
    if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
    if (isObjectKey(node) || isCaseLabel(node) || isElementAccessArgument(node)) return;
    const text = normalize(node.text);
    if (accept(text)) record(text, certain);
  };

  // Preserve the wording around interpolations while making the result independent of the
  // expression spelling. Renaming `minimumSpeakers` must not look like a copy change, but
  // changing "people spoke" must. One stable placeholder per expression gives the review
  // diff exactly that contract: `At least {{…}} people spoke`.
  const addTemplate = (node, accept, certain = false) => {
    if (!ts.isTemplateExpression(node)) return;
    if (isCaseLabel(node) || isElementAccessArgument(node)) return;
    const text = normalize(
      node.templateSpans.reduce((out, span) => `${out}{{…}}${span.literal.text}`, node.head.text)
    );
    if (accept(text)) record(text, certain);
  };

  // Walk an expression whose value is rendered. Structural subtrees still stay out, and
  // nested JSX goes through the normal walk so its own attribute semantics remain intact.
  // Function boundaries are optionally delegated for ReactNode props, matching the broad
  // callback recall used elsewhere without making their internals certain by position.
  const walkRenderedExpression = (node, certain, delegateFunctions = false) => {
    if (isStructural(node)) return;
    if (addTranslation(node, certain)) return;
    if (
      (delegateFunctions && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) ||
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node) ||
      ts.isJsxAttribute(node)
    ) {
      walk(node);
      return;
    }
    const accept = certain ? isCopy : (text) => !definitelyNotCopy(text);
    addLiteral(node, accept, certain);
    addTemplate(node, accept, certain);
    ts.forEachChild(node, (child) => walkRenderedExpression(child, certain, delegateFunctions));
  };

  const walk = (node) => {
    if (isStructural(node)) return;
    if (addTranslation(node, false)) return;

    if (ts.isJsxText(node)) {
      const text = normalize(node.text);
      // Rendered by construction — no heuristic, and always the `copy` partition.
      if (isCopy(text)) record(text, true);
      return;
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (RENDERED_NODE_ATTRIBUTES.includes(name)) {
        // ReactNode props are rendered even when their value is a direct string or a
        // conditional/call expression. Keep ambiguous lowercase tokens in the safety net,
        // while delegating nested JSX and callbacks to their normal structural handling so
        // attributes such as className stay out of the inventory.
        if (node.initializer) walkRenderedExpression(node.initializer, false, true);
        return;
      }
      if (!COPY_ATTRIBUTES.includes(name)) {
        // A non-copy prop's literal value is structural (`variant="danger"`,
        // `data-testid="save"`), but the prop can still carry a callback or a JSX action
        // that renders visible copy. Descend only into those executable/rendered branches:
        // walking the initializer wholesale would turn every structural prop into inventory
        // noise, while returning here would make callback copy disappear silently.
        const walkNonCopyAttribute = (n) => {
          if (
            ts.isArrowFunction(n) ||
            ts.isFunctionExpression(n) ||
            ts.isJsxElement(n) ||
            ts.isJsxSelfClosingElement(n) ||
            ts.isJsxFragment(n)
          ) {
            walk(n);
            return;
          }
          ts.forEachChild(n, walkNonCopyAttribute);
        };
        if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          walkNonCopyAttribute(node.initializer.expression);
        }
        return;
      }
      if (node.initializer) {
        // Covers `title="Copy"` and `title={cond ? 'Hide' : 'Show'}` alike.
        walkRenderedExpression(node.initializer, true, true);
      }
      // Do not fall through: descending again would count every copy attribute twice and
      // make the per-occurrence counts meaningless.
      return;
    }

    if (
      ts.isJsxExpression(node) &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      // A literal in children position — `{count === 1 ? 'note' : 'notes'}` — is rendered
      // exactly like JSX text. Structural knowledge, so no heuristic and no uncertainty.
      //
      // But stop at any nested JSX: `{items.map(x => <div className="p-1">…</div>)}` is
      // also a children expression, and descending into it would hand every className to
      // the certain-copy branch. Hand those back to the normal walk.
      ts.forEachChild(node, (child) => walkRenderedExpression(child, true, true));
      return;
    }

    // Everything else: a literal anywhere in the file, kept unless provably not copy.
    addLiteral(node, (text) => !definitelyNotCopy(text));
    addTemplate(node, (text) => !definitelyNotCopy(text));
    ts.forEachChild(node, walk);
  };
  walk(source);

  // Repeats are emitted as repeats so a change in occurrence count shows in the diff.
  // Plain sort, not localeCompare: collation is locale-dependent, so contributors and CI
  // on different host locales would each see the other's file as stale. Generated output
  // must be byte-identical everywhere.
  const flatten = (bucket) =>
    [...bucket.entries()]
      .flatMap(([text, count]) => Array.from({ length: count }, () => text))
      .sort();

  return { copy: flatten(copy), uncertain: flatten(uncertain) };
}

// Only run as a CLI. Exporting `collectFromSource` lets the tests drive the real
// extraction over a fixture file instead of asserting on the generated output.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const englishCatalogue = JSON.parse(fs.readFileSync(ENGLISH_CATALOGUE, 'utf8'));
  const inventory = {};
  for (const file of sourceFiles(SRC_DIR).sort()) {
    const { copy, uncertain } = collectFromSource(file, englishCatalogue);
    if (copy.length === 0 && uncertain.length === 0) continue;
    const entry = {};
    if (copy.length) entry.copy = copy;
    if (uncertain.length) entry.uncertain = uncertain;
    inventory[toPosixPath(path.relative(APP_DIR, file))] = entry;
  }

  const count = (key) =>
    Object.values(inventory).reduce((sum, entry) => sum + (entry[key]?.length ?? 0), 0);
  const copyTotal = count('copy');
  const uncertainTotal = count('uncertain');
  const total = copyTotal + uncertainTotal;
  const rendered =
    JSON.stringify(
      {
        // Read by humans in review; regenerate rather than hand-edit.
        _comment:
          'Generated by app/scripts/i18n-copy-inventory.mjs. In an i18n migration diff, strings must MOVE, never CHANGE. ' +
          '"copy" is the contract; "uncertain" is the recall safety net and may hold technical strings.',
        total,
        copyTotal,
        uncertainTotal,
        files: inventory,
      },
      null,
      2
    ) + '\n';

  if (update) {
    fs.mkdirSync(path.dirname(INVENTORY), { recursive: true });
    fs.writeFileSync(INVENTORY, rendered);
    console.log(
      `i18n inventory: written — ${copyTotal} copy + ${uncertainTotal} uncertain across ${Object.keys(inventory).length} file(s).`
    );
    process.exit(0);
  }

  if (!fs.existsSync(INVENTORY)) {
    console.error('i18n inventory: missing. Run: npm run i18n:inventory:update');
    process.exit(1);
  }
  if (fs.readFileSync(INVENTORY, 'utf8') !== rendered) {
    console.error('\ni18n inventory: stale — the renderer\'s English copy changed.\n');
    console.error('  npm run i18n:inventory:update\n');
    console.error('Then check the diff: a wording change should be intentional and reviewed.');
    console.error('During the i18n migration it must show strings moving, never changing.\n');
    process.exit(1);
  }
  console.log(
    `i18n inventory: up to date — ${copyTotal} copy + ${uncertainTotal} uncertain across ${Object.keys(inventory).length} file(s).`
  );

}
