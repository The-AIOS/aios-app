/**
 * Which glibc a Linux native module needs — read from the binary itself, no objdump.
 *
 * Issue 93: v0.13.0's .deb died on Ubuntu 24.04 (glibc 2.39) with `GLIBC_2.42 not found`,
 * because GitHub moved `ubuntu-latest` to 26.04 and node-pty was compiled there. Every gate was
 * green: the packaged smoke ran on the same new system that built it. So the gate reads the
 * version references an ELF carries (`GLIBC_2.34` …, in its version-needed strings) and refuses
 * anything newer than the oldest system we promise to run on.
 */
import fs from 'node:fs';

/* Ubuntu 22.04 LTS. The release builds on ubuntu-22.04, so its own binaries can never exceed this. */
export const GLIBC_CEILING = '2.35';

const num = (v) => v.split('.').map(Number);
export const cmpVersion = (a, b) => { const x = num(a), y = num(b); return (x[0] - y[0]) || ((x[1] || 0) - (y[1] || 0)); };

/** The highest GLIBC_x.y a binary references, or '' when it references none. */
export function maxGlibc(buf) {
  let best = '';
  for (const m of buf.toString('latin1').matchAll(/GLIBC_(\d+\.\d+)/g)) if (!best || cmpVersion(m[1], best) > 0) best = m[1];
  return best;
}

export const maxGlibcOfFile = (file) => maxGlibc(fs.readFileSync(file));
