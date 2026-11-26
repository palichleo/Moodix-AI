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


class SeedVR2ShareTest(unittest.TestCase):
    """(0.6.448) The share of the card left to the weights of the model follows the size of the image."""

    def test_the_weights_keep_their_share_where_it_was_enough_and_less_for_a_larger_image(self):
        from runner.pipelines import seedvr2

        share = lambda free, side, **more: seedvr2.share_gib(free, [(side, side)], **more)  # noqa: E731
        # What the steps compute with grows with the pixels: about ten times the tokens of the image.
        self.assertAlmostEqual(seedvr2.working_gib(2048, 2048), 2.64, places=2)
        self.assertAlmostEqual(seedvr2.working_gib(4096, 4096), 5.45, places=2)
        self.assertGreater(seedvr2.working_gib(2000, 1000), seedvr2.working_gib(1000, 1000))
        # A side that is no multiple of 16 is completed to one.
        self.assertEqual(seedvr2.working_gib(2040, 2040), seedvr2.working_gib(2048, 2048))
        # 10.6 GiB free (other programs on the card) or 11.4: 6 GiB of weights, as before, up to 2560 x 2560,
        # the sizes made on 26/11 (10 s and 15.5 s).
        for free in (10.6, 11.4):
            for side in (1024, 2048, 2560):
                self.assertEqual(share(free, side), 6, (free, side))
                self.assertEqual(share(free, side), min(6, max(0, free - 4)), (free, side))
        # 3072 x 3072: 9.8 GiB were asked for 9.6 under the ceiling, and the creation failed. The weights now
        # leave what the steps need, and the ceiling its margin; with the card nearly free, nothing changes.
        self.assertLess(share(10.6, 3072), 6)
        self.assertLessEqual(share(10.6, 3072) + seedvr2.working_gib(3072, 3072), 10.6 - 1)
        self.assertEqual(share(11.4, 3072), 6)
        # 4096 x 4096: it lacked 1.5 GiB with 6 GiB of weights.
        self.assertTrue(3.5 < share(10.6, 4096) < 4.5, share(10.6, 4096))
        self.assertLessEqual(share(10.6, 4096) + seedvr2.working_gib(4096, 4096), 10.6 - 1)
        # 8192 x 8192 needs more than the card beside any weights: none stay, never less than none.
        self.assertEqual(share(10.6, 8192), 0)
        self.assertEqual(share(2.0, 1024), 0)
        # Never more than the share the settings give, and the largest pass decides for all of them.
        self.assertEqual(share(10.6, 2048, cache_gib=4), 4)
        self.assertEqual(seedvr2.share_gib(10.6, [(2048, 2048), (4096, 4096)]), share(10.6, 4096))
        self.assertEqual(seedvr2.share_gib(10.6, [(4096, 4096), (2048, 2048)]), share(10.6, 4096))

    def test_short_of_memory_the_steps_are_made_again_with_fewer_weights_on_the_card(self):
        import inspect

        from runner.pipelines import seedvr2

        # As it is first, then half of it, then none; with none already, nothing smaller to try.
        self.assertEqual(seedvr2.smaller_shares(6), [None, 3, 0])
        self.assertEqual(seedvr2.smaller_shares(3.95), [None, 1.975, 0])
        self.assertEqual(seedvr2.smaller_shares(0), [None])
        source = inspect.getsource(seedvr2.generate)
        # The share is read from the sizes of the passes, and the steps go through the ladder.
        self.assertIn("budget = share_gib(hardware.free_bytes(torch) / 1024**3, sizes, config.get('cacheGiB', 6))", source)
        self.assertIn('x = smaller([lambda share=share: sample(share) for share in smaller_shares(budget)], torch)', source)
        # Made again, they start from the noise of the seed of their pass, with the share asked.
        steps = source[source.index('def sample(') : source.index('x = smaller([lambda share=share')]
        self.assertIn('pool.resize(share)', steps)
        self.assertIn("torch.Generator('cuda').manual_seed(seed + index)", steps)
        self.assertNotIn('done +=', steps)


class SeedVR2RefusalTest(unittest.TestCase):
    """(0.6.449) An image the card cannot hold is refused before anything is loaded, in the user's words."""

    def asked(self, side, scale, free_gib):
        """What generate does of a square image of `side` enlarged by `scale` with `free_gib` free on the card:
        the error it raises before the VAE is loaded, or 'loaded' when it goes on to load it."""
        import tempfile
        from pathlib import Path
        from unittest import mock

        import torch
        from PIL import Image

        from runner import hardware
        from runner.models import seedvr2_vae
        from runner.pipelines import seedvr2

        class Loaded(Exception):
            pass

        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'source.png')
            Image.new('RGB', (side, side), (120, 90, 60)).save(path)
            job = dict(
                id='refusal',
                pipeline='seedvr2',
                parameters=dict(seed=1, scale=scale, passes=1, max_side=8192, steps=1, color_correction='lab'),
                components=dict(model='C:/model', vae='C:/vae'),
                loras=[],
                references=[dict(role='image', path=path)],
            )
            with (
                mock.patch.object(torch.cuda, 'is_available', return_value=True),
                mock.patch.object(torch.cuda, 'reset_peak_memory_stats', return_value=None),
                mock.patch.object(torch.cuda, 'memory_reserved', return_value=0),
                mock.patch.object(hardware, 'free_bytes', return_value=int(free_gib * 1024**3)),
                mock.patch.object(seedvr2_vae, 'load', side_effect=Loaded),
            ):
                try:
                    seedvr2.generate(job, dict(outputRoot=folder), lambda **data: None)
                except Loaded:
                    return 'loaded'
                except RuntimeError as error:
                    return str(error)
        return 'made'

    def test_an_image_the_card_cannot_hold_is_refused_at_once_with_what_to_do(self):
        # 8192 x 8192: about 17 GiB beside the weights. On 12 GiB the steps failed after a minute, twice.
        said = self.asked(512, 16, 11.4)
        self.assertRegex(said, r'^SeedVR2 demande environ 15,7 Go de mémoire vidéo libre pour cette création ; 11,4 Go')
        self.assertIn('réduisez la taille de l’image', said)
        # 5120 x 5120 was made with 11.4 GiB free (26/11), 4096 x 4096 too: never refused.
        self.assertEqual(self.asked(320, 16, 11.4), 'loaded')
        self.assertEqual(self.asked(256, 16, 10.6), 'loaded')
        # 6144 x 6144 fails in the steps, but the estimate is not sure enough to refuse it at once.
        self.assertEqual(self.asked(384, 16, 11.4), 'loaded')
        # A card with more room makes what this one refuses.
        self.assertEqual(self.asked(512, 16, 23.0), 'loaded')
        # A small image on a card almost full: refused too, where the steps had nothing to compute with.
        self.assertRegex(self.asked(128, 16, 1.0), r'^SeedVR2 demande environ 1,6 Go')


if __name__ == '__main__':
    unittest.main()
