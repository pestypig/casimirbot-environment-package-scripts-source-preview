import { gzipSync } from 'node:zlib';

/** Deterministic private package writer; no filesystem traversal or hooks. */
export function createTarGzip(entries) {
  const blocks = [];
  for (const { name, bytes } of entries) {
    if (!Buffer.isBuffer(bytes) || Buffer.byteLength(name, 'ascii') > 99) throw new Error('tar_entry_invalid');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'ascii');
    const octal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
    octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}
