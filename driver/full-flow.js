'use strict';
/*
 * The whole MYSTIQUE feature set in one run: read state, walk every setting,
 * upload a still image and an animation, then select each for display.
 *
 * This is the driver that demonstrates the app working end to end on Linux.
 * Each step logs a marker, so map.py can attribute the frames it produced.
 */

const sweepSettings = require('./sweep-settings.js');
const uploadMedia = require('./upload-media.js');

module.exports = async function fullFlow(api) {
  const { invoke, log } = api;

  log('flow.start', { channels: api.channels.length });

  for (const channel of ['sys/get-userdata-path', 'app/get-setting', 'app/get-device-list',
    'app/get-fan-interface', 'sys/check-media-components']) {
    await invoke(channel);
  }

  log('flow.phase', { phase: 'settings' });
  await sweepSettings(api);

  log('flow.phase', { phase: 'media' });
  await uploadMedia(api);

  log('flow.done', {});
};
