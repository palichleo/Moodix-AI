import { familyPrompt } from './families.mjs';
import { TASKS } from './tasks.mjs';

/**
 * The Studio: the creation tools used by hand, without the chat model. Its results are kept
 * like those of a conversation, under one fixed identifier that is no conversation's.
 */
export const STUDIO_ID = '57ad1000-0000-4000-8000-000000000001';
/** What the Studio may start itself: the click on « Générer » is the confirmation. */
export const STUDIO_VERBS = [
  'create_image',
  'create_video',
  'extend_video',
  'replace_character',
  'create_audio',
  'upscale',
  'interpolate',
  // (0.6.242) « Changer la caméra » of a clip: the user's own hand only, never a tool of Moodix AI.
  'refilm_video',
];

const MADE = {
  create_image: 'an image',
  create_video: 'a video clip',
  extend_video: 'the continuation of a video clip',
  replace_character: 'a video in which the character of an image takes the place of a person of an existing video',
};

/**
 * The messages that make the chat model turn what the user typed in the Studio into the full
 * prompt a generator needs: nothing asked for is dropped, what is missing is added. `preferences`
 * are the user's standing instructions (the global ones of the application), which win.
 */
export function enrichMessages(prompt, { verb = 'create_image', preferences = '', family = '' } = {}) {
  const task = MADE[verb] ? verb : 'create_image',
    idea = String(prompt ?? '')
      .trim()
      .slice(0, 4000),
    wishes = String(preferences ?? '')
      .trim()
      .slice(0, 2000);
  const usual =
    `You rewrite what the user typed into the prompt of ${MADE[task]}, for a generator that only reads this prompt. ` +
    'Keep everything the user asked for (the subject, the action, the place, the mood, any words to show or to say) and add what is missing. ' +
    `What the prompt must be: ${TASKS[task].prompt} `;
  // (0.6.282) The model in hand when its family reads its prompt its own way (Qwen-Image-Edit: an instruction that
  // edits the images given, nothing added that the user did not ask to change); the guide of the verb otherwise.
  const own = familyPrompt(family, task);
  const system =
    (own
      ? `You rewrite what the user typed into the prompt of ${MADE[task]}. Keep everything the user asked for. ` +
        `What the prompt must be: ${own} `
      : usual) +
    'Answer with the prompt alone: no preamble, no title, no quotes, no list, no explanation.' +
    (wishes ? `\nThe user's standing instructions, which come first where they differ: ${wishes}` : '');
  return [
    { role: 'system', content: system },
    { role: 'user', content: idea },
  ];
}

const PAIRS = { '"': '"', "'": "'", '«': '»', '“': '”' };
/**
 * (0.6.318) A text without the pair of quotes around it all, and only that pair: one that ends or starts the
 * words said (`A man says: "Hello."`, `"Hello," she says. "Come back."`) stays. An apostrophe between two
 * letters (`'A fox's tail'`) is none.
 */
function unquoted(text) {
  const whole = text.trim(),
    open = whole[0],
    close = PAIRS[open],
    inner = whole.slice(1, -1);
  if (!close || whole.length < 2 || !whole.endsWith(close)) return whole;
  const marks = open === "'" ? inner.replace(/(?<=\p{L})'(?=\p{L})/gu, '') : inner;
  return marks.includes(open) || marks.includes(close) ? whole : inner.trim();
}

/** The model's answer as the prompt alone: no thinking block, label or quotes around it; 4000 characters at most. */
export function enrichedPrompt(text) {
  const lines = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
  return unquoted(unquoted(lines).replace(/^(?:enriched |rewritten |final )?prompt\s*:\s*/i, ''))
    .slice(0, 4000)
    .trim();
}
