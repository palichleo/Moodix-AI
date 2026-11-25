import { problem } from './engine.mjs';
import { TASKS } from './tasks.mjs';

// Tool names a stored conversation may contain: current generation verbs, earlier names and local readers.
const TOOL_NAMES = new Set([
  ...Object.keys(TASKS),
  'generate_image',
  'generate_video',
  'comfy_generate_image',
  'comfy_generate_video',
  'local_read_resource',
  'local_read_output',
]);
/**
 * The longest arguments of a call, as text: room for the largest call the tools allow, a prompt of
 * 8 000 characters and a series of nineteen of 3 000 (lib/tasks.json: 65 000 in all), with its
 * other arguments and what JSON adds to them. At 64 000, that call was cut in the middle of its
 * stream, and refused when the conversation was read again.
 */
export const MAX_CALL_ARGUMENTS = 96000;

export function nativeFields(message) {
  const result = {};
  if (message.role === 'tool') {
    if (typeof message.tool_call_id !== 'string' || !/^[-A-Za-z0-9_]{1,128}$/.test(message.tool_call_id))
      throw problem('Identifiant d’appel invalide.');
    result.tool_call_id = message.tool_call_id;
  }
  if (message.tool_calls !== undefined) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length !== 1)
      throw problem('Appel de fonction invalide.');
    result.tool_calls = message.tool_calls.map(call => {
      if (
        call?.type !== 'function' ||
        !/^[-A-Za-z0-9_]{1,128}$/.test(call.id) ||
        !TOOL_NAMES.has(call.function?.name) ||
        typeof call.function.arguments !== 'string' ||
        call.function.arguments.length > MAX_CALL_ARGUMENTS
      )
        throw problem('Appel de fonction invalide.');
      try {
        JSON.parse(call.function.arguments);
      } catch {
        throw problem('Paramètres d’appel invalides.');
      }
      return {
        id: call.id,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments },
      };
    });
  }
  return result;
}

/**
 * (0.6.297) The messages of a conversation with every call under an identifier of its own, its result with it.
 * A service that numbers its calls from zero in each answer (« functions.local_read_resource:0 ») gives the same
 * identifier to two readings made in two turns; a call the server answers itself (a reading, a call sent back
 * to the model) kept it, and a conversation gone on with Claude was refused whole at every message: two
 * « tool_use » of one identifier. Renamed where the conversation leaves for its model, in its order: one kept
 * so before this is repaired too, and what the page and the disk hold is not touched.
 */
export function uniqueCallIds(messages) {
  const taken = new Set();
  // The calls of the last message that made some, by the identifier the conversation gave them.
  let renamed = new Map();
  return messages.map(message => {
    if (message.tool_calls?.length) {
      renamed = new Map();
      const calls = message.tool_calls.map(call => {
        let id = call.id;
        for (let n = 2; taken.has(id); n++) id = call.id.slice(0, 128 - String(n).length - 1) + '_' + n;
        taken.add(id);
        if (id === call.id) return call;
        renamed.set(call.id, id);
        return { ...call, id };
      });
      return renamed.size ? { ...message, tool_calls: calls } : message;
    }
    return message.role === 'tool' && renamed.has(message.tool_call_id)
      ? { ...message, tool_call_id: renamed.get(message.tool_call_id) }
      : message;
  });
}
