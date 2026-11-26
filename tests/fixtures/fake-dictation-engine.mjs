// Moteur de dictée de test : il répond comme llama-server à /health et à /v1/audio/transcriptions, sans modèle.
// Il écrit sur sa sortie ce qu'il a reçu (lancement, formulaire), que les tests lisent dans les journaux du moteur.
import http from 'node:http';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  // As llama-server says it, on its error stream.
  console.error('version: 1 (fake)\nbuilt with node');
  process.exit(0);
}
const arg = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
if (!args.includes('--offline') || arg('--host') !== '127.0.0.1') process.exit(2);
// A card that refuses the model (FAKE_REFUSE): what llama.cpp says then, and it stops.
if (process.env.FAKE_REFUSE && Number(arg('--n-gpu-layers')) > 0) {
  console.error('0.01.002.003 E llama_model_load: error loading model: cudaMalloc failed: out of memory');
  process.exit(1);
}
const key = arg('--api-key');
console.log(
  'Lancé : ' +
    JSON.stringify({
      command: process.env.FAKE_COMMAND,
      threads: arg('--threads'),
      layers: arg('--n-gpu-layers'),
      context: arg('--ctx-size'),
      projector: arg('--mmproj'),
      offload: !args.includes('--no-mmproj-offload'),
    }),
);
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"status":"ok"}');
  }
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401);
    return res.end();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url !== '/v1/audio/transcriptions') {
    res.writeHead(404);
    return res.end();
  }
  const form = await new Request('http://127.0.0.1/', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] },
    body: Buffer.concat(chunks),
  }).formData();
  const file = form.get('file');
  console.log(
    'Reçu : ' +
      JSON.stringify({
        model: form.get('model'),
        format: form.get('response_format'),
        language: form.get('language'),
        prompt: form.get('prompt'),
        bytes: file?.size ?? 0,
        type: file?.type ?? '',
      }),
  );
  // The text as Qwen3-ASR may give it: its marks before, spaces around.
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'transcript.text.done', text: ' language French<asr_text>Un chat roux  sur un toit. ' }));
  }, Number(process.env.FAKE_DELAY || 0));
});
server.listen(Number(arg('--port')), '127.0.0.1');
