'use strict';

const { readRecipes, saveRecipe, deleteRecipe } = require('./recipes-store');

/** recipes-list / recipes-save / recipes-delete, for the Cookbooks page and chat. */
function registerRecipesIpc({ ipcMain, recipesPath }) {
  const fail = (e) => ({ success: false, error: e?.message || 'Failed' });
  ipcMain.handle('recipes-list', async () => ({ success: true, recipes: readRecipes(recipesPath()) }));
  ipcMain.handle('recipes-save', async (_event, input) => {
    try {
      return { success: true, recipe: saveRecipe(recipesPath(), input) };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('recipes-delete', async (_event, id) => {
    try {
      return { success: true, ...deleteRecipe(recipesPath(), id) };
    } catch (e) {
      return fail(e);
    }
  });
}

module.exports = { registerRecipesIpc };
