"""Native MiniMax-H3 (FastH3 Omni / FastH3 v2, and MiniMax's own FL2VA / Ref2VA): prompt + references
-> video with sound.

The request flow is the diffusers MiniMax-H3 modular pipeline (Apache-2.0), run
stage by stage so only one large model occupies the GPU at a time:
presentation + conditioner, VAE encoding of the conditions, 8-step joint
denoise with the streamed DiT, then video and audio decoding.
"""

from contextlib import ExitStack, contextmanager
import gc
import math
import time

from runner import hardware, preview

# The steps a checkpoint is sampled in: the distilled ones (FastH3), and MiniMax's own (0.6.108).
STEPS = 8
BASE_STEPS = 20
FRAME_CHOICES = tuple(17 * n + 5 for n in range(7, 21))  # 5 to 15 seconds at 24 fps
# A continuation overlap must cover whole VAE chunks (17n+5 frames -> 5n+2 latent frames),
# so the source tail encodes onto exactly the latent frames that open the new window.
OVERLAPS = (22, 39, 56)
AUDIO_LATENTS_PER_SECOND = 40
# RAM the weights kept between two videos leave free, in GiB. The model (19 GiB) does not fit
# whole beside everything else in 32 GiB: only the share of it that every step copies to the GPU
# is kept, page-locked (14 GiB with 4.7 GiB of the model on a 12 GiB card). Read from unlocked
# memory, those copies took a third of each step.
RAM_RESERVE_GIB = 4
# Locked a little beyond what is copied, so the next video finds its weights there (see streamed).
LOCK_MARGIN_GIB = 0.5
# Weights copied to the GPU in advance, while it computes the layers before them (WeightPool).
AHEAD_GIB = 0.5
# What is asked free beyond what the steps were measured to hold (least_gib): the margin of the
# engine (1 GiB) and half a gigabyte. With less, a video of 1920 x 1088 failed one time of two,
# after five minutes (17/11).
EDGE_GIB = 1.5
# Video memory what runs once before the steps takes beside a model left on the card, in GiB:
# the conditioner (1.4, 2.1 with reference images), the VAE encoders of the references (1.6),
# measured on the sweep of 17/11; and the margin the engine keeps under what is free.
BESIDE_GIB = 3.0
CEILING_GIB = 1.0
# What the video VAE's pixels are normalised by (ImageNet's, as the library's pipeline says).
PIXEL_MEAN, PIXEL_STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)
# (0.6.423) pi H3: a step adapter of MiniMax's FL2VA (pi-Flow, Hansheng Chen; runner.models.minimax_h3,
# validate_adapter). The steps of one whose name says none, where its grid starts (the raw time of the
# first step, lower for two steps), and how long its last step is beside the others (ComfyUI-piFlow,
# docs/piH3.md and the « pi-Flow Scheduler » of its workflows: Apache-2.0).
PI_STEPS = 4
PI_START, PI_START_SHORT, PI_LAST_STEP = 0.96, 0.93, 0.6


def grid_of(parameters):
    """(latent frames, rows, columns) of the tokens of a video."""
    return ((parameters['frames'] - 5) // 17 * 5 + 2, parameters['height'] // 32, parameters['width'] // 32)


def working_gib(tokens):
    """Video memory the model computes with beside its weights, in GiB: 5 (a feed-forward chunk,
    the allocator's slack, the engine's margin) plus the activations, which grow with the video
    (1 GiB for a 5 s draft)."""
    return 5 + tokens * 7168 * 2 * 6 / 1024**3


def least_gib(tokens):
    """Video memory the steps hold at the least, in GiB: with none of the weights kept on the
    card, and the dense attention in pieces. Measured on the sweep of 17/11 (RTX 4070 SUPER,
    INT8 model): 2.6 for 12 900 tokens, 5.1 for 34 800, 5.3 for 37 800, 9.7 for 76 000."""
    return 1.2 + 0.112 * tokens / 1000


def decode_gib(parameters):
    """Video memory the decode of the video holds, in GiB: its decoder (4.6) and what it
    computes a clip with, which grows with the picture. Measured 17/11 with the audio VAE
    beside it: 5.4 at 768 x 448, 6.0 at 1344 x 768; half a gigabyte is added to spare."""
    return 5.2 + 0.8e-6 * parameters['width'] * parameters['height']


class Loaded:
    """The video model as one generation leaves it for the next (runner.models.kept): its file
    open, its layers built, the share of its weights that stays on the GPU. As LTX 2.5's.

    Built at every video, the share was read from the file each time (2 s of a draft), and its
    pages pushed the decoders' file out of the system's cache: the decoder then took 3.6 to
    7.3 s to load, where ComfyUI leaves both on the card (18/11)."""

    def __init__(self, key):
        self.key, self.stack = key, ExitStack()
        self.store = self.pool = self.dit = self.sparse = None
        # The file of its step adapter (pi H3), open with the model's.
        self.adapter = None
        self.fast = False
        # Video memory all this holds, measured once the generation that leaves it is over.
        self.allocated = 0
        # Whether what its steps copy to the GPU comes from page-locked RAM, and the bytes there.
        self.locked = True
        self.ram = 0

    def drop(self):
        try:
            if self.pool is not None:
                self.pool.clear()
        finally:
            # Whatever the card answered, the file is closed and its RAM given back.
            self.dit = self.pool = self.sparse = None
            self.stack.close()


def keep_streamed(loaded, pool):
    """What the steps copy to the GPU goes to page-locked RAM (Store.keep): the weights of the model that do
    not stay on the card, and those of its step adapter (pi H3). Sets `loaded.locked` (whether the model may
    be left for the next video) and returns the bytes kept.

    (0.6.458) The adapter's first. Asked after the model's 15 GiB, its gigabyte found no room when RAM was
    short (32 GiB, a browser and other programs beside): the model was then held to be unlocked and thrown
    away after its video, and the next one built it anew, 10 s (three cold starts out of five, 27/11). Asked
    first it always fits; what RAM lacks is then cut from the end of the model's part, which the steps read
    from its file as they do for a model larger than what may be locked."""
    from runner.models import minimax_h3

    reserve = int(RAM_RESERVE_GIB * 1024**3)
    ours = pool.streamed().get(minimax_h3.ADAPTER, ()) if loaded.adapter is not None else ()
    kept = loaded.adapter.keep(ours, reserve) if ours else 0
    copied = pool.streamed().get('model', ())
    kept += loaded.store.keep(copied, reserve, spare=pool.streamed(LOCK_MARGIN_GIB, onward=True).get('model', ()))
    loaded.locked = (not copied or loaded.store.pinned) and (not ours or loaded.adapter.pinned)
    return kept


def too_large(parameters, card_gib):
    """Why this video cannot be made on a card of `card_gib`, in the user's words; '' when it can,
    or when the card is not known. Said before anything is unloaded for it: at 1344 x 768 for
    14 s the steps alone hold more than a 12 GiB card has, and the generation failed after
    half a minute, whatever was closed (17/11)."""
    if not card_gib:
        return ''
    need = least_gib(math.prod(grid_of(parameters)) + 512)
    # The engine keeps 1 GiB of the card free (runner.engine).
    if need <= card_gib - 1:
        return ''
    said = lambda value: f'{value:.0f}'  # noqa: E731
    return (
        f'MiniMax H3 ne peut pas faire cette vidéo sur cette carte graphique ({said(card_gib)} Go) : '
        f'{parameters["width"]} × {parameters["height"]} pendant {round(parameters["frames"] / 24)} s '
        f'demande environ {said(need)} Go pour le calcul seul. Réduisez la durée ou la résolution.'
    )


def check(job, family):
    p = job['parameters']
    roles = [ref['role'] for ref in job['references']]
    if p['frames'] not in FRAME_CHOICES:
        raise ValueError('MiniMax-H3 frames must be 17n+5 between 124 and 345')
    if p['fps'] != 24:
        raise ValueError('MiniMax-H3 generates at 24 fps')
    if roles.count('reference_image') > 9:
        raise ValueError('At most 9 reference images')
    if 'reference_image' in roles and ({'start_image', 'end_image'} & set(roles)):
        raise ValueError('Choose reference images or start/end images, not both')
    if 'source_video' in roles and ({'start_image', 'end_image'} & set(roles)):
        raise ValueError('A continuation already starts on its source video; drop the start/end images')
    if 'source_video' in roles and p.get('overlap_frames', 22) not in OVERLAPS:
        raise ValueError('MiniMax-H3 continuation overlap must be 22, 39 or 56 frames')


def steps_of(header):
    """The steps this checkpoint says it is sampled in, or None when it says nothing. A distilled one
    says so by what distillation left in it: several output heads (FastH3 Omni), or the gates of the
    sparse attention it was taught (FastH3 v2). MiniMax's own checkpoints have neither. (0.6.418) Nor
    has a distilled one merged into plain weights, nor one computed with a step adapter: a file without
    those marks is no proof of 20 steps, and its steps are those its version asks (check_steps)."""
    from runner.models import minimax_h3

    return STEPS if minimax_h3.pdd_heads(header) > 1 or minimax_h3.has_gates(header) else None


def model_path(job):
    """The file of the model for this job. MiniMax's own checkpoints come in two files: one for
    a text and start or end images (FL2VA), one for reference images (Ref2VA). A workflow that
    names the second (`referenceModel`) is given it for a job with reference images."""
    components = job['components']
    referenced = any(ref['role'] == 'reference_image' for ref in job['references'])
    return components['referenceModel'] if referenced and components.get('referenceModel') else components['model']


def adapter_path(job):
    """The file of the step adapter (pi H3) this job is computed with, or None."""
    return job['components'].get('stepAdapter') or None


def adapter_steps(path):
    """The steps a step adapter is sampled in: those its name says (« pi_h3_2step_… », « 4step »), 4 when
    it says none. Nothing in its tensors tells a two-step adapter from a four-step one."""
    import re
    from pathlib import Path

    said = re.search(r'(?:^|[^a-z0-9])(\d{1,2})[\s_-]?steps?(?![a-z])', Path(path).stem, re.IGNORECASE)
    return int(said.group(1)) if said and int(said.group(1)) >= 2 else PI_STEPS


def pi_sigmas(steps, shift):
    """The sigmas of a pi H3 creation for a stream of that shift (12 the video, 3 the sound), the final 0
    with them. The model's own schedule on another grid: raw times from 0.96 (0.93 in two steps) down to
    a last step 0.6 times as long as the others, where MiniMax's go from 1 to 0 in equal steps. In four
    steps: 0.96, 0.6933, 0.4267, 0.16, then 0; the video's sigmas are 0.99654, 0.96445, 0.89930, 0.69565."""
    top = PI_START if steps > 2 else PI_START_SHORT
    last = top * PI_LAST_STEP / (steps - 1 + PI_LAST_STEP)
    grid = [top + (last - top) * index / (steps - 1) for index in range(steps)]
    return [shift * raw / (1 + (shift - 1) * raw) for raw in grid] + [0.0]


def pi_scheduler(shift, steps):
    """MiniMax-H3's scheduler on the grid of pi H3 (pi_sigmas): the block that sets the timesteps asks
    for a number of them, and is given this grid whatever it asks. The steps are the library's Euler
    steps: with one output head, the policy the adapter names (« DX ») is exactly that."""
    from diffusers import MiniMaxH3Scheduler

    class PiScheduler(MiniMaxH3Scheduler):
        def set_timesteps(self, num_inference_steps=None, device=None, sigmas=None):
            super().set_timesteps(device=device, sigmas=pi_sigmas(steps, self.shift))

    return PiScheduler(shift=shift)


def pi_noise(parameters, generator, sigmas, device='cuda'):
    """The noise a pi H3 creation starts from, {latents, audio_latents} as the block of the library takes
    them in place of its own draws: the same draws (the video, then the sound in rows, from the generator
    of the request), each times the first sigma of its stream. The grid of pi H3 does not start at 1
    (0.9965 the video, 0.9863 the sound), and the adapter was made for a start at that level, as
    ComfyUI gives it: the library starts every creation from the noise itself."""
    import torch
    from diffusers.utils.torch_utils import randn_tensor

    device = torch.device(device)
    frames, height, width = grid_of(parameters)
    # (A token of the model is two latents by two; 24 channels, and 32 for each of the two of the sound.)
    shape = (1, 24, frames, height * 2, width * 2)
    video = randn_tensor(shape, generator=generator, device=device, dtype=torch.float32)
    count = round(parameters['frames'] / 24 * AUDIO_LATENTS_PER_SECOND)
    rows = randn_tensor((count * 2, 32), generator=generator, device=device, dtype=torch.float32)
    # (The block takes the sound as (2, 32, latents) and lays it in rows, channel after channel.)
    return dict(latents=video * sigmas[0], audio_latents=rows.reshape(2, count, 32).permute(0, 2, 1) * sigmas[1])


def keep_last_rows(dit, calls, steps, target, held):
    """Keeps in `held`, at the last step, what the pixel head of pi H3 reads (minimax_h3_dwd): the rows of
    the generated video as the 50 blocks leave them, before the final norm (`hidden`), the embedding of
    each time of that step (`temb`) and the time of each row (`indices`). The generated video is the last
    `target` video rows of the packed sequence (its conditions come first). Returns the hooks."""

    def before(_module, _args, values):
        held['rows'] = values['video_indices'][-target:] if calls['step'] == steps - 1 else None

    def at_norm(_module, args):
        rows = held.get('rows')
        if rows is not None:
            hidden, temb, indices = args
            held.update(
                hidden=hidden[0].index_select(0, rows), temb=temb.clone(), indices=indices.index_select(0, rows)
            )

    return (
        dit.register_forward_pre_hook(before, with_kwargs=True),
        dit.norm_out.register_forward_pre_hook(at_norm),
    )


def check_steps(job, header):
    """The steps of this job. A checkpoint that says its own (steps_of) is computed in those, and a
    job that asks for others is told so. One that says nothing is computed in the steps asked, 20
    (MiniMax's own) when none are: each version of the model has its steps (lib/model-versions.mjs).
    (0.6.423) With a step adapter (pi H3), in the steps of the adapter, whatever is asked: they are its
    own, nothing to choose.

    (0.6.418) A file without marks was held to be MiniMax's own, and refused unless 20 steps were
    asked. A distilled one merged into plain weights, read in place of the file its workflow was
    shipped with (deleted), could not be computed at all: « il se calcule en 20 étapes, pas en 8 »."""
    if adapter_path(job):
        return adapter_steps(adapter_path(job))
    said, asked = steps_of(header), job['parameters'].get('steps')
    if said is None:
        return BASE_STEPS if asked is None else asked
    if asked is not None and asked != said:
        raise ValueError(
            f'Ce modèle MiniMax H3 est distillé (FastH3) : il se calcule en {said} étapes, pas en {asked}. '
            f'Réglez ses étapes sur {said}, ou choisissez une autre version du modèle.'
        )
    return said


def model_kind(header):
    """'reference' for a Ref2VA-derived DiT (FastH3 Omni), 'base' otherwise (FastH3 v2)."""
    source = (header.get('__metadata__') or {}).get('source', '')
    return 'reference' if source == 'transformer_ref' else 'base'


def check_subject(job, header):
    """A subject asked of a checkpoint that takes none is refused. FastH3 Omni also runs text-only and start or
    end image requests: their packed sequences only add keyframe condition rows, which the reference model
    reads like LongForge does. A file the workflow names for reference images (MiniMax's Ref2VA) takes them too.

    (0.6.373) Checked before the creation (preflight), while the chat model is still loaded: said once the
    creation had begun, the chat model had been unloaded for nothing, and the MiniMax model kept from the video
    before was thrown away (its shape differs)."""
    roles = {ref['role'] for ref in job['references']}
    if (
        model_kind(header) == 'base'
        and 'reference_image' in roles
        and model_path(job) != job['components'].get('referenceModel')
    ):
        # (0.6.198) In the words of the page: « sujet », and the field as Paramètres › Modèles names it.
        raise ValueError(
            'Ce modèle MiniMax H3 ne prend pas de sujet : utilisez FastH3 Omni, ou donnez-lui son '
            '« Modèle pour les sujets » (Ref2VA) dans Paramètres › Modèles.'
        )


def check_adapter(job, model):
    """The header of the step adapter (pi H3) of this job, None when it has none. Refused before the
    creation, in the user's words, when it is not one for the model (`model`, its header), when its
    pixel head is not the one read here, or when it was tuned on another model of the same shapes."""
    path = adapter_path(job)
    if not path:
        return None
    from runner.models.headers import header
    from runner.models import minimax_h3, minimax_h3_dwd

    adapter = header(path)
    minimax_h3.validate_adapter(model, adapter)
    minimax_h3_dwd.validate(adapter)
    if not minimax_h3.fits_base(model_path(job), path):
        raise ValueError(
            'pi H3 est fait pour le modèle MiniMax H3 de base (FL2VA) : le modèle choisi en est un autre '
            '(Ref2VA ou une variante), avec lequel il ne donne que du bruit. Choisissez le fichier FL2VA '
            'dans Paramètres › Modèles.'
        )
    return adapter


def preflight(job, config):
    from runner.models.headers import header
    from runner.models import minimax_h3

    model = header(model_path(job))
    minimax_h3.validate(model)
    check_adapter(job, model)
    check_steps(job, model)
    check_subject(job, model)
    # A video the card cannot hold is said now, not after half a minute of loading.
    refused = too_large(job['parameters'], hardware.card_gib())
    if refused:
        raise RuntimeError(refused)
    # A source video of another size or frame rate is refused here, before the chat model is unloaded.
    for ref in job['references']:
        if ref['role'] == 'source_video':
            from runner.video.continuation import source_tail

            source_tail(ref['path'], job['parameters'], overlaps=OVERLAPS, default=22)


def _stage(block_name, components, state, **inputs):
    """Run one MiniMax-H3 block as its own small pipeline on the shared request state.

    One `PipelineState` carries the request (and the raw `references` / `image` /
    `last_image` the auto blocks select their workflow on) from stage to stage, so
    each stage only needs its own models loaded. The pipeline works on a copy:
    use the returned state.
    """
    from diffusers.modular_pipelines import MiniMaxH3Blocks

    # (« decode.audio »: a step of a block, when another of its steps is done here.)
    block = MiniMaxH3Blocks()
    for name in block_name.split('.'):
        block = block.sub_blocks[name]
    pipe = block.init_pipeline()
    needed = {spec.name for spec in block.expected_components} | {spec.name for spec in block.expected_configs}
    pipe.update_components(**{name: value for name, value in components.items() if name in needed})
    for name, value in inputs.items():
        if value is not None:
            state.set(name, value)
    return pipe(state=state)


def _free():
    import torch

    gc.collect()
    torch.cuda.empty_cache()


def _decoded_sound(state, parameters, paths):
    """The state once the sound of the video is decoded, that sound and its sampling rate; none for a video
    asked without sound. (0.6.374) Its decoder was loaded and the sound decoded for these too, then left out."""
    if not parameters.get('audio', True):
        return state, None, None
    from runner.models import minimax_h3_vae

    audio_vae = minimax_h3_vae.audio_vae(paths['audioVae'])
    state = _stage('decode.audio', dict(audio_vae=audio_vae), state)
    del audio_vae
    return state, state.get('audio'), state.get('sampling_rate')


@contextmanager
def _conditioner(path):
    """The conditioner and its open store, for the time a prompt is encoded: the store is closed after it
    whatever happened. (0.6.371) Closed after the prompt was kept, an encoding that failed (the card out of
    memory, and the creation made again in the same process) left it open: its reading thread asleep with up
    to 1 GiB of the file, the file held (neither replaced nor deleted under Windows), or its arena held where
    it fits in RAM. The model first, then the store it reads."""
    from runner.models import minimax_h3_text

    text_encoder, store = minimax_h3_text.load(path)
    try:
        yield text_encoder, store
    finally:
        del text_encoder
        store.close()


def _patchify(latents):
    """(1, C, T, H, W) VAE latents -> packed video rows (T * H/2 * W/2, C * 4), frame-major."""
    _, channels, frames, height, width = latents.shape
    rows = latents.reshape(1, channels, frames, 1, height // 2, 2, width // 2, 2)
    return rows.permute(0, 2, 4, 6, 1, 3, 5, 7).reshape(frames * (height // 2) * (width // 2), channels * 4)


def middle_frame(rows, velocity, sigma, grid):
    """The generated video's middle latent frame (C, H, W) as a step sees it finished, from the
    DiT's video rows and their velocity (1, rows, C * 4): the video's `grid` of tokens comes
    last, laid out as `_patchify` does. MiniMax-H3 predicts a data-ward velocity: x0 = x + sigma * v."""
    frames, height, width = grid
    count = height * width
    first = rows.shape[1] - (frames - frames // 2) * count
    finished = rows[0, first : first + count].float() + float(sigma) * velocity[0, first : first + count].float()
    finished = finished.reshape(height, width, -1, 2, 2)
    return finished.permute(2, 0, 3, 1, 4).reshape(finished.shape[2], height * 2, width * 2)


def protect_head(dit, schedulers, calls, video_head, audio_head, target_video_rows, target_audio_latents):
    """LongForge PROTECTED continuation on the packed sequence.

    The first target rows (video: the source tail's latent frames; audio: both stereo
    channels' first latents) are fed clean at a pinned timestep, and their velocity is
    replaced so every Euler step lands them on the clean source: the generated window
    opens exactly on the end of the source video and its sound.
    """
    import torch

    held = {}

    def before(_module, args, values):
        hidden, audio = values['hidden_states'], values['audio_hidden_states']
        timestep, indices = values['timestep'], values['timestep_indices'].clone()
        video_rows = values['video_indices']
        audio_rows = values['audio_indices']
        first_video = hidden.shape[1] - target_video_rows
        first_audio = audio.shape[1] - 2 * target_audio_latents
        video_slice = slice(first_video, first_video + video_head.shape[0])
        audio_slices = [
            slice(start, start + audio_head.shape[1])
            for start in (first_audio + channel * target_audio_latents for channel in range(2))
        ]
        held['video'] = (video_slice, hidden[0, video_slice].float())
        held['audio'] = [(part, audio[0, part].float()) for part in audio_slices]
        hidden = hidden.clone()
        hidden[0, video_slice] = video_head.to(hidden)
        audio = audio.clone()
        for channel, part in enumerate(audio_slices):
            audio[0, part] = audio_head[channel].to(audio)
        # Pinned timesteps: video like the other clean condition rows, audio fully clean.
        timestep = torch.cat([timestep, timestep.new_tensor([0.999, 1.0])])
        indices[video_rows[video_slice]] = timestep.numel() - 2
        for part in audio_slices:
            indices[audio_rows[part]] = timestep.numel() - 1
        values.update(hidden_states=hidden, audio_hidden_states=audio, timestep=timestep, timestep_indices=indices)
        return args, values

    def after(_module, _args, _values, output):
        video, audio = output[0].clone(), output[1].clone()
        step = calls['step'] - 1  # the step counter hook ran first
        sigma = float(schedulers[0].sigmas[step])
        audio_sigma = float(schedulers[1].sigmas[step])
        # MiniMax-H3 predicts a data-ward velocity: x0 = x + sigma * v.
        part, noisy = held['video']
        video[0, part] = ((video_head.to(noisy) - noisy) / sigma).to(video)
        for channel, (part, noisy) in enumerate(held['audio']):
            audio[0, part] = ((audio_head[channel].to(noisy) - noisy) / audio_sigma).to(audio)
        return (video, audio, *output[2:])

    return (
        dit.register_forward_pre_hook(before, with_kwargs=True),
        dit.register_forward_hook(after, with_kwargs=True),
    )


def _encode_tail(vae, audio_vae, path, tail, plan, parameters):
    """Clean packed rows of the source tail: video (rows, 96) and audio (2, latents, 32)."""
    import numpy as np
    import torch
    from diffusers.modular_pipelines.minimax_h3.encoders import encode_vae_condition
    from runner.video.audio_tail import read_audio

    pixels = torch.from_numpy(np.stack([np.asarray(frame.convert('RGB')) for frame in tail]))
    pixels = pixels.to(vae.device).permute(3, 0, 1, 2)[None]
    # Same recipe as the pipeline's own visual conditions (ImageNet pixels, seeded posterior sample).
    latents = encode_vae_condition(vae, pixels, PIXEL_MEAN, PIXEL_STD, 42)
    video_head = _patchify(latents.float())
    overlap = plan['overlapFrames']
    count = math.floor(overlap / 24 * AUDIO_LATENTS_PER_SECOND)
    audio_head = torch.zeros(2, 0, audio_vae.config.latent_channels)
    if parameters.get('audio', True) and plan.get('sourceAudio'):
        rate = audio_vae.config.sampling_rate
        hop = rate // AUDIO_LATENTS_PER_SECOND
        start = (plan['sourceFrames'] - overlap) / 24
        wave = read_audio(path, start, plan['sourceFrames'] / 24, rate=rate)
        if wave is not None:
            wave = np.pad(wave, ((0, 0), (0, -wave.shape[1] % hop)))
            posterior = audio_vae.encode(torch.from_numpy(wave).to(audio_vae.device)[:, None], return_dict=False)[0]
            audio = posterior.mode().float().cpu().transpose(1, 2)
            mean = torch.tensor(audio_vae.config.latents_mean).view(1, 1, -1)
            std = torch.tensor(audio_vae.config.latents_std).view(1, 1, -1)
            audio_head = ((audio - mean) / std)[:, :count]
    return video_head, audio_head


def generate(job, config, progress):
    """One video. The model the last generation left on the GPU is taken back when it is the one
    this job asks for (same file, same attention) for a video of the same shape, and left
    there again at the end."""
    import torch
    from runner.models import conditioning, kept

    p = job['parameters']
    shape = [p['width'], p['height'], p['frames'], sorted(ref['role'] for ref in job['references'])]
    attention = [p.get('attention', 'comfy_kitchen'), p.get('sparse_attention', 'off'), p.get('sparse_keep', 10)]
    key = [conditioning.stamp(model_path(job)), shape, attention]
    if adapter_path(job):
        # (0.6.423) A model built with a step adapter is never another's, nor the model's without it.
        key.append(conditioning.stamp(adapter_path(job)))
    holder = [kept.take('minimax_h3', key)]
    try:
        result = _generate(job, config, progress, key, holder)
    except BaseException:
        # Whatever state the failure left it in, it is not one to start the next video from.
        if holder[0] is not None:
            holder[0].drop()
        raise
    loaded = holder[0]
    if not loaded.locked or not loaded.pool.gpu:
        # RAM was short when it was built (its steps copied from the file's mapping, whose
        # pages stay in this process while the file is open), or its share left for the
        # decode: the next video builds it anew.
        loaded.drop()
    else:
        gc.collect()
        loaded.allocated = torch.cuda.memory_allocated()
        kept.put('minimax_h3', loaded)
    return result


def _generate(job, config, progress, key, holder):
    import numpy
    import torch
    from diffusers import MiniMaxH3Scheduler
    from diffusers.modular_pipelines.minimax_h3 import encoders as reference_encoders
    from diffusers.modular_pipelines.minimax_h3.references import MiniMaxH3ImageReference
    from runner.media import open_image
    from runner.models.headers import header
    from runner.models import conditioning, minimax_h3, minimax_h3_dwd, minimax_h3_text, minimax_h3_vae
    from runner.models.ladder import smaller
    from runner.models.pool import WeightPool, require
    from runner.models.residency import RESIDENCY, open_store, prefetch, use_order
    from runner.pipelines.ltx25 import memory
    from runner.video.export import save_video

    if not torch.cuda.is_available():
        raise RuntimeError('Native MiniMax-H3 requires CUDA')
    # Asked for before anything is loaded: what the model computes with for this video. Its
    # weights follow the card (see the budget below).
    require(
        'MiniMax H3',
        working_gib(math.prod(grid_of(job['parameters'])) + 512),
        'la taille ou la durée de la vidéo',
        measured=least_gib(math.prod(grid_of(job['parameters'])) + 512) + EDGE_GIB,
    )
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    timeline = []
    report = progress

    def progress(**data):
        timeline.append(
            dict(
                {key: value for key, value in data.items() if key != 'prompt'},
                seconds=round(time.perf_counter() - start, 2),
                allocated_gib=round(torch.cuda.memory_allocated() / 1024**3, 3),
                free_gib=round(hardware.free_bytes(torch) / 1024**3, 3),
                **memory(),
            )
        )
        report(**data)

    # (The model's file is the one of this job: see model_path.)
    p, paths = job['parameters'], dict(job['components'], model=model_path(job))
    dit_header = header(paths['model'])
    # (0.6.423) Its step adapter (pi H3), refused before the creation (preflight) and here again.
    adapter = check_adapter(job, dit_header)
    steps = check_steps(job, dit_header)
    kind = model_kind(dit_header)
    # (Refused before the creation, in preflight; here again for who calls it without one.)
    check_subject(job, dit_header)
    references = []
    keyframe_inputs = {}
    source = next((ref for ref in job['references'] if ref['role'] == 'source_video'), None)
    continuation = None
    if source:
        from runner.video.continuation import source_tail

        tail, continuation = source_tail(source['path'], p, overlaps=OVERLAPS, default=22)
    for ref in job['references']:
        if ref['role'] == 'source_video':
            continue
        with open_image(ref['path']) as image:
            pixels = image.convert('RGB')
        if ref['role'] == 'reference_image':
            references.append(MiniMaxH3ImageReference(image=pixels))
        elif ref['role'] == 'start_image':
            keyframe_inputs['image'] = pixels
        elif ref['role'] == 'end_image':
            keyframe_inputs['last_image'] = pixels
    from diffusers.modular_pipelines import PipelineState

    state = PipelineState()
    for name, value in dict(
        prompt=p['prompt'],
        height=p['height'],
        width=p['width'],
        num_frames=p['frames'],
        references=references or None,
        **keyframe_inputs,
    ).items():
        if value is not None:
            state.set(name, value)

    # 1. Presentation and conditioner (streamed Qwen3-VL-32B).
    progress(stage='loading video prompt encoder')
    # LongForge's "max" reference sizing: never upscale, cap the short edge at 2048.
    # (diffusers rescales every reference image to one configured short edge.)
    reference_edge = min([2048, *(min(ref.image.size) for ref in references)])
    state = _stage('before_encode', {'reference_image_short_edge': reference_edge}, state)
    # What the conditioner wrote for the same request (prompt, images, sizes) with the same
    # files comes back from the disk: the 16 GiB conditioner is not loaded, and the video
    # model stays in the system's file cache.
    entry = conditioning.key(
        'minimax_h3',
        conditioning.stamp(paths['textEncoder']),
        conditioning.stamp(paths['tokenizer']),
        dict(state.values),
    )
    found = conditioning.load(config, entry)
    left = holder[0].pool if holder[0] is not None else None
    if left is not None and left.gpu and (not found or references or keyframe_inputs or continuation):
        # A prompt to read, or references to encode, beside the share of the model the last
        # video left on the card: the share lends what they lack (WeightPool.lend).
        gc.collect()
        torch.cuda.empty_cache()
        left.lend(BESIDE_GIB + CEILING_GIB - hardware.free_bytes(torch) / 1024**3)
    read = None
    if found:
        for name, value in conditioning.restore(*found).items():
            state.set(name, value)
        # (0.6.372) Its own name: called `kind` as the kind of the model is (base, distilled), the group
        # diffusers files a value under took its place, and the take of a prompt kept on the disk said it
        # was made with the model « denoiser_input_fields ».
        for group, names in found[1].get('kinds', {}).items():
            known = state.kwargs_mapping.setdefault(group, [])
            known.extend(name for name in names if name not in known)
        kept = 'kept from an earlier generation'
    else:
        tokenizer, processor = minimax_h3_text.processor(paths['tokenizer'])
        with _conditioner(paths['textEncoder']) as (text_encoder, text_store):
            # The disk reads the conditioner in sequence while its layers run: by the store itself
            # when the file is not kept in RAM (Store.follow), else through the system's cache.
            ahead = (
                None
                if text_store.reader
                else prefetch(
                    paths, {'textEncoder': text_store}, [('textEncoder', key, None) for key in text_store.keys()]
                )
            )
            original = reference_encoders.get_qwen3vl_prompt_embeds
            reference_encoders.get_qwen3vl_prompt_embeds = minimax_h3_text.prompt_embeds
            before = dict(state.values)
            try:
                progress(stage='encoding video prompt')
                state = _stage(
                    'text_encoder', dict(text_encoder=text_encoder, tokenizer=tokenizer, processor=processor), state
                )
            finally:
                reference_encoders.get_qwen3vl_prompt_embeds = original
                read = ahead.stop() if ahead else text_store.reader.summary() if text_store.reader else None
            written = conditioning.changes(before, state.values)
            kept = (
                'kept for the next generations'
                if written
                and conditioning.save(config, entry, written[0], dict(written[1], kinds=dict(state.kwargs_mapping)))
                else 'not kept'
            )
            # (Its store is closed as the block ends: _conditioner.)
            del text_encoder
        del text_store, before, written
    state.set('prompt_embeds', state.get('prompt_embeds').to('cuda', torch.bfloat16))
    _free()
    progress(
        stage='video prompt encoded',
        tokens=int(state.get('prompt_embeds').shape[1]),
        conditioning=kept,
        **({'prefetch': read} if read else {}),
    )
    # The workflow's « attention creuse » (VSA), for the FastH3 models trained with it, decided
    # before the model is read: a dense generation neither loads nor reads ahead the gates. It
    # needs comfy-kitchen's sparse kernel, and a video large enough to gain from it.
    grid = grid_of(p)
    tokens = math.prod(grid) + 512
    sparse, dense_why = None, None
    if p.get('sparse_attention', 'off') == 'vsa':
        from runner.models import sparse_attention

        if adapter is not None:
            dense_why = 'a step adapter was not taught sparse attention'
        elif not sparse_attention.ready():
            dense_why = 'no sparse attention kernel on this GPU'
        elif tokens < sparse_attention.MIN_ROWS:
            dense_why = f'about {tokens} rows, faster dense below {sparse_attention.MIN_ROWS}'
        else:
            sparse = minimax_h3.Sparse(float(p.get('sparse_keep', 10)) / 100)

    def read_ahead():
        return prefetch(paths, {}, use_order(minimax_h3.names(dit_header, gate=sparse is not None, adapter=adapter)))

    # A model left by the last video is read no more: its share is on the card, the rest in RAM.
    ahead = None if holder[0] is not None else read_ahead()

    # 2. Conditions through the VAE encoders (only when there are any).
    video_head = audio_head = None
    if references or keyframe_inputs or continuation:
        progress(stage='encoding references')
        vae = minimax_h3_vae.video_vae(paths['vae'], 'encoder')
        audio_vae = minimax_h3_vae.audio_vae(paths['audioVae'])
        if references or keyframe_inputs:
            state = _stage('vae_encoder', dict(vae=vae, audio_vae=audio_vae), state)
        if continuation:
            with torch.inference_mode():
                video_head, audio_head = _encode_tail(vae, audio_vae, source['path'], tail, continuation, p)
            continuation['audioProtectedLatents'] = int(audio_head.shape[1])
        del vae, audio_vae
        _free()

    # 3. Joint denoise: DiT streamed from its file, PDD heads told each step's interval.
    progress(stage='loading video model')

    def share():
        """GiB of the DiT kept on the GPU; the rest is copied from RAM at every step, at about
        12 GiB/s. What the model computes with comes first: 5 GiB (a feed-forward chunk, the
        allocator's slack, the engine's margin) plus the activations, which grow with the
        video (1 GiB for a 5 s draft). Video memory that runs out halves the speed, a smaller
        share costs a second per step at most. Counted from what this process may hold: what
        is free, and what it holds already (the share the last video left).
        (Sparse attention needs less at its peak: 5 widths instead of 6, measured at 1344 x 768.)"""
        free = (hardware.free_bytes(torch) + torch.cuda.memory_reserved()) / 1024**3
        return min(config.get('cacheGiB', 6), max(0, free - working_gib(tokens) - AHEAD_GIB))

    budget = share()
    loaded = holder[0]
    if loaded is not None:
        # The share the last video left is this one's when it is about what this video leaves
        # the model (as for LTX 2.5: a quarter of a gigabyte over, half a gigabyte under), and
        # the model was built with the same attention. Else it is dropped and built anew: taken
        # back at another size it could not be given its page-locked RAM (see ltx25.Refit).
        held = loaded.pool
        near = (budget - LOCK_MARGIN_GIB) * 1024**3 <= held.limit
        suits = bool(held.gpu) and near and held.bytes <= (budget + 0.25) * 1024**3
        if not suits or (sparse is None) != (loaded.sparse is None):
            loaded.drop()
            loaded = holder[0] = None
            _free()
            budget = share()
            ahead = read_ahead()
    # A model taken back from the last generation: this one is the next of a run (the Studio).
    again = loaded is not None
    if not again:
        loaded = holder[0] = Loaded(key)
        # The model's file stays open with it, beyond this generation.
        loaded.store = loaded.stack.enter_context(open_store(paths['model']))
        stores, pairs = {'model': loaded.store}, ()
        if adapter is not None:
            # Read through its mapping, as the model's: what the steps copy of it goes to page-locked
            # RAM below, and its pixel head is read once, at the end. Its LoRA pairs are computed
            # beside the layers of the model (the pool's adapters), at their full strength.
            loaded.adapter = loaded.stack.enter_context(open_store(paths[minimax_h3.ADAPTER], resident=False))
            stores[minimax_h3.ADAPTER], pairs = loaded.adapter, ((minimax_h3.ADAPTER, 1.0),)
        loaded.pool = WeightPool(stores, budget, adapters=pairs, ahead_gib=AHEAD_GIB)
    store, pool = loaded.store, loaded.pool
    # What this generation hangs on the model, taken off again at its end.
    hooks = []
    with torch.inference_mode():
        if ahead:
            ahead.lead = pool.used
        try:
            if again:
                dit, fast_attention, sparse, budget = loaded.dit, loaded.fast, loaded.sparse, pool.limit / 1024**3
                pool.stats.update(dict.fromkeys(pool.stats, 0.0))
                if sparse is not None:
                    # The plans and the measures of the last video are not this one's.
                    sparse.plan, sparse.plans, sparse.statistics, sparse.measure = None, {}, {}, False
            else:
                # The workflow's « attention » choice; comfy-kitchen's INT8 kernel unless it asks for PyTorch's.
                fast_attention = (
                    p.get('attention', 'comfy_kitchen') == 'comfy_kitchen'
                    and minimax_h3.INT8_ATTENTION
                    and minimax_h3.int8_attention_ready()
                )
                dit, _heads = minimax_h3.load(dit_header, pool, fast_attention, sparse, adapter)
                loaded.dit, loaded.fast, loaded.sparse = dit, fast_attention, sparse
            if again:
                # Its page-locked RAM is the one its last video ran with: nothing is asked again.
                # Asked again, the weights to copy were named from the share as the steps left
                # it, a few layers more than first foreseen: at 1344 x 768, where RAM allows a
                # part of them only, 19 GiB were read anew beside the rest and the steps of the
                # next videos took five times longer (18/11).
                locked = loaded.ram
            else:
                # What will not stay on the GPU goes to page-locked RAM once, for every step and
                # the next videos; what stays is read from the file as it is loaded.
                locked = loaded.ram = keep_streamed(loaded, pool)
            # The share is filled; one left by the last video takes back what it lent.
            pool.preload()
            if adapter is None:
                scheduler, audio_scheduler = MiniMaxH3Scheduler(shift=12.0), MiniMaxH3Scheduler(shift=3.0)
            else:
                scheduler, audio_scheduler = pi_scheduler(12.0, steps), pi_scheduler(3.0, steps)
            calls = {'step': 0}
            # What the pixel head of a step adapter reads, kept at the last step (keep_last_rows).
            last = {}
            sparse_start = float(p.get('sparse_start', 0.2))

            def before(_module, args, values):
                i = calls['step']
                minimax_h3.set_interval(
                    dit,
                    (scheduler.sigmas[i], scheduler.sigmas[i + 1]),
                    (audio_scheduler.sigmas[i], audio_scheduler.sigmas[i + 1]),
                )
                if sparse is not None:
                    # The first steps lay the video out: they stay dense, as the model was trained.
                    sparse.plan = sparse.prepare(values, grid) if i >= sparse_start * steps else None
                    # The last of them measures what the first sparse step quantizes with.
                    sparse.measure = i < sparse_start * steps <= i + 1
                return args, values

            def after(_module, _args, values, output):
                calls['step'] += 1
                read = {'prefetch': ahead.stop()} if ahead and calls['step'] == 1 else {}
                mode = {}
                if sparse is not None:
                    mode['attention'] = 'sparse' if sparse.plan is not None else 'dense'
                progress(
                    stage='generating video', step=calls['step'], total=steps, weights=pool.summary(), **read, **mode
                )
                sigma = scheduler.sigmas[calls['step'] - 1]
                preview.send(report, preview.MINIMAX_H3, middle_frame, values['hidden_states'], output[0], sigma, grid)
                return output

            hooks.append(dit.register_forward_pre_hook(before, with_kwargs=True))
            hooks.append(dit.register_forward_hook(after, with_kwargs=True))
            if adapter is not None:
                hooks.extend(keep_last_rows(dit, calls, steps, math.prod(grid), last))
            if continuation:
                # Registered after the step counter: its output hook reads the finished step.
                latent_frames = (p['frames'] - 5) // 17 * 5 + 2
                hooks.extend(
                    protect_head(
                        dit,
                        (scheduler, audio_scheduler),
                        calls,
                        video_head.to('cuda'),
                        audio_head.to('cuda'),
                        latent_frames * (p['height'] // 32) * (p['width'] // 32),
                        round(p['frames'] / 24 * AUDIO_LATENTS_PER_SECOND),
                    )
                )
            label = 'int8' if fast_attention else 'pytorch'
            if sparse is not None:
                first = math.ceil(sparse_start * steps) + 1
                gates = 'with gates' if minimax_h3.has_gates(dit_header) else 'without gates'
                label += f', then vsa {round(sparse.keep * 100, 1)} % from step {first}, {gates}'
            elif dense_why:
                label += f' (vsa asked, dense: {dense_why})'
            progress(stage='sampling video', attention=label)
            # The diffusers blocks name the DiT by workflow: ref2va reads `transformer_ref`.
            name = 'transformer_ref' if references else 'transformer'
            generator = torch.Generator('cpu').manual_seed(p['seed'])
            noise = {}
            if adapter is not None:
                noise = pi_noise(p, generator, (pi_sigmas(steps, 12.0)[0], pi_sigmas(steps, 3.0)[0]))
            state = _stage(
                'denoise',
                {name: dit, 'scheduler': scheduler, 'audio_scheduler': audio_scheduler},
                state,
                num_inference_steps=steps + 1,
                generator=generator,
                **noise,
            )
            del noise
            if calls['step'] != steps:
                raise RuntimeError(f'Expected {steps} denoising steps, ran {calls["step"]}')
            cache = dict(
                gpu_cache_gib=round(pool.bytes / 1024**3, 3),
                gpu_cache_limit_gib=round(budget, 3),
                pinned_model=store.pinned,
                locked_ram_gib=round(locked / 1024**3, 3),
                residency=RESIDENCY.summary(),
            )
            progress(stage='video sampled', **cache)
            del dit
        finally:
            for hook in hooks:
                hook.remove()
            if ahead:
                ahead.stop()
            if sparse is not None:
                sparse_attention.release()
    # The share of the model stays on the GPU through the decode, for the next video: the
    # layers copied for a moment leave, and the pages of the file read for the share go back
    # to the system (the file stays open with the model).
    pool.settle()
    store.reopen()
    state.set('prompt_embeds', None)
    _free()

    # 4. Decode video and sound. The share lends the decode what it lacks.
    progress(stage='decoding video')
    # (With a step adapter the frames come from its pixel head, which asks for much less than the decoder.)
    asked = decode_gib(p) if adapter is None else minimax_h3_dwd.gib(grid)
    pool.lend(asked + 0.5 + CEILING_GIB - hardware.free_bytes(torch) / 1024**3)
    with torch.inference_mode():

        def frames_of():
            """The frames, uint8 [frames, height, width, 3], off the GPU as each stretch of them
            is decoded (minimax_h3_vae.decode_chunks): the block of the library joined the whole
            video on the GPU, several times as 32-bit floats."""
            vae = minimax_h3_vae.video_vae(paths['vae'], 'decoder')
            scale = lambda values: torch.tensor(values, device='cuda').view(1, -1, 1, 1, 1)  # noqa: E731
            latents = state.get('latents') * scale(vae.config.latents_std) + scale(vae.config.latents_mean)
            made = []
            for chunk in minimax_h3_vae.decode_chunks(vae, latents):
                # As the block does: back from the VAE's normalisation (ImageNet's), in [0, 1].
                chunk = (chunk.float() * scale(PIXEL_STD) + scale(PIXEL_MEAN)).clamp(0, 1)
                made.append((chunk[0] * 255).round().byte().permute(1, 2, 3, 0).cpu().numpy())
                del chunk
            return numpy.concatenate(made)

        def pixels_of():
            """pi H3: the frames from the rows its last step left, by the pixel head of its adapter
            (minimax_h3_dwd), a block of five latents at a time. The video VAE's decoder is not loaded: its
            4.6 GiB are neither read nor laid on the card. The rows are kept until the frames are made: the
            decode is tried again with more room when it lacks some."""
            head = minimax_h3_dwd.load(loaded.adapter)
            try:
                return numpy.concatenate(
                    list(minimax_h3_dwd.decode(head, last['hidden'], last['temb'], last['indices'], grid))
                )
            finally:
                head.release()

        made_by = frames_of if adapter is None else pixels_of

        def alone():
            # Beside the share of the model the decode did not fit: the share leaves whole, as
            # it always did before 0.6.80, and the next video builds the model anew.
            pool.clear()
            progress(stage='decoding video again without the share of the model')
            return made_by()

        def unbound():
            # A clip that does not fit under the engine's ceiling (1 GiB below what the card had
            # free): with all of the card, where the engine would run the whole video again.
            torch.cuda.set_per_process_memory_fraction(1.0)
            progress(stage='decoding video again without the video memory ceiling')
            return made_by()

        pixels = smaller([made_by, *([alone] if pool.gpu else []), unbound], torch)
        last.clear()
        if loaded.adapter is not None:
            # The pages of its file read for the head go back to the system, as the model's after the steps.
            loaded.adapter.reopen()
        _free()
        state, audio, rate = _decoded_sound(state, p, paths)
    _free()
    progress(stage='video decoded')
    if len(pixels) != p['frames']:
        raise RuntimeError(f'Decoded {len(pixels)} frames, expected {p["frames"]}')
    generated_audio = None
    if p.get('audio', True):
        waveform = audio[0] if isinstance(audio, (list, tuple)) else audio
        waveform = waveform.float().reshape(-1, waveform.shape[-1]).cpu()
        if waveform.shape[0] == 1:
            waveform = waveform.repeat(2, 1)
        if not torch.isfinite(waveform).all():
            raise RuntimeError('Non-finite audio; no output saved')
        generated_audio = (waveform[:2].T.contiguous().numpy(), int(rate))
    metadata = dict(
        job=job,
        parameters=p,
        seconds=round(time.perf_counter() - start, 2),
        peak_vram_gib=round(torch.cuda.max_memory_allocated() / 1024**3, 3),
        backend='pytorch-diffusers-minimax-h3',
        model=kind,
        steps=steps,
        **({'pixel_head': 'dwd'} if adapter is not None else {}),
        frames=p['frames'],
        fps=24,
        stage=p['stage'],
        audio=generated_audio is not None,
        timeline=timeline,
        weight_cache=cache,
    )
    if continuation:
        metadata['continuation'] = continuation
    return save_video(pixels, config, job, metadata, audio=generated_audio)
