'use strict';
/*
 * Exercises the image / GIF upload path.
 *
 * The renderer builds the upload argument in UploadDialog.crop():
 *   { id, path, x, y, width, height, model, rotate }   + serialNumber
 * with the cropper locked to 4/3 landscape or 3/4 portrait for 'mystique'
 * (landscape when options.screenRotate is 1 or 3).
 *
 * The upload path runs through native modules that are Windows-only and
 * therefore stubbed in this harness, so the point of this driver is as much to
 * find out WHICH of them the upload actually needs as it is to succeed.
 */

const path = require('path');

const SETTLE_MS = Number(process.env.DC_UPLOAD_SETTLE || 1500);
const MEDIA_DIR = process.env.DC_MEDIA_DIR || path.join(__dirname, '..', 'testmedia');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && typeof r === 'object' && 'data' in r ? r.data : r);

module.exports = async function uploadMedia(api) {
  const { invoke, log } = api;

  const list = unwrap(await invoke('app/get-device-list')) || [];
  const device = (Array.isArray(list) ? list : []).find(
    (d) => d && String(d.productName || '').toUpperCase().includes('MYSTIQUE')
  );
  if (!device) { log('upload.abort', { reason: 'no MYSTIQUE in device list' }); return; }
  const serialNumber = device.serialNumber;

  const before = unwrap(await invoke('sys/get-resources', serialNumber));
  log('upload.resources.before', { before });

  const jpg = path.join(MEDIA_DIR, 'test.jpg');
  const gif = path.join(MEDIA_DIR, 'test.gif');

  // Landscape crop covering the whole 640x480 test image, matching the 4/3
  // aspect the cropper enforces for this model.
  const attempts = [
    { name: 'jpeg-full', params: { path: jpg, x: 0, y: 0, width: 640, height: 480, model: 'mystique', rotate: 0, serialNumber } },
    { name: 'jpeg-with-id', params: { id: '', path: jpg, x: 0, y: 0, width: 640, height: 480, model: 'mystique', rotate: 0, serialNumber } },
    { name: 'jpeg-portrait', params: { path: jpg, x: 80, y: 0, width: 360, height: 480, model: 'mystique', rotate: 0, serialNumber } },
    { name: 'gif-full', params: { path: gif, x: 0, y: 0, width: 640, height: 480, model: 'mystique', rotate: 0, serialNumber } },
  ];

  for (const attempt of attempts) {
    log('upload.attempt', { name: attempt.name, params: attempt.params });
    await invoke('mystique/upload-image', attempt.params);
    await sleep(SETTLE_MS);
    const res = unwrap(await invoke('sys/get-resources', serialNumber));
    log('upload.resources.after', {
      name: attempt.name,
      jpg: (res && res.jpg && res.jpg.length) || 0,
      gif: (res && res.gif && res.gif.length) || 0,
      res
    });
  }

  // If anything landed, select it for display -- that is the step that makes
  // the device actually show the picture.
  const after = unwrap(await invoke('sys/get-resources', serialNumber));
  const jpgList = (after && after.jpg) || [];
  const gifList = (after && after.gif) || [];
  if (jpgList.length) {
    log('upload.select', { type: 0, index: 0, file: jpgList[0] });
    await invoke('mystique/update-motion-mode-screen', {
      serialNumber,
      motionModeScreen: { index: 0, type: 0 }
    });
    await sleep(SETTLE_MS);
  }
  if (gifList.length) {
    log('upload.select', { type: 1, index: 0, file: gifList[0] });
    await invoke('mystique/update-motion-mode-screen', {
      serialNumber,
      motionModeScreen: { index: 0, type: 1 }
    });
    await sleep(SETTLE_MS);
  }

  log('upload.done', { jpg: jpgList.length, gif: gifList.length });
};
