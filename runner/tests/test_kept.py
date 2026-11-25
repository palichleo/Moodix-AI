"""What a pipeline leaves on the card for its next generation (runner.models.kept)."""

import unittest
from unittest import mock

import torch

from runner.models import kept


class Left:
    """A model left on the card for the generations made with `key`."""

    def __init__(self, key, dropped):
        self.key, self.dropped = key, dropped

    def drop(self):
        self.dropped.append(self.key)


class TakeTests(unittest.TestCase):
    def tearDown(self):
        kept._kept.clear()

    def test_a_model_dropped_for_another_one_goes_back_to_the_driver(self):
        # (0.6.273) Dropped, its share stayed in PyTorch's reserve: the encoder of the next prompt,
        # which sizes its share by what the driver says is free, streamed what it could have kept.
        dropped, emptied = [], []
        with (
            mock.patch.object(torch.cuda, 'is_initialized', return_value=True),
            mock.patch.object(torch.cuda, 'empty_cache', lambda: emptied.append(True)),
        ):
            kept.put('qwen_image_edit', Left('angles at 1', dropped))
            # Asked again with the same files and strengths: taken back, nothing given back.
            found = kept.take('qwen_image_edit', 'angles at 1')
            self.assertEqual((found.key, dropped, emptied), ('angles at 1', [], []))
            kept.put('qwen_image_edit', found)
            # Asked with its LoRA at another strength: dropped, what it held given back to the driver.
            self.assertIsNone(kept.take('qwen_image_edit', 'angles at 0.8'))
            self.assertEqual((dropped, emptied, kept._kept), (['angles at 1'], [True], {}))
            # Another family's model left there: dropped and given back the same way.
            kept.put('ltx25', Left('a video', dropped))
            self.assertIsNone(kept.take('qwen_image_edit', 'angles at 0.8'))
            self.assertEqual((dropped[-1], emptied), ('a video', [True, True]))
            # Nothing left: nothing to give back.
            self.assertIsNone(kept.take('qwen_image_edit', 'angles at 0.8'))
            self.assertEqual(emptied, [True, True])

    def test_without_a_card_nothing_is_asked_of_it(self):
        dropped = []
        with mock.patch.object(torch.cuda, 'is_initialized', return_value=False), mock.patch.object(
            torch.cuda, 'empty_cache', side_effect=AssertionError('no card to give back to')
        ):
            kept.put('qwen_image_edit', Left('angles at 1', dropped))
            self.assertIsNone(kept.take('qwen_image_edit', 'angles at 0.8'))
        self.assertEqual(dropped, ['angles at 1'])


if __name__ == '__main__':
    unittest.main()
