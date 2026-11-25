import unittest
from unittest.mock import patch

import torch

from runner.models import qwen_image

CUDA = torch.cuda.is_available()
SIGMAS = [1.0, 0.9545, 0.9, 0.8333, 0.75, 0.6429, 0.5, 0.3]


def relative(got, expected):
    return ((got.float() - expected.float()).norm() / expected.float().norm()).item()


def tiny(zero=True, device='cpu', dtype=torch.float32):
    """Two blocks of two heads of the real size, the text 64 wide, random weights."""
    torch.manual_seed(0)
    model = qwen_image.architecture(layers=2, heads=2, text_width=64, zero=zero, empty=False)
    # Modulations of a few tenths, as a trained model's: the default initialisation gives the
    # gates and scales of a model that does nothing.
    for module in model.modules():
        if isinstance(module, torch.nn.Linear):
            torch.nn.init.normal_(module.weight, std=0.6 / module.in_features**0.5)
            torch.nn.init.normal_(module.bias, std=0.05)
    for name, parameter in model.named_parameters():
        if name.endswith('norm_q.weight') or 'norm_k' in name or 'norm_added' in name or name == 'txt_norm.weight':
            torch.nn.init.normal_(parameter, mean=1.0, std=0.1)
    model = model.eval().requires_grad_(False)
    # (diffusers warns at every change of precision; the processor's float32 is the model's own.)
    return model if (device, dtype) == ('cpu', torch.float32) else model.to(device, dtype)


def inputs(made=(8, 12), given=((10, 6),), words=7, device='cpu', dtype=torch.float32):
    """(packed latents of the picture, of the images given or None, the text, the grid)."""
    generator = torch.Generator().manual_seed(1)
    kind = dict(device=device, dtype=dtype)
    latents = qwen_image.pack(torch.randn(1, 16, *made, generator=generator)).to(**kind)
    packed = [qwen_image.pack(torch.randn(1, 16, *size, generator=generator)) for size in given]
    held = torch.cat(packed, dim=1).to(**kind) if packed else None
    text = torch.randn(1, words, 64, generator=generator).to(**kind)
    return latents, held, text, qwen_image.shapes(made, list(given))


class LayoutTests(unittest.TestCase):
    def header(self, prefix='', zero=True):
        model = qwen_image.architecture()
        found = {
            prefix + name: dict(dtype='BF16', shape=list(parameter.shape))
            for name, parameter in model.named_parameters()
        }
        for name in [key for key in found if key.endswith('.to_q.weight')]:
            found[name.removesuffix('.weight') + '.weight_scale'] = dict(dtype='F32', shape=[3072, 1])
            found[name.removesuffix('.weight') + '.comfy_quant'] = dict(dtype='U8', shape=[72])
        if zero:
            found[prefix + qwen_image.ZERO] = dict(dtype='F32', shape=[0])
        return found

    def test_a_file_of_2511_is_named_whole_and_says_it_reads_timestep_zero(self):
        for prefix in ('', qwen_image.PREFIX):
            names, zero = qwen_image.validate_layout(self.header(prefix))
            self.assertTrue(zero)
            self.assertEqual(
                names['transformer_blocks.0.attn.to_q.weight'],
                ('model', prefix + 'transformer_blocks.0.attn.to_q.weight', None),
            )
            self.assertNotIn('transformer_blocks.0.attn.to_q.weight_scale', names)
            self.assertNotIn(qwen_image.ZERO, names)
        self.assertFalse(qwen_image.validate_layout(self.header(zero=False))[1])

    def test_a_missing_tensor_or_another_size_is_refused_in_words(self):
        header = self.header()
        del header['transformer_blocks.59.img_mlp.net.2.weight']
        with self.assertRaisesRegex(ValueError, 'il lui manque transformer_blocks.59.img_mlp.net.2.weight'):
            qwen_image.validate_layout(header)
        header = self.header()
        header['txt_in.weight']['shape'] = [3072, 2560]
        with self.assertRaisesRegex(ValueError, 'Taille inattendue'):
            qwen_image.validate_layout(header)
        with self.assertRaisesRegex(ValueError, 'pas un modèle Qwen-Image'):
            qwen_image.validate_layout({'blocks.0.attn.wq.weight': dict(dtype='BF16', shape=[6144, 6144])})


class SplitTests(unittest.TestCase):
    def test_the_layers_read_once_a_picture_leave_the_model_of_the_steps(self):
        model = qwen_image.architecture()
        taken = qwen_image.split(model)
        # The two of the timestep, the output's, and two a block.
        self.assertEqual(len(taken), 2 + 1 + 2 * qwen_image.LAYERS)
        self.assertIn('transformer_blocks.7.img_mod.1', taken)
        self.assertIn('time_text_embed.timestep_embedder.linear_1', taken)
        left = [name for name, module in model.named_modules() if isinstance(module, torch.nn.Linear)]
        # Twelve a block for the steps, and the three around them.
        self.assertEqual(len(left), 12 * qwen_image.LAYERS + 3)
        self.assertFalse(any(qwen_image.ONCE.match(name) for name in left))
        with self.assertRaisesRegex(RuntimeError, 'read once a picture'):
            model.norm_out.linear(torch.zeros(1, 3072))

    def test_a_third_of_the_weights_are_read_once(self):
        model = qwen_image.architecture()
        everything = sum(parameter.numel() for parameter in model.parameters())
        once = sum(
            parameter.numel() for module in qwen_image.split(model).values() for parameter in module.parameters()
        )
        self.assertAlmostEqual(once / everything, 0.33, delta=0.01)


class RotationTests(unittest.TestCase):
    def test_the_table_turns_pairs_as_diffusers_complex_product_does(self):
        import comfy_kitchen
        from diffusers.models.transformers.transformer_qwenimage import apply_rotary_emb_qwen

        torch.manual_seed(0)
        freqs = torch.polar(torch.ones(5, 64), torch.rand(5, 64) * 6)
        query, key = torch.randn(1, 5, 2, 128), torch.randn(1, 5, 2, 128)
        expected = apply_rotary_emb_qwen(query, freqs, use_real=False)
        table = qwen_image._table(freqs)
        self.assertEqual(tuple(table.shape), (1, 5, 1, 64, 2, 2))
        turned, _ = comfy_kitchen.apply_rope_(query.clone(), key.clone(), table)
        self.assertLess(relative(turned, expected), 1e-6)

    def test_pack_and_unpack_are_each_others_inverse(self):
        latents = torch.randn(1, 16, 6, 10)
        tokens = qwen_image.pack(latents)
        self.assertEqual(tuple(tokens.shape), (1, 15, 64))
        # The layout of diffusers' pipeline: 16 channels of a 2 x 2 patch after another.
        self.assertTrue(torch.equal(tokens[0, 1, :4], latents[0, 0, :2, 2:4].reshape(-1)))
        self.assertTrue(torch.equal(qwen_image.unpack(tokens, 6, 10), latents))


class FusedPassTests(unittest.TestCase):
    """The fused pass against diffusers' own forward, in float32 on the processor: comfy-kitchen's
    kernels have an exact version there, so that any mistake of order or of row shows."""

    def compare(self, zero=True, given=((10, 6),), steps=(0, 3, 7)):
        model = tiny(zero)
        latents, held, text, grid = inputs(given=given)
        with torch.no_grad():
            mods = qwen_image.modulations(model, SIGMAS, zero=zero)
            prepared = qwen_image.prepare(model, text, held, grid, mods, zero=zero)
            kept = (prepared.text.clone(), None if prepared.given is None else prepared.given.clone())
            for step in steps:
                fused = qwen_image.predict(model, prepared, latents, step)
                exact = qwen_image.reference(model, latents, held, text, SIGMAS[step], grid)
                self.assertEqual(fused.shape, exact.shape)
                self.assertLess(relative(fused, exact), 1e-4, f'step {step}')
        self.assertTrue(torch.equal(prepared.text, kept[0]), 'the text is the same at every step')
        if held is not None:
            self.assertTrue(torch.equal(prepared.given, kept[1]), 'so are the images given')
        return model, prepared, latents

    def test_with_one_image_given_reading_timestep_zero(self):
        self.compare()

    def test_with_two_images_of_two_sizes(self):
        self.compare(given=((10, 6), (4, 8)))

    def test_without_any_image(self):
        self.compare(given=())

    def test_a_model_whose_given_images_read_the_step(self):
        self.compare(zero=False)

    def test_the_feed_forward_a_few_rows_at_a_time_gives_the_same_rows(self):
        model, prepared, latents = self.compare(steps=(2,))
        with torch.no_grad():
            whole = qwen_image.predict(model, prepared, latents, 2)
            with patch.object(qwen_image, 'ROWS', 5):
                pieces = qwen_image.predict(model, prepared, latents, 2)
        self.assertLess(relative(pieces, whole), 1e-6)

    def test_the_modulations_are_the_blocks_own_for_each_step(self):
        model = tiny()
        with torch.no_grad():
            mods = qwen_image.modulations(model, SIGMAS)
            self.assertEqual(tuple(mods['img'].shape), (2, 9, 6 * 256))
            self.assertEqual(tuple(mods['txt'].shape), (2, 8, 6 * 256))
            self.assertEqual(tuple(mods['out'].shape), (8, 2 * 256))
            # Step 3 of the second block, and timestep 0, as diffusers computes them.
            timestep = torch.tensor([SIGMAS[3], 0.0])
            temb = model.time_text_embed(timestep, torch.zeros(1, dtype=torch.float32))
            block = model.transformer_blocks[1]
            self.assertTrue(torch.allclose(mods['img'][1, 3], block.img_mod(temb)[0], atol=1e-6))
            self.assertTrue(torch.allclose(mods['img'][1, -1], block.img_mod(temb)[1], atol=1e-6))
            self.assertTrue(torch.allclose(mods['txt'][1, 3], block.txt_mod(temb[:1])[0], atol=1e-6))
            out = model.norm_out.linear(model.norm_out.silu(temb[:1]))[0]
            self.assertTrue(torch.allclose(mods['out'][3], out, atol=1e-6))


@unittest.skipUnless(CUDA, 'the fused kernels run on the GPU')
class FusedPassOnTheCardTests(unittest.TestCase):
    def run_both(self, int8_attention):
        model = tiny(device='cuda', dtype=torch.bfloat16)
        latents, held, text, grid = inputs(
            made=(32, 48), given=((40, 24),), words=40, device='cuda', dtype=torch.bfloat16
        )
        with torch.no_grad():
            mods = qwen_image.modulations(model, SIGMAS)
            prepared = qwen_image.prepare(model, text, held, grid, mods, int8_attention=int8_attention)
            fused = qwen_image.predict(model, prepared, latents, 4)
            exact = qwen_image.reference(model.float(), latents.float(), held.float(), text.float(), SIGMAS[4], grid)
        return fused, exact

    def test_the_fused_pass_stays_within_bfloat16s_rounding(self):
        fused, exact = self.run_both(False)
        self.assertLess(relative(fused, exact), 0.01)

    def test_the_int8_attention_stays_within_its_rounding(self):
        if not qwen_image.int8_attention_available():
            self.skipTest('no INT8 attention kernel for this GPU')
        fused, exact = self.run_both(True)
        self.assertLess(relative(fused, exact), 0.02)


if __name__ == '__main__':
    unittest.main()
