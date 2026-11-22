from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

import numpy as np

from runner.contracts import validate_job
from runner.models.ladder import smaller
from runner.pipelines.ltx25 import first_pass_size, working_gib
from runner.video import ic_reference as ic


def job(references=(), loras=()):
    return dict(
        schemaVersion=1,
        id='test-guided-video',
        pipeline='ltx25',
        mediaType='video',
        workflowId='test-workflow',
        workflowDigest='a' * 64,
        components={
            role: str(Path(role + '.safetensors').resolve()) for role in ('model', 'textEncoder', 'vae', 'audioVae')
        },
        parameters=dict(
            prompt='Crossview', seed=7, width=64, height=64, steps=8, frames=9, fps=24, stage='draft', audio=False
        ),
        loras=list(loras),
        references=list(references),
    )


def reference(role, name):
    return dict(input=name, role=role, path=str(Path(name).resolve()))


def lora_file(folder, name, metadata=None):
    import torch
    from safetensors.torch import save_file

    path = Path(folder) / name
    save_file({'transformer_blocks.0.attn1.to_q.lora_A.weight': torch.zeros(1, 2)}, str(path), metadata=metadata)
    return dict(id=name, path=str(path), strength=1.0)


def video_file(folder, name, frames):
    from runner.video.camera_warp import lossless

    path = Path(folder) / name
    writer = lossless(path, frames.shape[2], frames.shape[1], 24)
    for frame in frames:
        writer.send(np.ascontiguousarray(frame))
    writer.close()
    return path


class OutOfMemoryError(RuntimeError):
    pass


class FakeTorch:
    OutOfMemoryError = OutOfMemoryError

    def __init__(self):
        self.cuda = self

    def empty_cache(self):
        pass


class FakeVAE:
    """Encodes a video [1, 3, F, H, W] to latents [1, 128, f, H / 32, W / 32] that all hold its
    mean, and keeps what it was given; `whole=False` runs out of memory unless tiled."""

    def __init__(self, dtype=None, whole=True):
        import torch

        self.dtype = dtype or torch.float32
        self.whole = whole
        self.latents_mean = torch.full((128,), 0.5)
        self.latents_std = torch.full((128,), 2.0)
        self.use_framewise_decoding = False
        self.tile_sample_min_num_frames = 16
        self.tile_sample_stride_num_frames = 8
        self.use_tiling = False
        self.seen = []

    def encode(self, video):
        import torch

        tiled = (self.use_tiling, self.use_framewise_decoding, self.tile_sample_min_num_frames)
        self.seen.append((tuple(video.shape), video.dtype, tiled))
        if not self.whole and not self.use_tiling:
            raise OutOfMemoryError('whole video')
        size = ((video.shape[2] - 1) // 8 + 1, video.shape[3] // 32, video.shape[4] // 32)
        latents = torch.full((1, 128, *size), float(video.float().mean()))
        return SimpleNamespace(latent_dist=SimpleNamespace(mode=lambda: latents))


def rope():
    from diffusers.models.transformers.transformer_ltx2 import LTX2AudioVideoRotaryPosEmbed

    return LTX2AudioVideoRotaryPosEmbed(dim=64)


def guided_pipeline(vae, references, factor):
    """GuidedPipeline without its models: what `prepare_latents` reads of it."""
    pipeline = object.__new__(ic.pipeline_class())
    pipeline.vae = vae
    pipeline.transformer = SimpleNamespace(rope=rope())
    pipeline.vae_spatial_compression_ratio = 32
    pipeline.vae_temporal_compression_ratio = 8
    pipeline.transformer_spatial_patch_size = 1
    pipeline.transformer_temporal_patch_size = 1
    pipeline.ic_references = references
    pipeline.ic_factor = factor
    pipeline.ic_strength = 1.0
    pipeline.ic_encoded = []
    told = []
    pipeline.ic_progress = lambda **said: told.append(said)
    return pipeline, told


def prepare(pipeline, width, height, seed=3):
    import torch

    return pipeline.prepare_latents(
        conditions=None,
        batch_size=1,
        num_channels_latents=128,
        height=height,
        width=width,
        num_frames=9,
        frame_rate=24.0,
        noise_scale=1.0,
        dtype=torch.float32,
        device=torch.device('cpu'),
        generator=torch.Generator().manual_seed(seed),
        latents=None,
    )


class FactorTests(unittest.TestCase):
    def test_the_factor_an_ic_lora_declares(self):
        self.assertEqual(ic.downscale_factor({'__metadata__': {ic.FACTOR: '1'}}), 1)
        self.assertEqual(ic.downscale_factor({'__metadata__': {ic.FACTOR: '2'}}), 2)
        self.assertIsNone(ic.downscale_factor({'__metadata__': {'other': 'x'}}))
        self.assertIsNone(ic.downscale_factor({}))
        for value in ('one', '3', '0', '1.5'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ic.downscale_factor({'__metadata__': {ic.FACTOR: value}})

    def test_reference_videos_and_their_ic_lora_go_together(self):
        guides = [reference(ic.ROLE, 'warp.mkv'), reference(ic.ROLE, 'video.mp4')]
        with tempfile.TemporaryDirectory() as folder:
            crossview = lora_file(folder, 'crossview.safetensors', {ic.FACTOR: '1'})
            upscaler = lora_file(folder, 'upscale.safetensors', {ic.FACTOR: '2'})
            style = lora_file(folder, 'style.safetensors')
            self.assertEqual(ic.validate(job(guides, [crossview])), 1)
            self.assertEqual(ic.validate(job(guides, [style, upscaler])), 2)
            self.assertIsNone(ic.validate(job((), [style])))
            self.assertIsNone(ic.validate(job()))
            for value, said in (
                (job(guides), 'require their IC-LoRA'),
                (job(guides, [style]), 'require their IC-LoRA'),
                (job((), [crossview]), 'needs its reference videos'),
                (job(guides, [crossview, upscaler]), 'one IC-LoRA at a time'),
            ):
                with self.subTest(said=said), self.assertRaisesRegex(ValueError, said):
                    ic.validate(value)

    def test_the_contract_takes_two_reference_videos_beside_an_image_only(self):
        guides = [reference(ic.ROLE, 'warp.mkv'), reference(ic.ROLE, 'video.mp4')]
        lora = dict(id='crossview', path=str(Path('crossview.safetensors').resolve()), strength=1.0)
        validate_job(job(guides, [lora]))
        validate_job(job([*guides, reference('start_image', 'first.png')], [lora]))
        self.assertEqual([ref['input'] for ref in ic.guides(job(guides[::-1]))], ['video.mp4', 'warp.mkv'])
        for references in (
            [*guides, reference(ic.ROLE, 'third.mp4')],
            [*guides, reference('source_video', 'source.mp4')],
            [*guides, reference('msr_image', 'subject.png')],
        ):
            with self.subTest(roles=[ref['role'] for ref in references]), self.assertRaises(ValueError):
                validate_job(job(references, [lora]))


class SizeTests(unittest.TestCase):
    def test_a_reference_takes_the_frames_of_the_video_at_its_size(self):
        parameters = dict(width=768, height=448, frames=121)
        self.assertEqual(ic.latent_size(parameters, 1), (16, 14, 24))
        self.assertEqual(ic.latent_size(parameters, 2), (16, 7, 12))

    def test_the_memory_of_the_steps_counts_the_reference_videos(self):
        parameters = dict(frames=121)
        alone = working_gib(parameters, 768, 448, 0)
        self.assertAlmostEqual(alone, 2.6 + 0.1 * 5376 / 1000)
        self.assertAlmostEqual(working_gib(parameters, 768, 448, 0, 2, 1) - alone, 0.1 * 2 * 5376 / 1000)
        self.assertAlmostEqual(working_gib(parameters, 768, 448, 0, 2, 2) - alone, 0.1 * 2 * 1344 / 1000)

    def test_a_guided_video_is_made_in_one_pass(self):
        parameters = dict(width=1536, height=896, frames=121)
        components = dict(upscaler='upscaler.safetensors')
        self.assertIsNotNone(first_pass_size(parameters, components))
        self.assertIsNone(first_pass_size(parameters, components, guided=True))


class PixelTests(unittest.TestCase):
    def test_frames_are_read_as_the_encoder_reads_them(self):
        import torch

        frames = np.random.default_rng(0).integers(0, 255, (3, 8, 16, 3), dtype=np.uint8)
        video = ic.pixels(frames, 8, 16, torch, 'cpu')
        self.assertEqual(tuple(video.shape), (1, 3, 3, 8, 16))
        self.assertEqual(video.dtype, torch.float32)
        self.assertTrue(video.is_contiguous())
        expected = torch.from_numpy(frames).permute(3, 0, 1, 2).float() / 127.5 - 1
        torch.testing.assert_close(video[0], expected)
        # A narrower frame is cut in the middle; a smaller one scaled up to cover it.
        torch.testing.assert_close(ic.pixels(frames, 8, 8, torch, 'cpu')[0], expected[..., 4:12])
        self.assertEqual(tuple(ic.pixels(frames, 16, 32, torch, 'cpu').shape), (1, 3, 3, 16, 32))
        half = ic.pixels(frames, 8, 16, torch, 'cpu', torch.bfloat16)
        self.assertEqual(half.dtype, torch.bfloat16)
        torch.testing.assert_close(half.float(), video, atol=0.01, rtol=0)
        self.assertEqual(frames.dtype, np.uint8)

    def test_a_guide_is_read_back_exactly_and_a_short_one_refused(self):
        frames = np.random.default_rng(1).integers(0, 255, (5, 32, 48, 3), dtype=np.uint8)
        frames[:, :8, :8] = (255, 0, 255)
        with tempfile.TemporaryDirectory() as folder:
            path = video_file(folder, 'guide.mkv', frames)
            np.testing.assert_array_equal(ic.read_frames(path, 5), frames)
            np.testing.assert_array_equal(ic.read_frames(path, 3), frames[:3])
            with self.assertRaisesRegex(ValueError, 'a 5 images'):
                ic.read_frames(path, 9)


class SequenceTests(unittest.TestCase):
    def test_positions_are_those_of_the_same_frames_and_the_same_place(self):
        import torch

        positions = rope()
        target = positions.prepare_video_coords(1, 3, 2, 4, 'cpu', fps=24.0)
        torch.testing.assert_close(ic.coordinates(positions, (3, 2, 4), 1, 'cpu', 24.0), target)
        # Twice smaller: each token spans the place of four of the video's.
        half = ic.coordinates(positions, (3, 1, 2), 2, 'cpu', 24.0)
        self.assertEqual(tuple(half.shape), (1, 3, 6, 2))
        torch.testing.assert_close(half[0, 0], target[0, 0, ::4])
        self.assertEqual(half[0, 1].unique().tolist(), [0.0, 64.0])
        self.assertEqual(half[0, 2, :2].tolist(), [[0.0, 64.0], [64.0, 128.0]])
        self.assertEqual(target[0, 2, :4].tolist(), [[0.0, 32.0], [32.0, 64.0], [64.0, 96.0], [96.0, 128.0]])

    def test_references_are_appended_clean_after_the_sequence(self):
        import torch

        generator = torch.Generator().manual_seed(0)
        latents, clean = torch.randn(1, 6, 4), torch.zeros(1, 6, 4)
        mask = torch.zeros(1, 6, 1)
        mask[:, :2] = 1
        coords = torch.rand(1, 3, 2, 2)
        added, positions = torch.randn(1, 5, 4, dtype=torch.bfloat16), torch.rand(1, 3, 5, 2)
        found = ic.append(latents, mask, clean, coords, added, positions, 1.0, generator, torch)
        torch.testing.assert_close(found[0], torch.cat((latents, added.float()), dim=1))
        torch.testing.assert_close(found[1], torch.cat((mask, torch.ones(1, 5, 1)), dim=1))
        torch.testing.assert_close(found[2], torch.cat((clean, added.float()), dim=1))
        torch.testing.assert_close(found[3], torch.cat((coords, positions), dim=2))
        self.assertEqual(found[0].dtype, torch.float32)
        # No noise was drawn: the video is drawn from the same noise as without references.
        untouched = torch.randn(3, generator=torch.Generator().manual_seed(0))
        torch.testing.assert_close(torch.randn(3, generator=generator), untouched)
        # Alone, they are the only appended positions; held less, they start noisier.
        self.assertEqual(ic.append(latents, mask, clean, None, added, positions, 1.0, generator, torch)[3].shape[2], 5)
        noisy = ic.append(latents, mask, clean, None, added, positions, 0.25, torch.Generator().manual_seed(4), torch)
        noise = torch.randn(1, 5, 4, generator=torch.Generator().manual_seed(4))
        torch.testing.assert_close(noisy[0][:, 6:], added.float() * 0.25 + noise * 0.75)
        torch.testing.assert_close(noisy[1][:, 6:], torch.full((1, 5, 1), 0.25))
        # A batch of two takes the same references.
        double = ic.append(
            latents.expand(2, -1, -1),
            mask.expand(2, -1, -1),
            clean.expand(2, -1, -1),
            None,
            added,
            positions,
            1.0,
            generator,
            torch,
        )
        self.assertEqual(tuple(double[0].shape), (2, 11, 4))
        self.assertEqual(tuple(double[3].shape), (2, 3, 5, 2))

    def test_the_pipeline_reads_each_reference_in_its_order_after_the_video(self):
        import torch
        from diffusers import LTX2ConditionPipeline

        dark = np.full((9, 64, 64, 3), 40, dtype=np.uint8)
        bright = np.full((9, 64, 64, 3), 210, dtype=np.uint8)
        with tempfile.TemporaryDirectory() as folder:
            refs = [
                dict(path=str(video_file(folder, 'warp.mkv', dark))),
                dict(path=str(video_file(folder, 'video.mkv', bright))),
            ]
            for factor, size in ((1, 64), (2, 128)):
                with self.subTest(factor=factor):
                    vae = FakeVAE(torch.bfloat16)
                    pipeline, told = guided_pipeline(vae, refs, factor)
                    latents, mask, clean, coords = prepare(pipeline, size, size)
                    base = (size // 32) ** 2 * 2
                    self.assertEqual(tuple(latents.shape), (1, base + 16, 128))
                    # Each read at the size of the video over the factor, in the encoder's precision.
                    self.assertEqual([seen[:2] for seen in vae.seen], [((1, 3, 9, 64, 64), torch.bfloat16)] * 2)
                    self.assertEqual(pipeline.ic_encoded, ['whole', 'whole'])
                    self.assertEqual([said['reference'] for said in told], [1, 2])
                    # The warp first, then the video; normalized, clean, held at every step.
                    expected = [(40 / 127.5 - 1 - 0.5) / 2] * 8 + [(210 / 127.5 - 1 - 0.5) / 2] * 8
                    torch.testing.assert_close(clean[0, base:, 0], torch.tensor(expected), atol=0.01, rtol=0)
                    torch.testing.assert_close(latents[0, base:], clean[0, base:])
                    self.assertTrue((mask[0, base:] == 1).all())
                    self.assertTrue((mask[0, :base] == 0).all())
                    # Their positions: the same times, the place of the whole picture.
                    one = ic.coordinates(pipeline.transformer.rope, (2, 2, 2), factor, 'cpu', 24.0)
                    torch.testing.assert_close(coords, torch.cat((one, one), dim=2))
                    self.assertEqual(coords[0, 2].max().item(), size)
                    # The video itself starts from the noise it would have without them.
                    plain = object.__new__(LTX2ConditionPipeline)
                    for name in (
                        'vae',
                        'vae_spatial_compression_ratio',
                        'vae_temporal_compression_ratio',
                        'transformer_spatial_patch_size',
                        'transformer_temporal_patch_size',
                    ):
                        setattr(plain, name, getattr(pipeline, name))
                    alone = prepare(plain, size, size)
                    torch.testing.assert_close(latents[:, :base], alone[0])
                    self.assertIsNone(alone[3])

    def test_a_reference_that_does_not_fit_is_encoded_in_tiles(self):
        import torch

        vae = FakeVAE(whole=False)
        video = torch.zeros(1, 3, 9, 64, 64)
        latents, how = ic.encode(vae, video, FakeTorch(), smaller)
        self.assertEqual(how, 'tiles')
        self.assertEqual(tuple(latents.shape), (1, 128, 2, 2, 2))
        self.assertEqual([seen[2] for seen in vae.seen], [(False, False, 16), (True, True, ic.TILE_FRAMES)])
        # Its settings are given back.
        settings = (vae.use_tiling, vae.use_framewise_decoding, vae.tile_sample_min_num_frames)
        self.assertEqual(settings, (False, False, 16))
        self.assertEqual(ic.encode(FakeVAE(), video, FakeTorch(), smaller)[1], 'whole')


if __name__ == '__main__':
    unittest.main()
