const path = require('node:path');

const APPLE_LM_APP = '/Steno Apple LM.app';
const APPLE_LM_ENTITLEMENTS = path.resolve(
  __dirname,
  '..',
  'build',
  'entitlements.apple-lm.plist',
);

function isAppleLMHelper(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  return (
    normalized.endsWith(APPLE_LM_APP) ||
    normalized.includes(`${APPLE_LM_APP}/`)
  );
}

function createOptionsForFile(original) {
  return (filePath) => {
    const options = original(filePath);
    if (!isAppleLMHelper(filePath)) return options;
    return {
      ...options,
      entitlements: APPLE_LM_ENTITLEMENTS,
      hardenedRuntime: true,
    };
  };
}

async function sign(configuration) {
  const { signAsync } = require('@electron/osx-sign');
  return signAsync({
    ...configuration,
    optionsForFile: createOptionsForFile(configuration.optionsForFile),
  });
}

module.exports = sign;
module.exports.createOptionsForFile = createOptionsForFile;
module.exports.isAppleLMHelper = isAppleLMHelper;
