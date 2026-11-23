const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readRecipes, saveRecipe, deleteRecipe } = require('./recipes-store');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-')), 'recipes.json');

test('a missing or corrupt file reads as no recipes', () => {
  const file = tmp();
  assert.deepEqual(readRecipes(file), []);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readRecipes(file), []);
});

test('recipes are created, updated and deleted on disk', () => {
  const file = tmp();
  const made = saveRecipe(file, { name: ' Standup digest ', prompt: 'Summarise standups.', description: 'Daily' }, 1);
  assert.match(made.id, /^r_[a-f0-9]{12}$/);
  assert.equal(made.name, 'Standup digest');
  const updated = saveRecipe(file, { id: made.id, name: 'Standups', prompt: 'New prompt' }, 2);
  assert.equal(updated.updatedAt, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).recipes, [updated]);
  assert.deepEqual(deleteRecipe(file, made.id), { deleted: true });
  assert.deepEqual(readRecipes(file), []);
});

test('bad input is refused', () => {
  const file = tmp();
  assert.throws(() => saveRecipe(file, { name: '', prompt: 'x' }), /name/);
  assert.throws(() => saveRecipe(file, { name: 'x', prompt: '' }), /prompt/);
  assert.throws(() => saveRecipe(file, { name: 'x'.repeat(61), prompt: 'x' }), /name/);
  assert.throws(() => saveRecipe(file, { id: '../x', name: 'x', prompt: 'x' }), /id/);
  assert.throws(() => saveRecipe(file, { id: 'r_000000000000', name: 'x', prompt: 'x' }), /not found/);
  assert.throws(() => deleteRecipe(file, 'nope'), /id/);
});
