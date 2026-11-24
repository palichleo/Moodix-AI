"""Qwen-Image-Edit-2511: an image made from one to three images and a prompt, in the steps of
Lightning (lightx2v, 8 steps, a fixed shift of 3, no guidance), as the trial of 23/11 made them
(claude_design/essais-qwen-angles of the worktree wonderful-kirch-517c63): the same encoder, the
same sizes, the same schedule, the same noise for a seed.

Copied from the pipelines of Krea 2 (its VAE, the same file), of Wan 2.2 (a share of the model on
the card, read from its file in one go; the rest locked in RAM once and copied ahead of the
layers) and of LTX 2.5 (the model left on the card for the next image: runner.models.kept). Its
own:

- the blocks are computed by runner.models.qwen_image (comfy-kitchen's fused kernels), and the
  layers read once a picture (the modulations: a third of the file) are left out of the model of
  the steps, neither on the card nor locked in RAM;
- the modulations of the 8 steps depend on the model and its LoRAs alone: computed once, kept on
  the disk (runner.models.conditioning), as are the prompt read with its images and the latents of
  each image given (the same image tried again with another angle or another seed).
"""

from contextlib import ExitStack
import gc
import hashlib
import math
from pathlib import Path
import time

from runner import hardware

GiB = 1024**3
STEPS = 8
# The shift of Lightning's authors for their LoRA, fixed whatever the size (base and max alike).
SHIFT = 3.0
# Area of the picture made, and of each image given as the VAE reads it (diffusers' 1024 x 1024).
AREA = 1024 * 1024
# Video memory left beside the weights while the steps run, in GiB: a fixed part and what a
# step's own tensors take, which grows with the picture (the trial's values: 1 megapixel made
# from one image of 1 megapixel held 8.7 GiB beside 6.3 of weights kept).
RESERVE_GIB = 3.0
RESERVE_PER_MEGAPIXEL_GIB = 0.5
# Weights copied to the GPU ahead of the layers that read them (WeightPool).
AHEAD_GIB = 0.5
# RAM the weights leave free, and what is locked beyond what is copied (runner.pipelines.wan22).
RAM_RESERVE_GIB = 4
LOCK_MARGIN_GIB = 0.5
# Video memory the decoder needs, lent by the share of the model when the card lacks it.
DECODE_GIB = 2.0
# A prompt read beside the model the last image left on the card (runner.pipelines.ltx25): the
# encoder keeps on the card what fits and streams the rest, and streaming needs its room under the
# ceiling the engine sets 1 GiB below what was free (runner.engine._vram_ceiling). Its reserve then
# counts that gigabyte beside its own (runner.models.qwen_image_text.RESERVE_GIB). The share lends
# what is missing for it, all of itself if the encoder still runs out, and takes it back before the
# steps. (24/11: with the encoder's 1.5 GiB alone, the second pose of the bench ran out.)
BESIDE_RESERVE_GIB = 2.5
# comfy-kitchen's INT8 attention in place of cuDNN's: faster, not yet measured on this model.
INT8_ATTENTION = False
NAME = 'qwen_image_edit'
# The scheduler of Qwen/Qwen-Image-Edit-2511 (scheduler/scheduler_config.json) with Lightning's
# fixed shift: base and max of log(3), no terminal shift.
SCHEDULER = dict(
    base_image_seq_len=256,
    base_shift=math.log(SHIFT),
    max_image_seq_len=8192,
    max_shift=math.log(SHIFT),
    num_train_timesteps=1000,
    shift=1.0,
    shift_terminal=None,
    time_shift_type='exponential',
    use_dynamic_shifting=True,
    invert_sigmas=False,
    stochastic_sampling=False,
    use_beta_sigmas=False,
    use_exponential_sigmas=False,
    use_karras_sigmas=False,
)
# Sets of files already checked, by their stamps: building the empty encoder and model to compare
# them with their files takes a second, asked twice a generation (runner.pipelines.ltx25).
CHECKED = set()


def schedule(steps=STEPS):
    """(the σ of each step and 0 after the last, the timestep each step hands the model): as
    diffusers' scheduler gives them, float32, then the timestep divided by 1000 as the trial did."""
    import numpy as np
    from diffusers import FlowMatchEulerDiscreteScheduler

    scheduler = FlowMatchEulerDiscreteScheduler.from_config(SCHEDULER)
    scheduler.set_timesteps(sigmas=np.linspace(1.0, 1 / steps, steps), mu=math.log(SHIFT))
    sigmas = [float(value) for value in scheduler.sigmas]
    timesteps = [float(value) for value in (scheduler.timesteps / 1000)]
    return sigmas, timesteps


def size_of(width, height, area=AREA):
    """(width, height) of the given ratio at about `area` pixels, multiples of 32 (diffusers'
    calculate_dimensions)."""
    from diffusers.pipelines.qwenimage.pipeline_qwenimage_edit_plus import calculate_dimensions

    return tuple(calculate_dimensions(area, width / height))


def made_size(parameters, first):
    """The size of the picture made: the job's, else the first image's ratio at a megapixel."""
    if parameters.get('width') and parameters.get('height'):
        return parameters['width'], parameters['height']
    return size_of(*first)


def images_of(job):
    """The paths of the images given, the image to modify first, then the others in their order."""
    order = {'edit_image': 0, 'reference_image': 1}
    return [ref['path'] for ref in sorted(job['references'], key=lambda ref: order.get(ref['role'], 2))]


def step_lora(job):
    """Lightning, the LoRA of the steps, as the job's other LoRAs are given: always applied at 1."""
    path = job['components'].get('stepLora')
    return [dict(id='stepLora', path=path, strength=1.0)] if path else []


def check(job, family):
    if not job['references']:
        raise ValueError('Qwen-Image-Edit modifie des images : donnez-lui au moins une image.')
    if job['parameters'].get('cfg', 1) != 1:
        raise ValueError('Qwen-Image-Edit avec Lightning ne prend pas de guidage (cfg 1).')
    for side in ('width', 'height'):
        if (side in job['parameters']) != (('height' if side == 'width' else 'width') in job['parameters']):
            raise ValueError('Qwen-Image-Edit : la largeur et la hauteur vont ensemble.')


def preflight(job, config):
    """File-level checks run on CPU before the chat model is unloaded."""
    import importlib.util

    from runner.models import conditioning, qwen_image, qwen_image_text
    from runner.models.headers import header
    from runner.models.lora_keys import validate_lora

    tokenizer = job['components'].get('tokenizer')
    if not tokenizer or not Path(tokenizer).is_dir():
        raise ValueError(
            'Le moteur de Moodix a besoin du tokenizer de Qwen2.5 (dossier qwen25_tokenizer) : choisissez-le dans le workflow.'
        )
    if importlib.util.find_spec('comfy_kitchen') is None or not qwen_image.fusable():
        raise RuntimeError('Qwen-Image-Edit a besoin des noyaux INT8 de comfy-kitchen, absents ou trop anciens.')
    loras = step_lora(job) + job['loras']
    stamps = [(role, conditioning.stamp(path)) for role, path in sorted(job['components'].items())]
    stamps += [('lora', conditioning.stamp(item['path'])) for item in loras]
    if repr(stamps) not in CHECKED:
        model = header(job['components']['model'])
        qwen_image.validate_layout(model)
        qwen_image_text.validate_layout(header(job['components']['textEncoder']))
        for item in loras:
            validate_lora(header(item['path']), model)
        CHECKED.add(repr(stamps))
    from PIL import Image

    for path in images_of(job):
        with Image.open(path) as image:
            image.verify()


class Loaded:
    """The model as one image leaves it for the next (runner.models.kept): its files open, its
    layers built, the share of its weights on the card and the rest locked in RAM."""

    def __init__(self, key):
        self.key, self.stack = key, ExitStack()
        self.stores, self.adapters = {}, []
        self.pool = self.model = self.taken = self.names = None
        self.zero = True
        self.facts = {}
        self.allocated = 0
        self.locked = True

    def drop(self):
        try:
            if self.pool is not None:
                self.pool.clear()
        finally:
            self.pool = self.model = self.taken = None
            self.stack.close()


def _build(loaded, job, loras, budget, progress):
    """The model of the steps over its file and LoRAs, its share laid on the card (see Loaded)."""
    from runner.models import qwen_image
    from runner.models.headers import header
    from runner.models.pool import WeightPool, load_streamed
    from runner.models.residency import open_store

    began = time.perf_counter()
    loaded.names, loaded.zero = qwen_image.validate_layout(header(job['components']['model']))
    # The file is read through its mapping, never whole into RAM: a third of it (the modulations)
    # is read once and kept on the disk as what it gives (see modulations).
    store = loaded.stores['model'] = loaded.stack.enter_context(open_store(job['components']['model'], resident=False))
    for index, item in enumerate(loras):
        name = 'lora' + str(index)
        loaded.stores[name] = loaded.stack.enter_context(open_store(item['path']))
        loaded.adapters.append((name, item['strength']))
    pool = loaded.pool = WeightPool(loaded.stores, budget, adapters=loaded.adapters, ahead_gib=AHEAD_GIB)
    model = qwen_image.architecture(zero=loaded.zero)
    loaded.taken = qwen_image.split(model)
    loaded.model = load_streamed(model, loaded.names, pool)
    changed = pool.applied()
    for index, item in enumerate(loras):
        if not changed.get('lora' + str(index)):
            raise ValueError(f'LoRA incompatible avec Qwen-Image-Edit : aucune de ses couches ne s’applique ({item["id"]})')
    # As runner.pipelines.wan22 (_Expert.open): what stays on the card is read from the file in
    # one go and laid there; what every step copies is locked in RAM once.
    streamed = pool.streamed().get('model', ())
    spare = pool.streamed(LOCK_MARGIN_GIB, onward=True).get('model', ())
    reserve = int(RAM_RESERVE_GIB * GiB)
    gathered = store.gather(pool.staying().get('model', ()), reserve)
    pool.preload()
    store.scatter()
    locked = store.keep(streamed, reserve, spare=spare)
    pool.unhold()
    loaded.locked = not streamed or store.pinned
    loaded.facts = dict(
        opening_seconds=round(time.perf_counter() - began, 2),
        gpu_cache_gib=round(pool.bytes / GiB, 3),
        gpu_cache_limit_gib=round(budget, 3),
        gathered_gib=round(gathered / GiB, 3),
        locked_ram_gib=round(locked / GiB, 3),
        pinned_model=store.pinned,
        lora_layers=changed,
        zero_cond_t=loaded.zero,
    )
    progress(stage='transformer weights on the GPU', **loaded.facts)


def modulations(config, loaded, timesteps, progress):
    """The modulations of every step (runner.models.qwen_image.modulations), kept on the disk: they
    depend on the model's file, the LoRAs that change its layers and the steps, not on the picture."""
    import torch

    from runner.models import conditioning, qwen_image
    from runner.models.pool import WeightPool

    stamps = [conditioning.stamp(loaded.stores['model'].path)]
    stamps += [[conditioning.stamp(loaded.stores[name].path), strength] for name, strength in loaded.adapters]
    entry = conditioning.key('qwen image edit modulations', stamps, timesteps, loaded.zero)
    found = conditioning.load(config, entry)
    if found and set(found[0]) == {'img', 'txt', 'out'}:
        progress(stage='modulations kept from an earlier generation')
        return {name: value.to('cuda', torch.bfloat16) for name, value in found[0].items()}, True
    # Their layers over a pool of their own that keeps nothing on the card: each is read once.
    pool = WeightPool(loaded.stores, 0, adapters=loaded.adapters)
    try:
        built = qwen_image.layers(loaded.taken, loaded.names, pool)
        mods = qwen_image.modulations(loaded.model, timesteps, built, zero=loaded.zero)
    finally:
        pool.clear()
    conditioning.save(config, entry, mods)
    return mods, False


def fits(pool, budget):
    """Whether the share the last image left on the card suits this image's `budget` (GiB), as in
    runner.pipelines.ltx25: about the share this image leaves the model (a quarter of a gigabyte
    over is within what the steps are given to spare; half a gigabyte under is what the page-locked
    RAM was built to cover). Counted whole, what it lent to the prompt or to the VAE with it: lent,
    it seems smaller than it is, and taken back where the card had been filled by another program
    since, it ran out of memory (24/11, 3 GiB taken between two images)."""
    whole = pool.bytes + pool.lent
    return whole <= (budget + 0.25) * GiB and (budget - LOCK_MARGIN_GIB) * GiB <= pool.limit


def kept_share(loaded, budget, progress):
    """The model the last image left, for this image when its share fits `budget` (see fits), what
    it lent taken back; else dropped, to be built anew at this image's size (runner.pipelines.ltx25,
    Refit). Returns it, or None."""
    if not fits(loaded.pool, budget):
        loaded.drop()
        return None
    if loaded.pool.lent:
        progress(stage='transformer weights taken back', lent_gib=round(loaded.pool.lent / GiB, 2))
        loaded.pool.preload()
    return loaded


def texts(config, job, images, progress, beside=None):
    """The prompt read with the images (runner.models.qwen_image_text), kept on the disk. `beside`:
    the model the last image left on the card, whose share lends the encoder its room (see
    BESIDE_RESERVE_GIB); the caller takes it back."""
    import torch

    from runner.models import conditioning, qwen_image_text
    from runner.models.ladder import smaller
    from runner.models.pool import room

    views = [qwen_image_text.seen(image) for image in images]
    paths = job['components']
    stamps = [conditioning.stamp(paths['textEncoder']), conditioning.stamp(paths['tokenizer'])]
    prompt = job['parameters']['prompt']
    entry = conditioning.key('qwen image edit text', stamps, prompt, views)
    found = conditioning.load(config, entry)
    if found and 'value' in found[0]:
        progress(stage='encoding prompt', conditioning='kept from an earlier generation')
        return found[0]['value'], True
    progress(stage='loading text encoder')

    def read(reserve_gib):
        return qwen_image_text.encode(
            paths['textEncoder'], paths['tokenizer'], images, [prompt], progress, reserve_gib=reserve_gib
        )[0]

    attempts = [lambda: read(qwen_image_text.RESERVE_GIB)]
    pool = beside.pool if beside is not None else None
    if pool is not None and pool.gpu:
        gc.collect()
        torch.cuda.empty_cache()
        pool.lend(BESIDE_RESERVE_GIB - room(0))

        def alone():
            # Beside the share it still ran out: the share leaves the card whole, its layers built.
            pool.lend(pool.bytes / GiB + 1)
            return read(qwen_image_text.RESERVE_GIB)

        attempts = [lambda: read(BESIDE_RESERVE_GIB), alone]
    value = smaller(attempts, torch)
    conditioning.save(config, entry, {'value': value})
    return value, False


def load_vae(path):
    """The VAE of Qwen-Image (Krea 2's, the same file), as runner.pipelines.krea2 loads it."""
    import torch
    from accelerate import init_empty_weights
    from diffusers import AutoencoderKLQwenImage
    from diffusers.loaders.single_file_utils import convert_wan_vae_to_diffusers
    from safetensors import safe_open

    with init_empty_weights():
        vae = AutoencoderKLQwenImage()
    with safe_open(str(path), framework='pt', device='cpu') as store:
        state = convert_wan_vae_to_diffusers({key: store.get_tensor(key) for key in store.keys()})
    vae.load_state_dict(state, strict=True, assign=True)
    vae.eval().to(dtype=torch.bfloat16)
    vae.enable_tiling()
    return vae


def given_latents(config, job, paths, images, held, progress, before=None):
    """The latents of each image given, [1, 16, height / 8, width / 8] in float32 normalised, each
    at a megapixel of its own ratio; kept on the disk, told by what the file holds. `before` is
    called once before the VAE first encodes (to make it room)."""
    import torch

    from runner.models import conditioning

    vae_path = job['components']['vae']
    found, kept = [], 0
    for path, image in zip(paths, images):
        size = size_of(*image.size)
        entry = conditioning.key(
            'qwen image edit image', conditioning.stamp(vae_path), hashlib.sha256(Path(path).read_bytes()).hexdigest(), list(size)
        )
        cached = conditioning.load(config, entry)
        if cached and 'value' in cached[0]:
            found.append(cached[0]['value'])
            kept += 1
            continue
        from diffusers.image_processor import VaeImageProcessor

        if held.get('vae') is None:
            if before is not None:
                before()
            progress(stage='loading VAE')
            held['vae'] = load_vae(vae_path)
        vae = held['vae']
        mean = torch.tensor(vae.config.latents_mean, device='cuda', dtype=torch.float32).view(1, 16, 1, 1, 1)
        std = torch.tensor(vae.config.latents_std, device='cuda', dtype=torch.float32).view(1, 16, 1, 1, 1)
        pixels = VaeImageProcessor(vae_scale_factor=16).preprocess(image, size[1], size[0]).unsqueeze(2)
        vae.to('cuda')
        encoded = vae.encode(pixels.to(device='cuda', dtype=torch.bfloat16)).latent_dist.mode().float()
        value = ((encoded - mean) / std)[:, :, 0].cpu()
        vae.to('cpu')
        del encoded, pixels
        torch.cuda.empty_cache()
        conditioning.save(config, entry, {'value': value})
        found.append(value)
    return found, kept


def finished(latents, velocity, sigma, height, width):
    """The finished latent (16, H, W) as a step sees it, for the page."""
    from runner.models import qwen_image

    return qwen_image.unpack(latents - velocity.float() * sigma, height, width)[0]


def generate(job, config, progress):
    """One image. The model the last image left on the card is taken back when it is the one this
    job asks for (same files, same LoRAs at the same strengths), and left there again at the end."""
    from runner.models import conditioning, kept

    loras = step_lora(job) + job['loras']
    key = [
        [conditioning.stamp(path) for path in [job['components']['model'], *(item['path'] for item in loras)]],
        [item['strength'] for item in loras],
    ]
    holder = [kept.take(NAME, key)]
    try:
        result = _generate(job, config, progress, key, loras, holder)
    except BaseException:
        # Whatever state the failure left it in, it is not one to start the next image from.
        if holder[0] is not None:
            holder[0].drop()
        raise
    loaded = holder[0]
    if loaded.locked:
        import torch

        loaded.pool.settle()
        loaded.allocated = torch.cuda.memory_allocated()
        kept.put(NAME, loaded)
    else:
        # RAM was short when it was built: its steps copied from the file's mapping, and the
        # next image would find no room to lock either (runner.pipelines.ltx25).
        loaded.drop()
    return result


def _generate(job, config, report, key, loras, holder):
    import torch
    from PIL import Image

    from runner import preview
    from runner.media import save_image
    from runner.models import qwen_image
    from runner.models.pool import require
    from runner.pipelines.ltx25 import memory
    from runner.pipelines.wan_scail2 import smaller

    if not torch.cuda.is_available():
        raise RuntimeError('Native Qwen-Image-Edit requires CUDA')
    p = job['parameters']
    paths = images_of(job)
    images = [Image.open(path).convert('RGB') for path in paths]
    width, height = made_size(p, images[0].size)
    megapixels = width * height / 1024**2
    reserve = RESERVE_GIB + RESERVE_PER_MEGAPIXEL_GIB * megapixels
    require('Qwen-Image-Edit', reserve + AHEAD_GIB, 'la taille de l’image')
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    timeline = []

    def progress(**data):
        timeline.append(
            dict(
                {name: value for name, value in data.items() if name not in ('prompt', 'preview')},
                seconds=round(time.perf_counter() - start, 2),
                allocated_gib=round(torch.cuda.memory_allocated() / GiB, 3),
                free_gib=round(hardware.free_bytes(torch) / GiB, 3),
                **memory(),
            )
        )
        report(**data)

    def free_card():
        gc.collect()
        torch.cuda.empty_cache()

    bf16 = dict(device='cuda', dtype=torch.bfloat16)
    held = dict(vae=None)
    with torch.inference_mode():
        # 1. The prompt read with the images, then the latents of each image (both kept on the disk).
        # Beside the model the last image left, its share lends them the card, and takes it back.
        text, text_kept = texts(config, job, images, progress, beside=holder[0])
        text = text.to(**bf16)
        progress(stage='encoding references')

        def vae_room():
            if holder[0] is not None:
                holder[0].pool.lend(max(0.0, DECODE_GIB - hardware.free_bytes(torch) / GiB))

        found, images_kept = given_latents(config, job, paths, images, held, progress, before=vae_room)
        given = torch.cat([qwen_image.pack(value) for value in found], dim=1).to(**bf16)
        grid = qwen_image.shapes((height // 8, width // 8), [tuple(value.shape[2:]) for value in found])
        del found
        if held['vae'] is not None:
            held['vae'].to('cpu')
        free_card()

        # 2. The model: the one the last image left, or built (its share of the card first).
        sigmas, timesteps = schedule(p.get('steps', STEPS))
        loaded = holder[0]
        again = loaded is not None
        # (What the share lent to the prompt or to the VAE is free again here, and counted with what is free.)
        free = (hardware.free_bytes(torch) + torch.cuda.memory_reserved()) / GiB
        budget = max(0.0, free - reserve - AHEAD_GIB)
        if 'cacheGiB' in config:
            budget = min(budget, config['cacheGiB'])
        if again:
            loaded = holder[0] = kept_share(loaded, budget, progress)
            if loaded is None:
                # A share of another size than this image leaves it: built anew.
                again = False
                free_card()
        generator = torch.Generator('cpu').manual_seed(p['seed'])
        noise = qwen_image.pack(torch.randn((1, 16, height // 8, width // 8), generator=generator)).cuda()
        latents = prediction = None
        while latents is None:
            try:
                if loaded is None:
                    progress(stage='preparing transformer')
                    loaded = holder[0] = Loaded(key)
                    _build(loaded, job, loras, budget, progress)
                else:
                    progress(stage='preparing transformer', kept=True, **loaded.facts)
                mods, mods_kept = modulations(config, loaded, timesteps, progress)
                prepared = qwen_image.prepare(
                    loaded.model, text, given, grid, mods, zero=loaded.zero, int8_attention=INT8_ATTENTION
                )
                progress(stage='denoising ready', modulations_kept=mods_kept, text_kept=text_kept, images_kept=images_kept)
                current = noise.clone()
                for index in range(len(sigmas) - 1):
                    prediction = qwen_image.predict(loaded.model, prepared, current.to(torch.bfloat16), index)
                    preview.send(report, preview.KREA2, finished, current, prediction, sigmas[index], height // 8, width // 8)
                    current = current + prediction.float() * (sigmas[index + 1] - sigmas[index])
                    if not torch.isfinite(current).all():
                        raise RuntimeError('Valeurs non finies : l’image n’est pas enregistrée.')
                    progress(stage='denoising', step=index + 1, total=len(sigmas) - 1)
                latents = current
            except torch.OutOfMemoryError:
                if budget <= 0:
                    raise
            if latents is None:
                # Out of the handler, the failed attempt's tensors gone: the same image again with
                # half the weights on the card, then none (runner.pipelines.wan22).
                prepared = mods = prediction = None
                holder[0].drop()
                loaded = holder[0] = None
                free_card()
                budget = smaller(budget)
                progress(stage='retrying with a smaller share of the model', gpu_cache_limit_gib=budget)
        weights = dict(loaded.pool.summary(), **loaded.facts)
        del prepared, mods, prediction, noise, given, text
        free_card()

        # 3. The picture: the share lends the decoder what the card lacks, and takes it back.
        progress(stage='decoding image')
        lent = loaded.pool.lend(max(0.0, DECODE_GIB - hardware.free_bytes(torch) / GiB))
        vae = held['vae'] or load_vae(job['components']['vae'])
        mean = torch.tensor(vae.config.latents_mean, device='cuda', dtype=torch.float32).view(1, 16, 1, 1, 1)
        std = torch.tensor(vae.config.latents_std, device='cuda', dtype=torch.float32).view(1, 16, 1, 1, 1)
        vae.to('cuda')
        unpacked = qwen_image.unpack(latents, height // 8, width // 8).unsqueeze(2)
        decoded = vae.decode((unpacked * std + mean).to(torch.bfloat16), return_dict=False)[0][0, :, 0]
        if not torch.isfinite(decoded).all():
            raise RuntimeError('Image décodée non finie : elle n’est pas enregistrée.')
        pixels = ((decoded.float().clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()
        del decoded, unpacked, latents, vae
        held['vae'] = None
        free_card()
        if lent:
            loaded.pool.preload()
        progress(stage='decoded')
    metadata = dict(
        job=job,
        parameters=dict(p, width=width, height=height),
        seconds=round(time.perf_counter() - start, 2),
        peak_vram_gib=round(torch.cuda.max_memory_allocated() / GiB, 3),
        backend='moodix-qwen-image-edit',
        kernel_library='comfy_kitchen',
        attention='int8' if INT8_ATTENTION else 'cudnn',
        kept_model=again,
        weights=weights,
        timeline=timeline,
    )
    return save_image(pixels, config, job, metadata)
