import importlib.util
import unittest

HAS_TORCH = importlib.util.find_spec('torch') is not None


class SeedVR2SizesTest(unittest.TestCase):
    """(0.6.302) The size of each pass: none beyond the largest side, none that enlarges nothing."""

    def sizes(self, width, height, **parameters):
        from runner.pipelines import seedvr2

        return seedvr2._sizes(width, height, parameters)

    def test_no_pass_goes_beyond_the_largest_side_nor_is_made_for_nothing(self):
        # One pass, as the Studio asks it (« Agrandir »): as before, brought back to 8192 when it goes beyond.
        self.assertEqual(self.sizes(1024, 768, scale=2), [(2048, 1536)])
        self.assertEqual(self.sizes(1024, 768, scale=4, passes=1), [(4096, 3072)])
        self.assertEqual(self.sizes(4032, 3024, scale=4), [(8192, 6144)])
        # Several, as Moodix AI may ask them. It went through 12 000 px, then was made smaller by a third pass.
        self.assertEqual(self.sizes(3000, 2000, scale=2, passes=3), [(6000, 4000), (8192, 5461)])
        # It ended on a pass from 8192 to 8192: a whole diffusion that enlarged nothing.
        self.assertEqual(self.sizes(2048, 1152, scale=2, passes=3), [(4096, 2304), (8192, 4608)])
        # It went through 16 128 px at its first pass.
        self.assertEqual(self.sizes(4032, 3024, scale=4, passes=2), [(8192, 6144)])
        # Under the limit nothing changes.
        self.assertEqual(self.sizes(512, 512, scale=2, passes=3), [(1024, 1024), (2048, 2048), (4096, 4096)])
        self.assertEqual(self.sizes(640, 360, scale=1.5, passes=2), [(960, 540), (1440, 810)])
        # The side the request gives is the limit, never beyond 8192.
        self.assertEqual(self.sizes(1024, 1024, scale=2, passes=3, max_side=3000), [(2048, 2048), (3000, 3000)])
        self.assertEqual(self.sizes(1024, 1024, scale=2, passes=1, max_side=1500), [(1500, 1500)])
        self.assertEqual(self.sizes(4096, 4096, scale=4, max_side=20000), [(8192, 8192)])
        # The first pass is always made: an image already at the limit is restored there, one beyond it brought back.
        self.assertEqual(self.sizes(8192, 4608, scale=2), [(8192, 4608)])
        self.assertEqual(self.sizes(8192, 4608, scale=2, passes=3), [(8192, 4608)])
        self.assertEqual(self.sizes(10000, 5000, scale=2), [(8192, 4096)])
        # Passes that do not enlarge (scale 1) are restorations: all made, as before.
        self.assertEqual(self.sizes(1024, 768, scale=1, passes=3), [(1024, 768)] * 3)
        # Never under 16 px on a side.
        self.assertEqual(self.sizes(8192, 8, scale=2), [(8192, 16)])


@unittest.skipUnless(HAS_TORCH, 'torch is not installed')
class SeedVR2MemoryTest(unittest.TestCase):
    def test_the_picture_completed_in_32_bits_is_not_kept_through_a_pass(self):
        # (0.6.379) Converted to 16 bits for the encoder, its 32-bit copy stayed on the card under a name of
        # its own until the end of the pass: 12 bytes a pixel that the steps and the decoding could not have.
        import ast
        import inspect

        from runner.pipelines import seedvr2

        tree = ast.parse(inspect.getsource(seedvr2.generate))
        named = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        self.assertNotIn('pixels', named)
        # What the encoder reads is made in one expression, and given back before the steps.
        made = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign) and any(getattr(target, 'id', '') == 'source' for target in node.targets)
        ]
        self.assertEqual(len(made), 1)
        self.assertIn('bfloat16', ast.unparse(made[0].value))
        self.assertIn('pad(reference', ast.unparse(made[0].value))
        deleted = [
            getattr(target, 'id', '')
            for node in ast.walk(tree)
            if isinstance(node, ast.Delete)
            for target in node.targets
        ]
        self.assertIn('source', deleted)


class SeedVR2Test(unittest.TestCase):
    def test_windows_cover_every_token_once(self):
        import torch

        from runner.models import seedvr2

        for size in [(1, 72, 128), (1, 8, 12), (1, 40, 30), (3, 17, 23), (1, 1, 1)]:
            for method in ('win', 'swin'):
                grid = torch.zeros(size, dtype=torch.int)
                for st, sh, sw in seedvr2.window_slices(size, method):
                    grid[slice(*st), slice(*sh), slice(*sw)] += 1
                self.assertTrue(bool((grid == 1).all()), (size, method))

    def test_folded_vae_matches_a_three_tap_causal_kernel(self):
        import torch

        from runner.models import seedvr2_vae

        weight = torch.randn(4, 3, 3, 3)
        folded = seedvr2_vae.folded({'w': weight[:, :, None].repeat(1, 1, 3, 1, 1) / 3})['w']
        self.assertTrue(torch.allclose(folded, weight, atol=1e-6))

    def test_sliced_vae_attention_matches_whole_attention(self):
        import torch

        from runner.models import seedvr2_vae

        torch.manual_seed(0)
        layer = seedvr2_vae.Attention(64).eval()
        x = torch.randn(1, 64, 12, 10)
        with torch.no_grad():
            whole = layer(x)
            previous, seedvr2_vae.SLICE_SCORES = seedvr2_vae.SLICE_SCORES, 120 * 7
            try:
                sliced = layer(x)
            finally:
                seedvr2_vae.SLICE_SCORES = previous
        self.assertTrue(torch.allclose(whole, sliced, atol=1e-5))

    def test_strip_decoder_matches_a_single_strip(self):
        import torch

        from runner.models import seedvr2_vae

        torch.manual_seed(0)
        vae = seedvr2_vae.VAE().eval()
        for parameter in vae.parameters():
            parameter.data.normal_(0, 0.05)
        z = torch.randn(1, 16, 6, 5)
        previous = seedvr2_vae.STRIP_ELEMENTS
        try:
            with torch.no_grad():
                seedvr2_vae.STRIP_ELEMENTS = 1 << 40
                whole = vae.decoder(z)
                seedvr2_vae.STRIP_ELEMENTS = 128 * 20 * 3  # down to one-row strips
                strips = vae.decoder(z)
        finally:
            seedvr2_vae.STRIP_ELEMENTS = previous
        self.assertTrue(torch.allclose(whole, strips, atol=1e-4))

    def test_colour_corrections_keep_an_identical_image(self):
        import torch

        from runner.models import seedvr2_color

        image = torch.rand(1, 3, 32, 32)
        for method in seedvr2_color.METHODS:
            self.assertLess((seedvr2_color.correct(image, image, method) - image).abs().max().item(), 1e-4)

    def test_bundled_text_embedding_has_its_shape(self):
        from runner.models import seedvr2

        self.assertEqual(seedvr2.POSITIVE.stat().st_size, 58 * 5120 * 2)


if __name__ == '__main__':
    unittest.main()
