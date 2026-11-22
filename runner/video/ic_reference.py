"""LTX2.5 reference videos: the clean latents of other videos read beside the one generated.

An in-context LoRA (IC-LoRA) is trained to read, beside the noisy video, the latents of one or
more reference videos showing the same times: its own guide. CrossView-Warp, say, reads the video
redrawn from the new camera (runner.video.camera_warp: what the first camera did not see in
magenta), then the video as it was filmed, in that order: the order of the job's references.

Their tokens are appended to the sequence clean (conditioning mask 1, so timestep 0 at every
step), at the positions of the frames they show: the same times as the video generated, the
height and width axes multiplied by the factor the LoRA was trained with (its file says it:
`reference_downscale_factor`, the reference being that many times smaller than the video). The
learned marker of LTX 2.5's keyframes is left off them, as it is off every appended token (see
`keyframe_marker` in runner.pipelines.ltx25). The pipeline drops them from the result with the
other appended tokens. As in the IC-LoRA and DFR pipelines of diffusers' LTX2 (Apache-2.0).
"""

ROLE = 'reference_video'
FACTOR = 'reference_downscale_factor'
# The factors an IC-LoRA may declare (LTX's own upscaler: 2; CrossView-Warp: 1).
FACTORS = (1, 2, 4)
# When the encoder of a whole reference does not fit: tiles of this many frames, this far apart
# (one latent frame shared), and the library's own tiles of 512 pixels across.
TILE_FRAMES, TILE_STRIDE = 64, 56


def downscale_factor(entries):
    """The factor an IC-LoRA file declares (`entries` is its header), or None for another LoRA."""
    value = (entries.get('__metadata__') or {}).get(FACTOR)
    if value is None:
        return None
    try:
        factor = int(value)
    except (TypeError, ValueError):
        raise ValueError('Invalid IC-LoRA ' + FACTOR) from None
    if factor not in FACTORS:
        raise ValueError(f'Unsupported IC-LoRA {FACTOR}: {factor}')
    return factor


def guides(job):
    """The reference videos of a job, in its order (the order the IC-LoRA reads them in)."""
    return [ref for ref in job['references'] if ref['role'] == ROLE]


def validate(job):
    """Reference videos come with one IC-LoRA, and an IC-LoRA with its reference videos: alone,
    it would change the model for nothing it can read. Returns the LoRA's downscale factor (None
    without reference videos)."""
    from runner.models.headers import header

    found = [factor for factor in (downscale_factor(header(item['path'])) for item in job['loras']) if factor]
    if len(found) > 1:
        raise ValueError('This LTX2.5 executor supports one IC-LoRA at a time')
    if guides(job):
        if not found:
            raise ValueError(f'Reference videos require their IC-LoRA (a LoRA whose file declares {FACTOR})')
        return found[0]
    if found:
        raise ValueError('An IC-LoRA needs its reference videos: add them, or remove the LoRA')
    return None


def latent_size(parameters, factor):
    """(latent frames, rows, columns) a reference takes in the sequence."""
    rows = parameters['height'] // factor // 32
    columns = parameters['width'] // factor // 32
    return (parameters['frames'] - 1) // 8 + 1, rows, columns


def read_frames(path, count):
    """The first `count` frames of a video, [count, height, width, 3] uint8."""
    import numpy as np
    from runner.video.stream import frames

    found = []
    for frame in frames(path):
        found.append(frame)
        if len(found) == count:
            break
    if len(found) < count:
        raise ValueError(f'La vidéo de référence a {len(found)} images ; la vidéo à faire en compte {count}.')
    return np.stack(found)


def pixels(frames, height, width, torch, device, dtype=None):
    """Frames [F, H, W, 3] uint8 as the encoder reads them: [1, 3, F, height, width] in [-1, 1],
    in `dtype` (the encoder's; float32 when None), scaled to cover (height, width) and cropped in
    the middle, as LTX2's conditions are (bilinear, no smoothing before: diffusers'
    LTX2ConditionPipeline.preprocess_conditions). Computed in float32 in place: a video of 121
    frames of 768 × 448 takes 0.5 GiB so."""
    import math

    import numpy as np

    video = torch.from_numpy(np.ascontiguousarray(frames)).to(device).permute(0, 3, 1, 2).float()
    source_height, source_width = video.shape[-2:]
    if (source_height, source_width) != (height, width):
        scale = max(height / source_height, width / source_width)
        size = (math.ceil(source_height * scale), math.ceil(source_width * scale))
        video = torch.nn.functional.interpolate(video, size=size, mode='bilinear', align_corners=False)
        top, left = (size[0] - height) // 2, (size[1] - width) // 2
        video = video[:, :, top : top + height, left : left + width]
    video = video.div_(127.5).sub_(1.0).permute(1, 0, 2, 3).unsqueeze(0)
    # One copy, in the encoder's order and precision.
    return torch.empty(video.shape, dtype=dtype or torch.float32, device=video.device).copy_(video)


def encode(vae, video, torch, smaller):
    """The latents of a reference video ([1, 128, f, h, w]) and how they were made: whole, or in
    tiles when the encoder of the whole video does not fit beside what the card holds."""
    used = ['whole']

    def whole():
        return vae.encode(video).latent_dist.mode()

    def tiled():
        names = ('use_framewise_decoding', 'tile_sample_min_num_frames', 'tile_sample_stride_num_frames', 'use_tiling')
        saved = {name: getattr(vae, name) for name in names}
        try:
            # (`use_framewise_decoding` is the switch diffusers' LTX2 encoder reads to cut in time.)
            vae.use_framewise_decoding = True
            vae.tile_sample_min_num_frames, vae.tile_sample_stride_num_frames = TILE_FRAMES, TILE_STRIDE
            vae.use_tiling = True
            return vae.encode(video).latent_dist.mode()
        finally:
            for name, value in saved.items():
                setattr(vae, name, value)

    latents = smaller([whole, tiled], torch, told=lambda place: used.__setitem__(0, 'tiles'))
    return latents, used[0]


def coordinates(rope, shape, factor, device, frame_rate):
    """The positions of a reference's tokens, [1, 3, tokens, 2]: those of a video of its latent
    size, at the same times as the video generated, height and width times `factor`."""
    frames, rows, columns = shape
    position = rope.prepare_video_coords(1, frames, rows, columns, device, fps=frame_rate)
    if factor != 1:
        position[:, 1:] = position[:, 1:] * factor
    return position


def append(latents, mask, clean, coords, added, positions, strength, generator, torch):
    """The sequence with the reference tokens after it: `added` [1, tokens, channels] (each
    reference, packed, one after the other) at `positions`, held at `strength` (1: clean at every
    step). Noise is drawn only for a strength below 1: at 1, the video and its sound are drawn from
    the same noise as without references."""
    batch = latents.shape[0]
    added = added.to(latents.dtype).expand(batch, -1, -1)
    newmask = torch.full((*added.shape[:2], 1), float(strength), device=added.device, dtype=mask.dtype)
    noisy = added
    if strength < 1:
        noise = torch.randn(added.shape, device=added.device, dtype=added.dtype, generator=generator)
        noisy = added * newmask + noise * (1 - newmask)
    positions = positions.expand(batch, -1, -1, -1)
    coords = positions if coords is None else torch.cat((coords, positions), dim=2)
    return (
        torch.cat((latents, noisy), dim=1),
        torch.cat((mask, newmask), dim=1),
        torch.cat((clean, added), dim=1),
        coords,
    )


def pipeline_class():
    import torch
    from diffusers import LTX2ConditionPipeline
    from runner.models.ladder import smaller

    class GuidedPipeline(LTX2ConditionPipeline):
        """LTX2ConditionPipeline with the job's reference videos after the sequence: set
        `ic_references` (the refs), `ic_factor`, `ic_strength`, and `ic_encoded` (a list told how
        each was encoded) before calling it; `ic_progress`, when set, is told each encoding."""

        def prepare_latents(self, *args, **kwargs):
            latents, mask, clean, coords = super().prepare_latents(*args, **kwargs)
            parameters = dict(width=kwargs['width'], height=kwargs['height'], frames=kwargs['num_frames'])
            frames, rows, columns = latent_size(parameters, self.ic_factor)
            device = kwargs['device']
            packed, positions = [], []
            for index, ref in enumerate(self.ic_references):
                report = getattr(self, 'ic_progress', None)
                if report:
                    report(stage='encoding reference video', reference=index + 1, of=len(self.ic_references))
                frames_read = read_frames(ref['path'], kwargs['num_frames'])
                video = pixels(frames_read, rows * 32, columns * 32, torch, device, self.vae.dtype)
                del frames_read
                encoded, how = encode(self.vae, video, torch, smaller)
                del video
                encoded = self._normalize_latents(encoded, self.vae.latents_mean, self.vae.latents_std)
                if tuple(encoded.shape[2:]) != (frames, rows, columns):
                    raise ValueError('Unexpected reference video latent size')
                self.ic_encoded.append(how)
                packed.append(
                    self._pack_latents(
                        encoded, self.transformer_spatial_patch_size, self.transformer_temporal_patch_size
                    )
                )
                positions.append(
                    coordinates(
                        self.transformer.rope, (frames, rows, columns), self.ic_factor, device, kwargs['frame_rate']
                    )
                )
                del encoded
            if not packed:
                return latents, mask, clean, coords
            return append(
                latents,
                mask,
                clean,
                coords,
                torch.cat(packed, dim=1),
                torch.cat(positions, dim=2),
                self.ic_strength,
                kwargs['generator'],
                torch,
            )

    return GuidedPipeline
