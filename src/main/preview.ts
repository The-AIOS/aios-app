/* What the viewer may READ, decided before a single byte is read.
 *
 * fs:read used to `readFileSync(abs, 'utf8')` whatever it was handed. A ⌘-click on a 123 MB .dmg
 * printed in a terminal read it whole, shipped the string over IPC and asked the renderer to lay
 * it out as source — the window froze and the App had to be force-quit. The read is the cost, so
 * the gate lives in front of it, here, as a pure function a test can point at real files. */
import * as fs from 'node:fs';

/* Rendered from their PATH (an <img> / <iframe> src), never from their bytes — so they are not
   read, at any size. Mirrors IMG_EXT + PDF_EXT in the renderer. */
export const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|pdf)$/i;
/* Above this a text file is not opened either: the editor is for notes and code, and a 4 MB
   note does not exist. Inclusive. */
export const TEXT_LIMIT = 4 * 1024 * 1024;
const SNIFF = 8192;

export type ReadClass = { kind: 'text' } | { kind: 'asset' } | { kind: 'binary' | 'large'; size: number };

export function classifyForRead(abs: string, limit = TEXT_LIMIT): ReadClass {
  if (ASSET_EXT.test(abs)) return { kind: 'asset' };
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > limit) return { kind: 'large', size: st.size };
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(SNIFF, st.size));
    const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
    if (buf.subarray(0, n).includes(0)) return { kind: 'binary', size: st.size };
  } finally { fs.closeSync(fd); }
  return { kind: 'text' };
}
