import { readFileSync } from 'node:fs';

/** The verbs the chat model calls, with their roles and what their prompt says (lib/tasks.json): read once. */
export const TASKS = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
