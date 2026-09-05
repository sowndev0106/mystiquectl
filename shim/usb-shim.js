'use strict';
/*
 * Recording stand-in for the `usb` npm package (node-usb 2.14.0).
 *
 * Injected into DeepCool's app.asar in place of node_modules/usb/dist/index.js.
 * It presents a synthetic DeepCool MYSTIQUE (3633:0009) whose descriptors are
 * copied verbatim from the real device, and writes every call the application
 * makes -- above all every transferOut payload -- to a JSONL log.
 *
 * Purpose: the application's USB protocol lives in compiled V8 bytecode
 * (out/main/index.jsc), where the numeric constants cannot be recovered
 * statically. Letting the app talk to a fake device recovers them from the
 * wire instead. libusb inside Wine sees no devices at all, so nothing real is
 * ever displaced by this.
 *
 * Log: %DC_CAPTURE_DIR% or C:\deepcool-capture\usb.jsonl
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/* ------------------------------------------------------------------ logging */

const DIR = process.env.DC_CAPTURE_DIR
  || (process.platform === 'win32' ? 'C:\\deepcool-capture' : '/tmp/deepcool-capture');
const LOG = path.join(DIR, 'usb.jsonl');
let started = Date.now();
let seq = 0;

try {
  fs.mkdirSync(DIR, { recursive: true });
} catch (e) { /* ignore */ }

function log(event, detail) {
  let line;
  try {
    line = JSON.stringify(Object.assign(
      { n: seq++, t: Date.now() - started, event },
      detail || {}
    ));
  } catch (e) {
    line = JSON.stringify({ n: seq++, t: Date.now() - started, event, logError: String(e) });
  }
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch (e) { /* never let logging break the app */ }
}

function bytes(data) {
  if (data == null) return null;
  let buf;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else if (data && data.buffer instanceof ArrayBuffer) {
    buf = Buffer.from(data.buffer, data.byteOffset || 0, data.byteLength);
  } else if (Array.isArray(data)) buf = Buffer.from(data);
  else return { note: 'unrecognised payload', type: typeof data };
  return { len: buf.length, hex: buf.toString('hex') };
}

log('shim-loaded', { pid: process.pid, node: process.version, log: LOG });

/* ------------------------------------------------- custom sensor-slot value */
/* Command 0x01 (sensor push) is 13 slots of {uint16LE value, uint8 fraction}
 * starting at payload offset 0 (frame byte 3) -- see COMMANDS.md. Slot 2
 * (frame bytes 9-11) is what interface B's Auxiliary Display Area "System
 * Monitor" mode shows as its memory-percentage value. Overwriting just this
 * one slot, on the way out and after everything else (impl/sensors.js, the
 * Dashboard, Computer Configuration) has already used the real value, lets
 * one System Monitor number show something else entirely -- e.g. a manually
 * updated Claude Code usage percentage -- without touching genuine sensor
 * data anywhere else. DC_CLAUDE_USAGE_PATH overrides the default file path;
 * the file is re-read on every push (once a second) so editing it takes
 * effect immediately, no restart needed. */
const CLAUDE_USAGE_PATH = process.env.DC_CLAUDE_USAGE_PATH
  || path.join(require('os').homedir(), '.config', 'mystiquectl', 'claude-usage.json');

function applyCustomSlotOverride(raw) {
  if (!raw || raw.length < 45 || raw[2] !== 0x01) return false;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CLAUDE_USAGE_PATH, 'utf8')); } catch (e) { return false; }
  if (!cfg || !Number.isFinite(cfg.percent)) return false;
  const slot = Number.isInteger(cfg.slot) ? cfg.slot : 2;
  const off = 3 + slot * 3;
  if (slot < 0 || slot > 12 || off + 3 > raw.length - 8) return false;
  const pct = Math.max(0, Math.min(100, Math.round(cfg.percent)));
  raw.writeUInt16LE(pct, off);
  raw.writeUInt8(0, off + 2);
  /* The frame's own checksum is now stale for the bytes actually being
   * sent -- recompute it the same way impl/usb-bridge.py's repair_checksum
   * already does for the app's own broken sensor-push checksum, so this
   * works whether or not DC_REAL_USB is also fixing that separately. */
  let sum = 0;
  for (let i = 0; i < raw.length - 2; i++) sum += raw[i];
  raw.writeUInt16LE(sum & 0xFFFF, raw.length - 2);
  return true;
}

/* --------------------------------------------------- Windows path shim */
/* The app builds paths with backslashes ("~/.config/DeepCool\\Pictures\\...").
 * On Windows those are separators; on Linux they are ordinary filename
 * characters, so every read and write lands in the wrong place. Normalising
 * them at the fs layer makes the app's own path handling work unchanged. */
if (process.platform !== 'win32' && process.env.DC_WINPATH !== '0' && !global.__dcWinPath) {
  global.__dcWinPath = true;
  const realFs = require('fs');

  const rawMkdir = realFs.mkdirSync;
  const WRITE_OPS = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'open', 'openSync', 'createWriteStream', 'copyFile', 'copyFileSync',
    'rename', 'renameSync', 'outputFile', 'outputFileSync',
    'writeJson', 'writeJsonSync', 'outputJson', 'outputJsonSync']);

  const TRACE_WRITE = process.env.DC_TRACE_WRITE || '';
  const TRACE_PATH = process.env.DC_TRACE_PATH || '';
  const MUTATORS = new Set([...WRITE_OPS, 'mkdir', 'mkdirSync', 'rm', 'rmSync',
    'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'ensureDir', 'ensureDirSync',
    'move', 'moveSync', 'copy', 'copySync', 'remove', 'removeSync']);

  const fixOne = (v) => {
    if (typeof v === 'string' && v.includes('\\') && (v.startsWith('/') || /^[A-Za-z]:/.test(v))) {
      return v.replace(/\\+/g, '/');
    }
    return v;
  };
  const wrap = (obj, names) => {
    for (const name of names) {
      const orig = obj[name];
      if (typeof orig !== 'function') continue;
      obj[name] = function (...args) {
        const before = args[0];
        if (args.length) args[0] = fixOne(args[0]);
        /* On Windows "DeepCool\\Pictures\\<sn>\\jpg" is one mkdir of one
         * directory. Rewritten, it is four nested directories, and the app's
         * plain mkdir fails with ENOENT on the first one whose parent it never
         * had to create. Recursive is the faithful translation. */
        if (args[0] !== before && /^(mkdir|mkdirSync|ensureDir|ensureDirSync)$/.test(name)) {
          if (typeof args[1] === 'function' || args.length < 2) {
            args.splice(1, 0, { recursive: true });
          } else if (args[1] && typeof args[1] === 'object') {
            args[1] = { ...args[1], recursive: true };
          }
        }
        /* Normalise the second path (rename/copyFile/link's destination)
         * before deciding what needs a parent directory below -- it used to
         * happen after, so the mkdir block below only ever saw args[0] (the
         * source, for these ops), and the destination's parent was never
         * ensured even though the destination itself was being rewritten
         * into a different, possibly-not-yet-existing tree. */
        const beforeSecond = args[1];
        if (args.length > 1 && (name === 'rename' || name === 'renameSync'
            || name === 'copyFile' || name === 'copyFileSync'
            || name === 'link' || name === 'linkSync'
            || name === 'symlink' || name === 'symlinkSync')) {
          args[1] = fixOne(args[1]);
        }
        /* Directory creation and file writing do not both reach this wrapper:
         * the app makes directories through a path we never see, then writes
         * through one we normalise, so the write lands in a directory that was
         * never created ("Save Image Failed: ENOENT ... metadata.json").
         * Creating the parent on the write side makes the two agree. */
        if (WRITE_OPS.has(name) && typeof args[0] === 'string') {
          const flags = name === 'open' || name === 'openSync'
            ? (typeof args[1] === 'string' ? args[1] : 'r') : 'w';
          if (/[wa+]/.test(flags)) {
            /* Ensure a parent only for a path this wrapper actually
             * rewrote -- comparing the computed parent (`dir`) against the
             * pre-rewrite *full path* (`before`) can never be equal (one is
             * always shorter than the other), which made this run
             * unconditionally on every write, rewritten or not: one
             * capture of 58,533 events made roughly that many redundant
             * recursive-mkdir syscalls, including two on every single log
             * line this wrapper itself writes. */
            const ensure = (path, wasBefore) => {
              if (typeof path !== 'string' || path === wasBefore) return;
              const dir = path.slice(0, path.lastIndexOf('/'));
              if (!dir) return;
              try { rawMkdir(dir, { recursive: true }); } catch (e) { /* already there */ }
            };
            ensure(args[0], before);
            // The two-path ops' destination parent was never created at
            // all: the source (args[0]) necessarily already exists (you
            // cannot copy/rename from a path that isn't there), so the
            // block above's source-side check was a no-op for them, and
            // nothing ensured the destination's directory.
            if (args.length > 1 && typeof args[1] === 'string' && args[1] !== args[0]) {
              ensure(args[1], beforeSecond);
            }
          }
        }
        /* DC_TRACE_PATH=<substring>: any fs call at all whose path matches,
         * across fs, graceful-fs and fs-extra, with its call site. Narrower
         * than DC_TRACE_FS and it sees the fs-extra helpers too. */
        if (TRACE_PATH && typeof args[0] === 'string' && args[0].includes(TRACE_PATH)) {
          log('fs.path', {
            fn: name,
            path: args[0],
            at: (new Error().stack || '').split('\n').slice(2, 4).join(' | ')
          });
        }
        /* DC_TRACE_WRITE=<substring>: every write-side call touching a path
         * that contains the substring, with its call site. Directories that
         * appear on disk with a backslash in the name were made by a call that
         * never reached this wrapper, and comparing the two is what tells them
         * apart. */
        if (TRACE_WRITE && MUTATORS.has(name) && typeof args[0] === 'string'
            && args[0].includes(TRACE_WRITE)) {
          const site = (new Error().stack || '').split('\n').slice(2, 4).join(' | ');
          const rec = { fn: name, path: args[0], to: typeof args[1] === 'string' ? args[1] : undefined, at: site };
          try {
            const out = orig.apply(this, args);
            log('fs.write', { ...rec, ok: true });
            return out;
          } catch (err) {
            log('fs.write', { ...rec, ok: false, error: String(err && err.code) });
            throw err;
          }
        }
        return orig.apply(this, args);
      };
    }
  };
  /* DC_TRACE_FS=1 records what the app looks for on disk. A failing feature
   * usually fails at a missing-file check long before it reaches the code that
   * reports the error, and the error itself ("Upload Fail.") says nothing. */
  const traceFs = process.env.DC_TRACE_FS === '1';
  if (traceFs) {
    for (const name of ['existsSync', 'readdirSync', 'statSync', 'readFileSync']) {
      const orig = realFs[name];
      if (typeof orig !== 'function') continue;
      realFs[name] = function (...args) {
        const target = fixOne(args[0]);
        args[0] = target;
        try {
          const out = orig.apply(this, args);
          if (name === 'existsSync') log('fs.exists', { path: String(target), result: out });
          else log('fs.' + name, { path: String(target), ok: true });
          return out;
        } catch (err) {
          log('fs.' + name, { path: String(target), ok: false, error: String(err && err.code) });
          throw err;
        }
      };
    }
  }

  const NAMES = ['existsSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync',
    'readdirSync', 'statSync', 'lstatSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync',
    'renameSync', 'openSync', 'accessSync', 'createReadStream', 'createWriteStream', 'realpathSync',
    'readFile', 'writeFile', 'appendFile', 'mkdir', 'readdir', 'stat', 'lstat', 'unlink', 'rm',
    'rmdir', 'copyFile', 'rename', 'open', 'access'];
  wrap(realFs, NAMES);
  if (realFs.promises) wrap(realFs.promises, NAMES);

  /* The app does not call the built-in fs directly: it goes through fs-extra,
   * which sits on graceful-fs, which captures its own references at load time.
   * Wrapping only require('fs') therefore normalises nothing the app does, so
   * the loader hook below applies the same treatment to each of those. */
  global.__dcFixPath = fixOne;
  global.__dcWrapFs = (mod) => {
    if (!mod || typeof mod !== 'object') return mod;
    wrap(mod, NAMES);
    if (mod.promises) wrap(mod.promises, NAMES);
    for (const extra of ['ensureDir', 'ensureDirSync', 'ensureFile', 'ensureFileSync',
      'outputFile', 'outputFileSync', 'remove', 'removeSync', 'emptyDir', 'emptyDirSync',
      'copy', 'copySync', 'move', 'moveSync', 'readJson', 'readJsonSync',
      'writeJson', 'writeJsonSync', 'outputJson', 'outputJsonSync', 'pathExists',
      'pathExistsSync']) {
      const orig = mod[extra];
      if (typeof orig !== 'function') continue;
      mod[extra] = function (...args) {
        if (args.length) args[0] = fixOne(args[0]);
        if (args.length > 1 && /^(copy|move)/.test(extra)) args[1] = fixOne(args[1]);
        return orig.apply(this, args);
      };
    }
    return mod;
  };
  log('winpath.enabled', {});
}

/* ------------------------------------------------------- JSON.parse trace */
/* DC_TRACE_JSON=1 reports what JSON.parse was handed when it throws. The app
 * fails with `"[object Object]" is not valid JSON` inside onDataPipeData, and
 * the only way to see which value that is -- the code is bytecode -- is from
 * the call itself. */
if (process.env.DC_TRACE_JSON === '1' && !global.__dcJsonTrace) {
  global.__dcJsonTrace = true;
  const orig = JSON.parse;
  const MATCH = process.env.DC_TRACE_JSON_MATCH ? new RegExp(process.env.DC_TRACE_JSON_MATCH) : null;
  JSON.parse = function (text, reviver) {
    try {
      const out = orig.call(JSON, text, reviver);
      if (MATCH && typeof text === 'string' && MATCH.test(text)) {
        log('json.parse-ok', {
          head: text.slice(0, 160),
          len: text.length,
          at: (new Error().stack || '').split('\n').slice(2, 5).join(' | ')
        });
      }
      return out;
    } catch (err) {
      let keys;
      try { keys = text && typeof text === 'object' ? Object.keys(text).slice(0, 25) : undefined; } catch (e) { /* exotic */ }
      let dump;
      try { dump = JSON.stringify(text); } catch (e) { dump = String(text); }
      log('json.parse-failed', {
        type: typeof text,
        ctor: text && text.constructor && text.constructor.name,
        keys,
        value: String(dump).slice(0, 500),
        at: (new Error().stack || '').split('\n').slice(2, 5).join(' | ')
      });
      throw err;
    }
  };
  log('json.trace.installed', {});
}

/* ------------------------------------------------- named-pipe stand-in */
/* The app connects to the DeepCool background services over Windows named
 * pipes ("\\.\pipe\deepcool_sensor_data"). On Linux that connect fails with
 * ENOENT, and the startup sequence answers by tearing down its ready-watcher
 * and building a new one -- forever, which is what keeps the splash screen up.
 *
 * Every such path is mapped to a Unix socket under the capture directory, and
 * a listener is opened on it, so the connect succeeds. What the service would
 * have streamed is a separate question; this only gets past the connect.
 * DC_PIPE=0 turns it off. */
if (process.platform !== 'win32' && process.env.DC_PIPE !== '0' && !global.__dcPipe) {
  global.__dcPipe = true;
  try {
    const net = require('net');
    const nodePath = require('path');
    const PIPE_DIR = process.env.DC_PIPE_DIR || DIR;

    /* A Unix socket path is capped at 108 bytes by sun_path, and the kernel
     * silently truncates rather than failing: with a long capture directory
     * `..._sensor_data` and `..._sensor_data_channel` collapse onto the same
     * path and the second listen dies with EADDRINUSE, taking the data
     * channel -- and so every sensor reading -- with it. Fall back to a short
     * directory keyed by a hash of the real one whenever the path would not
     * fit. */
    const SOCK_MAX = 100;
    let shortDir = null;
    const pipeDirFor = (name) => {
      const full = nodePath.join(PIPE_DIR, name);
      if (Buffer.byteLength(full) <= SOCK_MAX) return full;
      if (!shortDir) {
        const h = require('crypto').createHash('sha1').update(PIPE_DIR).digest('hex').slice(0, 8);
        shortDir = nodePath.join(require('os').tmpdir(), 'dc-pipe-' + h);
        try { require('fs').mkdirSync(shortDir, { recursive: true }); } catch (e) { /* exists */ }
        log('pipe.short-dir', { from: PIPE_DIR, to: shortDir });
      }
      return nodePath.join(shortDir, name);
    };

    const mapPipe = (p) => {
      if (typeof p !== 'string') return null;
      const m = /^\\\\[.?]\\pipe\\(.+)$/.exec(p);
      if (!m) return null;
      return pipeDirFor('pipe-' + m[1].replace(/[^\w.-]/g, '_'));
    };

    const servers = new Map();
    const listen = (sock) => {
      if (servers.has(sock)) return;
      servers.set(sock, null);
      try { require('fs').unlinkSync(sock); } catch (e) { /* not there */ }
      /* impl/sensor-service.js answers the control handshake when it is
       * there; without it the listener still accepts, which is enough to see
       * what the app sends. */
      let attach = null;
      try {
        if (process.env.DC_IMPL_DIR) attach = require(process.env.DC_IMPL_DIR + '/sensor-service.js');
      } catch (err) {
        if (err && err.code !== 'MODULE_NOT_FOUND') log('pipe.impl-failed', { error: String(err && err.message) });
      }
      const server = net.createServer((conn) => {
        log('pipe.accept', { socket: sock });
        if (typeof attach === 'function') {
          try { attach(conn, log, sock); } catch (err) { log('pipe.attach-failed', { error: String(err && err.message) }); }
        }
        conn.on('data', (d) => {
          log('pipe.rx', { socket: sock, bytes: d.length, text: d.toString('utf8').slice(0, 600) });
          if (global.__dcPipeReply) global.__dcPipeReply(conn, d, sock);
        });
        conn.on('error', () => {});
      });
      server.on('error', (err) => log('pipe.listen-failed', { socket: sock, error: String(err && err.message) }));
      server.listen(sock, () => log('pipe.listening', { socket: sock }));
      server.unref();
      servers.set(sock, server);
    };

    const rewrite = (args) => {
      const a0 = args[0];
      if (typeof a0 === 'string') {
        const mapped = mapPipe(a0);
        if (mapped) { listen(mapped); log('pipe.map', { from: a0, to: mapped }); args[0] = mapped; }
      } else if (a0 && typeof a0 === 'object' && typeof a0.path === 'string') {
        const mapped = mapPipe(a0.path);
        if (mapped) { listen(mapped); log('pipe.map', { from: a0.path, to: mapped }); args[0] = { ...a0, path: mapped }; }
      }
      return args;
    };

    for (const name of ['connect', 'createConnection']) {
      const orig = net[name];
      if (typeof orig !== 'function') continue;
      net[name] = function (...args) { return orig.apply(this, rewrite(args)); };
    }
    const origSockConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      return origSockConnect.apply(this, rewrite(args));
    };
    log('pipe.enabled', { dir: PIPE_DIR });
  } catch (e) { log('pipe.failed', { error: String(e && e.stack || e) }); }
}

/* ------------------------------------------------ path.win32 detection */
/* Some of the app's writes land in directories literally named
 * "DeepCool\db" -- a backslash-joined path that reached the OS without going
 * through the fs wrapper above. Native addons are one way that happens
 * (classic-level takes its location straight to leveldb); the other is the
 * app joining paths with path.win32. This says which, and DC_PATHWIN=posix
 * makes path.win32 behave like path.posix so the joins come out right. */
if (process.platform !== 'win32' && !global.__dcPathWin) {
  global.__dcPathWin = true;
  try {
    const path = require('path');
    const mode = process.env.DC_PATHWIN || 'trace';
    if (mode !== 'off' && path.win32 && path.posix) {
      for (const name of ['join', 'resolve', 'normalize', 'relative']) {
        const orig = path.win32[name];
        if (typeof orig !== 'function') continue;
        path.win32[name] = function (...args) {
          const out = (mode === 'posix' ? path.posix[name] : orig).apply(this, args);
          log('path.win32', {
            fn: name,
            args: args.filter((a) => typeof a === 'string').slice(0, 4),
            out: String(out).slice(0, 200),
            delegated: mode === 'posix',
            at: (new Error().stack || '').split('\n')[2]
          });
          return out;
        };
      }
      log('pathwin.installed', { mode });
    }
  } catch (e) { log('pathwin.failed', { error: String(e) }); }
}

/* ------------------------------------------------- bundled-binary shim */
/* Some steps shell out to the Windows binaries the app ships (magick_x64.exe,
 * ffmpeg.exe). Those cannot run here, and the command lines carry Windows
 * paths, so both the program and its arguments are rewritten on the way to
 * child_process. */
if (process.platform !== 'win32' && process.env.DC_WINEXE !== '0' && !global.__dcExeShim) {
  global.__dcExeShim = true;
  const cp = require('child_process');

  const IM_SUBCOMMANDS = new Set(['convert', 'identify', 'mogrify', 'composite', 'montage', 'compare']);
  const slash = (v) => (typeof v === 'string' && v.includes('\\') ? v.replace(/\\+/g, '/') : v);

  /* "<...>/magick_x64.exe convert a b" -> "convert a b": ImageMagick 6 exposes
   * the subcommands as separate programs rather than as a first argument. */
  const rewriteCommand = (command) => {
    let out = slash(command);
    out = out.replace(/\S*magick_x(?:64|86)\.exe\s+(\w+)/g,
      (m, sub) => (IM_SUBCOMMANDS.has(sub) ? sub : 'convert ' + sub));
    out = out.replace(/\S*magick_x(?:64|86)\.exe/g, 'convert');
    out = out.replace(/\S*ffprobe\.exe/g, 'ffprobe');
    out = out.replace(/\S*ffmpeg\.exe/g, 'ffmpeg');
    return out;
  };

  const rewriteFile = (file, args) => {
    let f = slash(file);
    let a = Array.isArray(args) ? args.map(slash) : args;
    if (/magick_x(64|86)\.exe$/.test(f)) {
      if (Array.isArray(a) && a.length && IM_SUBCOMMANDS.has(a[0])) { f = a[0]; a = a.slice(1); }
      else f = 'convert';
    } else if (/ffprobe\.exe$/.test(f)) f = 'ffprobe';
    else if (/ffmpeg\.exe$/.test(f)) f = 'ffmpeg';
    return [f, a];
  };

  for (const name of ['exec', 'execSync']) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = function (command, ...rest) {
      const next = rewriteCommand(command);
      if (next !== command) log('exe.rewrite', { fn: name, from: String(command).slice(0, 160), to: next.slice(0, 160) });
      return orig.call(this, next, ...rest);
    };
  }
  for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = function (file, args, ...rest) {
      const [f, a] = rewriteFile(file, args);
      if (f !== file) log('exe.rewrite', { fn: name, from: String(file).slice(0, 160), to: f });
      return orig.call(this, f, a, ...rest);
    };
  }
  log('winexe.enabled', {});
}

/* ------------------------------------------------- process instrumentation */
/* The shim is required very early, which makes it a convenient place to watch
 * the rest of the app boot: which native modules load, and what kills it.
 * DeepCool dies in Wine for reasons unrelated to USB (several Windows-only
 * .node addons), and this is how we find out which. Install once. */

if (!global.__dcInstrumented) {
  global.__dcInstrumented = true;

  process.on('uncaughtException', (err) => {
    log('uncaughtException', { message: err && err.message, stack: err && err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection', { reason: String(reason && reason.stack || reason) });
  });
  process.on('exit', (code) => log('process.exit', { code }));

  /* Recording stub: stands in for a native module we do not want to run,
   * answering any property/call with another stub and logging the access. The
   * log shows the real API shape, so the stub can be replaced by something
   * faithful once we know what the app expects. */
  const BLOBS = path.join(DIR, 'blobs');
  try { fs.mkdirSync(BLOBS, { recursive: true }); } catch (e) { /* ignore */ }
  const INLINE_MAX = Number(process.env.DC_INLINE_MAX || 512);
  let blobSeq = 0;

  /* Payloads are the whole point of the capture, so buffers are preserved in
   * full: small ones inline as hex, larger ones written to blobs/ (an LCD
   * frame is a JPEG, and having the file makes that checkable directly). */
  const captureBuffer = (buf, tag) => {
    const sha = require('crypto').createHash('sha256').update(buf).digest('hex');
    if (buf.length <= INLINE_MAX) {
      return { len: buf.length, sha256: sha.slice(0, 16), hex: buf.toString('hex') };
    }
    const name = String(blobSeq++).padStart(6, '0') + '-' + String(tag || 'blob').replace(/[^A-Za-z0-9._-]/g, '_') + '.bin';
    try { fs.writeFileSync(path.join(BLOBS, name), buf); } catch (e) { /* ignore */ }
    return {
      len: buf.length,
      sha256: sha.slice(0, 16),
      head: buf.subarray(0, 64).toString('hex'),
      tail: buf.subarray(-16).toString('hex'),
      blob: name
    };
  };

  const toBuf = (a) => {
    if (Buffer.isBuffer(a)) return a;
    if (a instanceof ArrayBuffer) return Buffer.from(a);
    if (ArrayBuffer.isView(a)) return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    return null;
  };

  const safeArgs = (args, tag) => Array.prototype.map.call(args, (a) => {
    if (a == null) return a;
    if (typeof a === 'function') return '[function]';
    const buf = toBuf(a);
    if (buf) return captureBuffer(buf, tag);
    if (typeof a === 'object') { try { return JSON.parse(JSON.stringify(a)); } catch (e) { return '[object]'; } }
    return a;
  });

  /* Canvas rendering calls arrive in the hundreds of thousands and bury the
   * protocol traffic; drop them unless DC_QUIET=none. */
  const quiet = process.env.DC_QUIET === 'none'
    ? null
    : new RegExp(process.env.DC_QUIET || 'skia|Canvas|getContext|fillText|loadFont|measureText', 'i');
  const seenQuiet = new Set();

  /* Concrete return values for specific stub paths, from
   * capture/stub-values.json. The app chains real string/number methods onto
   * some of these results (getBiosSerialNumber().replace(...)), and a Proxy
   * standing in for a string makes downstream checks fail in ways that look
   * like protocol errors. */
  function stubValues() {
    try {
      return JSON.parse(fs.readFileSync(path.join(DIR, 'stub-values.json'), 'utf8'));
    } catch (e) {
      return {};
    }
  }

  /* Log calls into a real implementation the same way stub calls are logged,
   * so a capture reads the same whether a module was faked or implemented. */
  function wrapImpl(name, impl) {
    if (!impl || (typeof impl !== 'object' && typeof impl !== 'function')) return impl;
    let proxy;
    proxy = new Proxy(impl, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== 'function') return value;
        const path = `${name}.${String(prop)}`;
        /* A Proxy rather than a wrapper function: some of what a native addon
         * exports is a constructor, and a plain function cannot stand in for
         * one ("Class constructor EventWatcher cannot be invoked without
         * 'new'"). Proxying keeps both call forms, and the prototype with
         * them. */
        return new Proxy(value, {
          apply(t, thisArg, args) {
            log('impl.call', { path, args: safeArgs(args, path) });
            try {
              const out = Reflect.apply(t, thisArg === proxy ? target : thisArg, args);
              log('impl.return', { path, value: safeArgs([out], path)[0] });
              return out;
            } catch (err) {
              log('impl.threw', { path, error: String(err && err.message) });
              throw err;
            }
          },
          construct(t, args, newTarget) {
            log('impl.new', { path, args: safeArgs(args, path) });
            try {
              return Reflect.construct(t, args, newTarget === proxy ? t : newTarget);
            } catch (err) {
              log('impl.threw', { path, error: String(err && err.message) });
              throw err;
            }
          }
        });
      }
    });
    return proxy;
  }

  function recordingStub(name) {
    const make = (p) => new Proxy(function () {}, {
      get(target, prop) {
        if (prop === 'then' || prop === Symbol.toStringTag) return undefined;
        if (prop === Symbol.toPrimitive) return () => 0;
        if (prop === 'inspect' || prop === Symbol.for('nodejs.util.inspect.custom')) {
          return () => `[stub ${p}]`;
        }
        const full = `${p}.${String(prop)}`;
        if (!quiet || !quiet.test(full)) log('stub.get', { module: name, path: full });
        else if (!seenQuiet.has(full)) { seenQuiet.add(full); log('stub.get.first', { module: name, path: full }); }
        return make(full);
      },
      apply(target, thisArg, args) {
        if (!quiet || !quiet.test(p)) {
          log('stub.call', { module: name, path: p, args: safeArgs(args, p) });
        }
        const cb = args[args.length - 1];
        if (typeof cb === 'function') setTimeout(() => { try { cb(null, {}); } catch (e) { /* app's problem */ } }, 0);
        const overrides = stubValues();
        if (Object.prototype.hasOwnProperty.call(overrides, p)) {
          const value = overrides[p];
          log('stub.value', { path: p, value });
          return value;
        }
        return make(`${p}()`);
      },
      construct(target, args) {
        log('stub.new', { module: name, path: p, args: safeArgs(args, p) });
        return make(`new ${p}`);
      }
    });
    return make(name);
  }

  /* Which native modules to replace instead of loading. Set DC_STUB to a
   * comma-separated list of substrings, or DC_STUB=none to load everything.
   * Default targets the two that cannot work under Wine: electron-edge-js
   * starts a .NET CLR, and system_info reads sensors through a kernel driver. */
  const stubList = (process.env.DC_STUB === undefined
    ? 'edge_nativeclr,electron-edge-js,system_info'
    : process.env.DC_STUB
  ).split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');
  log('shim.stub-list', { stubList });

  try {
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request, parent) {
      const req = String(request);
      const interesting = /\.node$|system_info|wincapture|edge|skia|opencv|ffmp|zeromq|node-hid|serialport/i;
      if (interesting.test(req)) {
        log('module.load', { request: req, from: parent && parent.filename });
      }
      if (global.__dcWrapFs && /^(fs|graceful-fs|fs-extra|original-fs)$/.test(req)) {
        const mod = origLoad.apply(this, arguments);
        if (!mod.__dcWrapped) {
          global.__dcWrapFs(mod);
          try { Object.defineProperty(mod, '__dcWrapped', { value: true, enumerable: false }); } catch (e) { /* frozen */ }
          log('winpath.wrapped', { request: req });
        }
        return mod;
      }

      /* DC_TRACE_DB=1 follows the app's leveldb store. The media library is
       * backed by it, so when the library stays empty the question is whether
       * the database opened at all, and where.
       *
       * This has to be a Proxy, not a plain function standing in for the
       * class. classic-level does `class ClassicLevel extends AbstractLevel`,
       * and abstract-level requires *this same intercepted req* internally,
       * so ClassicLevel ends up extending whatever this hook hands back.
       * A plain function fails that silently: `super(...)` threads newTarget
       * through so the real subclass's prototype survives, but a function
       * body that does `return new C(...a)` discards newTarget and hands
       * back a bare, unrelated instance of the ORIGINAL base class. Every
       * ClassicLevel override -- _open, _put, _get, all of it -- becomes
       * unreachable, and abstract-level's no-op defaults run instead:
       * `_open`/`_put`/`_del` resolve without touching disk, `_get` rejects
       * NotFound. Confirmed against the app's own bundled classic-level: the
       * on-disk directory is never created, and a value just `put` reads
       * back LEVEL_NOT_FOUND. A `construct` trap on a Proxy preserves
       * new.target (and the class's statics) across the whole chain instead. */
      if (/(^|[\\/])(classic-level|level|abstract-level)([\\/]|$)/.test(req)) {
        const mod = origLoad.apply(this, arguments);
        try {
          if (mod && !mod.__dcLevel) {
            for (const key of Object.keys(mod)) {
              const C = mod[key];
              if (typeof C !== 'function' || !C.prototype
                  || typeof C.prototype.open !== 'function') continue;
              mod[key] = new Proxy(C, {
                construct(target, a, newTarget) {
                  /* leveldb opens the directory itself, so a backslash
                   * location becomes one directory with backslashes in its
                   * name, sitting beside the tree everything else uses. */
                  const raw = a[0];
                  if (global.__dcFixPath && typeof a[0] === 'string') a[0] = global.__dcFixPath(a[0]);
                  log('db.construct', {
                    request: req,
                    klass: key,
                    location: typeof a[0] === 'string' ? a[0] : null,
                    rewritten: a[0] !== raw
                  });
                  const inst = Reflect.construct(target, a, newTarget);
                  /* Only instrument the outermost construction (newTarget is
                   * the class actually being `new`'d): AbstractLevel's own
                   * constructor runs once per instance no matter how many
                   * classes it sits under, and instrumenting every level of
                   * that chain would wrap the same methods repeatedly. */
                  if (process.env.DC_TRACE_DB === '1' && newTarget === mod[key]) {
                    /* abstract-level opens lazily, so calling open() here
                     * proves nothing about whether the app ever gets that
                     * far. Wrap the operations instead and report what each
                     * one did. */
                    for (const m of ['open', 'put', 'get', 'del', 'batch', 'sublevel']) {
                      const fn = inst[m];
                      if (typeof fn !== 'function') continue;
                      inst[m] = function (...args) {
                        const key0 = typeof args[0] === 'string' ? args[0] : undefined;
                        let out;
                        try { out = fn.apply(this, args); } catch (e) {
                          log('db.call', { klass: key, op: m, key: key0, ok: false, error: String((e && e.message) || e) });
                          throw e;
                        }
                        if (out && typeof out.then === 'function') {
                          out.then(
                            (v) => log('db.call', { klass: key, op: m, key: key0, ok: true,
                                                    value: typeof v === 'string' ? v.slice(0, 300) : undefined }),
                            (e) => log('db.call', { klass: key, op: m, key: key0, ok: false,
                                                    error: String((e && e.message) || e) })
                          );
                        } else {
                          log('db.call', { klass: key, op: m, key: key0, ok: true, sync: true });
                        }
                        return out;
                      };
                    }
                  }
                  return inst;
                }
              });
            }
            Object.defineProperty(mod, '__dcLevel', { value: true, enumerable: false });
          }
        } catch (e) { log('db.trace-failed', { request: req, error: String(e) }); }
        return mod;
      }

      const hit = stubList.find((s) => req.toLowerCase().includes(s.toLowerCase()));
      if (hit) {
        /* A hand-written replacement beats a recording stub: the app can
         * actually make progress instead of only telling us what it wanted.
         * impl/<name>.js is used when present, still logged on every call. */
        const implDir = process.env.DC_IMPL_DIR;
        if (implDir) {
          const slug = hit.replace(/[^A-Za-z0-9_-]/g, '');
          try {
            const impl = origLoad.call(this, implDir + '/' + slug + '.js', parent, false);
            log('module.implemented', { request: req, matched: hit, impl: slug });
            return wrapImpl(slug, impl);
          } catch (err) {
            if (err && err.code !== 'MODULE_NOT_FOUND') {
              log('module.impl-failed', { request: req, impl: slug, error: String(err && err.message) });
            }
          }
        }
        log('module.stubbed', { request: req, matched: hit });
        return recordingStub(hit);
      }
      try {
        return origLoad.apply(this, arguments);
      } catch (err) {
        log('module.load.failed', { request: req, error: String(err && err.message) });
        throw err;
      }
    };

    const origDlopen = process.dlopen;
    process.dlopen = function (mod, filename) {
      log('dlopen', { filename });
      try {
        // Forward arguments verbatim: Module._extensions['.node'] calls this
        // with two arguments, and passing an explicit undefined `flags`
        // makes the underlying dlopen reject the mode.
        return origDlopen.apply(this, arguments);
      } catch (err) {
        log('dlopen.failed', { filename, error: String(err && err.message) });
        throw err;
      }
    };
  } catch (e) {
    log('instrumentation-failed', { error: String(e) });
  }
}

/* -------------------------------------------------- synthetic MYSTIQUE data */
/* Descriptors below are the real ones, from `lsusb -v -d 3633:0009`. */

const VID = 0x3633;
const PID = 0x0009;
const SERIAL = '00780031343832325031364C';

/* Which PIDs to present. 0x0009 is the real MYSTIQUE on this machine; the rest
 * are the PIDs matched by the app's per-model native modules (see PROTOCOL.md
 * §3). Presenting several at once shows which one the app actually engages,
 * which is how we pin down the model code without owning every cooler.
 * Override with DC_PIDS=0x0009,0x0022 or DC_PIDS=0x0009 for a single device. */
const DEFAULT_PIDS = ['0x0009', '0x0022', '0x0026', '0x0027', '0x002e', '0x0030', '0x0031', '0x0032'];
const CANDIDATE_PIDS = (() => {
  if (!process.env.DC_PIDS) return DEFAULT_PIDS.map((s) => parseInt(s, 16));
  /* parseInt(_, 16) stops at the first non-hex character instead of
   * rejecting the string -- parseInt('12xyz',16) is 18, parseInt('0x9
   * 0x22',16) is 9 -- so DC_PIDS="0x0009 0x0022" (space-separated, the
   * natural typo for a comma-separated list) silently produced one device
   * from garbage input instead of an error. A stricter per-token check
   * rejects those instead of guessing. */
  const tokens = process.env.DC_PIDS.split(',').map((s) => s.trim());
  const good = [], bad = [];
  for (const tok of tokens) {
    if (/^(0x)?[0-9a-f]{1,4}$/i.test(tok)) good.push(parseInt(tok, 16));
    else bad.push(tok);
  }
  if (bad.length) log('shim.pids-rejected', { rejected: bad, accepted: good.map((n) => '0x' + n.toString(16)) });
  if (!good.length) {
    /* A shim presenting no device at all has nothing to do -- the app just
     * searches for a cooler that is never there and sits on its splash
     * screen with no error anywhere. Falling back to the default list beats
     * silently doing nothing, and the log line above already says why. */
    log('shim.pids-fallback', { reason: 'DC_PIDS had no valid entries', using: DEFAULT_PIDS });
    return DEFAULT_PIDS.map((s) => parseInt(s, 16));
  }
  return good;
})();

const ENDPOINTS = [
  { bEndpointAddress: 0x81, bmAttributes: 2, wMaxPacketSize: 64, bInterval: 0 }, // EP1 IN  bulk
  { bEndpointAddress: 0x01, bmAttributes: 2, wMaxPacketSize: 64, bInterval: 0 }, // EP1 OUT bulk
  { bEndpointAddress: 0x82, bmAttributes: 2, wMaxPacketSize: 64, bInterval: 0 }, // EP2 IN  bulk
  { bEndpointAddress: 0x02, bmAttributes: 2, wMaxPacketSize: 64, bInterval: 0 }  // EP2 OUT bulk
];

const mkDeviceDescriptor = (pid) => ({
  bLength: 18,
  bDescriptorType: 1,
  bcdUSB: 0x0201,
  bDeviceClass: 0,
  bDeviceSubClass: 0,
  bDeviceProtocol: 0,
  bMaxPacketSize0: 64,
  idVendor: VID,
  idProduct: pid,
  bcdDevice: 0x0247,
  iManufacturer: 1,
  iProduct: 2,
  iSerialNumber: 3,
  bNumConfigurations: 1
});

const interfaceDescriptor = {
  bLength: 9,
  bDescriptorType: 4,
  bInterfaceNumber: 0,
  bAlternateSetting: 0,
  bNumEndpoints: 4,
  bInterfaceClass: 0xff,
  bInterfaceSubClass: 0,
  bInterfaceProtocol: 0,
  iInterface: 0,
  endpoints: ENDPOINTS,
  extra: Buffer.alloc(0)
};

const configDescriptor = {
  bLength: 9,
  bDescriptorType: 2,
  wTotalLength: 0x2e,
  bNumInterfaces: 1,
  bConfigurationValue: 1,
  iConfiguration: 0,
  bmAttributes: 0x80,
  bMaxPower: 50,
  interfaces: [[interfaceDescriptor]],
  extra: Buffer.alloc(0)
};

const STRINGS = { 1: 'DeepCool', 2: 'MYSTIQUE', 3: SERIAL };

/* Canned replies for transferIn / controlTransferIn, so the app does not stall
 * waiting for the device. Drop a JSON file next to the log to script them:
 *   { "in": { "1": "aa5500...", "2": "..." }, "default": "00" }
 * Values are hex strings, keyed by endpoint number. */
function replies() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'replies.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

let sweepIndex = 0;
let lastCommand = null;   // command byte of the most recent outbound frame

/* What the synthetic device remembers. Real hardware stores what you write to
 * it and hands it back on the next read; a reply built from a fixed canned
 * payload does not, so every setting the app writes reads back as the default
 * and the UI snaps its control straight back. Keyed by command byte, holding
 * that command's last 39-byte payload. DC_DEVICE_STATE=0 restores the old
 * amnesiac behaviour. */
const deviceState = new Map();

/* Build a reply in the device's own frame grammar:
 *     55 | 2E | CMD | STATUS | payload... | 'HIDC' | SUM16-LE
 * byte 1 is the constant 0x2E, not a length -- COMMANDS.md §1 confirms this
 * against the firmware disassembly directly: the sibling models write the
 * same "AA 2E" at the head of a 512-byte frame, so it cannot be "length - 2"
 * (it only looked that way here because MYSTIQUE frames are always 48 bytes,
 * where size-2 and 0x2E happen to coincide). CMD must equal the command being
 * answered (the app reports "Transfer sequence error: <got>,<want>"
 * otherwise) and STATUS must be 0. Every synthetic-mode capture used to
 * record `aa 3e <cmd> ...` -- a LEN byte and, with the 64-byte default below,
 * a frame length no real MYSTIQUE has ever produced. */
function buildReply(opts) {
  const size = opts.size || 48;
  const buf = Buffer.alloc(size);
  /* Real hardware answers with 0x55; the harness used 0xAA for a long time and
   * the app kept talking, so the byte looked unchecked. DC_REPLY_HEAD lets a
   * run try the real one. */
  buf[0] = parseInt(process.env.DC_REPLY_HEAD || '0xAA', 16);
  buf[1] = 0x2E;
  buf[2] = opts.cmd;
  buf[3] = opts.status || 0;
  if (opts.payload) {
    const p = Buffer.isBuffer(opts.payload) ? opts.payload : Buffer.from(String(opts.payload), 'ascii');
    p.copy(buf, 4, 0, Math.min(p.length, size - 10));
  }
  Buffer.from('HIDC', 'ascii').copy(buf, size - 6);
  let sum = 0;
  for (let i = 0; i < size - 2; i += 1) sum += buf[i];
  buf.writeUInt16LE(sum & 0xFFFF, size - 2);
  return buf;
}

function replyFor(endpointNumber, length) {
  const r = replies();
  /* Auto mode answers whatever command was just sent, which is what lets the
   * conversation continue past the handshake into the rest of the command set.
   *   { "auto": { "uuid": "PF2M4K7X9Q1B", "size": 64 } }
   */
  if (r.auto) {
    const cmd = lastCommand == null ? 0x12 : lastCommand;
    const remembered = process.env.DC_DEVICE_STATE !== '0' && deviceState.get(cmd);
    const buf = buildReply({
      cmd,
      size: r.auto.size || 64,
      status: r.auto.status || 0,
      payload: remembered || (r.auto.payload ? Buffer.from(r.auto.payload, 'hex') : (r.auto.uuid || ''))
    });
    log('reply.auto', { cmd: '0x' + cmd.toString(16).padStart(2, '0'),
                        stored: !!remembered, hex: buf.toString('hex') });
    return buf;
  }
  /* Sweep mode: replies.json holds {"sweep": ["<hex>", ...]} and each read is
   * answered with the next candidate, so one run tries many reply formats
   * instead of one. The index is logged next to the frame the app sends back,
   * which is what identifies the candidate that got it moving. */
  if (Array.isArray(r.sweep) && r.sweep.length) {
    const index = sweepIndex % r.sweep.length;
    sweepIndex += 1;
    const buf = Buffer.from(String(r.sweep[index]).replace(/[^0-9a-fA-F]/g, ''), 'hex');
    log('reply.sweep', { index, len: buf.length, hex: buf.toString('hex') });
    return buf; // a bulk read may legitimately return fewer bytes than asked
  }
  const key = String(endpointNumber);
  const hex = (r.in && r.in[key]) || r.default;
  if (hex) {
    const buf = Buffer.from(String(hex).replace(/[^0-9a-fA-F]/g, ''), 'hex');
    if (buf.length >= length) return buf.subarray(0, length);
    return Buffer.concat([buf, Buffer.alloc(length - buf.length)]);
  }
  return Buffer.alloc(length);
}

/* ------------------------------------------------------ real hardware
 * DC_REAL_USB turns the synthetic device into a pipe: every bulk transfer is
 * forwarded to impl/usb-bridge.py, which holds the actual 3633:0009. The
 * bridge, not this side, refuses the destructive commands -- the guard belongs
 * next to the hardware, so it still applies to anything else that connects.
 * Set it to 1 for the default socket or to a path. */
let bridgeSock = null;
let bridgeQueue = [];
/* Was `true`/`false` and stuck there: once any connection attempt failed,
 * bridgeConnect()'s guard (`bridgeSock || bridgeDead`) returned null forever
 * after, so a bridge that restarts -- exactly what run-real.sh/e2e.py do on
 * every launch -- could never be reconnected to for the rest of the process's
 * life, with nothing marking the moment it happened. A timestamp lets a retry
 * through once a short cooldown has passed instead of latching permanently. */
let bridgeDeadUntil = 0;
const BRIDGE_RETRY_MS = 2000;

function bridgeConnect() {
  if (bridgeSock) return bridgeSock;
  if (bridgeDeadUntil && Date.now() < bridgeDeadUntil) return null;
  const want = process.env.DC_REAL_USB;
  if (!want) return null;
  const p = want === '1' ? (process.env.DC_USB_SOCK || '/tmp/dc-usb-bridge.sock') : want;
  try {
    const sock = require('net').connect(p);
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 4) break;
        const n = buf.readUInt32LE(0);
        if (buf.length < 4 + n) break;
        let msg;
        try { msg = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); }
        catch (e) { msg = { ok: false, error: 'bad json from bridge' }; }
        buf = buf.subarray(4 + n);
        const resolve = bridgeQueue.shift();
        if (resolve) resolve(msg);
      }
    });
    const fail = (why) => {
      if (bridgeSock !== sock) return; // already handled by the other event
      bridgeSock = null;
      bridgeDeadUntil = Date.now() + BRIDGE_RETRY_MS;
      log('bridge.lost', { error: String(why), retryInMs: BRIDGE_RETRY_MS });
      while (bridgeQueue.length) bridgeQueue.shift()({ ok: false, error: String(why) });
    };
    sock.on('error', fail);
    sock.on('close', () => fail('closed'));
    bridgeSock = sock;
    log('bridge.connected', { socket: p });
  } catch (err) {
    bridgeDeadUntil = Date.now() + BRIDGE_RETRY_MS;
    log('bridge.connect-failed', { socket: p, error: String(err && err.message), retryInMs: BRIDGE_RETRY_MS });
  }
  return bridgeSock;
}

function bridgeRequest(req) {
  const sock = bridgeConnect();
  if (!sock) return Promise.resolve(null);
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(req), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    bridgeQueue.push(resolve);
    try { sock.write(Buffer.concat([head, body])); }
    catch (err) { bridgeQueue.pop(); resolve({ ok: false, error: String(err && err.message) }); }
  });
}

/* A DataView handed to the app must own its memory. Buffer.from() allocates
 * from Node's shared pool, and the app reads the view asynchronously, so a
 * pooled buffer gets overwritten by unrelated allocations before it is read --
 * which showed up as the app reporting garbage command bytes. */
function detachedView(buf) {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new DataView(ab);
}

/* ------------------------------------------------------- legacy usb.Device */

function FakeEndpoint(desc, device) {
  this.descriptor = desc;
  this.direction = desc.bEndpointAddress & 0x80 ? 'in' : 'out';
  this.transferType = 2; // LIBUSB_TRANSFER_TYPE_BULK
  this.address = desc.bEndpointAddress;
  this.timeout = 0;
  this._device = device;
}

FakeEndpoint.prototype.transfer = function (dataOrLength, cb) {
  const ep = this.address & 0x0f;
  if (this.direction === 'out') {
    log('endpoint.transfer.out', { endpoint: this.address, ep, data: bytes(dataOrLength) });
    if (cb) process.nextTick(() => cb(undefined, Buffer.isBuffer(dataOrLength) ? dataOrLength.length : 0));
  } else {
    const length = typeof dataOrLength === 'number' ? dataOrLength : 64;
    const buf = replyFor(ep, length);
    log('endpoint.transfer.in', { endpoint: this.address, ep, requested: length, reply: bytes(buf) });
    if (cb) process.nextTick(() => cb(undefined, buf));
  }
  return this;
};

FakeEndpoint.prototype.startPoll = function (nTransfers, size, cb) {
  log('endpoint.startPoll', { endpoint: this.address, nTransfers, size });
  this._polling = true;
  if (cb) this.on('data', cb);
  return this;
};
FakeEndpoint.prototype.stopPoll = function (cb) {
  log('endpoint.stopPoll', { endpoint: this.address });
  this._polling = false;
  if (cb) process.nextTick(cb);
};
Object.setPrototypeOf(FakeEndpoint.prototype, EventEmitter.prototype);

function FakeInterface(device) {
  this.interfaceNumber = 0;
  this.altSetting = 0;
  this.descriptor = interfaceDescriptor;
  this.endpoints = ENDPOINTS.map((d) => new FakeEndpoint(d, device));
  this._device = device;
}

FakeInterface.prototype.claim = function () { log('interface.claim', { iface: 0 }); };
FakeInterface.prototype.release = function (closeEndpoints, cb) {
  if (typeof closeEndpoints === 'function') { cb = closeEndpoints; }
  log('interface.release', { iface: 0 });
  if (cb) process.nextTick(() => cb(undefined));
};
FakeInterface.prototype.setAltSetting = function (n, cb) {
  log('interface.setAltSetting', { iface: 0, alt: n });
  this.altSetting = n;
  if (cb) process.nextTick(() => cb(undefined));
};
FakeInterface.prototype.isKernelDriverActive = function () { return false; };
FakeInterface.prototype.detachKernelDriver = function () { log('interface.detachKernelDriver', {}); };
FakeInterface.prototype.attachKernelDriver = function () { log('interface.attachKernelDriver', {}); };
FakeInterface.prototype.endpoint = function (addr) {
  return this.endpoints.find((e) => e.address === addr);
};

function FakeDevice(pid, index) {
  this.busNumber = 3;
  this.deviceAddress = 6 + (index || 0);
  this.portNumbers = [1 + (index || 0)];
  this.pid = pid;
  this.deviceDescriptor = mkDeviceDescriptor(pid);
  this.configDescriptor = configDescriptor;
  this.allConfigDescriptors = [configDescriptor];
  this.parent = undefined;
  this.timeout = 1000;
  this.interfaces = undefined; // populated on open(), like node-usb
  this._opened = false;
}

FakeDevice.prototype.open = function (defaultConfig) {
  log('device.open', { defaultConfig: defaultConfig !== false });
  this._opened = true;
  this._iface = this._iface || new FakeInterface(this);
  this.interfaces = [this._iface];
  return this;
};
FakeDevice.prototype.close = function () {
  log('device.close', {});
  this._opened = false;
  this.interfaces = undefined;
};
FakeDevice.prototype.interface = function (n) {
  if (!this.interfaces) this.open();
  return this.interfaces[n || 0];
};
FakeDevice.prototype.reset = function (cb) {
  log('device.reset', {});
  if (cb) process.nextTick(() => cb(undefined));
};
FakeDevice.prototype.setConfiguration = function (n, cb) {
  log('device.setConfiguration', { config: n });
  if (cb) process.nextTick(() => cb(undefined));
};
FakeDevice.prototype.getStringDescriptor = function (index, cb) {
  const value = STRINGS[index];
  log('device.getStringDescriptor', { index, value });
  if (cb) process.nextTick(() => cb(undefined, value));
};
FakeDevice.prototype.getBosDescriptor = function (cb) {
  log('device.getBosDescriptor', {});
  if (cb) process.nextTick(() => cb(undefined, undefined));
};
FakeDevice.prototype.getCapabilities = function (cb) {
  log('device.getCapabilities', {});
  if (cb) process.nextTick(() => cb(undefined, []));
};
FakeDevice.prototype.controlTransfer = function (bmRequestType, bRequest, wValue, wIndex, dataOrLength, cb) {
  const isIn = (bmRequestType & 0x80) !== 0;
  log('device.controlTransfer', {
    dir: isIn ? 'in' : 'out',
    bmRequestType, bRequest, wValue, wIndex,
    data: isIn ? { requested: dataOrLength } : bytes(dataOrLength)
  });
  if (cb) {
    const out = isIn ? replyFor(0, typeof dataOrLength === 'number' ? dataOrLength : 0) : undefined;
    process.nextTick(() => cb(undefined, out));
  }
};

const fakeDevices = CANDIDATE_PIDS.map((pid, i) => new FakeDevice(pid, i));
const fakeDevice = fakeDevices[0];
log('shim.devices', { pids: CANDIDATE_PIDS.map((p) => '0x' + p.toString(16).padStart(4, '0')) });

/* ------------------------------------------------- legacy `usb` namespace */
/* getDeviceList must return the *same* object every call: node-usb's polling
 * hotplug compares device identity between polls to decide attach/detach. */

const usbNs = new EventEmitter();

usbNs.INIT_ERROR = 0;
usbNs.pollHotplug = true;   // never call _enableHotplugEvents: Wine stubs
usbNs.pollHotplugDelay = 500; // CM_Register_Notification, which throws.
usbNs.Device = FakeDevice;
usbNs.Interface = FakeInterface;
usbNs.Endpoint = FakeEndpoint;
usbNs.Transfer = function Transfer() {};

usbNs.getDeviceList = function () { return fakeDevices; };
usbNs.findByIds = function (vid, pid) {
  log('usb.findByIds', { vid, pid: '0x' + Number(pid).toString(16) });
  return vid === VID ? fakeDevices.find((d) => d.pid === pid) : undefined;
};
usbNs.findBySerialNumber = async function (serial) {
  log('usb.findBySerialNumber', { serial });
  return fakeDevices.find((d) => d.serial === serial);
};
usbNs.setDebugLevel = function (n) { log('usb.setDebugLevel', { level: n }); };
usbNs.useUsbDkBackend = function () { log('usb.useUsbDkBackend', {}); };
usbNs._supportedHotplugEvents = function () { return 0; };
usbNs._enableHotplugEvents = function () { log('usb._enableHotplugEvents', { note: 'suppressed' }); };
usbNs._disableHotplugEvents = function () {};

// libusb constants the app (or the bundled WebUSB layer) may read.
usbNs.LIBUSB_ENDPOINT_IN = 0x80;
usbNs.LIBUSB_ENDPOINT_OUT = 0x00;
usbNs.LIBUSB_TRANSFER_TYPE_BULK = 2;
usbNs.LIBUSB_TRANSFER_TYPE_INTERRUPT = 3;
usbNs.LIBUSB_RECIPIENT_DEVICE = 0x00;
usbNs.LIBUSB_RECIPIENT_INTERFACE = 0x01;
usbNs.LIBUSB_RECIPIENT_ENDPOINT = 0x02;
usbNs.LIBUSB_REQUEST_TYPE_STANDARD = 0x00;
usbNs.LIBUSB_REQUEST_TYPE_CLASS = 0x20;
usbNs.LIBUSB_REQUEST_TYPE_VENDOR = 0x40;
usbNs.LIBUSB_DT_DEVICE = 0x01;
usbNs.LIBUSB_DT_CONFIG = 0x02;
usbNs.LIBUSB_DT_STRING = 0x03;
usbNs.LIBUSB_DT_INTERFACE = 0x04;
usbNs.LIBUSB_DT_ENDPOINT = 0x05;
usbNs.LIBUSB_DT_BOS = 0x0f;
usbNs.LIBUSB_TRANSFER_COMPLETED = 0;
usbNs.LIBUSB_ERROR_NOT_FOUND = -5;
usbNs.LIBUSB_ERROR_TIMEOUT = -7;
usbNs.LIBUSB_ERROR_NO_DEVICE = -4;

class LibUSBException extends Error {
  constructor(message, errno) { super(message); this.errno = errno; }
}
usbNs.LibUSBException = LibUSBException;

// Announce the device the way node-usb's polling path would.
usbNs.on('newListener', (event) => {
  if (event === 'attach') {
    log('usb.newListener', { listener: event });
    setTimeout(() => {
      for (const d of fakeDevices) {
        log('usb.emit.attach', { pid: '0x' + d.pid.toString(16).padStart(4, '0') });
        usbNs.emit('attach', d);
      }
    }, 300);
  }
});

/* ------------------------------------------------------------ WebUSB layer */
/* This is the surface DeepCool actually uses: transferOut/claimInterface/
 * endpointNumber are WebUSB names, not legacy node-usb ones. */

const mkWebConfiguration = () => {
  const cfg = {
    configurationValue: 1,
    configurationName: undefined,
    interfaces: [{
      interfaceNumber: 0,
      alternate: {
        alternateSetting: 0,
        interfaceClass: 0xff,
        interfaceSubclass: 0,
        interfaceProtocol: 0,
        interfaceName: undefined,
        endpoints: ENDPOINTS.map((d) => ({
          endpointNumber: d.bEndpointAddress & 0x0f,
          direction: d.bEndpointAddress & 0x80 ? 'in' : 'out',
          type: 'bulk',
          packetSize: d.wMaxPacketSize
        }))
      },
      alternates: [],
      claimed: false
    }]
  };
  cfg.interfaces[0].alternates = [cfg.interfaces[0].alternate];
  return cfg;
};

function mkWebDevice(pid, index) {
  const tag = '0x' + pid.toString(16).padStart(4, '0');
  const cfg = mkWebConfiguration();
  const serial = pid === PID ? SERIAL : SERIAL.slice(0, -2) + pid.toString(16).padStart(2, '0').toUpperCase();
  const L = (event, detail) => log(event, Object.assign({ pid: tag }, detail || {}));
  const legacy = new FakeDevice(pid, index || 0);

  return {
    /* DeepCool's WinUsbDevice reads node-usb's legacy descriptor fields off
     * the object delivered by the WebUSB `connect` event, so this presents
     * both shapes at once rather than making us guess which one it wants.
     * open() is async for the WebUSB caller but does its work before the
     * first await, so a legacy caller that ignores the promise still sees
     * `interfaces` populated. */
    deviceDescriptor: legacy.deviceDescriptor,
    configDescriptor,
    allConfigDescriptors: [configDescriptor],
    busNumber: legacy.busNumber,
    deviceAddress: legacy.deviceAddress,
    portNumbers: legacy.portNumbers,
    parent: undefined,
    timeout: 1000,
    interfaces: undefined,
    /* node-usb's real WebUSBDevice keeps the underlying libusb Device here,
     * and DeepCool's WinUsbDevice reaches through it for the descriptor. */
    device: legacy,
    _legacy: legacy,
    interface(n) { return legacy.interface(n); },
    getStringDescriptor(i, cb) { return legacy.getStringDescriptor(i, cb); },
    getBosDescriptor(cb) { return legacy.getBosDescriptor(cb); },
    getCapabilities(cb) { return legacy.getCapabilities(cb); },
    setConfiguration(n, cb) { return legacy.setConfiguration(n, cb); },
    controlTransfer(a, b, c, d, e, cb) { return legacy.controlTransfer(a, b, c, d, e, cb); },

    usbVersionMajor: 2, usbVersionMinor: 0, usbVersionSubminor: 1,
    deviceClass: 0, deviceSubclass: 0, deviceProtocol: 0,
    vendorId: VID, productId: pid,
    deviceVersionMajor: 2, deviceVersionMinor: 4, deviceVersionSubminor: 7,
    manufacturerName: 'DeepCool',
    productName: 'MYSTIQUE',
    serialNumber: serial,
    configuration: cfg,
    configurations: [cfg],
    opened: false,

    async open() {
      L('web.open');
      legacy.open();
      this.interfaces = legacy.interfaces;
      this.opened = true;
    },
    async close() { L('web.close'); legacy.close(); this.interfaces = undefined; this.opened = false; },
    async forget() { L('web.forget'); },
    async selectConfiguration(v) { L('web.selectConfiguration', { value: v }); },
    async claimInterface(n) { L('web.claimInterface', { iface: n }); cfg.interfaces[0].claimed = true; },
    async releaseInterface(n) { L('web.releaseInterface', { iface: n }); cfg.interfaces[0].claimed = false; },
    async selectAlternateInterface(n, alt) { L('web.selectAlternateInterface', { iface: n, alt }); },
    async reset() { L('web.reset'); },
    async clearHalt(direction, endpointNumber) { L('web.clearHalt', { direction, endpointNumber }); },

    async transferOut(endpointNumber, data) {
      const b = bytes(data);
      /* Only a genuine command frame updates what the auto-reply echoes. An
       * image transfer streams raw JPEG through this same call, and byte 2 of
       * a data chunk is just pixel data — letting that set lastCommand makes
       * the reply after a transfer echo a random byte, and the app then treats
       * the upload as unfinished (it never renames temp_<id> to <id>). */
      if (b && b.hex) {
        const raw = Buffer.from(b.hex, 'hex');
        const isCommandFrame = raw.length >= 8 && raw[0] === 0xAA && raw[1] === raw.length - 2
          && raw.subarray(raw.length - 6, raw.length - 2).toString('ascii') === 'HIDC';
        if (isCommandFrame) {
          lastCommand = raw[2];
          /* 0x12 reads the PC serial back rather than writing it, so it must
           * keep answering with the stored serial, not with its own empty
           * request payload. */
          if (raw[2] !== 0x12) deviceState.set(raw[2], Buffer.from(raw.subarray(3, 42)));
          if (applyCustomSlotOverride(raw)) b.hex = raw.toString('hex');
        }
      }
      if (process.env.DC_REAL_USB && b && b.hex) {
        const res = await bridgeRequest({ op: 'out', ep: endpointNumber, hex: b.hex });
        if (res && res.refused) {
          /* The bridge itself declined to forward this (0x11/0x13/0x14) and
           * queued a synthetic reply so the app can proceed -- from the
           * app's side the write genuinely succeeded, so 'ok' is correct. */
          L('bridge.refused', { cmd: res.refused });
        } else if (res && !res.ok) {
          /* Anything else is a real failure: the bridge is dead, the device
           * unplugged, or libusb rejected the write. Reporting bytesWritten
           * and status:'ok' here told the app a command reached hardware
           * that never did -- indistinguishable from success in every log
           * that only reads this call's return value. A real failed OUT
           * transfer rejects in WebUSB; do the same so the app's own error
           * handling (or, failing that, the process's unhandledRejection
           * logger) sees it instead of silently losing the command. */
          L('bridge.out-failed', { error: res.error });
          const err = new Error('bridge write failed: ' + (res.error || 'unknown'));
          err.name = 'NetworkError';
          throw err;
        }
      }
      L('web.transferOut', { ep: endpointNumber, data: b });
      return { bytesWritten: b ? b.len : 0, status: 'ok' };
    },
    async transferIn(endpointNumber, length) {
      let buf = null;
      if (process.env.DC_REAL_USB) {
        const res = await bridgeRequest({ op: 'in', ep: endpointNumber, len: length });
        if (res && res.ok && res.hex) {
          buf = Buffer.from(res.hex, 'hex');
        } else if (lastCommand === 0x12) {
          /* Every other command's fallback below is a shrug: some commands
           * legitimately go unanswered, and a canned reply keeps the app
           * moving instead of hanging on a promise that would never resolve.
           * 0x12 is not one of those -- its reply is the stored PC serial the
           * app compares against its own BIOS serial to decide whether this
           * cooler is already bound, and a wrong answer here is what used to
           * drive the app into re-running its whole init once a second (see
           * README). Fabricating "yes, bound" out of a read that never
           * reached real hardware is worse than the hang it would replace,
           * so surface the failure instead of answering for the device. */
          L('bridge.in-failed-0x12', { ep: endpointNumber, error: res && res.error });
          const err = new Error('bridge read failed for 0x12 handshake: ' + ((res && res.error) || 'unknown'));
          err.name = 'NetworkError';
          throw err;
        } else {
          /* A real device does not answer every command, and a read that times
           * out would stall the app where the canned reply never did. Fall back
           * and say so rather than hanging. */
          L('bridge.in-fallback', { ep: endpointNumber, error: res && res.error });
        }
      }
      if (!buf) buf = replyFor(endpointNumber, length);
      L('web.transferIn', { ep: endpointNumber, requested: length, reply: bytes(buf) });
      return { data: detachedView(buf), status: 'ok' };
    },
    async controlTransferOut(setup, data) {
      L('web.controlTransferOut', { setup, data: bytes(data) });
      const b = bytes(data);
      return { bytesWritten: b ? b.len : 0, status: 'ok' };
    },
    async controlTransferIn(setup, length) {
      const buf = replyFor(0, length);
      L('web.controlTransferIn', { setup, requested: length, reply: bytes(buf) });
      return { data: detachedView(buf), status: 'ok' };
    },
    async isochronousTransferIn() { throw new Error('isochronousTransferIn not implemented'); },
    async isochronousTransferOut() { throw new Error('isochronousTransferOut not implemented'); }
  };
}

/* DC_TRACE_DEVICE=1 wraps each device so every property the app reads is
 * logged. This is how we find out what WinUsbDevice actually wants when it
 * reports an undefined `deviceDescriptor`, instead of guessing at its shape. */
function traceDevice(dev, tag) {
  if (process.env.DC_TRACE_DEVICE !== '1') return dev;
  return new Proxy(dev, {
    get(target, prop, receiver) {
      const key = String(prop);
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      const value = Reflect.get(target, prop, receiver);
      log('device.read', {
        pid: tag,
        prop: key,
        type: value === undefined ? 'undefined' : (value === null ? 'null' : typeof value)
      });
      return value;
    },
    has(target, prop) {
      if (typeof prop === 'string') log('device.has', { pid: tag, prop: String(prop), present: prop in target });
      return Reflect.has(target, prop);
    }
  });
}

const webDevices = CANDIDATE_PIDS.map((pid, i) =>
  traceDevice(mkWebDevice(pid, i), '0x' + pid.toString(16).padStart(4, '0')));
const webDevice = webDevices[0];

/* Devices already handed to the app, so a second WebUSB instance does not
 * cause a second load of the same hardware. */
const announced = new Set();

class FakeWebUSB extends EventEmitter {
  constructor(options) {
    super();
    log('WebUSB.construct', { options: options ? Object.keys(options) : null });
    this._onconnect = undefined;
    this.ondisconnect = undefined;

    // The application may install its handler well after construction, so
    // announce the device whenever a handler appears rather than once on a
    // timer, and re-announce a few times in case discovery is deferred.
    const every = Number(process.env.DC_ANNOUNCE_EVERY || 0);
    if (every > 0) {
      setTimeout(() => this._announce('first'), 300);
      this._timer = setInterval(() => this._announce('interval'), every);
      if (this._timer.unref) this._timer.unref();
    } else {
      for (const ms of [300, 1500, 4000, 10000]) {
        setTimeout(() => this._announce('timer+' + ms), ms);
      }
    }
  }

  _announce(why) {
    log('WebUSB.connect-event', {
      why,
      hasHandler: typeof this._onconnect === 'function',
      listeners: this.listenerCount('connect'),
      devices: webDevices.length
    });
    /* The app builds more than one WebUSB object, and every announcement is
     * delivered to each of them, so the same physical device gets loaded and
     * initialised twice -- two device objects for one serial, and a setting
     * written to the one the UI holds is read back from the other. Deliver a
     * device once per process. DC_ANNOUNCE_DEDUPE=0 restores the old
     * behaviour, which is what the deferred-discovery retries needed before
     * the app got far enough to open its windows. */
    const dedupe = process.env.DC_ANNOUNCE_DEDUPE !== '0';
    for (const dev of webDevices) {
      if (dedupe) {
        const key = dev.serialNumber || String(dev.productId);
        if (announced.has(key)) continue;
        announced.add(key);
      }
      const ev = { type: 'connect', device: dev };
      if (typeof this._onconnect === 'function') {
        try { this._onconnect(ev); } catch (e) { log('WebUSB.onconnect-threw', { error: String(e) }); }
      }
      try { this.emit('connect', ev); } catch (e) { log('WebUSB.emit-threw', { error: String(e) }); }
    }
  }

  get onconnect() { return this._onconnect; }
  set onconnect(fn) {
    log('WebUSB.set-onconnect', { type: typeof fn });
    this._onconnect = fn;
    if (typeof fn === 'function') setTimeout(() => this._announce('onconnect-assigned'), 50);
  }

  async getDevices() { log('WebUSB.getDevices', { devices: webDevices.length }); return webDevices; }
  async requestDevice(options) {
    log('WebUSB.requestDevice', { filters: options && options.filters });
    const f = (options && options.filters) || [];
    const match = webDevices.find((d) => f.some(
      (x) => (x.vendorId === undefined || x.vendorId === d.vendorId)
          && (x.productId === undefined || x.productId === d.productId)));
    return match || webDevices[0];
  }
  addEventListener(type, listener) {
    log('WebUSB.addEventListener', { type });
    this.on(type, listener);
    if (type === 'connect') setTimeout(() => this._announce('addEventListener'), 50);
  }
  removeEventListener(type, listener) { this.off(type, listener); }
  dispatchEvent() { return true; }
}


/* --------------------------------------------------------------- UI trace */
/* Keep the MYSTIQUE fan and pump I/O choices alive. Always on: this is a fix,
 * not a trace. */
if (!global.__dcFanIO) {
  global.__dcFanIO = true;
  try {
    const { ipcMain } = require('electron');

    /* The two I/O-interface choices have nowhere to live.
     *
     * MYSTIQUE's page offers a CPU-fan and a pump-fan picker, and the app
     * feeds the chosen tachometer into its sensor object as fanRpm/pumpRpm.
     * But the choice does not survive the second it was made in:
     * mystique/update-device-info accepts it and echoes it back, the very next
     * mystique/get-device-info answers "" again, and the page re-reads that
     * channel once a second -- so the select snaps back to N/A. The DeviceInfo
     * the handler rebuilds has no room for two host-side fields, and the
     * device cannot store them either.
     *
     * Remember what was chosen and put it back into every DeviceInfo leaving
     * the handler. DC_FAN_IO="<cpu>,<pump>" seeds it without a click --
     * indices into the sensor service's fan list, exactly as offered by
     * app/get-fan-interface. */
    const FAN_IO_FIELDS = ['cpuFanIOInterface', 'pumpFanIOInterface'];
    const fanIO = {};
    if (process.env.DC_FAN_IO) {
      const parts = process.env.DC_FAN_IO.split(',');
      FAN_IO_FIELDS.forEach((f, i) => {
        if (parts[i] !== undefined && parts[i] !== '') fanIO[f] = parts[i];
      });
      log('fanio.seeded', { fanIO });
    }
    const fanIOInto = (options) => {
      if (!options) return;
      for (const f of FAN_IO_FIELDS) {
        if (fanIO[f] !== undefined && options[f] !== fanIO[f]) options[f] = fanIO[f];
      }
    };
    const fanIOFrom = (options) => {
      if (!options) return;
      for (const f of FAN_IO_FIELDS) {
        const v = options[f];
        /* '' is "N/A" -- a real, pickable choice in the dropdown, not "no
         * value yet". Excluding it here meant that once any real header had
         * been picked, choosing N/A again could never be remembered: fanIO[f]
         * kept the old header, and fanIOInto below put it straight back into
         * the very next DeviceInfo, so the select silently snapped back. */
        if (v !== undefined && v !== fanIO[f]) {
          fanIO[f] = v;
          log('fanio.remembered', { field: f, value: v });
        }
      }
    };

    const orig = ipcMain.handle;
    if (typeof orig === 'function') {
      ipcMain.handle = function (channel, listener) {
        if (channel !== 'mystique/get-device-info'
            && channel !== 'mystique/update-device-info') {
          return orig.call(this, channel, listener);
        }
        const wrapped = function (event, ...args) {
          if (channel === 'mystique/update-device-info' && args[0]) {
            fanIOFrom(args[0].options);
            fanIOInto(args[0].options);
          }
          const out = listener.apply(this, [event, ...args]);
          if (channel !== 'mystique/get-device-info') return out;
          /* The handler answers with its own record rather than a copy, so
           * patching the reply patches what the rest of main reads too. */
          const patch = (r) => { if (r && r.data) fanIOInto(r.data.options); return r; };
          return (out && typeof out.then === 'function') ? out.then(patch) : patch(out);
        };
        return orig.call(this, channel, wrapped);
      };
    }
  } catch (e) {
    log('fanio.failed', { error: String((e && e.stack) || e) });
  }
}

/* DC_TRACE_UI=1 records what the windows do: when each BrowserWindow is
 * created, what it loads, whether the load succeeded, everything the renderer
 * logs, and every ipc message the renderer sends. The splash hands over to the
 * main window from inside the (bytecode-only) main bundle, so when it does not
 * hand over this trace is the only way to see why. */
if (process.env.DC_TRACE_UI === '1' && !global.__dcUiTrace) {
  global.__dcUiTrace = true;
  try {
    const el = require('electron');
    const { app, BrowserWindow, ipcMain } = el;

    const wid = (wc) => { try { return wc.id; } catch (e) { return -1; } };

    app.on('web-contents-created', (_e, wc) => {
      const tag = { wc: wid(wc), type: wc.getType && wc.getType() };
      log('ui.wc.created', tag);
      wc.on('did-start-loading', () => log('ui.wc.load-start', { ...tag, url: wc.getURL() }));
      wc.on('did-finish-load', () => log('ui.wc.load-done', { ...tag, url: wc.getURL() }));
      wc.on('did-fail-load', (_ev, code, desc, url) =>
        log('ui.wc.load-fail', { ...tag, code, desc, url }));
      wc.on('dom-ready', () => log('ui.wc.dom-ready', { ...tag, url: wc.getURL() }));
      wc.on('render-process-gone', (_ev, details) => log('ui.wc.gone', { ...tag, details }));
      wc.on('unresponsive', () => log('ui.wc.unresponsive', tag));
      wc.on('preload-error', (_ev, p, err) =>
        log('ui.wc.preload-error', { ...tag, preload: p, error: String(err && err.stack || err) }));
      wc.on('console-message', (_ev, level, message, line, source) =>
        log('ui.console', { ...tag, level, message: String(message).slice(0, 600), line, source }));
    });

    /* What main tells the renderer. The splash's caption comes through here,
     * so the last message is the last stage the startup sequence reached. */
    app.on('web-contents-created', (_e, wc) => {
      const origSend = wc.send;
      wc.send = function (channel, ...a) {
        let payload;
        try { payload = JSON.stringify(a).slice(0, 300); } catch (e) { payload = '[unserialisable]'; }
        log('ui.send', { wc: wid(wc), channel, payload });
        return origSend.apply(this, [channel, ...a]);
      };
    });

    app.on('browser-window-created', (_e, win) => {
      const tag = { win: win.id, wc: wid(win.webContents) };
      log('ui.win.created', { ...tag, opts: null });
      win.on('ready-to-show', () => log('ui.win.ready-to-show', tag));
      win.on('show', () => log('ui.win.show', { ...tag, url: win.webContents.getURL() }));
      win.on('hide', () => log('ui.win.hide', tag));
      win.on('closed', () => log('ui.win.closed', tag));
    });

    /* An invalid pattern here (e.g. an unbalanced paren typo'd into the
     * value) threw a SyntaxError out of `new RegExp`, unwinding past every
     * block below this one in the same try -- wrapIpc, the window census,
     * DC_FORCE_SHOW/DC_FORCE_BOUNDS, and the DC_PICK_FILE dialog hook -- to
     * the catch further down. The three app.on(...) listeners already
     * registered above survive, so the log kept filling with events while
     * the window was never unmaximised, re-bounded or shown: every
     * screenshot after that pointed at whatever the compositor had already
     * done with it, at the compositor's own coordinates. */
    let RESULT_RE = null;
    if (process.env.DC_TRACE_IPC) {
      try { RESULT_RE = new RegExp(process.env.DC_TRACE_IPC); }
      catch (e) { log('shim.trace-ipc-invalid', { pattern: process.env.DC_TRACE_IPC, error: String(e && e.message) }); }
    }

    /* What the renderer asks the main process for, and when it stops asking. */
    const wrapIpc = (name) => {
      const orig = ipcMain[name];
      if (typeof orig !== 'function') return;
      ipcMain[name] = function (channel, listener) {
        const wrapped = function (event, ...args) {
          let a;
          try { a = JSON.parse(JSON.stringify(args)); } catch (e) { a = '[unserialisable]'; }
          const s = JSON.stringify(a);
          log('ui.ipc', { kind: name, channel, args: s && s.length > 400 ? s.slice(0, 400) + '...' : a });
          const out = listener.apply(this, [event, ...args]);
          /* DC_TRACE_IPC=<regex>: also record what the handler answered. Which
           * channel is empty, and which is merely never called, look the same
           * from the arguments alone. */
          if (RESULT_RE && RESULT_RE.test(channel)) {
            const show = (v) => {
              let j;
              try { j = JSON.stringify(v); } catch (e) { j = String(v); }
              log('ui.ipc.result', { channel, result: j === undefined ? 'undefined' : j.slice(0, 500) });
            };
            if (out && typeof out.then === 'function') out.then(show, (e) => show('THREW ' + e));
            else show(out);
          }
          return out;
        };
        return orig.call(this, channel, wrapped);
      };
    };
    wrapIpc('handle');
    wrapIpc('handleOnce');
    wrapIpc('on');
    wrapIpc('once');

    /* Periodic window census: whether each window is actually mapped, how big
     * it is and where. A main window that is "loaded" but never shown looks
     * identical to a hung app from outside, and only this tells them apart. */
    const census = () => {
      try {
        for (const w of BrowserWindow.getAllWindows()) {
          log('ui.win.state', {
            win: w.id,
            url: w.webContents.getURL().split('/').slice(-1)[0],
            visible: w.isVisible(),
            minimized: w.isMinimized(),
            bounds: w.getBounds(),
            opacity: w.getOpacity()
          });
        }
      } catch (e) { log('ui.census.failed', { error: String(e) }); }
    };
    const every = Number(process.env.DC_UI_CENSUS || 0);
    if (every > 0) setInterval(census, every);

    /* DC_FORCE_SHOW=<ms>: reveal the main window ourselves. The handover from
     * splash to main window happens inside the bytecode bundle; when it does
     * not happen, this shows what the app has already finished rendering. */
    const forceAt = Number(process.env.DC_FORCE_SHOW || 0);
    if (forceAt > 0) {
      setTimeout(() => {
        census();
        try {
          for (const w of BrowserWindow.getAllWindows()) {
            const url = w.webContents.getURL();
            if (url.includes('index.html')) {
              const want = (process.env.DC_FORCE_BOUNDS || '0,0,1280,860').split(',').map(Number);
              /* setBounds is a no-op on a maximised window, and the app
               * restores itself maximised on whichever head the compositor
               * chose -- which on a multi-head desktop is how it ends up on a
               * screen you are not looking at. */
              try { if (w.isFullScreen && w.isFullScreen()) w.setFullScreen(false); } catch (e) { /* older electron */ }
              try { if (w.isMaximized && w.isMaximized()) w.unmaximize(); } catch (e) { /* ditto */ }
              w.setBounds({ x: want[0], y: want[1], width: want[2], height: want[3] });
              w.setOpacity(1);
              w.showInactive();
              w.moveTop();
              log('ui.force.show', { win: w.id, bounds: w.getBounds() });
            } else if (url.includes('launch.html')) {
              w.hide();
              log('ui.force.hide-splash', { win: w.id });
            }
          }
        } catch (e) { log('ui.force.failed', { error: String(e && e.stack || e) }); }
        census();
      }, forceAt);
    }

    /* DC_PICK_FILE=<path>: answer the native file chooser without one.
     * The upload flow starts at an OS open dialog, which cannot be clicked from
     * a screenshot harness -- and which on Wine is exactly where the real app
     * would stop too. Answering it here lets the rest of the flow run for real:
     * the app still does its own crop, conversion and transfer. */
    const pick = process.env.DC_PICK_FILE;
    if (pick) {
      const dialog = el.dialog;
      const paths = pick.split(',').map((s) => s.trim()).filter(Boolean);
      let nth = 0;
      const next = () => {
        const p = paths[Math.min(nth, paths.length - 1)];
        nth += 1;
        return p;
      };
      dialog.showOpenDialog = async (...a) => {
        const p = next();
        log('ui.dialog.open', { returned: p, args: a.length });
        return { canceled: false, filePaths: [p] };
      };
      dialog.showOpenDialogSync = (...a) => {
        const p = next();
        log('ui.dialog.open-sync', { returned: p, args: a.length });
        return [p];
      };
      log('ui.dialog.hooked', { paths });
    }

    log('ui.trace.installed', {});
  } catch (err) {
    log('ui.trace.failed', { error: String(err && err.stack || err) });
  }
}


/* ------------------------------------------------------------ IPC driver */
/* The shim runs inside the main process, which is where the app registers its
 * ipcMain handlers. That makes it possible to invoke any application command
 * directly -- no renderer, no clicking -- which is how the command/setting map
 * gets built. DC_DRIVER=<path to a JS file> loads a script that receives the
 * driver API once the app has settled. */
if (!global.__dcDriver) {
  global.__dcDriver = true;
  /* `|| 8000` only rescues an empty/unset value; a typo like "10s" or
   * "8000ms" survives it as NaN, and setTimeout(fn, NaN) is clamped by Node
   * to 1 ms -- the driver body then runs at shim load, before the app has
   * registered a single ipcMain.handle. Every channel comes back empty,
   * every invoke() logs driver.invoke.missing, and a driver script that
   * expects the device list to be populated aborts with nothing else to say
   * why. `|| 8000` also made DC_DRIVER_DELAY=0 mean 8000, so an immediate
   * run could not be requested on purpose either. */
  const driverDelayRaw = Number(process.env.DC_DRIVER_DELAY);
  const delay = Number.isFinite(driverDelayRaw) && driverDelayRaw >= 0 ? driverDelayRaw : 8000;
  setTimeout(() => {
    let ipcMain;
    try { ipcMain = require('electron').ipcMain; } catch (e) {
      log('driver.no-electron', { error: String(e) });
      return;
    }
    const invokeHandlers = ipcMain._invokeHandlers instanceof Map
      ? [...ipcMain._invokeHandlers.keys()] : [];
    log('driver.channels', {
      invoke: invokeHandlers,
      on: typeof ipcMain.eventNames === 'function' ? ipcMain.eventNames() : [],
      delayMs: delay,
      delayRejected: process.env.DC_DRIVER_DELAY !== undefined
        && !(Number.isFinite(driverDelayRaw) && driverDelayRaw >= 0)
    });

    const api = {
      log,
      bytes,
      ipcMain,
      channels: invokeHandlers,
      /* Call an ipcMain.handle() channel exactly as the renderer would.
       *
       * Electron does not store the listener directly: handle() wraps it in
       *   async (e, ...args) => { try { e._reply(await fn(e, ...args)) }
       *                           catch (err) { e._throw(err) } }
       * so the result arrives through the event object rather than the return
       * value, and the event must supply _reply/_throw. */
      async invoke(channel, ...args) {
        const fn = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get(channel);
        if (!fn) { log('driver.invoke.missing', { channel }); return undefined; }

        const outcome = await new Promise((resolve) => {
          let settled = false;
          const done = (ok, value) => { if (!settled) { settled = true; resolve({ ok, value }); } };
          const event = {
            processId: 1,
            frameId: 1,
            senderFrame: { url: 'app://driver', routingId: 1, send() {} },
            sender: {
              id: 1,
              send() {},
              isDestroyed() { return false; },
              getURL() { return 'app://driver'; },
              session: {}
            },
            _reply: (value) => done(true, value),
            _throw: (err) => done(false, err)
          };
          Promise.resolve()
            .then(() => fn(event, ...args))
            .catch((err) => done(false, err));
        });

        if (outcome.ok) {
          log('driver.invoke', { channel, args: safeArgsPublic(args), ok: true, result: summarise(outcome.value) });
          return outcome.value;
        }
        const err = outcome.value;
        log('driver.invoke', {
          channel,
          args: safeArgsPublic(args),
          ok: false,
          error: String((err && err.message) || err),
          stack: err && err.stack ? String(err.stack).split('\n').slice(0, 5).join(' | ') : undefined
        });
        return undefined;
      }
    };

    const summarise = (v) => {
      try {
        const j = JSON.stringify(v);
        return j && j.length > 2000 ? j.slice(0, 2000) + '...' : j;
      } catch (e) { return String(v); }
    };
    const safeArgsPublic = (a) => {
      try { return JSON.parse(JSON.stringify(a)); } catch (e) { return '[unserialisable]'; }
    };

    const script = process.env.DC_DRIVER;
    if (script) {
      try {
        require(script)(api);
      } catch (err) {
        log('driver.script-failed', { script, error: String(err && err.stack || err) });
      }
    }
  }, delay);
}

/* --------------------------------------------------------------- exports */
/* Mirrors node-usb's dist/index.js export shape. */

module.exports = {
  usb: usbNs,
  webusb: new FakeWebUSB(),
  WebUSB: FakeWebUSB,
  WebUSBDevice: function () { return webDevice; },
  Device: FakeDevice,
  Interface: FakeInterface,
  Endpoint: FakeEndpoint,
  Transfer: usbNs.Transfer,
  LibUSBException,
  getDeviceList: usbNs.getDeviceList,
  findByIds: usbNs.findByIds,
  findBySerialNumber: usbNs.findBySerialNumber,
  useUsbDkBackend: usbNs.useUsbDkBackend,
  __shim: { log, bytes, fakeDevices, webDevices, LOG, CANDIDATE_PIDS }
};

/* Anything the app reaches for that we did not define shows up in the log,
 * so the shim can be extended from evidence instead of guesswork. */
module.exports = new Proxy(module.exports, {
  get(target, prop, receiver) {
    if (!(prop in target) && typeof prop === 'string' && !prop.startsWith('_')) {
      log('shim.missing-export', { prop });
    }
    return Reflect.get(target, prop, receiver);
  }
});
