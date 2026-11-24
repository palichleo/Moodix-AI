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

    def test_without_an_image_or_with_guidance_it_is_refused_in_words(self):
        with self.assertRaisesRegex(ValueError, 'au moins une image'):
            registry.validate_job(job(references=[]))
        with self.assertRaisesRegex(ValueError, 'Unsupported|cfg'):
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
            return dict(input_ids=torch.zeros(1, 3, dtype=torch.long), attention_mask=torch.ones(1, 3, dtype=torch.long))

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

    def test_the_names_of_transformers_find_the_keys_of_comfy_orgs_file(self):
        self.assertEqual(qwen_image_text.key('model.language_model.layers.3.mlp.up_proj.weight'), 'model.layers.3.mlp.up_proj.weight')
        self.assertEqual(qwen_image_text.key('model.language_model.embed_tokens.weight'), 'model.embed_tokens.weight')
        self.assertEqual(qwen_image_text.key('model.visual.blocks.0.attn.qkv.weight'), 'visual.blocks.0.attn.qkv.weight')

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
            qwen_image_text.validate_layout({'model.embed_tokens.weight': dict(dtype='BF16', shape=[151936, 2560])}, model)


class TextCacheTests(unittest.TestCase):
    def test_a_prompt_read_with_the_same_image_is_read_once(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ('qwen_vl.safetensors', 'tokenizer.json'):
                (root / name).write_bytes(b'x')
            given = job(components=dict(job()['components'], textEncoder=str(root / 'qwen_vl.safetensors'), tokenizer=str(root)))
            config = dict(cacheRoot=str(root / 'cache'))
            red, blue = Image.new('RGB', (64, 48), 'red'), Image.new('RGB', (64, 48), 'blue')
            calls = []

            def encode(path, tokenizer, images, prompts, progress):
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
                loaded = SimpleNamespace(stores=stores, adapters=adapters, taken=None, names=None, model=None, zero=zero)
                qwen_image_edit.modulations(dict(cacheRoot=str(root / 'cache')), loaded, list(timesteps), lambda **_: None)
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
        given += ['--reference', 'reference_image=' + str(folder / 'b.png'), '--reference', 'edit_image=' + str(folder / 'a.png')]
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
        self.assertEqual([(item['path'], item['strength']) for item in made['loras']], [(str(folder / 'angles.safetensors'), 1.0)])
        registry.validate_job(dict(made, schemaVersion=1, workflowId='bench', workflowDigest='d' * 64))
        args.size = '1024x768'
        self.assertEqual(qwen_image_edit.made_size(bench.qwen_image_edit_job(args, 1)['parameters'], (10, 10)), (1024, 768))


if __name__ == '__main__':
    unittest.main()
