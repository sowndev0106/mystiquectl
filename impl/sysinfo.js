'use strict';
/*
 * Linux system information in the shape SensorBridgeServer.exe reports it.
 *
 * The key names are not guesses: they are the JSON keys in the service binary
 * (resources/service/x64/SensorBridgeServer.exe), which is what the app was
 * written against.
 *
 *   deviceName systemName cpuName gpuInfo mainboardName motherboardChipset
 *   ramModuleManufacturer ramSlotNum ramSlotOccupied ramTiming diskNames
 *   diskSingle diskInfoList
 *
 * GPU list entries: index memorySize graphicsProcessClock graphicMemoryClock
 * iSensorIndex isDefault.   Disk entries: diskIndex total.
 */

const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; } };
const dmi = (f) => read('/sys/class/dmi/id/' + f);

function sh(cmd, args) {
  try {
    return String(execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }));
  } catch (e) { return ''; }
}

function cpuName() {
  const m = /^model name\s*:\s*(.+)$/m.exec(read('/proc/cpuinfo'));
  if (m) return m[1].trim();
  const c = os.cpus()[0];
  return (c && c.model) || 'Unknown CPU';
}

/* lspci is the only dependency-free way to name a GPU on a generic Linux box;
 * an NVIDIA card additionally answers nvidia-smi, which is where a memory size
 * can come from. Absent both, the list is empty and the app shows nothing --
 * the same as a machine with no discrete card. */
function gpuList() {
  const out = [];
  const smi = sh('nvidia-smi', ['--query-gpu=name,memory.total,clocks.max.graphics,clocks.max.memory',
    '--format=csv,noheader,nounits']);
  if (smi.trim()) {
    smi.trim().split('\n').forEach((line, i) => {
      const [name, mem, gclk, mclk] = line.split(',').map((s) => s.trim());
      out.push({
        index: i,
        name,
        memorySize: Number(mem) || 0,
        graphicsProcessClock: Number(gclk) || 0,
        graphicMemoryClock: Number(mclk) || 0,
        iSensorIndex: i,
        isDefault: i === 0
      });
    });
    return out;
  }
  const pci = sh('lspci', ['-mm']);
  pci.split('\n').forEach((line) => {
    if (!/VGA compatible controller|3D controller|Display controller/i.test(line)) return;
    const parts = line.match(/"([^"]*)"/g) || [];
    const vendor = (parts[2] || '').replace(/"/g, '');
    const device = (parts[3] || '').replace(/"/g, '');
    const i = out.length;
    out.push({
      index: i,
      name: [vendor, device].filter(Boolean).join(' ') || 'Unknown GPU',
      memorySize: 0,
      graphicsProcessClock: 0,
      graphicMemoryClock: 0,
      iSensorIndex: i,
      isDefault: i === 0
    });
  });
  return out;
}

function disks() {
  const names = [];
  const list = [];
  let dir = [];
  try { dir = fs.readdirSync('/sys/block'); } catch (e) { dir = []; }
  for (const dev of dir.sort()) {
    if (/^(loop|ram|zram|dm-|sr)/.test(dev)) continue;
    /* md (software RAID) was not in that list: a two-disk mdraid-1 array
     * has a nonzero size and no device/model, so it used to be pushed in
     * alongside its own member disks -- names = [sda's model, sdb's model,
     * "md0"] and the array's full capacity double-counted on top of the
     * physical drives that make it up. A real disk has a device/ symlink
     * (verified against every /sys/block entry on this machine); an md
     * array does not, and additionally carries its own md/ subdirectory. */
    if (!fs.existsSync(`/sys/block/${dev}/device`)) continue;
    const sectors = Number(read(`/sys/block/${dev}/size`)) || 0;
    if (!sectors) continue;
    const model = read(`/sys/block/${dev}/device/model`) || dev;
    names.push(model);
    list.push({ diskIndex: list.length, name: model, total: sectors * 512 });
  }
  return { names, list };
}

/* An SMBIOS structure is a fixed formatted area followed by its string table:
 * NUL-terminated strings, 1-based index, the set ending in a second NUL. The
 * formatted area's length is the byte at offset 1, which is where the strings
 * begin. */
function dmiString(buf, index) {
  if (!index) return '';
  let off = buf[1];
  for (let i = 1; off < buf.length; i += 1) {
    const end = buf.indexOf(0, off);
    if (end < 0 || end === off) break;
    if (i === index) return buf.slice(off, end).toString('latin1').trim();
    off = end + 1;
  }
  return '';
}

function dmiEntries(type) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync('/sys/firmware/dmi/entries'); } catch (e) { return out; }
  for (const d of names) {
    if (!d.startsWith(type + '-')) continue;
    try { out.push(fs.readFileSync('/sys/firmware/dmi/entries/' + d + '/raw')); } catch (e) { /* 0400 */ }
  }
  return out;
}

function memory() {
  const meminfo = read('/proc/meminfo');
  const kb = Number((/^MemTotal:\s+(\d+) kB$/m.exec(meminfo) || [])[1]) || 0;

  /* The slot layout comes from DMI type 17, one structure per socket whether
   * or not it is populated: Size at 0x0C is 0 for an empty one, and the
   * manufacturer is a string index at 0x17. /sys/firmware/dmi is 0400, so
   * without root these all come back empty and only the total is reported --
   * better than inventing a layout. DMI carries no CL timings at all, so
   * ramTiming stays blank rather than being guessed from the part number. */
  const devices = dmiEntries('17');
  if (!devices.length) {
    /* Not root: impl/dmi-cache.py leaves the same figures somewhere readable. */
    let c = null;
    try {
      c = JSON.parse(fs.readFileSync(process.env.DC_DMI_CACHE
        || (os.homedir() + '/.config/deepcool-linux/dmi.json'), 'utf8'));
    } catch (e) { /* no cache */ }
    /* A cache from a since-replaced motherboard was trusted forever, with
     * nothing comparing it against the machine actually running. Matches
     * impl/dmi-cache.py's fingerprint() -- board_vendor/board_name/bios_date,
     * mode 0444, no root needed. Absent (a cache from before this field
     * existed) still trusts it, so existing installs are not forced to
     * re-run dmi-cache.py. */
    if (c && c.boardFingerprint) {
      const read1 = (name) => { try { return fs.readFileSync('/sys/class/dmi/id/' + name, 'utf8').trim(); } catch (e) { return ''; } };
      const live = [read1('board_vendor'), read1('board_name'), read1('bios_date')].join('|');
      if (c.boardFingerprint !== live) c = null;
    }
    if (c) {
      return {
        totalBytes: kb * 1024,
        slots: c.ramSlotNum || 0,
        occupied: c.ramSlotOccupied || 0,
        manufacturer: c.ramModuleManufacturer || '',
        timing: ''
      };
    }
  }
  let occupied = 0;
  let manufacturer = '';
  for (const b of devices) {
    /* buf.length is formatted area + string table (that is how the kernel
     * exports each /sys/firmware/dmi/entries entry's raw file) -- the only
     * valid bound for a formatted-area offset is the structure's own Length
     * byte at buf[1]. On
     * an older board with a shorter type-17 structure, b.length being "long
     * enough" only because of trailing DIMM label strings let this read
     * string-table bytes as size/speed fields. See impl/dmi-cache.py's word()
     * for the same fix on the root-cache side, with a worked example. */
    if (b.length < 2 || b[1] < 0x18) continue;
    const flen = b[1];
    let size = b.readUInt16LE(0x0C);
    if (size === 0x7FFF && flen >= 0x20) size = b.readUInt32LE(0x1C);
    /* 0 is "no module in this socket" (a real empty slot); 0xFFFF is "a
     * module is here, size unknown" -- SMBIOS distinguishes them on purpose,
     * and folding both into "not occupied" undercounts ramSlotOccupied on
     * hardware that reports the latter. */
    if (!size) continue;
    occupied += 1;
    if (!manufacturer) manufacturer = dmiString(b, b[0x17]);
  }

  return {
    totalBytes: kb * 1024,
    slots: devices.length,
    occupied,
    manufacturer,
    timing: ''
  };
}

/* The app also walks a raw HWiNFO SDK report: HWINFO -> COMPUTER -> SubNodes,
 * picking the VIDEO node and reading its "GPU Type" and "Video Memory"
 * properties. Both the node names (VIDEO, MEMORY, MOBO, DRIVES) and the entry
 * keys (NodeName, SubNode, Property, Description, VALUE, UNIT) are the
 * service's; HWiNFO is Windows-only, so the tree is synthesised from the same
 * Linux sources as the flat fields. */
function hwinfoTree(gpus, d, mem) {
  const prop = (Description, VALUE, UNIT) => ({ Description, VALUE: String(VALUE), UNIT: UNIT || '' });
  return {
    COMPUTER: {
      NodeName: 'COMPUTER',
      SubNodes: [
        {
          NodeName: 'VIDEO',
          SubNode: gpus.map((g) => ({
            NodeName: g.name,
            Property: [
              prop('GPU Type', g.isDefault ? 'Discrete' : 'Integrated'),
              prop('Video Memory', g.memorySize, 'MB'),
              prop('Graphics Memory Clock', g.graphicMemoryClock, 'MHz')
            ]
          }))
        },
        {
          NodeName: 'MEMORY',
          SubNode: [{
            NodeName: 'Memory',
            Property: [
              prop('Module Manufacturer', mem.manufacturer || '--'),
              prop('Current Timing (tCAS-tRCD-tRP-tRAS)', mem.timing || '--')
            ]
          }]
        },
        {
          NodeName: 'MOBO',
          SubNode: [{
            NodeName: dmi('board_name') || 'Motherboard',
            Property: [prop('Motherboard Chipset', dmi('board_name') || '--')]
          }]
        },
        {
          NodeName: 'DRIVES',
          SubNode: d.list.map((x) => ({
            NodeName: x.name,
            Property: [prop('Drive Serial Number', '--')]
          }))
        }
      ]
    }
  };
}

module.exports = function systemInfo() {
  const d = disks();
  const mem = memory();
  const gpus = gpuList();
  return {
    deviceName: os.hostname(),
    systemName: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuName: cpuName(),
    gpuInfo: gpus,
    mainboardName: [dmi('board_vendor'), dmi('board_name')].filter(Boolean).join(' '),
    motherboardChipset: dmi('board_name'),
    ramModuleManufacturer: mem.manufacturer,
    ramSlotNum: mem.slots,
    ramSlotOccupied: mem.occupied,
    ramTiming: mem.timing,
    ramTotal: mem.totalBytes,
    diskNames: d.names,
    diskSingle: d.names.length === 1,
    diskInfoList: d.list,
    gpuList: gpus,
    HWINFO: hwinfoTree(gpus, d, mem)
  };
};
