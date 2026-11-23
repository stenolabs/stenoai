// Recipes: saved prompts the user runs in chat (the `/` menu) and manages on
// the Cookbooks page. The built-ins live in the renderer (translated copy);
// this file stores only the user's own, in <userData>/recipes.json.
const fs = require('fs');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('./atomic-write');

const MAX_RECIPES = 100;
const LIMITS = { name: 60, description: 160, prompt: 4000 };
const ID = /^r_[a-f0-9]{12}$/;

function readRecipes(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return [];
  }
  const list = Array.isArray(raw?.recipes) ? raw.recipes : [];
  return list.filter((r) => r && ID.test(r.id) && typeof r.name === 'string' && typeof r.prompt === 'string')
    .slice(0, MAX_RECIPES)
    .map((r) => ({
      id: r.id,
      name: r.name.slice(0, LIMITS.name),
      description: typeof r.description === 'string' ? r.description.slice(0, LIMITS.description) : '',
      prompt: r.prompt.slice(0, LIMITS.prompt),
      updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
    }));
}

function write(file, recipes) {
  writeFileAtomicSync(file, JSON.stringify({ version: 1, recipes }, null, 2));
}

/** Create (no id) or update a recipe. Returns the saved recipe; throws on bad input. */
function saveRecipe(file, input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw new Error('Invalid recipe');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!name || name.length > LIMITS.name) throw new Error('Invalid name');
  if (!prompt || prompt.length > LIMITS.prompt) throw new Error('Invalid prompt');
  if (description.length > LIMITS.description) throw new Error('Invalid description');
  const recipes = readRecipes(file);
  let recipe;
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !ID.test(input.id)) throw new Error('Invalid id');
    const idx = recipes.findIndex((r) => r.id === input.id);
    if (idx === -1) throw new Error('Recipe not found');
    recipe = { ...recipes[idx], name, description, prompt, updatedAt: now };
    recipes[idx] = recipe;
  } else {
    if (recipes.length >= MAX_RECIPES) throw new Error('Too many recipes');
    recipe = { id: `r_${crypto.randomBytes(6).toString('hex')}`, name, description, prompt, updatedAt: now };
    recipes.push(recipe);
  }
  write(file, recipes);
  return recipe;
}

function deleteRecipe(file, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid id');
  const recipes = readRecipes(file);
  const next = recipes.filter((r) => r.id !== id);
  if (next.length !== recipes.length) write(file, next);
  return { deleted: next.length !== recipes.length };
}

module.exports = { MAX_RECIPES, LIMITS, readRecipes, saveRecipe, deleteRecipe };
