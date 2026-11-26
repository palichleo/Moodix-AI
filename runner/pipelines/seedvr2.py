"""SeedVR2 7B image upscaling: Lanczos enlargement, one-step diffusion restoration, colour
correction against the enlarged source. Several passes repeat the whole (the model chooses).

One pass: resize the image by `scale` (Lanczos), pad to a multiple of 16, encode with the VAE,
denoise once from pure noise conditioned on that latent (t = 1000, v-prediction on a linear
schedule), decode, crop, then correct colours against the resized source.
"""

import time

from runner import hardware

MAX_SIDE = 8192
T = 1000.0
# The sides of the tiles the VAE works on, in pixels to encode and in latent cells to decode: the
# whole image first (up to 4096 pixels), then smaller each time the video memory lacks.
ENCODE_TILES = (4096, 2048, 1024)
DECODE_TILES = (512, 256, 128)
# (0.6.448) What a block of the model computes with for an image, beside its weights: about ten times its tokens
# (one for 16 x 16 pixels, 3072 values in 16 bits each: the input of the MLP, its hidden layer four times as wide,
# twice while the activation is made), and what stays on the card whatever the size (the VAE, the layers on their
# way). Read in the failures of 26/11 on an RTX 4070 SUPER with 6 GiB of weights on the card: 9.8 GiB asked at
# 3072 x 3072, more than 11 at 4096 x 4096 (it lacked 1.5 GiB for that hidden layer).
TOKEN_BYTES = 3072 * 2
STATES = 10
BESIDE_GIB = 1.7
# What the engine keeps free under its ceiling (runner.engine.VRAM_MARGIN), and a little more.
CEILING_GIB = 1.2
# (0.6.449) What that estimate was seen to overstate (26/11: 9.3 and 9.5 GiB held at 4096 x 4096 and 5120 x 5120,
# for 10.2 read from it): an image is refused only when the steps would lack memory even so.
SURE_GIB = 1.0


def working_gib(width, height):
    """Video memory the steps need beside the weights for an image of this size, in GiB."""
    tokens = -(-width // 16) * -(-height // 16)
    return BESIDE_GIB + STATES * tokens * TOKEN_BYTES / 1024**3


def share_gib(free_gib, sizes, cache_gib=6):
    """The share of the card the weights of the model keep through the passes of `sizes`.

    (0.6.448) 6 GiB of them stayed whatever the image, with 4 left to compute: enough up to 2560 x 2560, short
    beyond. A larger image now leaves the weights less (they come from RAM at each step instead: slower), down
    to none. Nothing changes where 4 GiB were enough."""
    largest = max(working_gib(width, height) for width, height in sizes)
    return min(cache_gib, max(0.0, free_gib - max(4.0, largest + CEILING_GIB)))


def smaller_shares(share):
    """The shares of the card tried for the weights when the steps run short of memory all the same (another
    program took some since, an image that needs more than was read): as it is, then half of it, then none."""
    return [None, share / 2, 0.0] if share > 0 else [None]


def check(job, family):
    p = job['parameters']
    if p.get('passes', 1) > 1 and p.get('scale', 2) ** p['passes'] > 16:
        raise ValueError('SeedVR2 would enlarge more than 16 times; use fewer passes or a smaller scale')


def _sizes(width, height, parameters):
    """Size after each pass, none beyond the largest side (`max_side`, 8192 at most).

    (0.6.302) Only the last pass was brought back to it. 3000 px enlarged twice in three passes went through
    12 000 px, where the model has no way back (more than 375 000 tokens for 262 000 at 8192), then was made
    smaller by a pass more; 2048 px ended on a third pass from 8192 to 8192, a whole diffusion that enlarged
    nothing. Each pass stops at the limit, and a pass that would enlarge nothing more is not made. The first
    one always is; passes that do not enlarge at all (scale 1) are restorations, all made.
    """
    scale, passes, max_side = parameters.get('scale', 2), parameters.get('passes', 1), parameters.get('max_side', 0)
    limit = min(max_side or MAX_SIDE, MAX_SIDE)
    sizes = []
    for _ in range(passes):
        wide, high = round(width * scale), round(height * scale)
        if max(wide, high) > limit:
            ratio = limit / max(wide, high)
            wide, high = max(16, round(wide * ratio)), max(16, round(high * ratio))
        if sizes and scale > 1 and (wide, high) == (width, height):
            break
        sizes.append((wide, high))
        width, height = wide, high
    return sizes


def preflight(job, config):
    from runner.media import open_image
    from runner.models import seedvr2, seedvr2_vae
    from runner.models.headers import header

    if not seedvr2.signature(header(job['components']['model'])):
        raise ValueError('Ce fichier n’est pas un DiT SeedVR2 7B.')
    if not seedvr2_vae.signature(header(job['components']['vae'])):
        raise ValueError('Ce fichier n’est pas le VAE de SeedVR2 (ema_vae_fp16).')
    # The first check runs before the sources are copied; generation checks again with them.
    if job['references']:
        with open_image(job['references'][0]['path']) as image:
            _sizes(*image.size, job['parameters'])


def generate(job, config, progress):
    import numpy as np
    import torch
    from PIL import Image

    from runner.media import open_image, save_image
    from runner.models.ladder import smaller
    from runner.models import seedvr2, seedvr2_color, seedvr2_vae
    from runner.models.pool import WeightPool, require
    from runner.models.residency import RESIDENCY, open_store

    if not torch.cuda.is_available():
        raise RuntimeError('SeedVR2 requires CUDA')
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    p = job['parameters']
    steps, method, seed = p.get('steps', 1), p.get('color_correction', 'lab'), p['seed']
    with open_image(job['references'][0]['path']) as image:
        current = image.convert('RGB')
    source_size = current.size
    sizes = _sizes(*current.size, p)
    # (0.6.449) An image the card cannot hold beside any share of the weights is refused before anything is
    # loaded, in the user's words. At 6144 x 6144 and 8192 x 8192 on 12 GiB the steps failed after a minute,
    # twice: under the ceiling of the engine, then without it on an error of PyTorch's own allocator
    # (« !handles_.at(i) INTERNAL ASSERT FAILED »). 5120 x 5120 is made.
    largest = max(working_gib(width, height) for width, height in sizes)
    require('SeedVR2', largest, 'la taille de l’image', measured=max(0.1, largest - SURE_GIB))
    progress(stage='loading upscaler')
    vae = seedvr2_vae.load(job['components']['vae'])
    total = len(sizes) * seedvr2.LAYERS * steps
    done = 0
    timeline = []
    with open_store(job['components']['model']) as store, torch.inference_mode():
        budget = share_gib(hardware.free_bytes(torch) / 1024**3, sizes, config.get('cacheGiB', 6))
        pool = WeightPool({'model': store}, budget)
        try:
            dit = seedvr2.load(store, pool)
            text = seedvr2.positive_text(store)
            for index, (width, height) in enumerate(sizes):
                resized = current.resize((width, height), Image.LANCZOS)
                reference = torch.from_numpy(np.asarray(resized)).to('cuda').permute(2, 0, 1)[None].float() / 255
                pad_h, pad_w = -height % 16, -width % 16
                progress(stage='encoding', step=done, total=total)
                # (0.6.379) In 16 bits at once. The picture completed in 32 bits was kept beside it under a
                # name to the end of the pass, through the encoding, the steps and the decoding (0.75 GiB of
                # the card at 8192 x 8192), read by nobody.
                source = (torch.nn.functional.pad(reference, (0, pad_w, 0, pad_h)) * 2 - 1).to(torch.bfloat16)
                # Whole where it fits (tiles see other statistics of the group norms), else in
                # tiles of 2048 pixels, then of 1024: 3072 x 3072 did not fit 12 GiB whole (17/11).
                encoders = [
                    lambda side=side: seedvr2_vae.tiled(vae.encode, source, 1 / 8, side, 256)
                    for side in ENCODE_TILES
                ]
                latent = smaller(encoders, torch)
                del source
                latent = latent[0].permute(1, 2, 0)[None].to(torch.bfloat16)  # (1, h, w, 16)
                condition = torch.cat([latent, torch.ones_like(latent[..., :1])], dim=-1)
                times = [T * (1 - i / steps) for i in range(steps)]

                def sample(share=None, first=done, index=index, latent=latent, condition=condition):
                    """The steps of this pass, from the noise of its seed; `share`: the weights first given
                    another share of the card (GiB)."""
                    if share is not None:
                        pool.resize(share)
                    generator = torch.Generator('cuda').manual_seed(seed + index)
                    x = torch.randn(latent.shape, generator=generator, device='cuda', dtype=torch.bfloat16)
                    for step, t in enumerate(times):

                        def report(block, blocks, base=first + step * seedvr2.LAYERS):
                            progress(stage='upscaling', step=base + block, total=total)

                        v = dit(torch.cat([x, condition], dim=-1), text, torch.tensor(t, device='cuda'), report)
                        x0 = x - (t / T) * v  # v-prediction on x_t = (1 - t/T) x0 + (t/T) noise
                        if step + 1 < steps:
                            s = times[step + 1]
                            noise = x + (1 - t / T) * v
                            x = (1 - s / T) * x0 + (s / T) * noise
                        else:
                            x = x0
                    return x

                # (0.6.448) Short of memory in the steps, they are made again with fewer weights on the card
                # (smaller_shares) instead of failing: the same image, from the same noise, slower.
                x = smaller([lambda share=share: sample(share) for share in smaller_shares(budget)], torch)
                done += seedvr2.LAYERS * steps
                progress(stage='decoding', step=done, total=total)
                # The decoder's full-resolution activations need the VRAM the DiT cache holds,
                # and its RAM copies (8 GB) push Windows into paging. A further pass re-reads
                # the weights from the mapped file.
                pool.clear()
                torch.cuda.empty_cache()
                # Whole images up to 4096 px: the strip decoder keeps the VRAM low without tile
                # seams. Beyond, tiles bound the middle attention (quadratic in the latent area).
                final = x[0].permute(2, 0, 1)[None]
                decoders = [
                    lambda side=side: seedvr2_vae.tiled(vae.decode, final, 8, side, 32) for side in DECODE_TILES
                ]
                decoded = smaller(decoders, torch)
                del final
                decoded = ((decoded[:, :, :height, :width].float() + 1) / 2).clamp(0, 1)
                corrected = seedvr2_color.correct(decoded, reference, method)
                current = Image.fromarray(
                    (corrected[0].permute(1, 2, 0) * 255).round().to(torch.uint8).cpu().numpy()
                )
                timeline.append(
                    dict(
                        pass_=index + 1,
                        size=[width, height],
                        seconds=round(time.perf_counter() - start, 2),
                        share_gib=round(pool.limit / 1024**3, 2),
                    )
                )
                del latent, condition, x, decoded, corrected, reference
            cache = dict(gpu_cache_gib=round(pool.bytes / 1024**3, 3), residency=RESIDENCY.summary())
            del dit
        finally:
            pool.clear()
    del vae
    torch.cuda.empty_cache()
    output = np.asarray(current)
    metadata = dict(
        job=job,
        backend='pytorch-seedvr2-7b',
        source=list(source_size),
        passes=len(sizes),
        steps=steps,
        color_correction=method,
        seconds=round(time.perf_counter() - start, 2),
        peak_vram_gib=round(torch.cuda.max_memory_allocated() / 1024**3, 3),
        timeline=timeline,
        weight_cache=cache,
    )
    return save_image(output, config, job, metadata)
