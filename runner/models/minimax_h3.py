"""Native MiniMax-H3 DiT for the pruned 8-step checkpoints (FastH3 Omni / FastH3 v2).

The block stack is diffusers' `MiniMaxH3Transformer3DModel` (Apache-2.0). The
pruned checkpoints differ from it in three places, adapted here:
- no timestep MLP: an `adaln_t_table` curve of 1025 points is linearly
  interpolated at t, and the AdaLN projections read it without SiLU;
- the output heads may hold several "PDD" heads (Omni: 32), blended per
  sampling step from the step's sigma interval;
- Comfy single-file layout: fused `qkv_proj` stacked [q; k; v], `fc1` stored
  [gate; value], int8 ConvRot linears streamed from the file.
"""

import math

import torch
import torch.nn.functional as F

from runner.models import attention8

RENAMES = (
    ('token_refiner.blocks.', 'token_refiner.refiner_blocks.'),
    ('video_patch_proj.', 'proj_in.'),
    ('audio_patch_proj.', 'audio_proj_in.'),
    ('condition_proj.', 'context_embedder.'),
    ('final_layer.norm.', 'norm_out.norm.'),
    ('final_layer.adaln_proj.linear.', 'norm_out.linear.'),
    ('final_layer.video_out.', 'proj_out.'),
    ('final_layer.audio_out.', 'audio_proj_out.'),
    ('.attn.q_norm.', '.attn.norm_q.'),
    ('.attn.k_norm.', '.attn.norm_k.'),
    ('.attn.out_proj.', '.attn.to_out.0.'),
    ('.mlp.fc1.', '.ff.net.0.proj.'),
    ('.mlp.fc2.', '.ff.net.2.'),
)
# Attention through the INT8 kernel when the GPU has it (see Int8Attention); False keeps
# PyTorch's exact attention, about a third slower on a 5 s draft and more on longer videos.
INT8_ATTENTION = True
VIDEO_PATCH = 96
AUDIO_PATCH = 32
VIDEO_SHIFT = 12.0
AUDIO_SHIFT = 3.0


# (0.6.423) A step adapter (pi H3): the role of its file among the stores of the pool, and the tensors
# of its pixel head, which are not the DiT's (runner.models.minimax_h3_dwd).
ADAPTER = 'stepAdapter'
PIXEL_HEAD = ('dwd_norm_out.', 'dwd_pixel_refiner.')
# What a layer reads beside its weight (runner.models.pool, BESIDE), and the quantization it says.
BESIDE_WEIGHT = ('.weight_scale', '.comfy_quant')


def _renamed(key):
    """The diffusers parameter name of a checkpoint key."""
    name = 'transformer_blocks.' + key[len('blocks.') :] if key.startswith('blocks.') else key
    for old, new in RENAMES:
        name = name.replace(old, new)
    # The file's fused [q; k; v] stays one projection (see architecture).
    return name.replace('.attn.qkv_proj.', '.attn.to_qkv.')


def names(header, gate=False, adapter=None):
    """{diffusers parameter name: (role, checkpoint key, qkv part or None)}.

    `gate` adds the sparse attention's gates (`to_gate_compress`, 1.9 GiB in INT8): only the
    sparse attention reads them, so a dense generation neither loads nor reads ahead them.
    `adapter` (the header of a step adapter) gives the tensors it replaces whole to its own file."""
    result = {}
    for key in header:
        if key == '__metadata__' or not key.endswith(('.weight', '.bias')):
            continue
        if (not gate and '.to_gate_compress.' in key) or key.startswith('rope.'):
            # RoPE is recomputed.
            continue
        result[_renamed(key)] = ('model', key, None)
    for key in replaced(adapter or {}):
        result[_renamed(key)] = (ADAPTER, key, None)
    return result


def replaced(adapter):
    """The tensors of the model a step adapter replaces whole, by their key (which is the model's): all
    that is neither its pixel head, nor a LoRA matrix, nor read beside a weight. For pi H3: the AdaLN
    projection of the 50 blocks, the three INT8 layers of blocks 46 to 49, and the final layer."""
    return [
        key
        for key in adapter
        if key != '__metadata__'
        and key.endswith(('.weight', '.bias'))
        and not key.startswith(PIXEL_HEAD)
        and '.lora_' not in key
    ]


def validate_adapter(header, adapter):
    """Raise, in the user's words, unless `adapter` is a step adapter (pi H3) for the model of `header`:
    every tensor of it is a LoRA pair for a layer of the model, a tensor of the model's own shape that
    replaces it, what a replaced layer reads beside its weight, or its pixel head (checked by
    runner.models.minimax_h3_dwd). Whether it was tuned on this very model is another check, which
    reads values (fits_base): MiniMax's Ref2VA has every shape of FL2VA."""
    from runner.models.lora_keys import lora_pairs

    if pdd_heads(header) > 1 or has_gates(header):
        raise ValueError(
            'pi H3 se calcule avec le modèle MiniMax H3 de base (FL2VA) : le modèle choisi est un modèle '
            'distillé (FastH3), qui a déjà ses propres étapes.'
        )
    ours = [key for key in adapter if key != '__metadata__' and not key.startswith(PIXEL_HEAD)]
    pairs, left = lora_pairs(ours, {key for key in header if key != '__metadata__'})
    wrong = ValueError(
        'Ce fichier n’est pas un adaptateur pi H3 pour MiniMax H3 : ses couches ne sont pas les siennes.'
    )
    if not pairs:
        raise wrong
    for target, (down, up, _alpha) in pairs.items():
        low, high = adapter[down]['shape'], adapter[up]['shape']
        if len(low) != 2 or len(high) != 2 or low[0] != high[1] or [high[0], low[1]] != header[target]['shape']:
            raise wrong
    whole = set(replaced(adapter))
    for key in left:
        if key in whole:
            if key not in header or adapter[key]['shape'] != header[key]['shape']:
                raise wrong
        elif not key.endswith(BESIDE_WEIGHT) or key[: key.rindex('.')] + '.weight' not in whole:
            raise wrong
    if 'final_layer.video_out.weight' not in whole or pdd_heads(adapter) != 1:
        raise wrong


def fits_base(model, adapter, key='blocks.0.adaln_proj.linear.weight'):
    """Whether the step adapter at `adapter` was tuned on the very model at `model` (two paths). Its AdaLN
    projections are the model's, barely moved: cosine 0.993 to 1.000 with MiniMax's FL2VA. Ref2VA and
    FastH3 Omni have the same shapes and another basis for their curve table: -0.69 to -0.83 (measured
    on 26 November 2026). Nothing else tells them apart, and the adapter turns their modulations upside
    down. Two tensors of 1.5 MB are read."""
    from safetensors import safe_open

    with safe_open(str(model), framework='pt') as base, safe_open(str(adapter), framework='pt') as tuned:
        ours, theirs = base.get_tensor(key).float().flatten(), tuned.get_tensor(key).float().flatten()
    return ours.shape == theirs.shape and float(F.cosine_similarity(ours, theirs, dim=0)) > 0.9


def pdd_heads(header):
    rows = header['final_layer.video_out.weight']['shape'][0]
    if rows % VIDEO_PATCH or header['final_layer.audio_out.weight']['shape'][0] != rows // VIDEO_PATCH * AUDIO_PATCH:
        raise ValueError('Unsupported MiniMax-H3 output heads')
    return rows // VIDEO_PATCH


def validate(header):
    """Raise unless the file is a pruned (AdaLN curve) MiniMax-H3 DiT this runner can stream."""
    if 'adaln_t_table' not in header:
        raise ValueError('Only the pruned MiniMax-H3 checkpoints (adaln_t_table) are supported')
    model, _ = architecture(header)
    expected = {name: list(value.shape) for name, value in model.state_dict().items()}
    mapped = names(header)
    for name, shape in expected.items():
        if name == 'time_embedder.table':
            continue
        location = mapped.get(name)
        if location is None:
            raise ValueError('Missing MiniMax-H3 tensor: ' + name)
        actual = list(header[location[1]]['shape'])
        if location[2] is not None:
            actual[0] //= 3
        if name in ('proj_out.weight', 'proj_out.bias', 'audio_proj_out.weight', 'audio_proj_out.bias'):
            actual[0] //= pdd_heads(header)
        if actual != shape:
            raise ValueError(f'Incompatible MiniMax-H3 tensor {name}: {actual} != {shape}')
    return pdd_heads(header)


class CurveEmbedding(torch.nn.Module):
    """t in [0, 1] -> linear interpolation of the AdaLN curve table."""

    def __init__(self, points, width):
        super().__init__()
        self.table = torch.nn.Parameter(torch.empty(points, width, dtype=torch.float32), requires_grad=False)

    def forward(self, timestep):
        last = self.table.shape[0] - 1
        position = timestep.float().clamp(0, 1) * last
        low = position.floor().long().clamp(max=last - 1)
        fraction = (position - low).unsqueeze(-1)
        table = self.table.float()
        return torch.lerp(table[low], table[low + 1], fraction)


def _curve_modulation(self, temb):
    # Curve form: the projection reads the interpolated table directly, without SiLU.
    temb = self.linear(temb.float()).to(torch.bfloat16)
    return temb.view(-1, 6 * self.hidden_size).chunk(6, dim=-1)


def _curve_norm_out(self, hidden_states, temb, timestep_indices):
    shift, scale = self.linear(temb.float()).float().chunk(2, dim=-1)
    hidden_states = self.norm(hidden_states).float()
    return hidden_states * (1.0 + scale.index_select(0, timestep_indices)) + shift.index_select(0, timestep_indices)


def runs(indices, limit=64):
    """The rows of the packed sequence as runs sharing one modulation row: [(start, stop, row)],
    computed once per forward (the 50 blocks share `indices`). None past `limit` runs."""
    found = getattr(indices, '_runs', False)
    if found is False:
        flat = indices.reshape(-1)
        cuts = (torch.nonzero(flat[1:] != flat[:-1]).flatten() + 1).tolist()
        found = None
        if len(cuts) < limit:
            bounds = [0, *cuts, flat.numel()]
            rows = flat[torch.tensor(bounds[:-1], device=flat.device)].tolist()
            found = list(zip(bounds[:-1], bounds[1:], rows))
        indices._runs = found
    return found


def _block_forward(self, hidden_states, temb, adaln_indices, rotary_emb, attention_mask=None):
    """diffusers' MiniMaxH3TransformerBlock.forward, modulated run by run in place.

    diffusers picks the six modulation vectors row by row (`index_select`): six tensors as
    large as the sequence per block (0.4 GiB each at 1344 x 768), read and written again
    by every product. The rows come in a handful of runs (text, sound, video, conditions),
    each with one vector: the same products in the same precision, on the runs in place.
    """
    found = runs(adaln_indices)
    if found is None:
        return self._reference_forward(hidden_states, temb, adaln_indices, rotary_emb, attention_mask)
    shift_msa, scale_msa, gate_msa, shift_mlp, scale_mlp, gate_mlp = self.adaln_proj(temb)

    def modulate_(value, scale, shift):
        for start, stop, row in found:
            value[:, start:stop].mul_(1.0 + scale[row]).add_(shift[row])
        return value

    def gate_(value, gate):
        for start, stop, row in found:
            value[:, start:stop].mul_(gate[row])
        return value

    attn_output = self.attn(modulate_(self.norm1(hidden_states), scale_msa, shift_msa), rotary_emb, attention_mask)
    hidden_states = hidden_states + gate_(attn_output, gate_msa)
    del attn_output
    ff_output = self.ff(modulate_(self.norm2(hidden_states), scale_mlp, shift_mlp))
    return hidden_states.add_(gate_(ff_output, gate_mlp))


def _gate_first_swiglu(self, rows):
    # The checkpoint's fc1 holds [gate; value].
    gate, value = self.proj(rows).chunk(2, dim=-1)
    return F.silu(gate) * value


def _chunked_feed_forward(self, hidden_states, chunk=8192):
    # Rows go in chunks, so the 28672-wide intermediate of a ~50k-row sequence never exists at
    # once; each chunk's result is written straight into its place (a concatenation copied the
    # whole output again, twice for a single chunk: 0.1 s a step on a 5 s draft).
    flat = hidden_states.reshape(-1, hidden_states.shape[-1])

    def run(rows):
        # Streamed INT8 layers take the gated activation into their quantizer (pool, act).
        if hasattr(self.net[2], 'location'):
            return self.net[2](self.net[0].proj(rows), act='swiglu')
        return self.net[2](_gate_first_swiglu(self.net[0], rows))

    if flat.shape[0] <= chunk:
        return run(flat).reshape(*hidden_states.shape[:-1], -1)
    out = None
    for start in range(0, flat.shape[0], chunk):
        piece = run(flat[start : start + chunk])
        if out is None:
            out = piece.new_empty(flat.shape[0], piece.shape[-1])
        out[start : start + piece.shape[0]] = piece
        del piece
    return out.reshape(*hidden_states.shape[:-1], -1)


# The smallest piece of the queries of a dense attention computed in pieces: whole blocks of
# the 128 rows the kernel quantizes together.
PIECE = 128 * 32


class Int8Attention:
    """Attention through comfy-kitchen's INT8 kernel, the method of SageAttention: queries, keys
    and values are quantized to 8 bits for the tensor cores and the softmax stays in FP32.

    Attention is the one cost of the model that grows with the square of the video's length and
    size; this kernel runs it two to three times faster than PyTorch's."""

    def __call__(self, attn, hidden_states, rotary_emb=None, attention_mask=None, measure=None):
        """`measure`, when given, is shown the keys and values (see SparseAttention)."""
        query, key, value = project(attn, hidden_states, rotary_emb)
        if measure is not None:
            measure(key, value)
        # The kernel reads [batch, heads, sequence, head]; the model keeps heads third.
        try:
            # (Through runner.models.attention8: a row the kernel fails on is computed again.)
            result = attention8.attend(
                query.transpose(1, 2),
                key.transpose(1, 2),
                value.transpose(1, 2),
                attn_mask=attention_mask,
            )
        except torch.OutOfMemoryError:
            if attention_mask is not None:
                raise
            result = None
        if result is None:
            result = self.in_pieces(query, key, value).type_as(hidden_states)
            return attn.to_out[1](attn.to_out[0](result))
        del query, key, value
        result = result.transpose(1, 2).flatten(2, 3).type_as(hidden_states)
        return attn.to_out[1](attn.to_out[0](result))

    @staticmethod
    def in_pieces(query, key, value):
        """The same attention when the kernel's own buffers do not fit beside the sequence (a
        video of 1920 x 1088, or of 1344 x 768 with three references, on a 12 GiB card): the
        queries a piece at a time, each piece's answer written where its queries were (they
        are read no more). The kernel holds no quantized queries and no answer of the whole
        sequence: a width and a half less. Pieces are whole blocks of the kernel's queries
        (128 rows share a scale), so the answer is the one of the whole call."""
        from runner.models.ladder import in_pieces

        keys, values = key.transpose(1, 2), value.transpose(1, 2)

        def piece(start, stop):
            answer = attention8.attend(query[:, start:stop].transpose(1, 2), keys, values)
            query[:, start:stop] = answer.transpose(1, 2)

        rows = query.shape[1]
        in_pieces(piece, rows, torch, unit=PIECE, first=-(-rows // 2 // PIECE) * PIECE)
        return query.flatten(2, 3)


# Queries and keys normalised and turned by one comfy-kitchen kernel, in place in the fused
# projection (False: PyTorch's norm, then rotate_).
FUSED_ROPE = True


def rotation_table(cos, sin):
    """diffusers' rotary cos/sin, (rows, span) or (batch, rows, 1, span), as comfy-kitchen's
    split-half rotation table (batch, rows, 1, span/2, 2, 2) in float32: [[cos, -sin],
    [sin, cos]] per pair of channels. Built once per forward: the blocks share `cos`."""
    found = getattr(cos, '_table', None)
    if found is None:
        c, s = (cos[:, :, 0], sin[:, :, 0]) if cos.ndim == 4 else (cos[None], sin[None])
        half = c.shape[-1] // 2
        first = torch.stack([c[..., :half], -s[..., :half]], dim=-1)
        second = torch.stack([s[..., half:], c[..., half:]], dim=-1)
        found = torch.stack([first, second], dim=-2).float().unsqueeze(2)
        cos._table = found
    return found


def tiled_rotation(cos, sin, plan):
    """rotation_table laid out in the plan's blocks (zeros in the padding), built once per
    forward: the kernel keeps what it derives from it as long as it gets the same tensor."""
    found = getattr(cos, '_tiled', None)
    if found is None or found[0] is not plan:
        found = (plan, plan.tile(rotation_table(cos, sin)))
        cos._tiled = found
    return found[1]


def project(attn, hidden_states, rotary_emb):
    """The queries, keys and values, (batch, rows, heads, 128): views of one INT8 projection
    (the file's fused q, k, v: the rows are quantized once, not three times), the queries and
    keys normalised and turned in place."""
    import comfy_kitchen

    projected = attn.to_qkv(hidden_states)
    query, key, value = projected.unflatten(-1, (3, attn.heads, attn.head_dim)).unbind(2)
    if rotary_emb is not None and FUSED_ROPE:
        comfy_kitchen.rms_rope_split_half_(
            query,
            key,
            rotation_table(*rotary_emb),
            # Detached: the kernel refuses tensors that keep a gradient, parameters included.
            attn.norm_q.weight.detach(),
            attn.norm_k.weight.detach(),
            attn.norm_q.eps if attn.norm_q.eps is not None else 1e-6,
            rot_dim=rotary_emb[0].shape[-1],
        )
    else:
        query, key = attn.norm_q(query), attn.norm_k(key)
        if rotary_emb is not None:
            # Turned in place (same result as diffusers): four tensors of temporaries less.
            rotate_(query, *rotary_emb)
            rotate_(key, *rotary_emb)
    return query, key, value


def has_gates(header):
    """Whether the file carries the gates of a model trained with sparse attention (FastH3)."""
    return 'blocks.0.attn.to_gate_compress.weight' in header


class Sparse:
    """The sparse attention of one generation (see runner.models.sparse_attention): the share of
    the video's cubes each cube reads, and the plan of the step under way, None while the
    attention is dense. The pipeline sets `plan` before each step.

    The kernel quantizes a step with what the step before measured, layer by layer: the mean
    key and the scale of the values (`statistics`, by layer). `measure` asks a dense step for
    them, the one before the first sparse step: without them, that step would read each
    projection twice."""

    def __init__(self, keep):
        self.keep = keep
        self.plan = None
        self.plans = {}
        self.statistics = {}
        self.measure = False

    def prepare(self, values, grid):
        """The plan of the packed sequence this forward receives (kept for the next steps), or
        None when it is too short to gain from sparse attention or not laid out as expected."""
        from runner.models import sparse_attention

        rows = int(values['position_ids'].shape[0])
        if rows < sparse_attention.MIN_ROWS:
            return None
        if rows not in self.plans:
            found = segments(values, grid)
            self.plans[rows] = sparse_attention.layout(found).to('cuda') if found else None
        return self.plans[rows]


def segments(values, grid):
    """The packed sequence of a MiniMax-H3 forward as runs kept exact and the generated video's
    token grid, last: [text, conditions…, audio, (frames, height, width)]. A run never mixes
    two modalities, and two images or key frames (another rotary time) are two runs. None when
    the sequence does not end with that video."""
    import torch

    rows = int(values['position_ids'].shape[0])
    target = math.prod(grid)
    kind = torch.zeros(rows, dtype=torch.int8)
    kind[values['text_indices'].cpu()] = 1
    kind[values['audio_indices'].cpu()] = 2
    video = values['video_indices'].cpu()
    if target > rows or video.numel() < target or not torch.equal(video[-target:], torch.arange(rows - target, rows)):
        return None
    time = values['position_ids'][: rows - target, 0].cpu()
    head = kind[: rows - target]
    cuts = [0]
    if head.numel() > 1:
        change = (head[1:] != head[:-1]) | ((head[1:] == 0) & (time[1:] != time[:-1]))
        cuts += (torch.nonzero(change).flatten() + 1).tolist()
    cuts.append(rows - target)
    return [b - a for a, b in zip(cuts, cuts[1:]) if b > a] + [tuple(grid)]


def rotate_(value, cos, sin):
    """diffusers' _apply_rotary_emb (rotate_half over the first channels), in place, on a tensor
    nobody else holds: the same products and sums in the same precision, so the same result,
    with a third of a tensor of temporaries instead of four (0.5 GiB each at 1344 x 768)."""
    span = cos.shape[-1]
    half = span // 2
    cos = cos.to(value.dtype)[None, :, None, :]
    sin = sin.to(value.dtype)[None, :, None, :]
    first, second = value[..., :half], value[..., half:span]
    turned = first * cos[..., :half]
    turned -= second * sin[..., :half]
    crossed = first * sin[..., half:]
    second.mul_(cos[..., half:]).add_(crossed)
    first.copy_(turned)
    return value


class SparseAttention:
    """Video sparse attention on the steps that have a plan, `dense` on the others.

    The layer's input is laid out in blocks first: its fused q, k, v projection then comes
    out in the kernel's order, piece by piece, and the kernel normalises, turns and quantizes
    each piece as it comes (see sparse_attention.attend). The gate of the coarse branch
    (`to_gate_compress`) is one more INT8 projection of the same rows, computed only on the
    sparse steps. `index` is the layer's, for the statistics kept from one step to the next."""

    def __init__(self, sparse, dense, index):
        self.sparse = sparse
        self.dense = dense
        self.index = index

    def measure(self, key, value):
        from runner.models import sparse_attention

        self.sparse.statistics[self.index] = sparse_attention.statistics(key, value)

    def __call__(self, attn, hidden_states, rotary_emb=None, attention_mask=None):
        from runner.models import sparse_attention

        sparse = self.sparse
        plan = sparse.plan
        if (
            plan is None
            or attention_mask is not None
            or rotary_emb is None
            or hidden_states.shape[:2] != (1, plan.rows)
            or hidden_states.dtype != torch.bfloat16
            or attn.head_dim != sparse_attention.WIDTH
        ):
            if sparse.measure and isinstance(self.dense, Int8Attention) and attention_mask is None:
                return self.dense(attn, hidden_states, rotary_emb, attention_mask, measure=self.measure)
            return self.dense(attn, hidden_states, rotary_emb, attention_mask)
        rope = (
            tiled_rotation(*rotary_emb, plan),
            # Detached: the kernel refuses tensors that keep a gradient, parameters included.
            attn.norm_q.weight.detach(),
            attn.norm_k.weight.detach(),
            attn.norm_q.eps if attn.norm_q.eps is not None else 1e-6,
        )
        result, sparse.statistics[self.index] = sparse_attention.attend(
            plan.tile(hidden_states),
            attn.to_qkv,
            getattr(attn, 'to_gate_compress', None),
            plan,
            sparse.keep,
            attn.heads,
            rope,
            sparse.statistics.get(self.index),
        )
        return attn.to_out[1](attn.to_out[0](result.flatten(2, 3)))


def int8_attention_ready():
    try:
        import comfy_kitchen

        return bool(comfy_kitchen.int8_attention_is_available(torch.device('cuda')))
    except Exception:
        return False


def architecture(header, int8_attention=False, sparse=None):
    """Empty diffusers model adapted to the pruned checkpoint, and its PDD head count.

    With `sparse` (a Sparse), the attention of the 50 blocks becomes SparseAttention, with
    the file's gates when it has them (the text refiner stays dense)."""
    from accelerate import init_empty_weights
    from diffusers import MiniMaxH3Transformer3DModel
    from diffusers.models.attention import FeedForward
    from diffusers.models.transformers import transformer_minimax_h3 as reference

    points, width = header['adaln_t_table']['shape']
    with init_empty_weights():
        model = MiniMaxH3Transformer3DModel(time_embed_dim=width)
        model.time_proj = torch.nn.Identity()
        model.time_embedder = CurveEmbedding(points, width)
    for module in list(model.modules()):
        if isinstance(module, reference.MiniMaxH3AdaLayerNormModulation):
            module.forward = _curve_modulation.__get__(module)
        elif isinstance(module, reference.MiniMaxH3AdaLayerNormOut):
            module.forward = _curve_norm_out.__get__(module)
        elif isinstance(module, FeedForward):
            module.forward = _chunked_feed_forward.__get__(module)
        elif isinstance(module, reference.MiniMaxH3TransformerBlock):
            module._reference_forward = module.forward
            module.forward = _block_forward.__get__(module)
        elif isinstance(module, reference.MiniMaxH3Attention):
            # The file's fused [q; k; v] stays one projection: one quantization of the rows.
            with init_empty_weights():
                module.to_qkv = torch.nn.Linear(module.to_q.in_features, 3 * module.inner_dim, bias=False)
            del module.to_q, module.to_k, module.to_v
            module.fused_projections = True
            if int8_attention:
                module.processor = Int8Attention()
    if sparse is not None:
        for index, block in enumerate(model.transformer_blocks):
            attn = block.attn
            if has_gates(header):
                with init_empty_weights():
                    attn.to_gate_compress = torch.nn.Linear(
                        attn.to_qkv.in_features, attn.heads * attn.head_dim, bias=False
                    )
            attn.processor = SparseAttention(sparse, attn.processor, index)
    return model, pdd_heads(header)


def sigma_shift(sigma, shift):
    return shift * sigma / (1 + (shift - 1) * sigma)


def sigma_unshift(sigma, shift):
    return sigma / (shift - (shift - 1) * sigma)


class PDDHead(torch.nn.Module):
    """Output projection blending the checkpoint's per-interval heads for the current step.

    Head 0 is the base projection and heads 1..n-1 its per-interval corrections.
    A step from sigma to sigma_next covers the base-time interval
    [1 - unshift(sigma), 1 - unshift(sigma_next)]; the corrections of the heads
    in that interval are averaged with weights proportional to the length of
    each head's slot on the stream's shifted sigma grid.
    """

    def __init__(self, weight, bias, heads, shift):
        super().__init__()
        self.heads = heads
        self.shift = shift
        # Buffers, so diffusers' get_parameter_dtype finds this head's float32 precision.
        self.register_buffer('weight', weight.float().reshape(heads, -1, weight.shape[-1]), persistent=False)
        self.register_buffer('bias', bias.float().reshape(heads, -1), persistent=False)
        grid = sigma_shift(torch.linspace(1, 0, heads + 1, dtype=torch.float64), shift)
        self.slots = (grid[:-1] - grid[1:]).float()
        self.interval = None
        self.cache = {}

    def blend(self, sigma, sigma_next):
        n = self.heads
        start = round((1 - sigma_unshift(float(sigma), self.shift)) * n)
        stop = round((1 - sigma_unshift(float(sigma_next), self.shift)) * n)
        start = min(start, n - 1)
        stop = max(stop, start + 1)
        if (start, stop) not in self.cache:
            weights = self.slots[start:stop] / self.slots[start:stop].sum()
            weight, bias = self.weight[0].clone(), self.bias[0].clone()
            for k in range(max(start, 1), stop):
                weight += weights[k - start] * self.weight[k]
                bias += weights[k - start] * self.bias[k]
            self.cache = {(start, stop): (weight, bias)}
        return self.cache[(start, stop)]

    def forward(self, hidden_states):
        if self.heads == 1:
            weight, bias = self.weight[0], self.bias[0]
        else:
            if self.interval is None:
                raise RuntimeError('PDD head used without a sampling interval')
            weight, bias = self.blend(*self.interval)
        return F.linear(hidden_states.float(), weight, bias)


def load(header, pool, int8_attention=False, sparse=None, adapter=None):
    """Build the DiT on CUDA: int8 linears streamed through `pool`, small tensors resident.

    (0.6.423) With `adapter` (the header of a step adapter, its file open in the pool under ADAPTER): the
    tensors it replaces are read from its file (names), its LoRA pairs are computed beside the layers of
    the model (the pool's `adapters`, said by who builds the pool), and its final layer has one head."""
    from runner.models.pool import load_streamed

    model, heads = architecture(header, int8_attention, sparse)
    mapping = names(header, gate=sparse is not None, adapter=adapter)

    def tensor(name, dtype=None):
        role, key, _part = mapping.get(name, ('model', name, None))
        value = pool.stores[role].get_tensor(key)
        return value.to('cuda', dtype=dtype or value.dtype)

    def plain_linear(prefix, dtype=None):
        weight = tensor(prefix + '.weight', dtype)
        linear = torch.nn.Linear(
            weight.shape[1], weight.shape[0], bias=prefix + '.bias' in mapping, device='cuda', dtype=weight.dtype
        )
        linear.weight = torch.nn.Parameter(weight, requires_grad=False)
        if linear.bias is not None:
            linear.bias = torch.nn.Parameter(tensor(prefix + '.bias', weight.dtype), requires_grad=False)
        return linear

    for prefix, container in (('token_refiner.', model.token_refiner), *(
        (f'transformer_blocks.{i}.', block) for i, block in enumerate(model.transformer_blocks)
    )):
        local = {name[len(prefix) :]: location for name, location in mapping.items() if name.startswith(prefix)}
        load_streamed(container, local, pool)
    # A layer reads its bias in the file of its weight (WeightPool.parts). Where the adapter replaces a
    # weight and has no bias for it (the AdaLN projection of blocks 0 to 45), the model's stays: given
    # as what is added to the bias of that layer (the pool's `shifts`).
    for key in replaced(adapter or {}):
        bias = key.removesuffix('.weight') + '.bias'
        if key.endswith('.weight') and key.startswith('blocks.') and bias not in adapter and bias in header:
            pool.shifts[(ADAPTER, key, None)] = pool.stores['model'].get_tensor(bias).to('cuda')
    model.proj_in = plain_linear('proj_in')
    model.audio_proj_in = plain_linear('audio_proj_in')
    model.context_embedder = plain_linear('context_embedder')
    model.norm_out.linear = plain_linear('norm_out.linear', torch.float32)
    # (An adapter stores this weight in 16-bit floats where the model has it in bfloat16, the precision of the
    # rows it norms: left as stored, PyTorch said it could not fuse the norm, four times a video.)
    norm = tensor('norm_out.norm.weight', torch.bfloat16 if mapping['norm_out.norm.weight'][0] == ADAPTER else None)
    model.norm_out.norm.weight = torch.nn.Parameter(norm, requires_grad=False)
    model.time_embedder.table = torch.nn.Parameter(tensor('adaln_t_table', torch.float32), requires_grad=False)
    model.proj_out = PDDHead(tensor('proj_out.weight'), tensor('proj_out.bias'), heads, VIDEO_SHIFT)
    model.audio_proj_out = PDDHead(tensor('audio_proj_out.weight'), tensor('audio_proj_out.bias'), heads, AUDIO_SHIFT)
    for name, value in list(model.named_parameters()) + list(model.named_buffers()):
        if value.device.type == 'meta':
            raise ValueError('Missing native MiniMax-H3 tensor ' + name)
    # RoPE frequencies are generated, keep them at their own precision on CUDA.
    return model.eval().to('cuda'), heads


def set_interval(model, video, audio):
    """Tell the PDD heads which (sigma, sigma_next) step the next forward belongs to."""
    model.proj_out.interval = video
    model.audio_proj_out.interval = audio
