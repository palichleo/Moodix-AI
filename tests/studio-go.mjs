import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
/** The declarations of the rule written exactly with `selector`. */
function rule(selector) {
  const at = css.indexOf('\n' + selector + ' {\n');
  assert.ok(at >= 0, 'no rule ' + selector);
  return css.slice(at, css.indexOf('\n}', at + 1));
}

test('Générer: dark, its triangle and word centred, 46 px, 8 px corners (moodix-design.md 7 bis 22)', () => {
  const go = rule('#studio-view .studio-go');
  for (const declaration of [
    'min-width: 170px;',
    'height: calc(var(--format-button) + 2 * var(--format-inset));',
    'padding: 0 20px;',
    'border: 1px solid #2e323c;',
    'border-radius: 8px;',
    'background: #1c1f26;',
    'color: #ffffff;',
    'font-weight: 800;',
    'font-size: var(--size-4);',
    'justify-content: center;',
    'gap: 10px;',
  ])
    assert.ok(go.includes(declaration), declaration);
  const glyph = rule('#studio-view .studio-go svg');
  assert.match(glyph, /width: 14px;[^]*height: 14px;[^]*fill: currentColor;/);
  // No red band, no « Ctrl ↵ », no brightness on hover, no 40 % greying.
  assert.doesNotMatch(css, /studio-go-key/);
  assert.doesNotMatch(css, /\.studio-go[^{]*\{[^}]*(--fn-action|brightness|opacity: 0\.4)/);
});

test('its foot: the gradient of the filet, fixed, over all', () => {
  assert.match(css, /--mdx-gradient: linear-gradient\(90deg, #3d6bf5 19%, #22a060 47\.6%, #f6c343 71\.4%, #e8402f 92\.9%\);/);
  const foot = rule('#studio-view .studio-go::before');
  assert.match(foot, /bottom: 0;[^]*left: 0;[^]*z-index: 2;[^]*height: 3px;[^]*background: var\(--mdx-gradient\);/);
  assert.doesNotMatch(foot, /animation/);
});

test('hovered or focused, unavailable, and under way', () => {
  assert.match(rule('#studio-view .studio-go:is(:hover, :focus-visible):enabled'), /background: #252932;[^]*border-color: #3a3f4a;/);
  assert.match(rule('#studio-view .studio-go:focus-visible'), /outline: 2px solid var\(--focus\);/);
  const dim = rule("#studio-view .studio-go.is-unavailable,\n#studio-view .studio-go:disabled:not([role='progressbar'])");
  assert.match(dim, /background: #121318;[^]*border-color: #22252c;[^]*color: var\(--text-4\);/);
  assert.match(css, /#studio-view \.studio-go:disabled:not\(\[role='progressbar'\]\)::before \{\n {2}display: none;/);
  // (0.6.186, measured in the page on 21/11) In the group of the Salle obscure its words stayed lit when it
  // was greyed for a model that cannot run here or for a creation made elsewhere: the rule of the group
  // comes after the one above and is as precise. What cannot be pressed dims its words there, after it.
  const held = "#studio-view .studio-go-group .studio-go:disabled:not([role='progressbar']) :is(.studio-go-label, svg)";
  assert.match(
    rule('#studio-view .studio-go.is-blank,\n#studio-view .studio-go-group .studio-go.is-blank :is(.studio-go-label, svg),\n' + held),
    /color: rgba\(238, 232, 222, 0\.45\);/,
  );
  assert.ok(css.indexOf(held) > css.indexOf('#studio-view .studio-go-group:not(.is-checking) .studio-go {'), 'after the rule of the group');
  // Under way: the bar fills the whole height from the left, under the words; mono 14 px.
  assert.match(rule('.studio-go-bar'), /top: 0;[^]*bottom: 0;[^]*z-index: 0;[^]*width: calc\(var\(--studio-progress, 0\) \* 100%\);[^]*background: #2c313b;/);
  assert.match(rule("#studio-view .studio-go[role='progressbar'] .studio-go-label"), /font-family: var\(--font-mono\);[^]*font-size: var\(--size-3\);[^]*font-weight: 600;/);
  assert.match(rule("#studio-view .studio-go[role='progressbar'] svg"), /display: none;/);
  assert.match(rule('#studio-view .studio-go:disabled'), /cursor: progress;/);
});

test('(0.6.474) it does not move under the pointer: the line above it keeps its place, the Sortie its height', () => {
  // (Étude du 27/11, défaut 2.) A failure said under the buttons pushed « Générer » up by 31 to 50 px, down again as
  // it went; the row of the Sortie was 104 to 132 px high from one project to the next (a sound alone, empty, full),
  // and when « EN COURS » came in it. The line is above the buttons, one line high, taken from the screen: under
  // them, its room was the one the menu of the Caméra and « Plus de réglages » need above « Générer ». Measured in
  // the page by scripts/check-ui.mjs.
  const under = rule('#studio-view .studio-under');
  assert.match(under, /flex: none;[^]*align-self: stretch;[^]*height: 19px;[^]*margin: -4px 0;/);
  assert.match(under, /overflow: hidden;[^]*line-height: 19px;/);
  assert.match(
    rule('#studio-view .studio-under > *'),
    /overflow: hidden;[^]*white-space: nowrap;[^]*text-overflow: ellipsis;/,
  );
  // The row of an empty Sortie (its line of 117 px and its margins of 4), full or not.
  assert.match(rule('#studio-view .studio-block.is-output .studio-sortie-row'), /flex: none;[^]*height: 125px;/);
  assert.match(rule('.studio-empty-strip'), /height: 117px;[^]*margin: 4px;/);
});
