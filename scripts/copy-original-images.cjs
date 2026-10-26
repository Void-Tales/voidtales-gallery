const config = require('../src/config/externaldownload.cjs');
const { syncDir } = require('./lib/listing.cjs');

// The six bundled fallback photos are not on the fileserver and must stay.
const defaults = ['31736163', '44215106', '64517921', '72382172', '96103542', '99323854'];

syncDir({
  label: 'original image',
  destDir: './public/images/original/',
  urls: [config.originalSourceUrlInternal, config.originalSourceUrlExternal],
  pattern: /\.(png|jpe?g|webp|bmp)$/i,
  keep: defaults.map((id) => `${id}-default.webp`),
});
