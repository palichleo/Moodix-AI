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

test('(0.6.466) the queue: « Générer ensuite », « Reprendre » and its lines in the window, no text under 12 px', () => {
  const glass = '#studio-view .studio-go-group:not(.is-checking) .studio-go-glass';
  // « ▸ Générer ensuite · 46 % » in the glass of « Générer » while a take of the Studio is made.
  assert.match(rule('#studio-view .studio-go-glass.is-working.is-next'), /width: auto;[^]*min-width: 266px;/);
  assert.match(rule(glass + '.is-working .studio-go.is-next'), /justify-content: flex-start;[^]*cursor: pointer;/);
  assert.match(rule(glass + ".is-working .studio-go.is-next[aria-disabled='true']"), /cursor: default;/);
  const percent = rule('#studio-view .studio-go-percent');
  assert.match(percent, /margin-left: auto;[^]*font: 500 12\.5px\/1 var\(--font-mono\);/);
  // « ▸ Reprendre · 3 | × »: its cross in the place of « Arrêter », of its size.
  assert.match(rule(glass + '.is-paused .studio-go'), /min-width: 168px;/);
  assert.match(rule(glass + ' .studio-clear'), /width: 54px;[^]*height: 100%;[^]*background: transparent;/);
  assert.match(rule('#studio-view .studio-go-glass .studio-clear:focus-visible'), /outline: 2px solid var\(--focus\);/);
  // (0.6.478, variante A) A request is a line of the window at the bottom right, no more a tile of the Sortie: its
  // title in small capitals of 10.5 px, its prompt on one line (13 px), its model, its format and its tries (12 px).
  assert.doesNotMatch(css, /is-queued|studio-queued/);
  assert.match(css, /--size-label: 10\.5px;/);
  assert.match(rule('.work-mini-queue-title'), /font: 400 var\(--size-label\) \/ 1 var\(--font-mono\);[^]*uppercase;/);
  assert.match(rule('.work-mini-row-text'), /font: 400 13px\/1\.25 var\(--font-ui\);[^]*text-overflow: ellipsis;/);
  assert.match(rule('.work-mini-row-what'), /font: 400 12px\/1\.2 var\(--font-ui\);/);
  assert.match(rule('.work-mini-queue-head.is-paused .work-mini-queue-title > b'), /color: var\(--warning\);/);
  assert.match(rule('.work-mini-row.is-failed .work-mini-row-words'), /cursor: pointer;/);
  // Four lines and a half in sight (three and a half on a low page), the list scrolls in the window, never the page.
  assert.match(rule('.work-mini-rows'), /max-height: calc\(4\.5 \* 46px \+ 4 \* 2px\);[^]*overflow-y: auto;/);
  assert.match(css, /@media \(max-height: 800px\) \{\n {2}\.work-mini-rows \{\n {4}max-height: calc\(3\.5 \* 46px/);
  // Lying in the Studio, its foot stays in sight at the bottom of the window, its lines scrolling under it.
  const foot = rule('.work-mini.is-docked .work-mini-foot');
  assert.match(foot, /position: sticky;[^]*bottom: 0;[^]*background: var\(--surface\);/);
  // Nothing fades in, nothing blinks; no size under 12 px but that of the small capitals.
  const queue = css.slice(css.indexOf('(0.6.466) The queue of the Studio'));
  assert.doesNotMatch(queue, /animation|opacity|transition: (?!none;)/);
  const sizes = [...queue.matchAll(/font(?:-size)?: (?:\d+ )?(\d+(?:\.\d+)?)px/g)].map(([, size]) => Number(size));
  assert.ok(sizes.length > 4 && sizes.every(size => size >= 12), sizes.join(' '));
});
