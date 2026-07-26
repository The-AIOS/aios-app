/**
 * Designer core — a BRIEF composer, not a file writer.
 *
 * The Designer used to compose and write the .md itself. That let an operator produce a
 * technically-valid but useless unit (name a skill "a", press create, get an empty
 * SKILL.md in custom/) — the app can enforce a shape, but it cannot judge whether the
 * thing is any good, or wire it into the framework's conventions. So the app no longer
 * authors framework infra: it collects intent and hands a precise brief to the
 * `aios-builder` agent, which knows the conventions (frontmatter contracts, `custom/`
 * placement, `_index.md` upkeep, the agent-vs-skill distinction) and writes the file.
 *
 * The app's job: ask the right questions, name the destination, and be exact about
 * create-vs-update so the builder never edits a bundled unit.
 */

/**
 * 'command' rather than 'plugin' is deliberate. An operator wants `/money`, not "a
 * plugin" — but Claude Code only delivers commands INSIDE a plugin (a directory with
 * `.claude-plugin/plugin.json`, registered in marketplace.json), so the plugin is
 * packaging, not the goal. The Designer therefore asks for a command and lets the
 * builder place it in the operator's existing custom plugin, creating one only if none
 * exists. (Commands cannot live at `plugins/custom/` directly — that's a namespace
 * folder, not a plugin.)
 */
export type DesignerKind = 'agent' | 'skill' | 'command';

export interface DesignerFields {
  name: string;
  description: string;
  keywords?: string;
  tier?: 'mechanical' | 'judgment';
  /** What the operator wants it to DO — the brief's substance, in their words. */
  body: string;
}

/** Where each kind lives once built — shown in the UI and stated in the brief. */
export const DESIGNER_HOMES: Record<DesignerKind, string> = {
  agent: 'agents/custom/{slug}.md',
  skill: 'skills/custom/{slug}/SKILL.md',
  command: 'plugins/custom/<your-plugin>/commands/{slug}.md',
};

/** Operator-facing one-liner: what this kind IS, so the choice is informed. */
export const DESIGNER_ABOUT: Record<DesignerKind, string> = {
  agent: 'A role you can spawn — a named session that wears one hat (a lawyer, an accountant, a code reviewer), with its own expertise and instructions.',
  skill: 'A reusable capability Claude loads on demand when a task matches its description — a recipe it follows, not a session it becomes.',
  command: 'Your own slash command — `/your-plugin:name`. It ships inside your personal plugin; if you don\'t have one yet, one is created for you.',
};

/** kebab-case file handle from a display name (matches the spawn/agent conventions). */
export function slugify(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** The concrete destination for a kind + slug (no placeholder left in it). */
export function designerHome(kind: DesignerKind, slug: string): string {
  return DESIGNER_HOMES[kind].replace('{slug}', slug);
}

export interface BriefOptions {
  /** 'create' writes a new unit; 'update' edits one of the operator's OWN custom units. */
  mode: 'create' | 'update';
  /** A bundled unit to imitate — READ-ONLY reference, never edited. */
  templatePath?: string;
  /** The operator's custom unit being updated (mode 'update'). */
  targetPath?: string;
  /** Existing custom plugin handles — a new command joins one instead of minting another. */
  plugins?: string[];
  /** A handle to PROPOSE when the operator has no plugin yet (derived from their name). */
  suggestedHandle?: string;
}

/**
 * The prompt handed to `aios-builder`. Deliberately explicit about the three things a
 * builder must not get wrong: WHICH kind, WHERE it goes, and WHAT it must not touch.
 * Returns '' when there's nothing to build (no usable name) so callers refuse early.
 */
export function composeBuilderBrief(kind: DesignerKind, f: DesignerFields, opts: BriefOptions): string {
  const slug = slugify(f.name);
  if (!slug) return '';
  const home = designerHome(kind, slug);
  const dest = opts.mode === 'update' && opts.targetPath ? opts.targetPath : home;
  const L: string[] = [];

  L.push(opts.mode === 'update'
    ? `Update my existing custom AIOS ${kind} "${slug}".`
    : `Create a new custom AIOS ${kind} for me: "${f.name}" (slug \`${slug}\`).`);
  L.push('');
  L.push(`It must live at \`${dest}\` and follow the framework's conventions for a ${kind} exactly — the frontmatter contract, \`custom/\` placement, and the \`_index.md\` update that goes with it.`);
  L.push('');
  L.push('## What I want it to do');
  L.push(f.body.trim() || '(I only filled in the fields below — infer what you can and ask me about anything essential that is missing.)');
  L.push('');
  L.push('## Fields I filled in');
  L.push(`- **name**: ${f.name}`);
  if (f.description.trim()) L.push(`- **description**: ${f.description.trim()}`);
  if (f.keywords && f.keywords.trim()) L.push(`- **keywords**: ${f.keywords.trim()}`);
  if (kind === 'agent' && f.tier) {
    L.push(`- **model tier**: ${f.tier} (${f.tier === 'mechanical' ? 'cheaper/faster — deterministic work' : 'frontier — real judgment'})`);
  }
  L.push('');

  if (opts.templatePath) {
    L.push('## Use this as a shape reference');
    L.push(`Read \`${opts.templatePath}\` and follow its structure and level of craft. It is a BUNDLED unit: read it, never modify it.`);
    L.push('');
  }
  if (opts.mode === 'update' && opts.targetPath) {
    L.push('## Scope');
    L.push(`Edit ONLY \`${opts.targetPath}\`. Keep what still applies; don't rewrite it from scratch unless I asked for that above.`);
    L.push('');
  }

  L.push('## Ground rules');
  L.push('- Write only inside the `custom/` namespace — never a bundled `aios/` or company unit.');
  // aios-builder's step 3 is registration ("the whole point of this agent"): agents need
  // tags + the custom _index row; skills need skills/setup.sh + a verified
  // ~/.claude/skills/<name>; plugins need marketplace.json. Naming it keeps a hurried run
  // from stopping at "file written".
  if (kind === 'command' && opts.mode === 'create') {
    // Commands can't stand alone: Claude Code loads them from a plugin. Reuse the
    // operator's plugin when they have one — minting a second plugin per command would
    // scatter their commands across namespaces.
    const mine = (opts.plugins || []).filter(Boolean);
    L.push(mine.length === 1
      ? `- Put this command inside my existing custom plugin \`${mine[0]}\` (\`plugins/custom/${mine[0]}/commands/${slug}.md\`), so it becomes \`/${mine[0]}:${slug}\`. Don't create another plugin.`
      : mine.length > 1
        ? `- Put it inside one of my existing custom plugins (${mine.map((p) => `\`${p}\``).join(', ')}) — ask me which — rather than creating a new one.`
        // First command on a fresh vault: don't ask an open question ("what handle?"),
        // propose the operator's own name and let them override — the plugin is a
        // namespace they'll live with, so a sensible default beats a blank prompt.
        : `- I have no custom plugin yet, so create one first: \`plugins/custom/${opts.suggestedHandle || '<handle>'}/\` with its \`.claude-plugin/plugin.json\`, then put the command in its \`commands/\` folder — it becomes \`/${opts.suggestedHandle || '<handle>'}:${slug}\`. Confirm that handle with me before you commit to it (it prefixes every command I ever add).`);
    L.push('- Register the plugin in `.claude-plugin/marketplace.json` if it isn\'t there, and tell me if I need to restart my sessions for the command to load.');
  }
  L.push('- Do the REGISTRATION step, not just the file: the `_index.md` row, and for a skill `skills/setup.sh` (verify `~/.claude/skills/<slug>` exists), for a plugin the `.claude-plugin/marketplace.json` entry. Authored-but-unwired is a failure.');
  L.push('- Wire the frontmatter the convention requires (including `tools:` for an agent) from what I described — I did not fill that in.');
  L.push('- If what I described is too thin to make something genuinely useful, tell me what is missing and ask, rather than writing a hollow file.');
  L.push('- When it is written, show me the path and a one-line summary of what it does.');
  return L.join('\n');
}
