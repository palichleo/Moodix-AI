"""Qwen2.5-VL-7B reading the prompt with the images given, for Qwen-Image-Edit (as diffusers'
QwenImageEditPlusPipeline does, which the trial of 23/11 followed):

- each image is seen at about 384 x 384, at its own ratio (`seen`), by the image processor of
  Qwen/Qwen-Image-Edit-2511 built here from its preprocessor_config.json (same pixels and same
  tokens as the official processor, checked on 24/11 against the trial's image);
- the text is the pipeline's template with « Picture n: » and the image's tokens before the prompt;
- what the model reads is the last hidden state, the 64 tokens of the system prompt left out.

The file is Comfy-Org's « fp8 scaled » one (qwen_2.5_vl_7b_fp8_scaled): its layers go through the
engine's pool (runner.models.pool), a share of them on the card and the rest copied once a pass,
their 8-bit weights brought to bfloat16 by their scale; the table of the tokens stays in RAM, only
the rows read go to the card. The tokenizer is Krea 2's (qwen25_tokenizer: the same tokens).
"""

import gc
import time

TEMPLATE = (
    '<|im_start|>system\nDescribe the key features of the input image (color, shape, size, texture, objects, '
    "background), then explain how the user's text instruction should alter or modify the image. Generate a new "
    'image that meets the user\'s requirements while maintaining consistency with the original input where '
    'appropriate.<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n'
)
# The tokens of the system prompt, left out of what the model reads.
DROP = 64
PICTURE = 'Picture {}: <|vision_start|><|image_pad|><|vision_end|>'
PAD = '<|image_pad|>'
# The area each image is seen at by the encoder (diffusers' CONDITION_IMAGE_SIZE).
SEEN_AREA = 384 * 384
# Qwen/Qwen-Image-Edit-2511, processor/preprocessor_config.json.
PROCESSOR = dict(
    image_mean=[0.48145466, 0.4578275, 0.40821073],
    image_std=[0.26862954, 0.26130258, 0.27577711],
    patch_size=14,
    merge_size=2,
    temporal_patch_size=2,
    min_pixels=3136,
    max_pixels=12845056,
    resample=3,
    do_resize=True,
    do_rescale=True,
    rescale_factor=1 / 255,
    do_normalize=True,
    do_convert_rgb=True,
)
_ROPE = dict(mrope_section=[16, 24, 24], rope_type='default', type='default')
_TEXT = dict(
    model_type='qwen2_5_vl_text',
    vocab_size=152064,
    hidden_size=3584,
    intermediate_size=18944,
    num_hidden_layers=28,
    num_attention_heads=28,
    num_key_value_heads=4,
    hidden_act='silu',
    max_position_embeddings=128000,
    max_window_layers=28,
    rms_norm_eps=1e-6,
    rope_theta=1000000.0,
    rope_scaling=_ROPE,
    attention_dropout=0.0,
    use_sliding_window=False,
    sliding_window=None,
    layer_types=['full_attention'] * 28,
    bos_token_id=151643,
    eos_token_id=151645,
    vision_token_id=151654,
    tie_word_embeddings=False,
)
# Qwen/Qwen-Image-Edit-2511, text_encoder/config.json.
CONFIG = dict(
    _TEXT,
    model_type='qwen2_5_vl',
    text_config=_TEXT,
    vision_config=dict(
        model_type='qwen2_5_vl',
        depth=32,
        hidden_size=1280,
        intermediate_size=3420,
        num_heads=16,
        out_hidden_size=3584,
        in_channels=3,
        in_chans=3,
        patch_size=14,
        spatial_patch_size=14,
        spatial_merge_size=2,
        temporal_patch_size=2,
        tokens_per_second=2,
        window_size=112,
        fullatt_block_indexes=[7, 15, 23, 31],
        hidden_act='silu',
    ),
    image_token_id=151655,
    video_token_id=151656,
    vision_start_token_id=151652,
    vision_end_token_id=151653,
)
# Video memory left beside the share of the encoder on the card while it reads, in GiB: what a
# pass takes (a few hundred tokens) and the margin of the engine (the trial's value).
RESERVE_GIB = 1.5
# The RAM the share laid on the card leaves free while it is read at once, as the model's
# (runner.pipelines.qwen_image_edit, RAM_RESERVE_GIB): it leaves the RAM as soon as it is there.
# Without it, the default reserve of 12 GiB sends 8 GiB of the encoder through the mapping.
GATHER_RESERVE_GIB = 4
# The file of Comfy-Org says it is « fp8 scaled » with this tensor; its layers also carry a scale
# for their input, which the pool does not apply: it must be 1 (it is, in that file).
MARK = 'scaled_fp8'
_CHECKED = set()


def architecture():
    """The encoder as transformers builds it, empty, its head left out (only the hidden states are read)."""
    import torch
    from accelerate import init_empty_weights
    from transformers import Qwen2_5_VLConfig, Qwen2_5_VLForConditionalGeneration

    config = Qwen2_5_VLConfig.from_dict(CONFIG)
    config._attn_implementation = 'sdpa'
    with init_empty_weights():
        model = Qwen2_5_VLForConditionalGeneration(config)
    model.lm_head = torch.nn.Identity()
    return model


def key(name):
    """The key, in the file, of a weight named as transformers names it."""
    if name.startswith('model.language_model.'):
        return 'model.' + name.removeprefix('model.language_model.')
    if name.startswith('model.visual.'):
        return name.removeprefix('model.')
    return name


def validate_layout(header, model=None):
    """{name in transformers: ('text', its key in the file, None)} of a file of Qwen2.5-VL-7B, every
    weight there with its size; else a ValueError that says what the file is not."""
    model = model or architecture()
    if 'visual.merger.mlp.2.weight' not in header or 'model.embed_tokens.weight' not in header:
        raise ValueError(
            'Ce fichier n’est pas l’encodeur Qwen2.5-VL-7B de Qwen-Image-Edit : '
            'il lui manque la vision ou la table des jetons.'
        )
    names = {}
    for name, parameter in model.named_parameters():
        found = header.get(key(name))
        if found is None:
            raise ValueError('L’encodeur Qwen2.5-VL-7B est incomplet : il lui manque ' + key(name) + '.')
        size = 1
        for side in found['shape']:
            size *= side
        if size != parameter.numel():
            raise ValueError('Taille inattendue pour l’encodeur Qwen2.5-VL-7B : ' + key(name))
        names[name] = ('text', key(name), None)
    return names


def seen(image):
    """The image as the encoder sees it: about 384 x 384 at its own ratio, as diffusers resizes it."""
    from diffusers.pipelines.qwenimage.pipeline_qwenimage_edit_plus import calculate_dimensions
    from PIL import Image

    size = calculate_dimensions(SEEN_AREA, image.width / image.height)
    return image.convert('RGB').resize(size, Image.Resampling.LANCZOS)


def processor():
    from transformers import Qwen2VLImageProcessor

    return Qwen2VLImageProcessor(**PROCESSOR)


def inputs(tokenizer, images, prompt, pictures=None):
    """The model's inputs for one prompt read with `images` (PIL, as `seen` gives them):
    dict(input_ids, attention_mask, pixel_values, image_grid_thw), on the processor's side."""
    pictures = pictures or processor()
    text = TEMPLATE.format(''.join(PICTURE.format(index + 1) for index in range(len(images))) + prompt)
    found = {}
    if images:
        found = dict(pictures(images=list(images), return_tensors='pt'))
        merge = PROCESSOR['merge_size'] ** 2
        # Each image's pad, as many times as its tokens (what Qwen2VLProcessor does).
        parts = text.split(PAD)
        text = parts[0]
        for grid, rest in zip(found['image_grid_thw'], parts[1:]):
            text += PAD * (int(grid.prod()) // merge) + rest
    tokens = tokenizer([text], return_tensors='pt')
    return dict(input_ids=tokens['input_ids'], attention_mask=tokens['attention_mask'], **found)


def check_scales(store):
    """The scale every layer of the file asks for its input must be 1 (see MARK)."""
    if store.path in _CHECKED:
        return
    odd = [name for name in store.keys() if name.endswith('.scale_input') and store.get_tensor(name).item() != 1]
    if odd:
        raise ValueError('Encodeur Qwen2.5-VL : échelle d’entrée différente de 1 (' + odd[0] + ')')
    _CHECKED.add(store.path)


def encode(path, tokenizer_path, images, prompts, progress=None, reserve_gib=RESERVE_GIB):
    """[the conditioning of each prompt read with `images`, [1, tokens, 3584] in bfloat16 on the
    processor's side], the encoder opened once. `images`: PIL images, as given (they are seen
    through `seen` here)."""
    import torch
    from transformers import AutoTokenizer

    from runner.models.headers import header
    from runner.models.pool import WeightPool, load_streamed, room
    from runner.models.residency import open_store

    report = progress or (lambda **_: None)
    began = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path), local_files_only=True)
    pictures = processor()
    views = [seen(image) for image in images]
    model = architecture()
    names = validate_layout(header(path), model)
    results = []
    with torch.inference_mode(), open_store(str(path), resident=False) as store:
        check_scales(store)
        budget = room(reserve_gib)
        pool = WeightPool({'text': store}, budget)
        try:
            model = load_streamed(model, names, pool)
            # The share that stays is read from the file in one go and laid on the card: through
            # the mapping it came in page by page (runner.pipelines.wan22, _Expert.open).
            gathered = store.gather(pool.staying().get('text', ()), int(GATHER_RESERVE_GIB * 1024**3))
            pool.preload()
            store.scatter()
            report(
                stage='text encoder loaded',
                seconds=round(time.perf_counter() - began, 2),
                gpu_gib=round(pool.bytes / 1024**3, 2),
                gathered_gib=round(gathered / 1024**3, 2),
                budget_gib=round(budget, 2),
            )
            for prompt in prompts:
                given = inputs(tokenizer, views, prompt, pictures)
                given = {name: value.to('cuda') for name, value in given.items()}
                if 'pixel_values' in given:
                    given['pixel_values'] = given['pixel_values'].to(torch.bfloat16)
                outputs = model.model(**given, output_hidden_states=True, use_cache=False)
                hidden = outputs.hidden_states[-1][:, DROP:].to(torch.bfloat16)
                if not torch.isfinite(hidden).all():
                    raise RuntimeError('Texte encodé non fini (encodeur Qwen2.5-VL)')
                results.append(hidden.cpu())
                del outputs, given, hidden
        finally:
            pool.clear()
    del model
    gc.collect()
    torch.cuda.empty_cache()
    report(stage='prompt encoded', seconds=round(time.perf_counter() - began, 2), prompts=len(prompts))
    return results
