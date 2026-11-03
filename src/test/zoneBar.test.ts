/**
 * The zone header — tabs scroll, controls stay.
 *
 * Each zone's header used to be ONE horizontally scrolling strip holding the tabs AND the zone's
 * controls (+, Chat | Terminal, expand). Only expand was sticky, so a long session name or a narrow
 * zone pushed the (+) and the Chat | Terminal switch past the right edge, and expand sat on top of
 * the tab name. The controls now live beside the scroller, not inside it, and the (+) pins to the
 * scroller's edge. This is guarded structurally: a control moved back into the strip would pass
 * every behavioural test and only show up at a narrow width.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const html = fs.readFileSync('renderer/index.html', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');

for (const [strip, z] of [['tabs', 'Main'], ['ttabs', 'Term']] as const) {
  test(`#${strip}: Chat | Terminal and expand sit outside the scrolling strip`, () => {
    const m = new RegExp(`<div class="zbar"><div id="${strip}" class="tabstrip">([\\s\\S]*?)</div>([\\s\\S]*?)</div>`).exec(html);
    assert.ok(m, `#${strip} is not wrapped in a .zbar — the controls would scroll with the tabs`);
    const [, inside, beside] = m;
    assert.match(inside, /class="newTab"/, 'the (+) stays with the tabs it adds to');
    assert.doesNotMatch(inside, /zview|zexp/, 'no zone control inside the scroller');
    assert.match(beside, new RegExp(`id="zview${z}"`), 'Chat | Terminal beside the scroller');
    assert.match(beside, new RegExp(`id="zexp${z}"`), 'expand beside the scroller');
  });
}

test('the strip can shrink, and the (+) pins to its edge when tabs overflow', () => {
  assert.match(css, /\.tabstrip \{[^}]*flex: 1 1 auto; min-width: 0;/, 'the scroller shrinks instead of pushing the controls out');
  assert.match(css, /\.tabstrip \.newTab \{[^}]*position: sticky; right: 0;/, 'the (+) is never scrolled away');
});
