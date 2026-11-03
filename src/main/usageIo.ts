import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UsageIo } from '../core/usageReader';

/** Claude Code's projects folder — honours CLAUDE_CONFIG_DIR, like Claude Code itself. */
export function projectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** The async file access the shared usage reader needs. Nothing here blocks the thread. */
export const fsUsageIo: UsageIo = {
  async find(sessionId) {
    const base = projectsDir();
    let dirs: fs.Dirent[];
    try { dirs = await fs.promises.readdir(base, { withFileTypes: true }); } catch { return undefined; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const f = path.join(base, d.name, `${sessionId}.jsonl`);
      try { await fs.promises.access(f); return f; } catch { /* not here */ }
    }
    return undefined;
  },
  async size(file) { return (await fs.promises.stat(file)).size; },
  async read(file, offset, length) {
    const fh = await fs.promises.open(file, 'r');
    try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return b.subarray(0, bytesRead); }
    finally { await fh.close(); }
  },
};
