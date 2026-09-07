// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // `ingestion/` is a standalone Node project with its own toolchain.
    ignores: ['dist/*', 'ingestion/**'],
  },
]);
