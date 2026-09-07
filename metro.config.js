// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// `ingestion/` is a standalone Node project — never bundled into or resolved
// by the app. Keep Metro's resolver out of it.
const ingestion = /[/\\]ingestion[/\\].*/;
config.resolver.blockList = config.resolver.blockList
  ? [].concat(config.resolver.blockList, ingestion)
  : [ingestion];

module.exports = config;
