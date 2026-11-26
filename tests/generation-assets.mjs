import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GenerationAssets } from '../lib/generation-assets.mjs';

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-assets-'));
  try {
    await fn(directory, new GenerationAssets(join(directory, 'assets.json')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function weights(path, tensors) {
  const header = Buffer.from(JSON.stringify(tensors));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  await writeFile(
    path,
    Buffer.concat([
      prefix,
      header,
      Buffer.alloc(Math.min(10240, Math.max(...Object.values(tensors).map(tensor => tensor.data_offsets[1])))),
    ]),
  );
}
const tensor = { dtype: 'F32', shape: [1], data_offsets: [0, 4] };
const encoderTensor = { dtype: 'F32', shape: [1, 2560], data_offsets: [0, 10240] };

test('registered assets use inspected local checkpoint headers and persisted stable IDs', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'anything.safetensors');
    await weights(path, { 'model.embed_tokens.weight': encoderTensor });
    const saved = await assets.register({
      id: 'encoder',
      name: 'My encoder',
      path,
      kind: 'textEncoder',
      family: 'krea2',
    });
    assert.equal(saved.path, await realpath(path));
    assert.equal(
      (await assets.resolve('encoder', { kind: 'textEncoder', family: 'krea2' })).path,
      await realpath(path),
    );
    assert.equal((await new GenerationAssets(assets.file).read('encoder')).name, 'My encoder');
    await assert.rejects(assets.resolve('encoder', { kind: 'vae', family: 'krea2' }), /kind|compatible/i);
    await assert.rejects(assets.resolve('encoder', { kind: 'textEncoder', family: 'ltx25' }), /family|compatible/i);
    assert.equal((await assets.list()).length, 1);
    const unnamed = await assets.register({ path, kind: 'textEncoder', family: 'krea2' });
    assert.equal(unnamed.name, 'My encoder');
    assert.equal(unnamed.id, saved.id);
    assert.equal((await assets.list()).length, 1);
  });
});

test('invalid header and incompatible layouts cannot overwrite a registered asset', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'valid.safetensors');
    await weights(path, { 'model.embed_tokens.weight': encoderTensor });
    await assets.register({ id: 'encoder', path, kind: 'textEncoder', family: 'krea2' });
    const before = await readFile(assets.file, 'utf8');
    const bad = join(directory, 'bad.safetensors');
    await writeFile(bad, 'not weights');
    await assert.rejects(
      assets.register({ id: 'encoder', path: bad, kind: 'textEncoder', family: 'krea2' }),
      /header|safetensors/i,
    );
    await assert.rejects(
      assets.register({ id: 'encoder', path, kind: 'vae', family: 'krea2' }),
      /structure de ce fichier/,
    );
    assert.equal(await readFile(assets.file, 'utf8'), before);
    await weights(bad, { 'model.embed_tokens.weight': { ...tensor, data_offsets: [0, 400] } });
    await assert.rejects(assets.register({ path: bad, kind: 'textEncoder', family: 'krea2' }), /offset|size|header/i);
  });
});

test('corrupted registry entries are isolated with an actionable warning', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'encoder.safetensors');
    await weights(path, { 'model.embed_tokens.weight': encoderTensor });
    const saved = await assets.register({ id: 'encoder', path, kind: 'textEncoder', family: 'krea2' });
    await writeFile(assets.file, JSON.stringify({ schemaVersion: 1, assets: [saved, { id: '../unsafe' }] }));
    assert.deepEqual(
      (await assets.list()).map(asset => asset.id),
      ['encoder'],
    );
    assert.match(assets.warnings[0], /unsafe|invalid|entry/i);
  });
});

test('checkpoint role checks reject tensor names with the wrong basic shape', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'wrong-shape.safetensors');
    await weights(path, { 'model.embed_tokens.weight': tensor });
    await assert.rejects(
      assets.register({ id: 'wrong', path, kind: 'textEncoder', family: 'krea2' }),
      /structure de ce fichier/,
    );
  });
});

test('MOSS Image: the model itself is refused as its text encoder, and each file only in its own role', async () => {
  await fixture(async (directory, assets) => {
    const wide = { dtype: 'F16', shape: [1, 4096], data_offsets: [0, 8192] };
    // The diffusion model, as its file is laid out: the projection of the text encoder's 4096 values.
    const model = join(directory, 'MOSS-Image-SFT-INT8.safetensors');
    await weights(model, {
      'text_embedder.proj.weight': wide,
      'layers.0.proj.qkv.weight': { dtype: 'I8', shape: [4], data_offsets: [8192, 8196] },
    });
    // Its text encoder, a Qwen3.5-9B: a table of token embeddings 4096 wide.
    const encoder = join(directory, 'qwen3.5_9b.safetensors');
    await weights(encoder, { 'model.language_model.embed_tokens.weight': wide });
    // A smaller Qwen (2560 wide) is another model's encoder.
    const small = join(directory, 'qwen_4b.safetensors');
    await weights(small, { 'model.embed_tokens.weight': encoderTensor });
    const vae = join(directory, 'flux2-vae.safetensors');
    await weights(vae, {
      'encoder.conv_in.weight': { dtype: 'F32', shape: [1, 3, 3, 3], data_offsets: [0, 108] },
      'decoder.conv_in.weight': { dtype: 'F32', shape: [1, 32, 3, 3], data_offsets: [108, 1260] },
    });
    const register = (path, kind) => assets.register({ path, kind, family: 'moss' });

    // What happened: the model picked in the text encoder's place. It is said in the user's words.
    await assert.rejects(
      register(model, 'textEncoder'),
      /La structure de ce fichier n’est pas celle attendue pour « Encodeur de texte » \(MOSS Image\)\. Attendu : .*Qwen3\.5-9B.*non le modèle/,
    );
    await assert.rejects(register(small, 'textEncoder'), /structure de ce fichier/);
    await assert.rejects(register(encoder, 'model'), /structure de ce fichier/);
    await assert.rejects(register(model, 'vae'), /structure de ce fichier/);
    assert.equal((await register(model, 'model')).kind, 'model');
    assert.equal((await register(encoder, 'textEncoder')).kind, 'textEncoder');
    assert.equal((await register(vae, 'vae')).kind, 'vae');
  });
});

test('a model file is inspected again once it changed, never taken from what was kept', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'encoder.safetensors');
    await weights(path, { 'model.embed_tokens.weight': encoderTensor });
    await assets.register({ id: 'encoder', path, kind: 'textEncoder', family: 'krea2' });
    const first = await assets.resolve('encoder', { kind: 'textEncoder', family: 'krea2' });
    assert.deepEqual(await assets.resolve('encoder', { kind: 'textEncoder', family: 'krea2' }), first);
    // Another file in its place, of another layout: refused, as it would be the first time.
    await weights(path, { 'unrelated.weight': tensor });
    await assert.rejects(
      assets.resolve('encoder', { kind: 'textEncoder', family: 'krea2' }),
      /structure|signature|attendu/i,
    );
  });
});

test('a model found again by its name is remembered while it stays there, searched again once gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assets-locate-'));
  const first = join(root, 'first'),
    second = join(root, 'second');
  await mkdir(join(first, 'sub'), { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(first, 'sub', 'model.safetensors'), 'x');
  let roots = [first, second];
  const assets = new GenerationAssets(join(root, 'registry.json'), { roots: () => roots });
  try {
    assert.equal(await assets.locate('model.safetensors'), join(first, 'sub', 'model.safetensors'));
    // A namesake appears where it would be found first: the file found stays while it is there
    // (the folders are not read again at each call)...
    await writeFile(join(first, 'model.safetensors'), 'y');
    assert.equal(await assets.locate('model.safetensors'), join(first, 'sub', 'model.safetensors'));
    // ...and once gone, the folders are searched again.
    await rm(join(first, 'sub', 'model.safetensors'));
    assert.equal(await assets.locate('model.safetensors'), join(first, 'model.safetensors'));
    // Other folders: searched in them alone.
    roots = [second];
    assert.equal(await assets.locate('model.safetensors'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('a LoRA is never stood for by another: by its id, by its name, or it is missing (0.6.421)', async () => {
  const { isLora } = await import('../lib/generation-assets.mjs'),
    { basename } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'atelier-loras-'));
  try {
    const loras = join(directory, 'loras'),
      models = join(directory, 'vae');
    await mkdir(loras);
    await mkdir(models);
    const assets = new GenerationAssets(join(directory, 'assets.json'), {
      roots: () => [directory],
      folder: (family, kind) => [isLora(family, kind) ? loras : models],
    });
    const part = (rows, columns, at = 0) => ({ dtype: 'I8', shape: [rows, columns], data_offsets: [at, at + rows * columns] }),
      // Any LoRA of LTX 2.5 has this layout, any of Wan that one: nothing in them tells one from another.
      ltx = { 'blocks.0.attn1.to_k.lora_A.weight': part(1, 4096), 'blocks.0.attn1.to_k.lora_B.weight': part(4096, 1, 4096) },
      wan = { 'blocks.0.self_attn.q.lora_down.weight': part(1, 5120), 'blocks.0.self_attn.q.lora_up.weight': part(5120, 1, 5120) },
      ID = '11111111-1111-4111-8111-111111111111',
      MSR = 'LTX-2.5-Licon-MSR-V1.safetensors',
      missing = asked => assert.rejects(assets.resolve(ID, asked), /not found/);
    await weights(join(loras, 'a-style.safetensors'), ltx);
    await weights(join(loras, 'another-wan-lora.safetensors'), wan);
    // The folder still answers for who asks it (a component no workflow fixes): unchanged.
    assert.equal(basename((await assets.pick('lora', 'ltx25')).path), 'a-style.safetensors');
    assert.equal(basename((await assets.pick('stepLora', 'wan22')).path), 'another-wan-lora.safetensors');
    // The LoRA a workflow names is not there: missing, whatever the folder holds. The style was taken for
    // the subjects of LTX 2.5, the other LoRA of Wan for each of those of Wan 2.2 and of SCAIL-2.
    await missing({ kind: 'lora', family: 'ltx25', file: MSR });
    await missing({ kind: 'lora', family: 'ltx25' });
    for (const [family, kind] of [['wan22', 'stepLora'], ['wan22', 'stepLoraLow'], ['wan_scail2', 'stepLora'], ['wan_scail2', 'identityLora'], ['ltx25_refilm', 'guideLora'], ['qwen_image_edit', 'stepLora']]) {
      assert.equal(isLora(family, kind), true, kind);
      await missing({ kind, family, file: 'absent.safetensors' });
    }
    // There under its name: that file, registered under the id the workflow gives it.
    await weights(join(loras, MSR), ltx);
    const found = await assets.resolve(ID, { kind: 'lora', family: 'ltx25', file: MSR });
    assert.deepEqual([basename(found.path), found.id, found.automatic], [MSR, ID, undefined]);
    // Registered, its file gone since: found again under its name elsewhere, never replaced by another.
    await rm(join(loras, MSR));
    await assert.rejects(assets.resolve(ID, { kind: 'lora', family: 'ltx25', file: MSR }), { code: 'ENOENT' });
    await mkdir(join(directory, 'elsewhere'));
    await weights(join(directory, 'elsewhere', MSR), ltx);
    const moved = await assets.resolve(ID, { kind: 'lora', family: 'ltx25', file: MSR });
    assert.deepEqual([basename(moved.path), moved.automatic], [MSR, true]);
    // What is not a LoRA is as before: another file of the same layout stands for the one that is gone.
    assert.deepEqual([isLora('ltx25', 'vae'), isLora('ltx25', 'model'), isLora('unknown', 'model')], [false, false, false]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
