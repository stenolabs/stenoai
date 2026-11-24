const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CONFIG_FLAG_DEFAULTS,
  CONFIG_VALUE_DEFAULTS,
  flagFromConfig,
  readConfigFile,
  readConfigFlag,
} = require('./config-flags');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-flags-'));
let n = 0;
function configWith(contents) {
  const p = path.join(dir, `config-${n++}.json`);
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
}

test('readConfigFile returns null for a missing, broken or non-object file', () => {
  assert.equal(readConfigFile(configWith(undefined)), null);
  assert.equal(readConfigFile(configWith('not json')), null);
  assert.equal(readConfigFile(configWith('null')), null);
  assert.equal(readConfigFile(configWith('[1]')), null);
  assert.deepEqual(readConfigFile(configWith('{"a": 1}')), { a: 1 });
});

test('default-on flags are off only for a literal false', () => {
  for (const [key, def] of Object.entries(CONFIG_FLAG_DEFAULTS)) {
    if (!def) continue;
    assert.equal(readConfigFlag(configWith(undefined), key), true, key);
    assert.equal(readConfigFlag(configWith('{}'), key), true, key);
    assert.equal(readConfigFlag(configWith('broken'), key), true, key);
    assert.equal(readConfigFlag(configWith(JSON.stringify({ [key]: 'false' })), key), true, key);
    assert.equal(readConfigFlag(configWith(JSON.stringify({ [key]: false })), key), false, key);
  }
});

test('default-off flags are on only for a literal true', () => {
  for (const [key, def] of Object.entries(CONFIG_FLAG_DEFAULTS)) {
    if (def) continue;
    assert.equal(readConfigFlag(configWith(undefined), key), false, key);
    assert.equal(readConfigFlag(configWith('{}'), key), false, key);
    assert.equal(readConfigFlag(configWith(JSON.stringify({ [key]: 'true' })), key), false, key);
    assert.equal(readConfigFlag(configWith(JSON.stringify({ [key]: true })), key), true, key);
  }
});

test('an unknown flag is a programming error', () => {
  assert.throws(() => flagFromConfig({}, 'not_a_flag'), /Unknown config flag/);
});

// The Python config owns these defaults; this keeps the JS mirror honest.
test('defaults match src/config.py', () => {
  const py = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.py'), 'utf-8');
  for (const [key, def] of Object.entries(CONFIG_FLAG_DEFAULTS)) {
    const inDefaults = py.match(new RegExp(`"${key}":\\s*(True|False)`));
    if (inDefaults) {
      assert.equal(inDefaults[1] === 'True', def, `${key} default in _get_default_config`);
      continue;
    }
    // Not in the default dict: the accessor must be opt-in (`is True`).
    assert.equal(def, false, key);
    assert.match(py, new RegExp(`get\\("${key}"\\)\\s+is True`), key);
  }
});

test('value defaults match src/config.py', () => {
  const py = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.py'), 'utf-8');
  const pyLiteral = (v) => (v === null ? 'None' : JSON.stringify(v));
  for (const [key, def] of Object.entries(CONFIG_VALUE_DEFAULTS)) {
    const m = py.match(new RegExp(`"${key}":\\s*([^,\\n]+),`));
    assert.ok(m, `${key} missing from _get_default_config`);
    assert.equal(m[1].trim(), pyLiteral(def), key);
  }
});
