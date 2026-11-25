import unittest
from types import SimpleNamespace
from unittest import mock


class KeptModelTests(unittest.TestCase):
    """MiniMax H3 leaves its model on the card for the next video, as LTX 2.5 does (0.6.80)."""

    def job(self, width=768, references=(), **parameters):
        parameters = dict(width=width, height=448, frames=124, **parameters)
        return dict(components={'model': 'model'}, loras=[], references=list(references), parameters=parameters)

    def test_the_model_left_is_taken_back_for_the_same_video_only_and_dropped_when_it_is_no_use(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest('torch is required')
        from runner.models import kept
        from runner.pipelines import minimax_h3 as pipeline

        given, dropped = [], []

        def run(_job, _config, _progress, key, holder):
            given.append(holder[0])
            if holder[0] is None:
                width = key[1][0]
                holder[0] = SimpleNamespace(
                    key=key,
                    # RAM was short for the one of 1344: its steps copied from the file's mapping.
                    locked=width != 1344,
                    # The decode of the one of 1920 did not fit beside the share: it left whole.
                    pool=SimpleNamespace(gpu={} if width == 1920 else {'layer': 1}),
                    allocated=0,
                    drop=lambda: dropped.append(width),
                )
            return 'video'

        with (
            mock.patch('runner.models.conditioning.stamp', side_effect=lambda path: [path, 1, 1]),
            mock.patch.object(pipeline, '_generate', run),
        ):
            try:
                self.assertEqual(pipeline.generate(self.job(), {}, None), 'video')
                first = kept._kept['minimax_h3']
                self.assertEqual(pipeline.generate(self.job(), {}, None), 'video')
                self.assertEqual((given, dropped), ([None, first], []))
                # Another size, an image to start from, another attention: the model is built for
                # them, so the one left is not taken back.
                pipeline.generate(self.job(width=832), {}, None)
                pipeline.generate(self.job(width=832, references=[{'role': 'start_image'}]), {}, None)
                sparse = self.job(width=832, references=[{'role': 'start_image'}], sparse_attention='vsa')
                pipeline.generate(sparse, {}, None)
                self.assertEqual((given[2:], dropped), ([None, None, None], [768, 832, 832]))
                # A failure leaves nothing for the next video.
                with mock.patch.object(pipeline, '_generate', side_effect=RuntimeError('out of memory')):
                    with self.assertRaises(RuntimeError):
                        job = self.job(width=832, references=[{'role': 'start_image'}], sparse_attention='vsa')
                        pipeline.generate(job, {}, None)
                self.assertEqual((dropped[3:], kept._kept), ([832], {}))
                # Not kept: a model whose steps copied from unlocked memory, nor one whose share left.
                pipeline.generate(self.job(width=1344), {}, None)
                pipeline.generate(self.job(width=1920), {}, None)
                self.assertEqual((dropped[4:], kept._kept), ([1344, 1920], {}))
            finally:
                kept._kept.clear()

    def test_what_is_left_closes_its_file_whatever_the_card_answers(self):
        from runner.pipelines import minimax_h3 as pipeline

        loaded, closed = pipeline.Loaded('key'), []
        loaded.stack.callback(lambda: closed.append(True))

        def clear():
            raise RuntimeError('CUDA error')

        loaded.pool, loaded.dit = SimpleNamespace(clear=clear), object()
        with self.assertRaises(RuntimeError):
            loaded.drop()
        self.assertEqual((closed, loaded.pool, loaded.dit), ([True], None, None))

    def test_the_conditioner_is_closed_once_a_prompt_is_encoded_whatever_happened(self):
        # (0.6.371) An encoding that failed left its store open: a thread asleep with up to 1 GiB of the file,
        # the file held under Windows, or 14.6 GiB of locked RAM that nothing gave back.
        import weakref

        from runner.models import minimax_h3_text
        from runner.pipelines import minimax_h3 as pipeline

        class Model:
            pass

        told = []

        def load(path):
            model = Model()
            alive = weakref.ref(model)
            # (Its store says, when it is closed, whether the model that reads it is still there.)
            return model, SimpleNamespace(close=lambda: told.append((path, alive() is not None)))

        with mock.patch.object(minimax_h3_text, 'load', load):
            with self.assertRaisesRegex(RuntimeError, 'out of memory'):
                with pipeline._conditioner('conditioner.safetensors') as (text_encoder, store):
                    del text_encoder
                    raise RuntimeError('CUDA out of memory')
            self.assertEqual(told, [('conditioner.safetensors', False)])
            # As it always was when the prompt is encoded: the model first, then the store it reads, once.
            with pipeline._conditioner('conditioner.safetensors') as (text_encoder, store):
                del text_encoder
            self.assertEqual(told, [('conditioner.safetensors', False)] * 2)

    def test_a_conditioner_that_cannot_be_made_of_its_file_closes_the_file(self):
        # (0.6.371) A wrong file (a tensor it lacks): opened, then left open until the engine stopped.
        from runner.models import minimax_h3_text, residency

        closed = []

        def missing(key):
            raise KeyError(key)

        store = SimpleNamespace(keys=lambda: [], get_tensor=missing, close=lambda: closed.append(True))
        with mock.patch.object(residency, 'open_store', lambda path, **options: store):
            with self.assertRaises(KeyError):
                minimax_h3_text.load('wrong.safetensors')
        self.assertEqual(closed, [True])

    def test_the_kind_of_the_model_a_take_says_is_never_written_over(self):
        # (0.6.372) Read from the header of the model, then said in what the take keeps of itself (`model`):
        # a loop that put back a prompt kept on the disk used the same name for something else.
        import ast
        import inspect

        from runner.pipelines import minimax_h3 as pipeline

        tree = ast.parse(inspect.getsource(pipeline._generate))
        bound = [
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.Name) and node.id == 'kind' and isinstance(node.ctx, ast.Store)
        ]
        self.assertEqual(len(bound), 1, 'the kind of the model is given its value once in a creation')
        said = [
            keyword
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            for keyword in node.keywords
            if keyword.arg == 'model' and isinstance(keyword.value, ast.Name) and keyword.value.id == 'kind'
        ]
        self.assertEqual(len(said), 1, 'and it is what the take says of its model')

    def test_the_decode_asks_for_its_decoder_and_more_for_a_larger_picture(self):
        from runner.pipelines.minimax_h3 import decode_gib

        small, large = decode_gib(dict(width=768, height=448)), decode_gib(dict(width=1344, height=768))
        # Measured with the audio VAE beside the decoder: 5.4 and 6.0 GiB (17/11).
        self.assertTrue(5.3 < small < 5.7 and 5.9 < large < 6.3, (small, large))


if __name__ == '__main__':
    unittest.main()
