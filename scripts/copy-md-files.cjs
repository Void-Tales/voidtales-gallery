const config = require('../src/config/externaldownload.cjs');
const { syncDir } = require('./lib/listing.cjs');

// The six bundled fallback photos are not on the fileserver and must stay.
const defaults = ['31736163', '44215106', '64517921', '72382172', '96103542', '99323854'];

syncDir({
  label: 'markdown',
  destDir: './src/content/photos/',
  urls: [config.mdSourceUrlInternal, config.mdSourceUrlExternal],
  pattern: /\.md$/,
  keep: defaults.map((id) => `${id}-default.md`),
});
