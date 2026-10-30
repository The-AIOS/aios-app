/**
 * Chat skin — the slash-command popup's reading half. Everything here is read-only and bounded: it lists
 * the markdown files Claude Code itself would load as commands and reads the first few KiB of each for its
 * frontmatter. The decisions (merging, ranking, what the box is asking for) are in core/slashCommands.ts.
 *
 * SOURCES, in the places Claude Code looks:
 *   · user    — <config dir>/commands/**.md          (the config dir honours CLAUDE_CONFIG_DIR: aios.claudeConfigDir())
 *   · project — <the pane's cwd>/.claude/commands/**.md
 *   · plugins — <installPath>/commands/**.md for each plugin in <config dir>/plugins/installed_plugins.json
 *               (a project- or local-scope install counts only inside its own project)
 *   · the AIOS framework's own commands arrive already discovered (aios.discoverCommands()) and are passed in,
 *     so this module does not import the heavy aios.ts.
 * A command in a sub-folder is namespaced `folder:name`, a plugin's as `plugin:name` — the names the TUI shows.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter } from '../core/frontmatter';
import { builtinCommands, mergeSlashCommands, type SlashCommand, type SlashSource } from '../core/slashCommands';
import { isSameOrInside, type PathRules } from './pathResolve';

const MAX_DEPTH = 3;          // commands/a/b/c.md is as deep as anyone nests them
const MAX_FILES = 400;        // per folder tree: a runaway folder must not stall the popup
const HEAD_BYTES = 4096;      // the frontmatter is at the top; a command's whole body is never read

/** The first HEAD_BYTES of a file as text, or '' when it cannot be read. */
async function head(file: string): Promise<string> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; }
  finally { await fh?.close().catch(() => undefined); }
}

/** Every `*.md` under a commands folder, as [namespaced name, file]. Folders that are symlinks are not followed. */
async function walk(dir: string, prefix: string[], depth: number, out: Array<[string, string]>): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;   // `_index.md` and friends are documentation, not commands
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, [...prefix, e.name], depth + 1, out);
    else if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.md')) out.push([[...prefix, e.name.slice(0, -3)].join(':'), full]);
  }
}

/** Commands in one folder tree. A folder that does not exist is an empty list, not an error. */
export async function readCommandsDir(dir: string, source: SlashSource, plugin?: string): Promise<SlashCommand[]> {
  const files: Array<[string, string]> = [];
  await walk(dir, [], 1, files);
  const out: SlashCommand[] = [];
  for (const [name, file] of files) {
    const fm = parseFrontmatter(await head(file));
    out.push({
      name: plugin ? `${plugin}:${name}` : name,
      description: (fm.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
      ...(fm.argumentHint ? { argumentHint: fm.argumentHint.slice(0, 120) } : {}),
      source,
      ...(plugin ? { plugin } : {}),
    });
  }
  return out;
}

interface InstalledEntry { scope?: string; installPath?: string; projectPath?: string }

/**
 * The commands folders of the plugins that apply to `cwd`: user-scope installs always, project/local ones only inside their project.
 * `pathMod` is the path rules the registry's paths are written in (the host's own; `path.win32` in tests on another host). The
 * registry FILE is always read with the host's path module — that is where it really is.
 */
export async function pluginCommandDirs(configDir: string, cwd: string | null, pathMod: PathRules = path): Promise<Array<{ plugin: string; dir: string }>> {
  let raw: { plugins?: Record<string, InstalledEntry[]> };
  try { raw = JSON.parse(await fs.promises.readFile(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')); } catch { return []; }
  const out: Array<{ plugin: string; dir: string }> = [];
  for (const [id, entries] of Object.entries(raw.plugins ?? {})) {
    const plugin = id.split('@')[0];
    if (!plugin || !Array.isArray(entries)) continue;
    const hit = entries.find((e) => e && typeof e.installPath === 'string' && (
      !e.scope || e.scope === 'user'
      || (!!cwd && isSameOrInside(e.projectPath, cwd, pathMod))));   // not a bare startsWith: see isSameOrInside
    if (hit?.installPath) out.push({ plugin, dir: pathMod.join(hit.installPath, 'commands') });
  }
  return out;
}

export interface SlashListOptions {
  /** Claude Code's config folder (aios.claudeConfigDir()). */
  configDir: string;
  /** The pane's working folder, or null when unknown (project commands and project-scope plugins are then skipped). */
  cwd: string | null;
  /** The AIOS framework's own commands, as aios.discoverCommands() returns them (names without the `aios:` prefix). */
  aiosCommands?: Array<{ name: string; description: string; argumentHint?: string }>;
}

/** Every command the popup can offer for one pane: built-in, project, user and plugin, merged by name. */
export async function listSlashCommands(o: SlashListOptions): Promise<SlashCommand[]> {
  const cwd = o.cwd && path.isAbsolute(o.cwd) ? o.cwd : null;
  const [project, user, plugins] = await Promise.all([
    cwd ? readCommandsDir(path.join(cwd, '.claude', 'commands'), 'project') : Promise.resolve([] as SlashCommand[]),
    readCommandsDir(path.join(o.configDir, 'commands'), 'user'),
    pluginCommandDirs(o.configDir, cwd).then((dirs) => Promise.all(dirs.map((d) => readCommandsDir(d.dir, 'plugin', d.plugin)))),
  ]);
  // the framework's copy first: it is the live checkout, while the installed plugin is a cached release of the same commands
  const aios: SlashCommand[] = (o.aiosCommands ?? []).map((c) => ({
    name: `aios:${c.name}`, description: c.description.replace(/\s+/g, ' ').trim().slice(0, 240), ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}), source: 'plugin' as const, plugin: 'aios',
  }));
  return mergeSlashCommands(builtinCommands(), project, user, aios, ...plugins);
}
