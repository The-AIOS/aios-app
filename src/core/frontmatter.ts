/**
 * Pure YAML-frontmatter reader — NO vscode import. Shared by commands / agents /
 * skills discovery, unit-testable outside the extension host.
 */

export interface Frontmatter {
  name?: string;
  description?: string;
  argumentHint?: string;
  /** Optional codicon id an element can declare to style its terminal/UI. */
  icon?: string;
  /** Optional search synonyms (`keywords: social media, posts, linkedin`) —
   *  folded into pickers' matched detail so intent words find the element. */
  keywords?: string;
  tags: string[];
}

/**
 * Minimal YAML-frontmatter reader. The command files use a flat shape
 * (description / argument-hint scalars, a `tags:` block list), so a full
 * YAML dependency would be overkill for v1.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const fm: Frontmatter = { tags: [] };
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return fm;

  const lines = match[1].split(/\r?\n/);
  let inTags = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^tags:\s*$/.test(line)) {
      inTags = true;
      continue;
    }
    if (inTags) {
      const item = line.match(/^\s*-\s+(.+)$/);
      if (item) {
        fm.tags.push(stripQuotes(item[1].trim()));
        continue;
      }
      inTags = false; // dedented out of the tags block
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = stripQuotes(kv[2].trim());
    if (key === 'name') fm.name = value;
    else if (key === 'description') fm.description = value;
    else if (key === 'icon') fm.icon = value;
    else if (key === 'keywords') fm.keywords = value.replace(/^\[|\]$/g, '').trim();
    else if (key === 'argument-hint') fm.argumentHint = value;
    else if (key === 'tags' && value) {
      // inline list form: tags: [a, b]
      fm.tags.push(...value.replace(/^\[|\]$/g, '').split(',').map((s) => stripQuotes(s.trim())).filter(Boolean));
    }
  }
  return fm;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}
