"""Qwen-Image-Edit-2511's transformer, computed with comfy-kitchen's fused kernels.

diffusers' QwenImageTransformer2DModel is the reference: the model is built from it, empty, its
layers take their weights from the engine's pool (runner.models.pool), and `reference` runs its
own forward. That forward writes every intermediate out, the rotary embedding as a product of
complex numbers in float32, and it computes again at every step what depends on the step alone.
`predict` computes the same products in the same order, as runner.models.wan_block does for Wan:

- The tokens of the image are two runs: the picture being made, then the images given with it.
  2511 reads the given ones at timestep 0 (`zero_cond_t`; its file says so with a tensor named
  `__index_timestep_zero__`): diffusers holds both runs in one sequence and picks the modulation
  of every token with torch.where, six times a block. Here each run is normalised and modulated
  with its own row in one kernel (adaln), and the end of each branch is summed into it by the INT8
  product itself, with its own gate (one value per channel).
- The queries and the keys are normalised and turned in place by one kernel (rms_rope_), from
  rotation matrices built once per picture (`prepare`): the positions do not change from a step
  to the next.
- The joint attention of the text and of both runs goes through cuDNN's kernel, or comfy-kitchen's
  INT8 one (runner.models.attention8), in diffusers' order: text, made, given.
- The modulations depend on the timestep alone, and the steps of Lightning are always the same:
  they are computed once for every step of a picture (`modulations`), and the pipeline keeps them
  on the disk. Their layers (two of 3072 x 18432 a block: a third of the file) are not read at
  every step, nor held in page-locked RAM: see `ONCE`.
- In the last block, what would only carry the given images and the text further is not
  computed: the output reads the made picture alone.

Rounding once where the separate steps rounded each time, a pass differs from diffusers' by what
bfloat16 itself cannot hold.
"""

import re
from types import SimpleNamespace

import torch
import torch.nn.functional as F

HEADS = 24
HEAD = 128
LAYERS = 60
TEXT_WIDTH = 3584
CHANNELS = 16
PATCH = 2
ROPE = (16, 56, 56)
EPS = 1e-6
# A feed-forward runs this many tokens at a time (its inner layer is four times as wide).
ROWS = 8192
KERNELS = ('adaln', 'rms_rope_')
# The tensor by which Comfy-Org's file of 2511 says its given images read timestep 0.
ZERO = '__index_timestep_zero__'
# What a file holds beside the model's own parameters: the notes and scales of its INT8 layers.
BESIDE = ('.comfy_quant', '.weight_scale', '.scale_weight', '.scale_input')
PREFIX = 'model.diffusion_model.'
# The layers a picture reads once, not at every step (see `modulations`): the embedding of the
# timesteps, the modulation of each block and that of the output.
ONCE = re.compile(
    r'^(?:time_text_embed\.timestep_embedder\.linear_[12]|norm_out\.linear'
    r'|transformer_blocks\.\d+\.(?:img|txt)_mod\.1)$'
)


def architecture(layers=LAYERS, heads=HEADS, text_width=TEXT_WIDTH, zero=True, empty=True):
    """The model as diffusers builds it, empty (on the meta device) unless `empty` is False (the
    tests give it weights of their own)."""
    from diffusers import QwenImageTransformer2DModel

    config = dict(
        patch_size=PATCH,
        in_channels=CHANNELS * PATCH * PATCH,
        out_channels=CHANNELS,
        num_layers=layers,
        attention_head_dim=HEAD,
        num_attention_heads=heads,
        joint_attention_dim=text_width,
        guidance_embeds=False,
        axes_dims_rope=ROPE,
        zero_cond_t=zero,
    )
    if not empty:
        return QwenImageTransformer2DModel(**config)
    from accelerate import init_empty_weights

    with init_empty_weights():
        return QwenImageTransformer2DModel(**config)


def names(header):
    """{parameter of the model: ('model', its key in the file, None)}: every tensor of the file but
    the notes and scales of its INT8 layers (the pool reads them beside their weights) and its
    mark of timestep 0. With or without ComfyUI's prefix."""
    prefix = PREFIX if any(key.startswith(PREFIX) for key in header) else ''
    found = {}
    for key in header:
        if key == '__metadata__' or key.removeprefix(prefix) == ZERO or key.endswith(BESIDE):
            continue
        found[key.removeprefix(prefix)] = ('model', key, None)
    return found


def validate_layout(header):
    """(names, whether the given images read timestep 0) of a file of Qwen-Image-Edit, every tensor
    in its place and of its size; else a ValueError that says what the file is not."""
    prefix = PREFIX if any(key.startswith(PREFIX) for key in header) else ''
    entry = header.get(prefix + 'img_in.weight')
    if entry is None or not any(key.startswith(prefix + 'transformer_blocks.') for key in header):
        raise ValueError('Ce fichier n’est pas un modèle Qwen-Image : il n’a pas les couches attendues.')
    found = names(header)
    model = architecture(zero=(prefix + ZERO) in header)
    wanted = {name: tuple(parameter.shape) for name, parameter in model.named_parameters()}
    missing = sorted(wanted.keys() - found.keys())
    if missing:
        raise ValueError(
            'Ce fichier n’est pas un modèle Qwen-Image-Edit complet : il lui manque ' + missing[0] + '.'
        )
    extra = sorted(found.keys() - wanted.keys())
    if extra:
        raise ValueError('Tenseur inattendu pour Qwen-Image-Edit : ' + found[extra[0]][1])
    for name, shape in wanted.items():
        if tuple(header[found[name][1]]['shape']) != shape:
            raise ValueError('Taille inattendue pour Qwen-Image-Edit : ' + found[name][1])
    return found, (prefix + ZERO) in header


def once(model):
    """The paths of the layers read once a picture (ONCE), in the model's order."""
    return [name for name, module in model.named_modules() if isinstance(module, torch.nn.Linear) and ONCE.match(name)]


class _Apart(torch.nn.Module):
    """A layer read once a picture, left out of the model whose steps run (see `split`)."""

    def __init__(self, path):
        super().__init__()
        self.path = path

    def forward(self, *_args, **_kwargs):
        raise RuntimeError(self.path + ' is read once a picture: see runner.models.qwen_image.modulations')


def split(model):
    """The layers read once a picture leave `model` (each for an _Apart that refuses to run), so
    that the pool built over it serves the steps alone: none of them stays on the card nor is held
    in page-locked RAM, and the order of the layers it learns is the order of a step. Returns
    {path: the empty layer it was}, for `layers` to build them over a pool of their own."""
    taken = {}
    for path in once(model):
        taken[path] = model.get_submodule(path)
        model.set_submodule(path, _Apart(path))
    return taken


def layers(taken, names, pool):
    """{path: layer} of the layers read once a picture, over `pool` (one of their own, which keeps
    nothing on the card: they run once)."""
    from runner.models.pool import load_streamed

    holder = torch.nn.Module()
    renamed = {}
    for index, (path, module) in enumerate(taken.items()):
        label = 'layer' + str(index)
        holder.add_module(label, module)
        renamed[label + '.weight'] = names[path + '.weight']
    holder = load_streamed(holder, renamed, pool)
    return {path: getattr(holder, 'layer' + str(index)) for index, path in enumerate(taken)}


def modulations(model, timesteps, built=None, zero=True):
    """The modulation of every block and of the output for each of `timesteps` (the σ a picture
    runs through, the last 0 left out), computed together:

    - `img` [blocks, steps + 1, 6 x 3072]: the rows of the made picture, one per step, then the row
      the given images read (timestep 0; the step's own row without `zero`, set apart all the same);
    - `txt` [blocks, steps, 6 x 3072]: the rows of the text;
    - `out` [steps, 2 x 3072]: the scale and the shift of the output's norm.

    As diffusers computes them: the timestep in the precision of the tokens, its sinusoidal
    embedding, two layers, then SiLU and each block's own layer (with what a LoRA adds to it).
    `built`: {path: layer} of the layers read once (see `layers`); the model's own where absent.
    """
    built = built or {}

    def layer(path):
        return built.get(path) or model.get_submodule(path)

    blocks = model.transformer_blocks
    reference = next(parameter for parameter in model.parameters() if parameter.is_floating_point())
    dtype = reference.dtype if reference.device.type != 'meta' else torch.bfloat16
    device = torch.device('cuda') if reference.device.type == 'meta' else reference.device
    values = torch.tensor([float(value) for value in timesteps] + [0.0], device=device).to(dtype)
    sinusoid = model.time_text_embed.time_proj(values).to(dtype)
    embedder = 'time_text_embed.timestep_embedder.'
    embedded = layer(embedder + 'linear_2')(F.silu(layer(embedder + 'linear_1')(sinusoid)))
    activated = F.silu(embedded)
    steps = activated[:-1]
    count = len(blocks)
    image = torch.stack([layer(f'transformer_blocks.{index}.img_mod.1')(activated) for index in range(count)])
    if not zero:
        # Without timestep 0 the given images read the step's own row: the last one is never read.
        image[:, -1] = 0
    return dict(
        img=image,
        txt=torch.stack([layer(f'transformer_blocks.{index}.txt_mod.1')(steps) for index in range(count)]),
        out=layer('norm_out.linear')(steps),
    )


def _table(freqs):
    """diffusers' rotary frequencies of Qwen, [tokens, head size / 2] complex numbers, as the
    matrices comfy-kitchen reads: [1, tokens, 1, head size / 2, 2, 2] in float32, [[cos, -sin],
    [sin, cos]] for each pair of channels (pairs 2k, 2k + 1: diffusers' complex view)."""
    c, s = freqs.real.float(), freqs.imag.float()
    return torch.stack((c, -s, s, c), dim=-1).unflatten(-1, (2, 2))[None, :, None].contiguous()


def shapes(made, given):
    """The grids of tokens of the picture and of each image given, as diffusers' `img_shapes` of one
    sample: [(1, rows, columns), ...]. `made`, `given`: (height, width) of the latents."""
    return [(1, height // PATCH, width // PATCH) for height, width in [made, *given]]


def pack(latents):
    """[1, 16, height, width] latents as the model reads them: [1, tokens, 64], 2 x 2 at a time."""
    _, channels, height, width = latents.shape
    value = latents.view(1, channels, height // PATCH, PATCH, width // PATCH, PATCH).permute(0, 2, 4, 1, 3, 5)
    return value.reshape(1, (height // PATCH) * (width // PATCH), channels * PATCH * PATCH)


def unpack(tokens, height, width):
    """The inverse of `pack`: [1, 16, height, width]."""
    value = tokens.view(1, height // PATCH, width // PATCH, CHANNELS, PATCH, PATCH).permute(0, 3, 1, 4, 2, 5)
    return value.reshape(1, CHANNELS, height, width)


def positions(model, grid, length, device):
    """The rotary frequencies of the picture and the images given (`grid`), and of `length` tokens of text, on
    `device`: diffusers' position embedding, asked on the processor and laid on the device here.

    (0.6.462) The library keeps for ever what it computes for a device (functools.lru_cache on its position
    embedding): asked for the card, it kept 8 MiB there after every picture (four tables of complex numbers).
    The engine could then never say the card was free again (« GPU cleanup incomplete: 0.007782 GiB still
    allocated »): « carte restée prise » after a retouch that had worked. They are computed once a picture:
    nothing is lost."""
    images, said = model.pos_embed([grid], max_txt_seq_len=length, device=torch.device('cpu'))
    return images.to(device), said.to(device)


def prepare(model, text, given, grid, mods, zero=True, int8_attention=False):
    """What every step of a picture reads, computed once:

    - `text`: the encoder's [1, tokens, 3584] as the blocks read it (txt_norm, txt_in);
    - `given`: the images given, [1, tokens, 64] packed one after the other, as the blocks read
      them (img_in); None without any;
    - the rotation matrices of the text, of the picture and of the images given (`grid`: see
      `shapes`, the picture first);
    - `mods`: see `modulations`.
    """
    words = model.txt_in(model.txt_norm(text))
    held = model.img_in(given) if given is not None and given.shape[1] else None
    images, said = positions(model, grid, words.shape[1], words.device)
    made = grid[0][1] * grid[0][2]
    return SimpleNamespace(
        text=words,
        given=held,
        tables=(_table(said), _table(images[:made]), _table(images[made:]) if held is not None else None),
        mods=mods,
        zero=zero,
        int8_attention=int8_attention,
    )


def _heads(value):
    return value.unflatten(-1, (-1, HEAD))


def _projected(attn, normed, table, added):
    """Queries, keys and values of one run, [1, tokens, heads, 128], the queries and the keys
    normalised and turned (rms_rope_). `added`: the text's own layers (add_*_proj)."""
    import comfy_kitchen

    if added:
        layers, norms = (attn.add_q_proj, attn.add_k_proj, attn.add_v_proj), (attn.norm_added_q, attn.norm_added_k)
    else:
        layers, norms = (attn.to_q, attn.to_k, attn.to_v), (attn.norm_q, attn.norm_k)
    query, key, value = (_heads(layer(normed)) for layer in layers)
    # Detached: the kernel refuses tensors that keep a gradient, parameters included.
    weights = (norm.weight.detach().to(query.dtype) for norm in norms)
    comfy_kitchen.rms_rope_(query, key, table, *weights, norms[0].eps)
    return query, key, value


def _attend(query, key, value, fast):
    """Attention of [1, tokens, heads, 128] queries over keys and values, [1, tokens, heads, 128]."""
    from runner.models import attention8
    from runner.models.ltx25_block import _attention

    if fast:
        # The kernel reads [batch, heads, tokens, head size]. (A row it fails on is computed again.)
        return attention8.attend(query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2)).transpose(1, 2)
    return _attention(query, key, value)


def _feed(mlp, stream, scale, shift, gate):
    """The feed-forward of one run summed into it, a few thousand rows at a time (`stream` is the
    caller's to write: the block made it)."""
    import comfy_kitchen

    from runner.models.ltx25_block import _joined

    normed = comfy_kitchen.adaln(stream, scale, shift, EPS)
    project, out = mlp.net[0].proj, mlp.net[2]
    for start in range(0, normed.shape[1], ROWS):
        rows = slice(start, start + ROWS)
        stream[:, rows] = _joined(out, project(normed[:, rows]), stream[:, rows], gate, act='gelu_tanh', own=False)
    return stream


def _rows(value):
    """A block's modulation row [6 x 3072] as its six [1, 1, 3072] parts: shift, scale and gate of
    the attention, then of the feed-forward (diffusers' order)."""
    return [part.view(1, 1, -1) for part in value.chunk(6)]


def block(module, made, given, text, rows, prepared, last=False):
    """One of diffusers' QwenImageTransformerBlock, the picture and the images given as two runs:
    (made, given, text) after it, (made, None, None) for the last one. `rows`: the block's
    modulations (made, given, text), see `modulations`. The tensors handed in are not written."""
    import comfy_kitchen

    from runner.models.ltx25_block import _joined

    attn = module.attn
    own, words = _rows(rows[0]), _rows(rows[2])
    held = _rows(rows[1]) if given is not None else None
    # In diffusers' order: the text, the picture, the images given.
    runs = [(text, words, prepared.tables[0], True), (made, own, prepared.tables[1], False)]
    if given is not None:
        runs.append((given, held, prepared.tables[2], False))
    queries, keys, values = [], [], []
    for stream, (shift, scale, *_), table, added in runs:
        normed = comfy_kitchen.adaln(stream, scale, shift, EPS)
        query, key, value = _projected(attn, normed, table, added)
        del normed
        queries.append(query)
        keys.append(key)
        values.append(value)
    del runs
    counts = [part.shape[1] for part in keys]
    key, value = torch.cat(keys, dim=1), torch.cat(values, dim=1)
    del keys, values
    # The last block reads the picture's own queries alone: nothing after it reads the others.
    query = queries[1] if last else torch.cat(queries, dim=1)
    del queries
    seen = _attend(query, key, value, prepared.int8_attention).flatten(2, 3)
    del query, key, value
    if last:
        made = _joined(attn.to_out[0], seen.type_as(made), made, own[2], own=False)
        return _feed(module.img_mlp, made, own[4], own[3], own[5]), None, None
    parts = seen.split(counts, dim=1)
    del seen
    # The streams handed in are the caller's (the same text and images at every step): each first
    # sum writes a new one, and the feed-forward writes in that one.
    text = _joined(attn.to_add_out, parts[0].type_as(text), text, words[2], own=False)
    made = _joined(attn.to_out[0], parts[1].type_as(made), made, own[2], own=False)
    if given is not None:
        given = _joined(attn.to_out[0], parts[2].type_as(given), given, held[2], own=False)
    del parts
    made = _feed(module.img_mlp, made, own[4], own[3], own[5])
    if given is not None:
        given = _feed(module.img_mlp, given, held[4], held[3], held[5])
    text = _feed(module.txt_mlp, text, words[4], words[3], words[5])
    return made, given, text


def predict(model, prepared, latents, step):
    """What the model draws at step `step` for the picture's packed latents [1, tokens, 64], in the
    precision of the tokens (the given images and the text are those of `prepared`)."""
    import comfy_kitchen

    made = model.img_in(latents)
    given, text = prepared.given, prepared.text
    mods = prepared.mods
    blocks = model.transformer_blocks
    for index, module in enumerate(blocks):
        image = mods['img'][index]
        rows = (image[step], image[-1] if prepared.zero else image[step], mods['txt'][index][step])
        made, given, text = block(module, made, given, text, rows, prepared, last=index == len(blocks) - 1)
    scale, shift = (part.view(1, 1, -1) for part in mods['out'][step].chunk(2))
    return model.proj_out(comfy_kitchen.adaln(made, scale, shift, EPS))


def reference(model, latents, given, text, sigma, grid):
    """diffusers' own forward for the same picture: what `predict` gives, the way diffusers computes
    it, for the tests to compare them. (Never run for an image: preflight refuses a card without
    the kernels, and the model of the steps lacks the layers read once a picture, see split.)"""
    hidden = latents if given is None else torch.cat([latents, given], dim=1)
    timestep = torch.as_tensor(sigma, device=latents.device).reshape(1).to(latents.dtype)
    out = model(
        hidden_states=hidden,
        timestep=timestep,
        encoder_hidden_states=text,
        encoder_hidden_states_mask=None,
        img_shapes=[grid],
        guidance=None,
        attention_kwargs={},
        return_dict=False,
    )[0]
    return out[:, : latents.shape[1]]


def fusable():
    """Whether `predict` can run: comfy-kitchen is there, with its kernels."""
    try:
        import comfy_kitchen
    except ImportError:
        return False
    return all(hasattr(comfy_kitchen, name) for name in KERNELS)


def int8_attention_available():
    """Whether comfy-kitchen's INT8 attention runs on this card."""
    try:
        import comfy_kitchen

        return bool(comfy_kitchen.int8_attention_is_available(torch.device('cuda')))
    except Exception:
        return False
