import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { nativeFields, uniqueCallIds } from '../lib/native-messages.mjs';
import { MAX_CONVERSATION_MESSAGES } from '../lib/history.mjs';
import { problem } from '../lib/engine.mjs';
import { claudeMessages } from '../lib/claude.mjs';
import { responsesRequest } from '../lib/chatgpt.mjs';

// (0.6.297) A service that numbers its calls from zero in each answer (« functions.local_read_resource:0 », an
// OpenAI-compatible one behind OpenRouter) gives two readings made in two turns the same identifier. The server
// kept it for the calls it answers itself, and the conversation, gone on with Claude, was refused at every message.
const SAME = 'functions_local_read_resource_0',
  call = id => ({ id, type: 'function', function: { name: 'local_read_resource', arguments: '{"refs":[1]}' } }),
  reading = (id, said) => [
    { role: 'assistant', content: '', tool_calls: [call(id)] },
    { role: 'tool', tool_call_id: id, content: '{"status":"loaded"}' },
    { role: 'assistant', content: said },
  ],
  history = [
    { role: 'system', content: 'Tu es un assistant.' },
    { role: 'user', content: 'Regarde #ref1' },
    ...reading(SAME, 'Une plage.'),
    { role: 'user', content: 'Et #ref2 ?' },
    ...reading(SAME, 'Une forêt.'),
    { role: 'user', content: 'Et #ref3 ?' },
    ...reading(SAME, 'Un phare.'),
    { role: 'user', content: 'Anime #ref2' },
  ],
  calls = messages => messages.flatMap(message => (message.tool_calls ?? []).map(made => made.id)),
  results = messages => messages.filter(message => message.role === 'tool').map(message => message.tool_call_id);

test('every call leaves for its model under an identifier of its own, its result with it (0.6.297)', () => {
  const sent = uniqueCallIds(history);
  assert.deepEqual(calls(sent), [SAME, SAME + '_2', SAME + '_3']);
  assert.deepEqual(results(sent), calls(sent), 'each result follows its call under the same identifier');
  // Nothing else is touched, and what the page and the disk hold stays as it is.
  assert.deepEqual(
    sent.map(message => [message.role, message.content]),
    history.map(message => [message.role, message.content]),
  );
  assert.deepEqual(calls(history), [SAME, SAME, SAME]);
  // A conversation without two calls of one identifier is given back as it is, message for message.
  const clean = uniqueCallIds(sent);
  assert.ok(clean.every((message, index) => message === sent[index]));
  // The name a call is given is never one another call has, before or after it.
  const crossed = uniqueCallIds([...reading(SAME, 'a'), ...reading(SAME + '_2', 'b'), ...reading(SAME, 'c'), ...reading(SAME + '_3', 'd')]);
  assert.deepEqual(calls(crossed), [SAME, SAME + '_2', SAME + '_3', SAME + '_3_2']);
  assert.deepEqual(results(crossed), calls(crossed));
  // As long as an identifier may be, it stays one.
  const long = 'a'.repeat(128),
    renamed = calls(uniqueCallIds([...reading(long, 'a'), ...reading(long, 'b')]));
  assert.deepEqual(renamed, [long, 'a'.repeat(126) + '_2']);
  assert.doesNotThrow(() => nativeFields({ role: 'tool', tool_call_id: renamed[1] }));
});

test('what the server sends of a conversation kept with twice the same identifier is taken by Claude and ChatGPT (0.6.297)', async () => {
  // What /api/chat makes of the messages of a request (chatPayload), as the server runs it.
  const source = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
    start = source.indexOf('function chatPayload('),
    context = { problem, nativeFields, uniqueCallIds, MAX_CONVERSATION_MESSAGES, Buffer };
  assert.ok(start > 0);
  runInNewContext(source.slice(start, source.indexOf('/** 32 random bytes kept', start)) + '\nthis.chatPayload = chatPayload;', context);
  const payload = JSON.parse(JSON.stringify(context.chatPayload({ messages: history }, true, 1024)));
  assert.deepEqual(calls(payload.messages), [SAME, SAME + '_2', SAME + '_3']);
  assert.deepEqual(results(payload.messages), calls(payload.messages));

  // Claude: no two « tool_use » of one identifier, each « tool_result » answering its own.
  const blocks = claudeMessages(payload.messages).messages.flatMap(turn => turn.content),
    used = blocks.filter(block => block.type === 'tool_use').map(block => block.id),
    answered = blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id);
  assert.deepEqual([used, answered], [calls(payload.messages), calls(payload.messages)]);
  // ChatGPT: the same of its « function_call » and their outputs.
  const input = responsesRequest(payload, 'gpt-5').input,
    asked = input.filter(item => item.type === 'function_call').map(item => item.call_id),
    given = input.filter(item => item.type === 'function_call_output').map(item => item.call_id);
  assert.deepEqual([asked, given], [calls(payload.messages), calls(payload.messages)]);
});
