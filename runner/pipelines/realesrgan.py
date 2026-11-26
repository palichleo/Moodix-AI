"""Real-ESRGAN upscaling of an original image, or of a video frame by frame with its audio kept."""

from contextlib import closing
import time

MAX_IMAGE_SIDE = 16384
MAX_VIDEO_SIDE = 4096


def _target(width, height, scale, max_side):
    """Output size: the model's scale, then reduced to max_side if set (never enlarged further)."""
    width, height = width * scale, height * scale
    if max_side and max(width, height) > max_side:
        ratio = max_side / max(width, height)
        width, height = max(2, round(width * ratio / 2) * 2), max(2, round(height * ratio / 2) * 2)
    return width, height


def as_bytes(result):
    """A picture (1, 3, H, W) in [0, 1] as its bytes (H, W, 3), where it is. (0.6.378) One copy in 32 bits at
    the most, then computed in it: bounding, multiplying and rounding each made a whole picture of their own,
    24 bytes a pixel at the most beside the result, some 8 GiB for the largest image the family gives
    (16384 x 16384). The same values, bit for bit."""
    import torch

    # (What the network gives is a tensor of inference: computed in place only in that mode.)
    with torch.inference_mode():
        values = result[0].permute(1, 2, 0).float()
        return values.clamp_(0, 1).mul_(255).round_().to(torch.uint8)


def _model_scale(path):
    from runner.models.rrdbnet import layout, state_dict

    return layout(state_dict(path))[0]


def preflight(job, config):
    """Reads the checkpoint layout and the source size on CPU, before the chat model is unloaded."""
    scale = _model_scale(job['components']['upscaler'])
    # The first check runs before the sources are copied; generation checks again with them.
    if not job['references']:
        return
    source = job['references'][0]['path']
    max_side = job['parameters'].get('max_side', 0)
    if job['mediaType'] == 'image':
        from runner.media import open_image

        with open_image(source) as image:
            width, height = _target(*image.size, scale, max_side)
        if max(width, height) > MAX_IMAGE_SIDE:
            raise ValueError(f'The upscaled image would exceed {MAX_IMAGE_SIDE} pixels; set a maximum side')
    else:
        from runner.video.stream import probe

        info = probe(source)
        width, height = _target(info['width'], info['height'], scale, max_side)
        if max(width, height) > MAX_VIDEO_SIDE:
            raise ValueError(f'The upscaled video would exceed {MAX_VIDEO_SIDE} pixels; set a maximum side')


def generate(job, config, progress):
    import numpy as np
    import torch
    from torch.nn import functional as F

    from runner.models import rrdbnet

    start = time.perf_counter()
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if device == 'cuda' else torch.float32
    if device == 'cuda':
        torch.cuda.reset_peak_memory_stats()
    # (0.6.412) Its stage, as SeedVR2 says it: « state » is read by nothing (lib/generation-progress.mjs).
    progress(stage='loading upscaler')
    model = rrdbnet.load(job['components']['upscaler']).to(device, dtype)
    parameters = job['parameters']
    tile, max_side = parameters.get('tile', 512), parameters.get('max_side', 0)
    source = job['references'][0]['path']

    def upscale(pixels):
        tensor = torch.from_numpy(pixels).to(device).permute(2, 0, 1)[None].to(dtype) / 255
        result = rrdbnet.upscale(model, tensor, tile=tile)
        width, height = _target(pixels.shape[1], pixels.shape[0], model.scale, max_side)
        # (0.6.377) Its height too: a clip four times as high as it is wide, brought under a largest side just
        # below its double, keeps its width and loses a few rows. Its width alone was compared: the picture went
        # as it was, and the video refused it (a frame of another size than its file).
        if tuple(result.shape[-2:]) != (height, width):
            result = F.interpolate(result.float(), size=(height, width), mode='area')
        return as_bytes(result).cpu().numpy()

    metadata = dict(job=job, backend='pytorch-rrdbnet', scale=model.scale, tile=tile, device=device)
    if job['mediaType'] == 'image':
        from runner.media import open_image, save_image

        with open_image(source) as image:
            pixels = np.array(image.convert('RGB'))
        progress(step=1, total=1)
        output = upscale(pixels)
        metadata.update(seconds=round(time.perf_counter() - start, 2), source=list(pixels.shape[1::-1]))
        if device == 'cuda':
            metadata['peak_vram_gib'] = round(torch.cuda.max_memory_allocated() / 1024**3, 3)
        return save_image(output, config, job, metadata)

    from runner.media import publish, subfolder
    from runner.video.stream import VideoWriter, frames, output_paths, probe

    info = probe(source)
    width, height = _target(info['width'], info['height'], model.scale, max_side)
    output, temporary, manifest = output_paths(config, '.mp4', job)
    writer = VideoWriter(temporary, width, height, info['fps'])
    try:
        # The source is closed as soon as the loop ends, however it ends.
        with closing(frames(source)) as reader:
            for index, pixels in enumerate(reader):
                writer.write(upscale(pixels))
                progress(step=index + 1, total=max(info['frames'], index + 1))
        writer.close(audio_from=source if info['audio'] else None)
    except BaseException:
        # Failed or stopped half-way: the encoder is closed, then its file removed (VideoWriter.abort).
        writer.abort()
        raise
    metadata.update(
        seconds=round(time.perf_counter() - start, 2),
        frames=writer.count,
        fps=float(info['fps']),
        audio=info['audio'],
        source=[info['width'], info['height']],
    )
    if device == 'cuda':
        metadata['peak_vram_gib'] = round(torch.cuda.max_memory_allocated() / 1024**3, 3)
    folder = subfolder(config, output)
    descriptor = dict(filename=output.name, subfolder=folder, type='output', width=width, height=height)
    return publish(temporary, output, manifest, dict(jobId=job['id'], outputs=[descriptor], metadata=metadata))
