"""The seed of an LTX 2.5 video, kept through a pass made again for want of memory (runner.pipelines.ltx25)."""

import importlib
import unittest
from contextlib import ExitStack, nullcontext
from types import SimpleNamespace
from unittest import mock

import torch

GiB = 1024**3
# The latents of the passes have 8 channels here: as few as the test needs.
CHANNELS = 8
SEED = 7


class Latents:
    """What a pass gives, as the pipeline leaves it on the card: here it stays on the processor."""

    def __init__(self, values):
        self.values = values

    def to(self, _device, dtype=None):
        return self.values if dtype is None else self.values.to(dtype)

    def cpu(self):
        return self.values


class Model(torch.nn.Module):
    """The video model at its first step. `short` lists the passes (0, the first; 1, the second of a
    large video) whose next attempt runs out of memory there: the steps needed more than was set
    aside for them (working_gib)."""

    def __init__(self, short):
        super().__init__()
        self.short = list(short)

    def forward(self, hidden_states, refining, **_):
        if refining in self.short:
            self.short.remove(refining)
            raise torch.OutOfMemoryError('CUDA out of memory (as at the first step)')
        return hidden_states


class Sampler:
    """In the place of diffusers' pipeline (LTX2Pipeline): it draws its noise from the generator as
    that pipeline does (prepare_latents, then prepare_audio_latents; on a second pass, the noise added
    to what the first gave, _create_noised_state), then runs the model once, as its first step does.
    Each attempt is kept in `attempts`: (pass, video noise, sound noise)."""

    def __init__(self, transformer, attempts, **_parts):
        self.transformer, self.attempts = transformer, attempts

    def set_progress_bar_config(self, **_):
        pass

    def __call__(self, *, width, height, num_frames, generator, latents=None, audio_latents=None, noise_scale=0, **_):
        refining = int(latents is not None)
        video_shape = (1, CHANNELS, (num_frames - 1) // 8 + 1, height // 32, width // 32)
        sound_shape = (1, CHANNELS, num_frames, 16)
        video_noise = torch.randn(latents.shape if refining else video_shape, generator=generator)
        video = noise_scale * video_noise + (1 - noise_scale) * latents if refining else video_noise
        sound_noise = torch.randn(audio_latents.shape if refining else sound_shape, generator=generator)
        sound =noise_scale * sound_noise + (1 - noise_scale) * audio_latents if refining else sound_noise
        self.attempts.append((refining, video_noise, sound_noise))
        # The first step: the share of the model is filled (`fill`), then the model runs.
        self.transformer(hidden_states=video.flatten(2).transpose(1, 2), refining=refining)
        # What the steps make of the noise (the same here for the same noise).
        return Latents(video.cos()), sound.sin()


def upscaler(latents):
    """The latent upscaler: twice the rows and the columns."""
    return latents.repeat_interleave(2, dim=-2).repeat_interleave(2, dim=-1)


class Pool:
    """WeightPool as the steps see it: the share of the model kept on the card, of the sizes asked in
    turn (`sizes`, in GiB)."""

    def __init__(self, *_stores, **_options):
        self.gpu, self.order, self.stats, self.sizes = {}, [], {}, []
        self.bytes = self.limit = self.lent = 0
        self.recent = None

    def applied(self):
        return {}

    def streamed(self, *_margin, **_onward):
        return {}

    def resize(self, gib):
        self.sizes.append(gib)
        self.bytes = int(gib * GiB)
        self.gpu = {'share': self.bytes} if self.bytes else {}

    def clear(self):
        self.bytes, self.gpu = 0, {}

    def used(self):
        return 0

    def settle(self):
        pass

    def summary(self):
        return {}


def here(make):
    """torch.zeros or torch.ones, made on the processor whatever device is asked."""
    return lambda *size, device=None, **options: make(*size, **options)


# What _generate imports: imported before the card is faked, as they are when the engine starts.
MODULES = (
    'runner.models.ladder',
    'runner.models.ltx25_audio',
    'runner.models.ltx25_block',
    'runner.models.ltx25_text',
    'runner.models.pool',
    'runner.models.residency',
    'runner.video.export',
    'runner.video.ic_reference',
)


class SeedTests(unittest.TestCase):
    """A pass that ran out of memory at its first step is made again: the first with half the weights
    kept (`budget /= 2`), the second of a large video with none. Its noise must be the seed's, as the
    video's settings say (they are written in its file): on 24/11, made again after the attempt that
    failed had drawn its noise, a video had another sound than the same seed without the shortage."""

    def generate(self, short=(), large=False):
        """Runs the generation of a video of 25 frames with its sound, from its prompt kept, to the
        decoders: `large`, 1024 x 576 in two passes (512 x 288, then the full size), else 512 x 288 in
        one. `short`: the passes whose next attempt runs out of memory at the first step (see Model).
        Returns the latents given to the decoders (video, sound); the attempts of the passes are left
        in `self.attempts`, the sizes of the share in `self.sizes`."""
        for name in MODULES:
            importlib.import_module(name)
        import diffusers
        from diffusers import FlowMatchEulerDiscreteScheduler, LTX2ConditionPipeline, LTX2Pipeline  # noqa: F401

        from runner import hardware
        from runner.models import conditioning, headers, ltx25 as model, ltx25_audio, ltx25_block, residency
        from runner.models import pool as weights
        from runner.pipelines import ltx25 as pipeline

        width, height = (1024, 576) if large else (512, 288)
        parameters = dict(prompt='a lighthouse at dusk', seed=SEED, width=width, height=height, frames=25, fps=24)
        components = dict(model='model', textEncoder='encoder', vae='vae', audioVae='audio')
        if large:
            components['upscaler'] = 'upscaler'
        job = dict(parameters=dict(parameters, audio=True, stage='final'), components=components)
        job.update(loras=[], references=[])
        transformer, attempts, decoded, pools = Model(short), [], {}, []
        # The prompt as the model reads it, kept by an earlier generation: the connectors do not run.
        text = {name: Latents(torch.zeros(1, 4, 8)) for name in ('video', 'audio', 'mask')}
        store = SimpleNamespace(keep=lambda *_args, **_spare: 0, part=None, pinned=True, reopen=lambda: None)

        def pool(*stores, **options):
            pools.append(Pool(*stores, **options))
            return pools[-1]

        def video_decoded(_job, _headers, latents, _progress):
            decoded['video'] = latents
            return 'pixels'

        def sound_decoded(latents, _job, _headers, _progress):
            decoded['sound'] = latents
            return 'sound'

        layout = lambda _headers, roles: ({role: role for role in roles}, dict.fromkeys(roles, {}))  # noqa: E731
        built = lambda part, _names, _pool: transformer if part == 'model' else SimpleNamespace(part=part)  # noqa: E731
        generator = torch.Generator
        with ExitStack() as stack:
            enter = stack.enter_context
            enter(mock.patch.object(diffusers, 'LTX2Pipeline', lambda **parts: Sampler(attempts=attempts, **parts)))
            for name, value in (('is_available', True), ('reset_peak_memory_stats', None), ('empty_cache', None)):
                enter(mock.patch.object(torch.cuda, name, return_value=value))
            for name in ('memory_reserved', 'memory_allocated', 'max_memory_allocated'):
                enter(mock.patch.object(torch.cuda, name, return_value=0))
            enter(mock.patch.object(hardware, 'free_bytes', lambda _torch: 10 * GiB))
            # The card is the processor here: what is made on it, and the generator of the seed.
            enter(mock.patch.object(torch, 'zeros', here(torch.zeros)))
            enter(mock.patch.object(torch, 'ones', here(torch.ones)))
            enter(mock.patch.object(torch, 'Generator', lambda *_device: generator()))
            enter(mock.patch.object(headers, 'header', return_value={}))
            enter(mock.patch.object(conditioning, 'stamp', side_effect=str))
            enter(mock.patch.object(conditioning, 'load', return_value=[text]))
            enter(mock.patch.object(model, 'validate_layout', layout))
            enter(mock.patch.object(weights, 'WeightPool', pool))
            enter(mock.patch.object(weights, 'load_streamed', built))
            enter(mock.patch.object(model, 'latent_upscaler', return_value=upscaler))
            enter(mock.patch.object(ltx25_block, 'fuse', return_value=True))
            enter(mock.patch.object(residency, 'open_store', lambda *_args: nullcontext(store)))
            enter(mock.patch.object(residency, 'prefetch', lambda *_args, **_lead: SimpleNamespace(stop=dict)))
            enter(mock.patch.object(pipeline, 'decode_pixels', video_decoded))
            enter(mock.patch.object(ltx25_audio, 'decode', sound_decoded))
            written = lambda _pixels, metadata: metadata  # noqa: E731
            metadata = pipeline._generate(job, {}, lambda **_stage: None, 'key', [None], finish=written)
        self.attempts, self.sizes = attempts, pools[0].sizes
        passes = [(512, 288, 8), *([(1024, 576, 3)] if large else [])]
        self.assertEqual(metadata['passes'], [dict(width=w, height=h, steps=steps) for w, h, steps in passes])
        return decoded['video'], decoded['sound']

    def assertSame(self, found, wanted):
        for got, given in zip(found, wanted, strict=True):
            self.assertTrue(torch.equal(got, given), 'other latents than the same seed without the shortage')

    def test_without_a_shortage_the_video_has_the_noise_of_its_seed(self):
        # What every case below is compared with: the noise of the seed, drawn in the order the
        # pipeline draws it, one pass after the other.
        for large in (False, True):
            self.generate(large=large)
            self.assertEqual([attempt[0] for attempt in self.attempts], [0, 1] if large else [0])
            drawn = torch.Generator().manual_seed(SEED)
            for _pass, video, sound in self.attempts:
                self.assertTrue(torch.equal(video, torch.randn(video.shape, generator=drawn)))
                self.assertTrue(torch.equal(sound, torch.randn(sound.shape, generator=drawn)))

    def test_a_first_pass_made_again_for_want_of_memory_draws_the_noise_of_the_seed_again(self):
        for large in (False, True):
            wanted = self.generate(large=large)
            found = self.generate(short=[0], large=large)
            # Made again with half the weights kept, from the noise the failed attempt drew.
            self.assertEqual([attempt[0] for attempt in self.attempts], [0, 0, 1] if large else [0, 0])
            self.assertAlmostEqual(self.sizes[1], self.sizes[0] / 2)
            failed, again = self.attempts[:2]
            self.assertTrue(torch.equal(again[1], failed[1]) and torch.equal(again[2], failed[2]))
            self.assertSame(found, wanted)

    def test_a_second_pass_made_again_for_want_of_memory_draws_the_noise_the_first_pass_left(self):
        wanted = self.generate(large=True)
        unshort = self.attempts
        found = self.generate(short=[1], large=True)
        # Made again with no weight kept, from where the first pass left the generator: not from
        # the seed, not from where the failed attempt left it.
        self.assertEqual([attempt[0] for attempt in self.attempts], [0, 1, 1])
        self.assertEqual(self.sizes[-1], 0)
        for again in self.attempts[1:]:
            self.assertTrue(torch.equal(again[1], unshort[1][1]) and torch.equal(again[2], unshort[1][2]))
        self.assertSame(found, wanted)
        # Both passes made again: the same video still.
        self.assertSame(self.generate(short=[0, 1], large=True), wanted)
        self.assertEqual([attempt[0] for attempt in self.attempts], [0, 0, 1, 1])


if __name__ == '__main__':
    unittest.main()
