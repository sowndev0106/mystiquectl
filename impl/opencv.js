'use strict';
/*
 * Linux stand-in for DeepCool's resources/opencv/pixel.node.
 *
 * The upload path calls into that Windows addon to convert, crop, rotate and
 * resize images, and to explode GIFs into JPEG frames. The signatures below were
 * recovered by watching what the app passed to the recording stub:
 *
 *   checkImageType(sourcePath, expectedType)            -> truthy when it matches
 *   convertImgToJpeg({sourcePath, targetPath})          -> plain transcode
 *   convertImgToJpeg({sourcePath, targetPath, roiOption:{x,y,width,height,beforeRotate},
 *                     rotate, resizeOption:{width,height}})
 *   getGifImageData(sourcePath)                         -> {frameCount, duration, inputFps}
 *   convertGifToJpeg({sourcePath, targetPath, filePrefix, roiOption, rotate, resizeOption})
 *
 * A rotate/beforeRotate of -1 means "none" — that is what the app sends when the
 * cropper was never rotated.
 *
 * Everything is synchronous, matching a native addon: the app sometimes awaits
 * the result and sometimes uses it directly, and a plain value is correct for
 * both.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAGICK = process.env.DC_MAGICK || 'convert';

/* The app builds Windows-style paths. The shim normalises them for everything
 * that goes through Node's fs, but ImageMagick is a child process and never
 * sees that, so the same normalisation has to happen here or the app and this
 * module end up writing and reading two different files. */
function norm(p) {
  if (typeof p !== 'string') return p;
  if (process.platform === 'win32' || process.env.DC_WINPATH === '0') return p;
  return p.includes('\\') ? p.replace(/\\+/g, '/') : p;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function noRotation(v) {
  return v === undefined || v === null || v === -1;
}

/** Build the ImageMagick argument list shared by the still and GIF paths. */
function geometryArgs(roiOption, rotate, resizeOption) {
  /* Without this, IM crops the raw pixel grid as the file stores it, not as
   * anything displaying the image (a browser, Cropper.js, an OS viewer)
   * shows it -- all of which apply EXIF orientation by default. A portrait
   * phone photo (e.g. 4032x3024 stored, Orientation=6, so shown as
   * 3024x4032) gets ROI coordinates measured against the shown 3024x4032
   * frame applied to the un-rotated 4032x3024 raster instead: a crop that
   * looked right in the UI lands on the wrong region, or misses the image
   * bounds entirely (see the geometry-does-not-contain-image check in run()
   * above, which this makes far less likely to fire from EXIF alone).
   * -auto-orient first also physically rotates the pixels, so any -rotate
   * that follows for screenRotate is relative to the now-upright image, not
   * to the sensor's native orientation. */
  const args = ['-auto-orient'];
  if (!noRotation(roiOption && roiOption.beforeRotate)) {
    args.push('-rotate', String(roiOption.beforeRotate));
  }
  if (roiOption && roiOption.width && roiOption.height) {
    args.push('-crop',
      `${roiOption.width}x${roiOption.height}+${roiOption.x || 0}+${roiOption.y || 0}`,
      '+repage');
  }
  if (!noRotation(rotate)) {
    args.push('-rotate', String(rotate));
  }
  if (resizeOption && resizeOption.width && resizeOption.height) {
    // '!' forces the exact panel geometry rather than preserving aspect.
    args.push('-resize', `${resizeOption.width}x${resizeOption.height}!`);
  }
  return args;
}

function run(args) {
  /* execFileSync only surfaces stderr when the process fails -- its return
   * value on success is stdout (or null, here, since stdout is ignored), so
   * a warning printed on a *successful* run was invisible no matter what
   * stdio said. spawnSync always hands back { status, stderr }, on every
   * exit code, which is the only way to catch the case below. */
  const r = spawnSync(MAGICK, args, { timeout: 60000 });
  if (r.error) throw r.error;
  const stderr = r.stderr ? r.stderr.toString('utf8') : '';
  if (r.status !== 0) {
    const err = new Error(`${MAGICK} exited ${r.status}` + (stderr ? ': ' + stderr.trim() : ''));
    err.stderr = stderr;
    throw err;
  }
  /* A crop region outside the image bounds is not a failure ImageMagick
   * reports through its exit code: it warns on stderr and still exits 0,
   * having produced a degenerate 1x1 image -- confirmed with `convert
   * <img> -crop 50x50+200+200 +repage out.jpg` on a 100x100 source, which
   * exits 0 and writes a 1x1 JPEG. The caller's fs.existsSync(targetPath)
   * then reports success, and whatever -resize step follows stretches that
   * one pixel into a solid-colour panel with nothing anywhere to say why.
   * The wording below is IM6's own ("warning/transform.c/CropImage"). */
  if (/geometry does not contain image/i.test(stderr)) {
    throw new Error('crop region is outside the source image: ' + stderr.trim());
  }
}

/* Returns the image's TYPE CODE, not a boolean: the caller compares the result
 * against the type it expected (0 = still, 1 = animated), so answering `true`
 * makes every check fail. */
function checkImageType(sourcePath, expectedType) {
  sourcePath = norm(sourcePath);
  if (!fs.existsSync(sourcePath)) return -1;
  let format = '';
  try {
    format = String(execFileSync('identify', ['-format', '%m', sourcePath + '[0]'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })).trim().toUpperCase();
  } catch (e) {
    return -1;
  }
  const type = format === 'GIF' ? 1 : 0;
  return process.env.DC_IMAGETYPE_ECHO === '1' ? expectedType : type;
}

function convertImgToJpeg(opts) {
  const { roiOption, rotate, resizeOption } = opts || {};
  const sourcePath = norm(opts && opts.sourcePath);
  const targetPath = norm(opts && opts.targetPath);
  if (!sourcePath || !targetPath) return false;
  ensureDir(path.dirname(targetPath));
  run([sourcePath + '[0]', ...geometryArgs(roiOption, rotate, resizeOption),
    '-quality', '92', targetPath]);
  return fs.existsSync(targetPath);
}

function convertGifFirstFrameToJpeg(opts) {
  return convertImgToJpeg(opts);
}

function getGifImageData(sourcePath) {
  sourcePath = norm(sourcePath);
  let frameCount = 1;
  let delaysCs = [];
  try {
    const out = String(execFileSync('identify', ['-format', '%T\n', sourcePath],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
    delaysCs = out.split('\n').map((x) => x.trim()).filter(Boolean).map(Number);
    frameCount = delaysCs.length || 1;
  } catch (e) {
    frameCount = 1;
  }
  // ImageMagick reports delay in hundredths of a second; 0 means "as fast as
  // possible", which viewers treat as 10cs.
  const totalCs = delaysCs.reduce((a, b) => a + (b > 0 ? b : 10), 0) || 10;
  const duration = totalCs * 10; // milliseconds
  const inputFps = duration > 0 ? Math.round((frameCount * 1000) / duration) : 10;
  return { frameCount, duration, inputFps: inputFps || 10 };
}

function convertGifToJpeg(opts) {
  const { filePrefix, roiOption, rotate, resizeOption } = opts || {};
  const sourcePath = norm(opts && opts.sourcePath);
  const targetPath = norm(opts && opts.targetPath);
  if (!sourcePath || !targetPath) return false;
  ensureDir(targetPath);
  const prefix = filePrefix || 'frame_';
  run([sourcePath, '-coalesce', ...geometryArgs(roiOption, rotate, resizeOption),
    '-quality', '92', path.join(targetPath, `${prefix}%d.jpg`)]);
  const written = fs.readdirSync(targetPath).filter((f) => f.startsWith(prefix));
  return written.length;
}

module.exports = {
  checkImageType,
  convertImgToJpeg,
  convertGifFirstFrameToJpeg,
  convertGifToJpeg,
  getGifImageData,
};
