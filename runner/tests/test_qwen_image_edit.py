import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch

from runner import registry
from runner.models import qwen_image_text
from runner.pipelines import qwen_image_edit


def job(**changes):
    folder = Path(tempfile.gettempdir())
    value = dict(
        schemaVersion=1,
        id='job-1',
        pipeline='qwen_image_edit',
        mediaType='image',
        workflowId='a7601a5d-e43b-4f4e-8871-2d9dc7138bd9',
        workflowDigest='0' * 64,
        parameters=dict(prompt='<sks> right side view eye-level shot medium shot', seed=7, steps=8, cfg=1),
        components={
            role: str(folder / name)
            for role, name in dict(
                model='qwen.safetensors',
                textEncoder='qwen_vl.safetensors',
                tokenizer='qwen25_tokenizer',
                vae='vae.safetensors',
                stepLora='lightning.safetensors',
            ).items()
        },
        loras=[],
        references=[
            dict(input='reference-1', role='reference_image', path=str(folder / 'b.png')),
            dict(input='source', role='edit_image', path=str(folder / 'a.png')),
        ],
    )
    value.update(changes)
    return value


class ScheduleTests(unittest.TestCase):
    def test_lightning_runs_eight_steps_shifted_by_three(self):
        sigmas, timesteps = qwen_image_edit.schedule()
        # σ' = 3σ / (1 + 2σ) over 1, 7/8, ... 1/8, then 0.
        expected = [3 * s / (1 + 2 * s) for s in (1, 7 / 8, 6 / 8, 5 / 8, 4 / 8, 3 / 8, 2 / 8, 1 / 8)] + [0]
        self.assertEqual(len(sigmas), 9)
        for got, wanted in zip(sigmas, expected):
            self.assertAlmostEqual(got, wanted, places=6)
        # The model reads each step's σ, as the trial handed it (timestep / 1000).
        for got, wanted in zip(timesteps, sigmas[:-1]):
            self.assertAlmostEqual(got, wanted, places=6)


class SizeTests(unittest.TestCase):
    def test_the_picture_takes_the_ratio_of_the_image_to_modify_at_a_megapixel(self):
        self.assertEqual(qwen_image_edit.made_size({}, (1920, 1080)), (1376, 768))
        self.assertEqual(qwen_image_edit.made_size({}, (900, 1600)), (768, 1376))
        self.assertEqual(qwen_image_edit.made_size(dict(width=512, height=640), (1920, 1080)), (512, 640))

    def test_the_image_to_modify_comes_first_then_the_others_in_their_order(self):
        given = job(
            references=[
                dict(input='reference-2', role='reference_image', path='/c.png'),
                dict(input='source', role='edit_image', path='/a.png'),
                dict(input='reference-1', role='reference_image', path='/b.png'),
            ]
        )
        self.assertEqual(qwen_image_edit.images_of(given), ['/a.png', '/c.png', '/b.png'])

    def test_lightning_is_applied_whole_before_the_jobs_own_loras(self):
        given = job(loras=[dict(id='angles', path='/angles.safetensors', strength=0.8)])
        loras = qwen_image_edit.step_lora(given) + given['loras']
        self.assertEqual([(item['id'], item['strength']) for item in loras], [('stepLora', 1.0), ('angles', 0.8)])


class RulesTests(unittest.TestCase):
    def test_a_job_of_the_shipped_workflow_is_valid(self):
        registry.validate_job(job())

    def test_without_an_image_or_with_guidance_it_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'au moins une image'):
            registry.validate_job(job(references=[]))
        # Guidance: by the registry, before the pipeline's own rules (the family's only choice is 1).
        with self.assertRaisesRegex(ValueError, '^cfg must be one of the supported values$'):
            registry.validate_job(job(parameters=dict(prompt='a', seed=1, steps=8, cfg=4)))
        with self.assertRaisesRegex(ValueError, 'largeur et la hauteur'):
            registry.validate_job(job(parameters=dict(prompt='a', seed=1, steps=8, width=1024)))
        with self.assertRaisesRegex(ValueError, 'Too many references'):
            registry.validate_job(
                job(
                    references=[
                        dict(input=f'r{i}', role='reference_image', path=str(Path(tempfile.gettempdir()) / f'r{i}.png'))
                        for i in range(3)
                    ]
                )
            )


class EncoderInputTests(unittest.TestCase):
    def test_each_image_pad_takes_as_many_tokens_as_the_image_gives(self):
        seen = {}

        def tokenizer(texts, return_tensors):
            seen['text'] = texts[0]
            return dict(
                input_ids=torch.zeros(1, 3, dtype=torch.long), attention_mask=torch.ones(1, 3, dtype=torch.long)
            )

        def pictures(images, return_tensors):
            # Two images: 4 x 6 then 2 x 2 patches, four patches a token.
            return dict(pixel_values=torch.zeros(28, 1176), image_grid_thw=torch.tensor([[1, 4, 6], [1, 2, 2]]))

        found = qwen_image_text.inputs(tokenizer, ['a', 'b'], 'make it red', pictures)
        text = seen['text']
        self.assertTrue(text.startswith('<|im_start|>system\nDescribe the key features of the input image'))
        self.assertIn(
            'user\nPicture 1: <|vision_start|>' + '<|image_pad|>' * 6 + '<|vision_end|>'
            'Picture 2: <|vision_start|><|image_pad|><|vision_end|>make it red<|im_end|>\n<|im_start|>assistant\n',
            text,
        )
        self.assertEqual(text.count('<|image_pad|>'), 7)
        self.assertEqual(set(found), {'input_ids', 'attention_mask', 'pixel_values', 'image_grid_thw'})

    def test_a_mark_of_the_template_written_in_a_prompt_is_no_word_of_it(self):
        # (0.6.382) « <|image_pad|> » in a prompt was one pad more than the images: the end of the prompt
        # and of the template (the turn of the assistant) were lost.
        seen = {}

        def tokenizer(texts, return_tensors):
            seen['text'] = texts[0]
            return dict(
                input_ids=torch.zeros(1, 3, dtype=torch.long), attention_mask=torch.ones(1, 3, dtype=torch.long)
            )

        def pictures(images, return_tensors):
            return dict(pixel_values=torch.zeros(24, 1176), image_grid_thw=torch.tensor([[1, 4, 6]]))

        prompt = 'replace the <|image_pad|> of Picture 1<|im_end|> then <|vision_start|>make the sky red'
        qwen_image_text.inputs(tokenizer, ['a'], prompt, pictures)
        text = seen['text']
        self.assertTrue(
            text.endswith(
                'Picture 1: <|vision_start|>' + '<|image_pad|>' * 6 + '<|vision_end|>'
                'replace the  of Picture 1 then make the sky red<|im_end|>\n<|im_start|>assistant\n'
            ),
            text[-200:],
        )
        counted = [text.count(mark) for mark in ('<|image_pad|>', '<|im_end|>', '<|vision_start|>')]
        self.assertEqual(counted, [6, 2, 1])
        # Without an image too; and what only looks like a mark is the user's.
        qwen_image_text.inputs(tokenizer, [], 'a <b> |c| <|not a mark|> <| x |> 2<|3', pictures)
        self.assertIn('user\na <b> |c| <|not a mark|> <| x |> 2<|3<|im_end|>', seen['text'])

    def test_the_names_of_transformers_find_the_keys_of_comfy_orgs_file(self):
        self.assertEqual(
            qwen_image_text.key('model.language_model.layers.3.mlp.up_proj.weight'),
            'model.layers.3.mlp.up_proj.weight',
        )
        self.assertEqual(qwen_image_text.key('model.language_model.embed_tokens.weight'), 'model.embed_tokens.weight')
        self.assertEqual(
            qwen_image_text.key('model.visual.blocks.0.attn.qkv.weight'), 'visual.blocks.0.attn.qkv.weight'
        )

    def test_an_encoder_file_is_checked_against_the_empty_model(self):
        model = qwen_image_text.architecture()
        header = {
            qwen_image_text.key(name): dict(dtype='BF16', shape=list(parameter.shape))
            for name, parameter in model.named_parameters()
        }
        names = qwen_image_text.validate_layout(header, model)
        self.assertEqual(names['model.visual.merger.mlp.2.weight'], ('text', 'visual.merger.mlp.2.weight', None))
        del header['model.layers.27.mlp.down_proj.weight']
        with self.assertRaisesRegex(ValueError, 'il lui manque model.layers.27.mlp.down_proj.weight'):
            qwen_image_text.validate_layout(header, model)
        with self.assertRaisesRegex(ValueError, 'pas l’encodeur Qwen2.5-VL-7B'):
            qwen_image_text.validate_layout(
                {'model.embed_tokens.weight': dict(dtype='BF16', shape=[151936, 2560])}, model
            )


class TextCacheTests(unittest.TestCase):
    def test_a_prompt_read_with_the_same_image_is_read_once(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ('qwen_vl.safetensors', 'tokenizer.json'):
                (root / name).write_bytes(b'x')
            given = job(
                components=dict(job()['components'], textEncoder=str(root / 'qwen_vl.safetensors'), tokenizer=str(root))
            )
            config = dict(cacheRoot=str(root / 'cache'))
            red, blue = Image.new('RGB', (64, 48), 'red'), Image.new('RGB', (64, 48), 'blue')
            calls = []

            def encode(path, tokenizer, images, prompts, progress, reserve_gib=None):
                calls.append(prompts)
                return [torch.full((1, 5, 3584), float(len(calls)), dtype=torch.bfloat16)]

            quiet = lambda **_: None  # noqa: E731
            with patch.object(qwen_image_text, 'encode', encode):
                first, kept = qwen_image_edit.texts(config, given, [red], quiet)
                self.assertFalse(kept)
                again, kept = qwen_image_edit.texts(config, given, [red], quiet)
                self.assertTrue(kept)
                self.assertTrue(torch.equal(first, again))
                # Another image, or another prompt, is read anew.
                qwen_image_edit.texts(config, given, [blue], quiet)
                other = job(parameters=dict(given['parameters'], prompt='<sks> back view eye-level shot medium shot'))
                qwen_image_edit.texts(config, dict(given, parameters=other['parameters']), [red], quiet)
            self.assertEqual(len(calls), 3)


class Share:
    """A share of 6 GiB on the card, lent as WeightPool lends it: its last layers (of 1 GiB) first.
    The matrices of the LoRAs merged into its layers (`merged` GiB, counted in its bytes) are never
    lent: they stay on the card."""

    def __init__(self, merged=0):
        self.gpu = {index: qwen_image_edit.GiB for index in range(6)}
        self.merged_bytes = int(merged * qwen_image_edit.GiB)
        self.bytes = self.limit = 6 * qwen_image_edit.GiB + self.merged_bytes
        self.lent = 0
        self.asked = []

    def lend(self, gib):
        self.asked.append(round(gib, 2))
        wanted, freed = int(gib * qwen_image_edit.GiB), 0
        if wanted <= 0:
            return 0
        for location in reversed(list(self.gpu)):
            if freed >= wanted:
                break
            freed += self.gpu.pop(location)
        self.bytes -= freed
        self.lent += freed
        return freed

    def preload(self):
        self.asked.append('preload')
        self.gpu = {index: qwen_image_edit.GiB for index in range(6)}
        self.bytes, self.lent = self.limit, 0


class GivenLatentsTests(unittest.TestCase):
    def test_what_was_kept_of_a_photo_read_lying_is_not_taken_for_it_upright(self):
        # (0.6.303) As for the start image of Wan 2.2: the latents of an image given are kept on the disk, told
        # by what its file holds. A photo kept upside down has the same size once turned: without its
        # orientation in the key, what was kept of it before (read as it is kept) was taken for it.
        import hashlib

        from PIL import Image

        from runner.media import open_image
        from runner.models import conditioning

        with tempfile.TemporaryDirectory() as folder:
            vae, upright, turned = (Path(folder) / name for name in ('vae.safetensors', 'made.png', 'phone.jpg'))
            vae.write_bytes(b'vae')
            Image.effect_noise((64, 32), 60).save(upright)
            note = Image.Exif()
            note[0x0112] = 3
            Image.effect_noise((64, 32), 60).convert('RGB').save(turned, exif=note)
            config, job = dict(cacheRoot=folder), dict(components=dict(vae=str(vae)))
            size = list(qwen_image_edit.size_of(64, 32))

            def key(path, *more):
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                return conditioning.key('qwen image edit image', conditioning.stamp(str(vae)), digest, size, *more)

            # What the version before kept of both; and what this one keeps of the photo.
            for path in (upright, turned):
                conditioning.save(config, key(path), {'value': torch.zeros(1, 16, 4, 8)})
            conditioning.save(config, key(turned, 'orientation 3'), {'value': torch.ones(1, 16, 4, 8)})
            paths = [str(upright), str(turned)]
            images = [open_image(path).convert('RGB') for path in paths]
            found, kept = qwen_image_edit.given_latents(config, job, paths, images, {}, lambda **_said: None)
            self.assertEqual((kept, [float(value.max()) for value in found]), (2, [0.0, 1.0]))


class BesideTests(unittest.TestCase):
    """A new prompt read beside the model the last image left on the card (24/11, on the card:
    the second pose of the bench ran out of video memory in the encoder)."""

    def read(self, failures, share):
        from PIL import Image

        from runner.models import pool

        reserves = []

        def encode(path, tokenizer, images, prompts, progress, reserve_gib):
            reserves.append(reserve_gib)
            if len(reserves) <= failures:
                raise torch.OutOfMemoryError('no room')
            return [torch.zeros(1, 5, 3584, dtype=torch.bfloat16)]

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ('qwen_vl.safetensors', 'tokenizer.json'):
                (root / name).write_bytes(b'x')
            given = job(
                components=dict(job()['components'], textEncoder=str(root / 'qwen_vl.safetensors'), tokenizer=str(root))
            )
            beside = SimpleNamespace(pool=share) if share is not None else None
            # 1 GiB free beside the share.
            with (
                patch.object(qwen_image_text, 'encode', encode),
                patch.object(pool, 'room', lambda reserve: 1.0 - reserve),
            ):
                qwen_image_edit.texts(
                    dict(cacheRoot=str(root / 'cache')),
                    given,
                    [Image.new('RGB', (64, 48), 'red')],
                    lambda **_: None,
                    beside=beside,
                )
        return reserves

    def test_the_share_lends_the_encoder_its_room_then_all_of_itself(self):
        from runner import engine

        beside = qwen_image_edit.BESIDE_RESERVE_GIB
        # Its streaming has room under the ceiling the engine sets below what was free.
        self.assertGreaterEqual(beside, qwen_image_text.RESERVE_GIB + engine.VRAM_MARGIN / qwen_image_edit.GiB)
        share = Share()
        self.assertEqual(self.read(0, share), [beside])
        # 1 GiB was free: what the encoder's reserve lacked is lent, two layers of the share.
        self.assertEqual(
            (share.asked, len(share.gpu), share.lent), ([round(beside - 1.0, 2)], 4, 2 * qwen_image_edit.GiB)
        )
        # Still out of memory beside it: all of the share leaves the card, but the LoRA matrices
        # merged into its layers (Lightning's: about 0.8 GiB), and the encoder runs alone.
        share = Share(merged=0.8)
        self.assertEqual(self.read(1, share), [beside, qwen_image_text.RESERVE_GIB])
        self.assertEqual((share.gpu, share.lent, share.bytes), ({}, 6 * qwen_image_edit.GiB, share.merged_bytes))
        # No model on the card: one reading, with the encoder's own reserve, nothing lent.
        self.assertEqual(self.read(0, None), [qwen_image_text.RESERVE_GIB])
        idle = Share()
        idle.gpu.clear()
        self.assertEqual((self.read(0, idle), idle.asked), ([qwen_image_text.RESERVE_GIB], []))

    def test_the_share_is_weighed_whole_before_it_is_taken_back(self):
        # 4 GiB on the card and 2 lent to the prompt: a share of 6, kept for an image that leaves it 6.
        share = Share()
        share.lend(2)
        self.assertEqual((share.bytes, share.lent), (4 * qwen_image_edit.GiB, 2 * qwen_image_edit.GiB))
        self.assertTrue(qwen_image_edit.fits(share, 6))
        # Another program took 2 GiB of the card since: what is on it would fit, the share whole
        # does not, and taken back it ran out of memory (24/11). It is built anew.
        self.assertFalse(qwen_image_edit.fits(share, 4))
        # More room than when it was built: built anew at this image's size.
        self.assertFalse(qwen_image_edit.fits(share, 7))

    def test_what_was_lent_comes_back_only_to_a_share_that_fits(self):
        class Loaded:
            def __init__(self):
                self.pool, self.dropped = Share(), False

            def drop(self):
                self.dropped = True

        stages = []
        loaded = Loaded()
        loaded.pool.lend(2)
        self.assertIs(qwen_image_edit.kept_share(loaded, 6, lambda **data: stages.append(data)), loaded)
        self.assertEqual((loaded.pool.asked[-1], loaded.pool.lent, loaded.dropped), ('preload', 0, False))
        self.assertEqual(stages, [dict(stage='transformer weights taken back', lent_gib=2.0)])
        # The card filled by another program since: dropped as it is, nothing taken back first.
        loaded, stages = Loaded(), []
        loaded.pool.lend(2)
        self.assertIsNone(qwen_image_edit.kept_share(loaded, 4, lambda **data: stages.append(data)))
        self.assertEqual((loaded.pool.asked, loaded.dropped, stages), ([2], True, []))
        # Nothing lent: kept as it is.
        loaded = Loaded()
        self.assertIs(qwen_image_edit.kept_share(loaded, 6, lambda **data: stages.append(data)), loaded)
        self.assertEqual((loaded.pool.asked, stages), ([], []))


class ModulationCacheTests(unittest.TestCase):
    def test_the_modulations_kept_are_told_by_the_loras_that_change_them(self):
        # The angles LoRA changes img_mod and txt_mod: modulations kept without it, or at another
        # strength, are not those of a picture made with it.
        from runner.models import conditioning, qwen_image

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stores = {}
            for name in ('model', 'lora0', 'lora1', 'lora2'):
                (root / name).write_bytes(name.encode())
                stores[name] = SimpleNamespace(path=root / name)
            asked = []

            def load(config, entry):
                asked.append(entry)
                return None

            class Pool:
                def __init__(self, *args, **kwargs):
                    pass

                def clear(self):
                    pass

            def made(adapters, timesteps=(1.0, 0.5), zero=True):
                loaded = SimpleNamespace(
                    stores=stores, adapters=adapters, taken=None, names=None, model=None, zero=zero
                )
                qwen_image_edit.modulations(
                    dict(cacheRoot=str(root / 'cache')), loaded, list(timesteps), lambda **_: None
                )
                return asked[-1]

            with (
                patch.object(conditioning, 'load', load),
                patch.object(conditioning, 'save', lambda *args, **kwargs: True),
                patch.object(qwen_image, 'layers', lambda *args: None),
                patch.object(qwen_image, 'modulations', lambda *args, **kwargs: {}),
                patch('runner.models.pool.WeightPool', Pool),
            ):
                lightning = made([('lora0', 1.0)])
                angles = made([('lora0', 1.0), ('lora1', 1.0)])
                weaker = made([('lora0', 1.0), ('lora1', 0.5)])
                another = made([('lora0', 1.0), ('lora2', 1.0)])
                self.assertEqual(len({lightning, angles, weaker, another}), 4)
                # The same files at the same strengths: the same entry, read back.
                self.assertEqual(made([('lora0', 1.0), ('lora1', 1.0)]), angles)
                # Other steps, or the images given read at the step of the picture: others again.
                self.assertNotEqual(made([('lora0', 1.0)], timesteps=(1.0, 0.25)), lightning)
                self.assertNotEqual(made([('lora0', 1.0)], zero=False), lightning)


class BenchTests(unittest.TestCase):
    def test_the_bench_asks_for_a_job_the_engine_takes(self):
        import argparse

        from runner import bench

        class Read(Exception):
            pass

        parse = argparse.ArgumentParser.parse_args

        def stop(parser, *args, **kwargs):
            raise Read(parse(parser, *args, **kwargs))

        folder = Path(tempfile.gettempdir())
        prompt = '<sks> back view eye-level shot medium shot'
        given = ['qwen_image_edit', '--out', str(folder), '--seed', '3', '--same-prompt', '--prompt', prompt]
        for name in ('model', 'text-encoder', 'vae', 'step-lora'):
            given += ['--' + name, str(folder / (name + '.safetensors'))]
        given += ['--tokenizer', str(folder / 'qwen25_tokenizer'), '--lora', str(folder / 'angles.safetensors') + ':1']
        given += ['--reference', 'reference_image=' + str(folder / 'b.png')]
        given += ['--reference', 'edit_image=' + str(folder / 'a.png')]
        with patch.object(argparse.ArgumentParser, 'parse_args', stop), self.assertRaises(Read) as read:
            bench.main(given)
        args = read.exception.args[0]
        # (What `main` does of --same-prompt once the arguments are read.)
        args.new_prompts = 1
        self.assertEqual(bench.FAMILIES['qwen_image_edit'][0], 'runner.pipelines.qwen_image_edit')
        made = bench.qwen_image_edit_job(args, 2)
        # As shipped: Lightning's eight steps, no guidance, the size of the image to modify.
        self.assertEqual(made['parameters'], dict(prompt=prompt, seed=4, steps=8, cfg=1))
        self.assertEqual(made['components']['stepLora'], str(folder / 'step-lora.safetensors'))
        self.assertEqual(qwen_image_edit.images_of(made), [str(folder / 'a.png'), str(folder / 'b.png')])
        self.assertEqual(
            [(item['path'], item['strength']) for item in made['loras']], [(str(folder / 'angles.safetensors'), 1.0)]
        )
        registry.validate_job(dict(made, schemaVersion=1, workflowId='bench', workflowDigest='d' * 64))
        args.size = '1024x768'
        sized = bench.qwen_image_edit_job(args, 1)['parameters']
        self.assertEqual(qwen_image_edit.made_size(sized, (10, 10)), (1024, 768))


class Built:
    """The share of the model built for `budget` GiB, as the steps see it: what they stream is
    counted in `stats`, as WeightPool counts it."""

    def __init__(self, budget):
        self.gpu = {0: 1}
        self.bytes = self.limit = int(budget * qwen_image_edit.GiB)
        self.lent = 0
        self.stats = dict(first_gib=0.0, first_seconds=0.0, again_gib=0.0)

    def summary(self):
        return dict(self.stats)

    def lend(self, _gib):
        return 0

    def preload(self):
        self.lent = 0

    def settle(self):
        pass

    def clear(self):
        self.gpu = {}


def on_the_processor(make):
    """torch.tensor and the like, made on the processor whatever device is asked."""
    return lambda *args, device=None, **options: make(*args, **options)


class GenerateTests(unittest.TestCase):
    """The real generate and _generate, one image after the other, on the processor: the card, the
    encoder, the VAE and the steps of the model faked (0.6.273)."""

    def images(self, count, short=(), sized=True):
        """Makes `count` images with the same job. `short`: the images (0, the first) whose first
        step runs out of memory once. `sized`: the job gives a width and a height (256 x 256). Returns
        their sheets; the budgets of the models built are left in `self.builds`, what was asked of
        pool.require in `self.required`."""
        from contextlib import ExitStack
        from unittest import mock

        from PIL import Image

        from runner import hardware, media, preview
        from runner.models import conditioning, kept, pool, qwen_image
        from runner.pipelines import ltx25

        sigmas = qwen_image_edit.schedule()
        builds, pools, short, made, prepared, required = [], [], list(short), [0], [], []

        def build(loaded, _job, _loras, budget, _progress):
            builds.append(budget)
            loaded.pool = Built(budget)
            pools.append(loaded.pool)
            loaded.model, loaded.zero, loaded.locked = 'model', True, True
            loaded.facts = dict(opening_seconds=0.1)

        def predict(_model, _prepared, current, index):
            if index == 0 and made[0] in short:
                short.remove(made[0])
                raise torch.OutOfMemoryError('CUDA out of memory (as at the first step)')
            # Each step streams half a gigabyte of the model, read from its file.
            pools[-1].stats['first_gib'] += 0.5
            return torch.zeros_like(current)

        def texts(*_args, **_beside):
            return torch.zeros(1, 5, 3584), False

        def given_latents(*_args, **_before):
            return [torch.zeros(1, 16, 8, 8)], 0

        class Vae:
            config = SimpleNamespace(latents_mean=[0.0] * 16, latents_std=[1.0] * 16)

            def to(self, *_device):
                return self

            def decode(self, latents, return_dict=False):
                return (torch.zeros(1, 3, 1, 8, 8),)

        real_to = torch.Tensor.to

        def to(tensor, *args, **options):
            options.pop('device', None)
            args = [arg for arg in args if not isinstance(arg, (str, torch.device))]
            return real_to(tensor, *args, **options)

        sheets = []
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack:
            enter = stack.enter_context
            path = Path(folder) / 'a.png'
            Image.new('RGB', (64, 48), 'red').save(path)
            given = job(references=[dict(input='source', role='edit_image', path=str(path))])
            if sized:
                given['parameters'] = dict(given['parameters'], width=256, height=256)
            for name, value in (('is_available', True), ('reset_peak_memory_stats', None), ('empty_cache', None)):
                enter(mock.patch.object(torch.cuda, name, return_value=value))
            for name in ('memory_reserved', 'memory_allocated', 'max_memory_allocated'):
                enter(mock.patch.object(torch.cuda, name, return_value=0))
            enter(mock.patch.object(torch.Tensor, 'to', to))
            enter(mock.patch.object(torch.Tensor, 'cuda', lambda tensor, *_device: tensor))
            enter(mock.patch.object(torch, 'tensor', on_the_processor(torch.tensor)))
            enter(mock.patch.object(hardware, 'free_bytes', lambda _torch: 10 * qwen_image_edit.GiB))
            enter(mock.patch.object(pool, 'require', lambda *args, **_measured: required.append(args)))
            enter(mock.patch.object(ltx25, 'memory', dict))
            enter(mock.patch.object(conditioning, 'stamp', side_effect=str))
            enter(mock.patch.object(preview, 'send', lambda *_args: None))
            enter(mock.patch.object(media, 'save_image', lambda _pixels, _config, _job, metadata: metadata))
            enter(mock.patch.object(qwen_image, 'prepare', lambda *_args, **options: prepared.append(options)))
            enter(mock.patch.object(qwen_image, 'predict', predict))
            enter(mock.patch.object(qwen_image_edit, 'schedule', lambda _steps=8: sigmas))
            enter(mock.patch.object(qwen_image_edit, 'texts', texts))
            enter(mock.patch.object(qwen_image_edit, 'given_latents', given_latents))
            enter(mock.patch.object(qwen_image_edit, 'modulations', lambda *_args: ({}, False)))
            enter(mock.patch.object(qwen_image_edit, '_build', build))
            enter(mock.patch.object(qwen_image_edit, 'load_vae', lambda _path: Vae()))
            try:
                for index in range(count):
                    made[0] = index
                    sheets.append(qwen_image_edit.generate(given, dict(cacheRoot=folder), lambda **_stage: None))
            finally:
                kept._kept.clear()
        self.builds, self.prepared, self.required = builds, prepared, required
        return sheets

    def test_a_refusal_for_memory_says_to_make_the_picture_smaller_only_when_its_size_is_set(self):
        # (0.6.283) The shipped workflow gives no width and no height: the picture has the size of the image to
        # modify at a megapixel, and there is nothing to make smaller. With its own size, there is.
        self.images(1, sized=False)
        self.assertEqual([asked[2] for asked in self.required], [None])
        self.images(1)
        self.assertEqual([asked[2] for asked in self.required], ['la taille de l’image'])

    def test_the_sheet_of_an_image_made_with_the_model_kept_counts_its_own_weights(self):
        first, second = self.images(2)
        self.assertEqual(len(self.builds), 1)
        self.assertEqual([first['kept_model'], second['kept_model']], [False, True])
        # Eight steps of half a gigabyte each: for the second image, its own, not the sum of both.
        self.assertEqual([first['weights']['first_gib'], second['weights']['first_gib']], [4.0, 4.0])

    def test_an_image_made_again_with_a_model_built_anew_does_not_say_it_was_kept(self):
        first, second = self.images(2, short=[1])
        # Out of memory at the first step of the second image: the model left is dropped, and the
        # image made again with half the share, from a model built anew.
        self.assertEqual(len(self.builds), 2)
        self.assertAlmostEqual(self.builds[1], self.builds[0] / 2)
        self.assertEqual([first['kept_model'], second['kept_model']], [False, False])
        self.assertEqual(second['weights']['first_gib'], 4.0)

    def test_int8_attention_is_asked_only_where_the_card_runs_it(self):
        # (0.6.274) Turned on, the switch asked any card for comfy-kitchen's INT8 kernel, and one
        # without it would fail at the first step (runner.pipelines.minimax_h3 asks first).
        from runner.models import qwen_image

        for available in (False, True):
            with (
                patch.object(qwen_image_edit, 'INT8_ATTENTION', True),
                patch.object(qwen_image, 'int8_attention_available', lambda: available),
            ):
                (sheet,) = self.images(1)
            said = 'int8' if available else 'cudnn'
            self.assertEqual((self.prepared[0]['int8_attention'], sheet['attention']), (available, said))
        # Off, as shipped: the card is not even asked.
        with patch.object(qwen_image, 'int8_attention_available', side_effect=AssertionError('asked')):
            (sheet,) = self.images(1)
        self.assertEqual((self.prepared[0]['int8_attention'], sheet['attention']), (False, 'cudnn'))


if __name__ == '__main__':
    unittest.main()
