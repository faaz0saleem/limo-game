/**
 * Builds the upload archive for GameMonetize / CrazyGames / Poki.
 *
 * Their requirement is that index.html sits at the ROOT of the zip, not inside
 * a folder — a zip of the containing directory is the usual reason an upload
 * is rejected.
 */
import { createWriteStream } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { deflateRawSync, crc32 } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'midnight-limo.zip');
const INCLUDE = ['index.html', 'styles.css', 'src', 'vendor'];

async function walk(rel) {
  const abs = path.join(ROOT, rel);
  const s = await stat(abs);
  if (s.isFile()) return [rel];
  const out = [];
  for (const e of await readdir(abs)) {
    if (e === '.DS_Store') continue;
    out.push(...await walk(path.join(rel, e)));
  }
  return out;
}

const files = (await Promise.all(INCLUDE.map(walk))).flat();

const chunks = [];
const central = [];
let offset = 0;
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

for (const rel of files) {
  const name = Buffer.from(rel.split(path.sep).join('/'));
  const data = await readFile(path.join(ROOT, rel));
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0),
    u32(crc), u32(comp.length), u32(data.length), u16(name.length), u16(0), name,
  ]);
  chunks.push(local, comp);

  central.push(Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0),
    u32(crc), u32(comp.length), u32(data.length),
    u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
  ]));
  offset += local.length + comp.length;
}

const dir = Buffer.concat(central);
const end = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
  u32(dir.length), u32(offset), u16(0),
]);

const ws = createWriteStream(OUT);
for (const c of [...chunks, dir, end]) ws.write(c);
await new Promise((r) => ws.end(r));

const total = [...chunks, dir, end].reduce((n, c) => n + c.length, 0);
console.log(`midnight-limo.zip — ${files.length} files, ${(total / 1048576).toFixed(2)} MB`);
console.log('index.html is at the archive root, as the portals require.');
