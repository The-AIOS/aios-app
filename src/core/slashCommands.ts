/**
 * Chat skin — the slash-command popup's pure half: which commands exist (the built-in ones), how a list from
 * several sources is merged, what the box's text is asking for, and in what order the candidates come.
 * No electron, no fs: the reading from disk is src/main/slashCommandsIo.ts, and the popup itself is in
 * renderer/app.js. Everything that decides WHAT is offered lives here so it can be tested without a window.
 *
 * WHERE THE BUILT-IN LIST COMES FROM, AND WHY IT IS WRITTEN OUT HERE. Claude Code keeps its built-in
 * commands inside its own binary (a single compiled executable): there is no commands folder, no manifest and
 * no `--list-commands` anywhere on disk to read them from. The only way to get them "from the installed
 * program" is to scan that ~270 MB executable for strings, which takes seconds, depends on how it happens to
 * be bundled (it changes between releases) and would run inside the app on every start. So the list is
 * curated here instead. It was built by reading the installed CLI (2.1.310) once, read-only: names, argument
 * hints and aliases come from the command definitions found in it, and the descriptions are re-worded
 * (and translated) in src/i18n/locales as `chat.slash.cmd.<name>`.
 *
 * WHAT IS LEFT OUT ON PURPOSE, so the list reads as what a person types in a conversation:
 *  - account and billing offers (upgrade, usage-credits, extra-usage, privacy offers tied to a plan);
 *  - cloud-only flows (teleport, session, web-setup, ultraplan, ultrareview, remote-env, cloud-plugins,
 *    autofix-pr, install-slack-app, workflows);
 *  - terminal-rendering switches that mean nothing in a chat view (tui, scroll-speed);
 *  - internal, hidden or switched-off ones (version, loops, wellbeing, pause-memory, design-*, heapdump,
 *    workflow-launch-exec, radio, stickers) and provider setup that only exists for Bedrock/Vertex users.
 * A command that is missing here can still be typed and sent like any other message: the popup only
 * COMPLETES, it never decides what may be sent. A command Claude Code adds later is simply not listed until
 * this table is refreshed from the CLI.
 */

export type SlashSource = 'builtin' | 'plugin' | 'user' | 'project';

export interface SlashCommand {
  /** What follows the slash. A plugin's command is `plugin:name`; a command in a sub-folder is `folder:name`. */
  name: string;
  /** Plain text (a command file's frontmatter). Empty for a built-in: those carry `descKey` instead. */
  description: string;
  /** i18n key of a built-in's description, so the popup follows the app's language. */
  descKey?: string;
  /** The frontmatter's `argument-hint`, or the built-in's usage, such as `[name]`. */
  argumentHint?: string;
  source: SlashSource;
  /** For `source: 'plugin'`: the plugin's name, shown as the row's tag. */
  plugin?: string;
  /** Other names that run the same command (`/reset` for `/clear`). Matched, never shown as rows. */
  aliases?: string[];
}

/** [name, argument hint, aliases]. The description is `chat.slash.cmd.<name>` in every locale (a test pins it). */
export const BUILTIN_COMMANDS: ReadonlyArray<readonly [string, string?, string[]?]> = [
  ['add-dir', '<path>'],
  ['autocompact', '[auto|<tokens>]'],
  ['background', '[prompt]', ['bg']],
  ['branch', '[name]'],
  ['btw', '[question]'],
  ['bug', '[report]', ['share']],
  ['cd', '<path>'],
  ['chrome'],
  ['clear', '[name]', ['reset', 'new']],
  ['color'],
  ['compact', '<optional custom summarization instructions>'],
  ['config', 'key=value', ['settings']],
  ['context', '[all]'],
  ['copy'],
  ['desktop', undefined, ['app']],
  ['diff'],
  ['doctor', undefined, ['checkup']],
  ['effort', '[low|medium|high|xhigh|max|auto]'],   // from the installed CLI (2.1.311): `Usage: /effort [<levels the model has>|auto]`; xhigh and max exist only on some models
  ['exit', undefined, ['quit']],
  ['export', '[filename]'],
  ['fast', '[on|off]'],
  ['feedback', '[report]'],
  ['focus', '[on|off]'],
  ['fork', '<directive>'],
  ['goal', '[<condition> | clear]'],
  ['help'],
  ['hooks'],
  ['ide', '[open]'],
  ['import', '[codex|gemini|cursor] [--dry-run]'],
  ['init'],
  ['insights'],
  ['install-github-app'],
  ['keybindings'],
  ['list-agents', undefined, ['peers']],
  ['login'],
  ['logout'],
  ['mcp', '[reconnect|enable|disable [<server>|all]]'],
  ['memory'],
  ['mobile', undefined, ['ios', 'android']],
  ['model', '[model]'],
  ['output-style', '[style]'],
  ['permissions', undefined, ['allowed-tools']],
  ['plan', '[open|<description>]'],
  ['plugin', undefined, ['plugins', 'marketplace']],
  ['powerup'],
  ['privacy-settings'],
  ['recap'],
  ['release-notes'],
  ['reload-plugins', '[--force]'],
  ['reload-skills'],
  ['remote-control', undefined, ['rc']],
  ['rename', '[name]', ['name']],
  ['resume', '[conversation id or search term]', ['continue']],
  ['rewind', undefined, ['checkpoint', 'undo']],
  ['schedule', undefined, ['routines']],
  ['security-review'],
  ['skill-doctor'],
  ['skills'],
  ['status'],
  ['stop'],
  ['subtask', '<task>'],
  ['tasks', undefined, ['bashes']],
  ['terminal-setup'],
  ['theme'],
  ['usage', undefined, ['cost', 'stats']],
  ['voice', '[hold|tap|off]'],
];

export function builtinCommands(): SlashCommand[] {
  return BUILTIN_COMMANDS.map(([name, hint, aliases]) => ({
    name, description: '', descKey: `chat.slash.cmd.${name}`, argumentHint: hint, source: 'builtin' as const, ...(aliases ? { aliases } : {}),
  }));
}

/**
 * What the box is asking for: the text after the leading slash when the WHOLE content is one slash word
 * (`/`, `/co`, `/aios:to`), and null for anything else. A space, a newline or a second line means the
 * operator has moved on to arguments or prose, so nothing is offered. Only the start of the box counts: a
 * slash in the middle of a sentence is a path or a fraction, not a command.
 */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(text);
  return m ? m[1] : null;
}

/** Who wins when two sources define the same name: the built-in (assumed to take precedence in Claude Code, which resolves its own names first), then project, user, plugin. */
const PRIORITY: Record<SlashSource, number> = { builtin: 0, project: 1, user: 2, plugin: 3 };
/** How the lists are ordered when nothing has been typed yet: what the operator wrote or installed first, the stock commands after. */
const BROWSE: Record<SlashSource, number> = { project: 0, user: 1, plugin: 2, builtin: 3 };

/** Union of several lists. A name defined twice is shown once, by the source that wins (see PRIORITY). */
export function mergeSlashCommands(...lists: SlashCommand[][]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const list of lists) {
    for (const c of list) {
      if (!c || typeof c.name !== 'string' || !c.name) continue;
      const have = byName.get(c.name);
      if (!have || PRIORITY[c.source] < PRIORITY[have.source]) byName.set(c.name, c);
    }
  }
  return [...byName.values()];
}

/** Lower is better; Infinity = not a match. */
function score(c: SlashCommand, q: string): number {
  const name = c.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  const aliases = (c.aliases ?? []).map((a) => a.toLowerCase());
  if (aliases.some((a) => a === q)) return 2;
  if (aliases.some((a) => a.startsWith(q))) return 3;
  // `/tod` finds `aios:today`: the part after the plugin or folder prefix is what a person remembers
  const tail = name.slice(name.lastIndexOf(':') + 1);
  if (tail !== name && tail.startsWith(q)) return 4;
  if (name.split(/[:\-_]/).some((w) => w.startsWith(q))) return 5;
  if (name.includes(q)) return 6;
  if ((c.description || '').toLowerCase().includes(q)) return 7;
  return Infinity;
}

/** The names a typed word matches EXACTLY (the command is already complete): its own name, or an alias. */
function namesExactly(c: SlashCommand, q: string): boolean {
  return c.name.toLowerCase() === q || (c.aliases ?? []).some((a) => a.toLowerCase() === q);
}

export interface RankOptions {
  /** How many rows at most. The popup scrolls, but a hundred rows are not a menu. */
  limit?: number;
}

/** Candidates for a query, best first; the empty query lists everything in browse order. */
export function rankSlashCommands(cmds: SlashCommand[], query: string, o: RankOptions = {}): SlashCommand[] {
  const q = query.toLowerCase();
  const limit = o.limit ?? 80;
  // a built-in's description lives in the locale files (`descKey`), which main does not load: only names, aliases and file descriptions are searched
  const scored = cmds.map((c) => ({ c, s: q ? score(c, q) : 0 })).filter((x) => x.s !== Infinity);
  // equally good matches: the operator's own before the stock ones, then A-Z (no popularity data exists, and a surprising order is worse than a plain one)
  scored.sort((a, b) => a.s - b.s || BROWSE[a.c.source] - BROWSE[b.c.source] || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, limit).map((x) => x.c);
}

/**
 * The popup's one question: given the text in the box, what should it offer? An empty list means "no popup":
 * the text is not a lone slash word, nothing matches, or the word is already a complete command name (then
 * Enter should send it, not complete it a second time).
 */
export function slashSuggestions(cmds: SlashCommand[], text: string, o: RankOptions = {}): SlashCommand[] {
  const q = slashQuery(text);
  if (q === null) return [];
  if (q && cmds.some((c) => namesExactly(c, q.toLowerCase()))) return [];
  return rankSlashCommands(cmds, q, o);
}

/** What picking a row writes into the box: the command and a space, ready for its arguments (or for Enter). */
export const slashCompletion = (c: Pick<SlashCommand, 'name'>): string => `/${c.name} `;
