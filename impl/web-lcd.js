'use strict';
/*
 * Renders an arbitrary webpage and pushes it to the MYSTIQUE panel as a
 * still image, refreshed on an interval -- the panel has no browser of its
 * own, so "showing a website" means periodically screenshotting the page
 * and uploading it through the exact same IPC channels the app's own crop
 * dialog uses (mystique/upload-image, mystique/update-motion-mode-screen),
 * invoked directly the way DC_DRIVER already does (see usb-shim.js's IPC
 * driver section) rather than through a real renderer click.
 *
 * A tiny loopback-only HTTP server is the control surface, so the injected
 * overlay (see webLcdOverlayScript() below) can drive it with a plain
 * fetch() call regardless of the app window's own node-integration
 * settings. Nothing here touches DeepCool's own renderer code.
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.DC_WEB_LCD_PORT) || 47474;
const LOAD_TIMEOUT_MS = Number(process.env.DC_WEB_LCD_LOAD_TIMEOUT_MS) || 15000;
const SETTLE_MS = Number(process.env.DC_WEB_LCD_SETTLE_MS) || 1200;
const MIN_INTERVAL_S = 5;

function makeInvoke(ipcMain) {
  return function invoke(channel, ...args) {
    const fn = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get(channel);
    if (!fn) return Promise.reject(new Error(`no ipcMain.handle registered for ${channel}`));
    return new Promise((resolve, reject) => {
      const event = {
        processId: 1,
        frameId: 1,
        senderFrame: { url: 'app://web-lcd', routingId: 1, send() {} },
        sender: {
          id: 1,
          send() {},
          isDestroyed() { return false; },
          getURL() { return 'app://web-lcd'; },
          session: {}
        },
        _reply: (v) => resolve(v),
        _throw: (e) => reject(e)
      };
      Promise.resolve().then(() => fn(event, ...args)).catch(reject);
    });
  };
}

function unwrap(r) { return (r && typeof r === 'object' && 'data' in r) ? r.data : r; }

function install(log) {
  let electron;
  try { electron = require('electron'); } catch (e) { log('web-lcd.no-electron', { error: String(e) }); return; }
  const { app, BrowserWindow, ipcMain } = electron;
  const invoke = makeInvoke(ipcMain);

  let win = null;
  let timer = null;
  let lastUploadedId = null;
  const state = { url: null, intervalSeconds: null, running: false, lastSuccessAt: null, lastError: null, cycles: 0 };

  function getWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: 480,
      height: 640,
      useContentSize: true,
      show: false,
      frame: false,
      webPreferences: { sandbox: true, offscreen: false }
    });
    /* The overlay-injector in usb-shim.js listens for every window's
     * did-finish-load to add the URL-input widget -- without this flag it
     * would also fire for whatever page THIS window loads (the site being
     * captured), overlaying our own controls onto the screenshot that goes
     * to the panel. */
    win.webContents.__dcWebLcdCapture = true;
    return win;
  }

  async function findSerialNumber() {
    const list = unwrap(await invoke('app/get-device-list')) || [];
    const device = (Array.isArray(list) ? list : []).find(
      (d) => d && String(d.productName || '').toUpperCase().includes('MYSTIQUE')
    );
    if (!device) throw new Error('no MYSTIQUE in device list');
    return device.serialNumber;
  }

  async function captureUrl(url) {
    const w = getWindow();
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timeoutHandle);
        err ? reject(err) : resolve();
      };
      const timeoutHandle = setTimeout(() => finish(new Error(`timed out loading ${url}`)), LOAD_TIMEOUT_MS);
      w.webContents.once('did-finish-load', () => finish());
      w.webContents.once('did-fail-load', (_e, code, desc) => finish(new Error(`did-fail-load ${code} ${desc}`)));
      try { w.loadURL(url).catch(finish); } catch (e) { finish(e); }
    });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const image = await w.webContents.capturePage();
    return image.toJPEG(88);
  }

  async function runCycle() {
    if (!state.url) return;
    const jpegBuf = await captureUrl(state.url);
    const serialNumber = await findSerialNumber();

    const tmpFile = path.join(os.tmpdir(), `mystique-web-lcd-${process.pid}.jpg`);
    fs.writeFileSync(tmpFile, jpegBuf);

    const before = unwrap(await invoke('sys/get-resources', serialNumber)) || {};
    const beforeJpg = (before.jpg) || [];
    const beforeIds = new Set(beforeJpg.map((e) => e && (e.id ?? e.name ?? e.path ?? JSON.stringify(e))));

    const uploadResult = await invoke('mystique/upload-image', {
      id: '', path: tmpFile, x: 0, y: 0, width: 480, height: 640, model: 'mystique', rotate: 0, serialNumber
    });

    const after = unwrap(await invoke('sys/get-resources', serialNumber)) || {};
    const afterJpg = (after.jpg) || [];
    if (process.env.DC_WEB_LCD_DEBUG === '1') {
      log('web-lcd.debug', {
        jpegBytes: jpegBuf.length,
        uploadResult: (() => { try { return JSON.stringify(uploadResult); } catch (e) { return String(uploadResult); } })(),
        beforeIds: [...beforeIds],
        afterIds: afterJpg.map((e) => e && (e.id ?? e.name ?? e.path))
      });
    }
    const fresh = afterJpg.find((e) => e && !beforeIds.has(e.id ?? e.name ?? e.path ?? JSON.stringify(e)));
    const newEntry = fresh || afterJpg[afterJpg.length - 1];
    if (!newEntry) throw new Error('upload did not add a jpg resource');
    const newId = newEntry.id ?? newEntry.name ?? newEntry.path;
    const newIndex = afterJpg.indexOf(newEntry);

    await invoke('mystique/update-motion-mode-screen', {
      serialNumber,
      motionModeScreen: { index: newIndex, type: 0 }
    });

    if (lastUploadedId !== null && lastUploadedId !== newId) {
      try {
        /* mystique_api.txt shows this (and upload-image, update-motion-mode-
         * screen) written as ipcInstance.send(...) in the renderer source,
         * which reads like fire-and-forget ipcRenderer.send -- but it is
         * actually registered as an ipcMain.handle() channel like the rest
         * of the mystique/* API, same as upload-image/update-motion-mode-
         * screen above, which is why invoke() (the _invokeHandlers lookup)
         * is used here instead of ipcMain.emit(): emit() only reaches
         * ipcMain.on()/.once() listeners, and this channel isn't one --
         * confirmed live, emit() silently removed nothing. */
        await invoke('mystique/remove-image', serialNumber, lastUploadedId);
        const check = unwrap(await invoke('sys/get-resources', serialNumber)) || {};
        log('web-lcd.cleanup', {
          removedId: lastUploadedId,
          jpgCountBefore: afterJpg.length,
          jpgCountAfter: ((check.jpg) || []).length,
          stillPresent: ((check.jpg) || []).some((e) => (e && (e.id ?? e.name ?? e.path)) === lastUploadedId)
        });
      } catch (e) { log('web-lcd.cleanup-failed', { id: lastUploadedId, error: String(e) }); }
    }
    lastUploadedId = newId;

    try { fs.unlinkSync(tmpFile); } catch (e) { /* best-effort */ }

    state.lastSuccessAt = Date.now();
    state.cycles += 1;
    state.jpgCount = afterJpg.length;
    log('web-lcd.cycle', { url: state.url, index: newIndex, id: newId, cycles: state.cycles, jpgCount: afterJpg.length });
  }

  async function ensureMediaMode() {
    const serialNumber = await findSerialNumber();
    const current = unwrap(await invoke('mystique/get-device-info', serialNumber));
    if (current && current.mode === 2) return;
    await invoke('mystique/update-device-info', { serialNumber, mode: 2 });
  }

  function scheduleLoop() {
    if (timer) clearInterval(timer);
    const ms = Math.max(MIN_INTERVAL_S, state.intervalSeconds || MIN_INTERVAL_S) * 1000;
    const tick = () => {
      runCycle().catch((err) => {
        state.lastError = String((err && err.message) || err);
        log('web-lcd.cycle-failed', { url: state.url, error: state.lastError });
      });
    };
    tick();
    timer = setInterval(tick, ms);
  }

  async function start(url, intervalSeconds) {
    state.url = url;
    state.intervalSeconds = Math.max(MIN_INTERVAL_S, Number(intervalSeconds) || 15);
    state.running = true;
    state.lastError = null;
    await ensureMediaMode();
    scheduleLoop();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    state.running = false;
    state.url = null;
  }

  const server = http.createServer((req, res) => {
    const respond = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/status') {
      return respond(200, state);
    }
    if (req.method === 'POST' && req.url === '/stop') {
      stop();
      return respond(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/set') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch (e) { return respond(400, { ok: false, error: 'bad json' }); }
        let url;
        try {
          const parsedUrl = new URL(parsed.url);
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return respond(400, { ok: false, error: 'only http:// and https:// URLs are allowed' });
          }
          url = parsedUrl.toString();
        } catch (e) { return respond(400, { ok: false, error: 'bad url' }); }
        start(url, parsed.intervalSeconds)
          .then(() => respond(200, { ok: true, state }))
          .catch((err) => respond(500, { ok: false, error: String((err && err.message) || err) }));
      });
      return;
    }
    respond(404, { ok: false, error: 'not found' });
  });

  server.on('error', (err) => log('web-lcd.server-error', { error: String(err) }));
  server.listen(PORT, '127.0.0.1', () => log('web-lcd.listening', { port: PORT }));

  app.on('before-quit', () => { try { server.close(); } catch (e) { /* ignore */ } });
}

module.exports = { install, PORT };
