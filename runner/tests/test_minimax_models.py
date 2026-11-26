"""MiniMax-H3: which file a job reads, and in how many steps (0.6.108)."""

import unittest

from runner.pipelines import minimax_h3 as pipeline
from runner.registry import family


def _header(heads=1, gates=False):
    """What tells the checkpoints apart, as their files say it."""
    found = {
        'final_layer.video_out.weight': {'shape': [96 * heads, 5376]},
        'final_layer.audio_out.weight': {'shape': [32 * heads, 5376]},
    }
    if gates:
        found['blocks.0.attn.to_gate_compress.weight'] = {'shape': [5376, 5376]}
    return found


def _job(roles=(), steps=None, **components):
    parameters = {} if steps is None else {'steps': steps}
    return dict(
        parameters=parameters,
        components=dict(model='fl2va.safetensors', **components),
        references=[dict(role=role, path=role + '.png') for role in roles],
    )


class MiniMaxModels(unittest.TestCase):
    def test_a_checkpoint_says_whether_it_is_distilled(self):
        # FastH3 Omni: 32 output heads. FastH3 v2: one head, and the gates of its sparse attention.
        self.assertEqual(pipeline.steps_of(_header(heads=32, gates=True)), 8)
        self.assertEqual(pipeline.steps_of(_header(gates=True)), 8)
        # MiniMax's own FL2VA and Ref2VA: neither. (0.6.418) Nor a distilled one merged into plain
        # weights: a file without those marks says nothing of its steps.
        self.assertIsNone(pipeline.steps_of(_header()))

    def test_a_checkpoint_that_says_its_steps_refuses_others_one_that_says_none_takes_the_asked_0_6_418(self):
        self.assertEqual(pipeline.check_steps(_job(steps=20), _header()), 20)
        self.assertEqual(pipeline.check_steps(_job(steps=8), _header(heads=32, gates=True)), 8)
        # A job that does not say (an older record): the checkpoint's own, 20 for one that says nothing.
        self.assertEqual(pipeline.check_steps(_job(), _header()), 20)
        self.assertEqual(pipeline.check_steps(_job(), _header(gates=True)), 8)
        # A file without marks, in the steps its version asks: a distilled one merged into plain weights
        # (8), one computed with a step adapter (4). It was refused: « il se calcule en 20 étapes, pas en 8 ».
        self.assertEqual(pipeline.check_steps(_job(steps=8), _header()), 8)
        self.assertEqual(pipeline.check_steps(_job(steps=4), _header()), 4)
        # One that carries the marks of its distillation is still computed in its own.
        with self.assertRaisesRegex(ValueError, 'distillé.*8 étapes, pas en 20.*Réglez ses étapes sur 8'):
            pipeline.check_steps(_job(steps=20), _header(gates=True))
        with self.assertRaisesRegex(ValueError, 'distillé.*8 étapes, pas en 4'):
            pipeline.check_steps(_job(steps=4), _header(heads=32, gates=True))

    def test_reference_images_are_read_by_the_file_the_workflow_names_for_them(self):
        both = dict(referenceModel='ref2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['reference_image'], **both)), 'ref2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['reference_image', 'reference_image'], **both)), 'ref2va.safetensors')
        # A text alone, start and end images, a video to continue: the model's own file.
        self.assertEqual(pipeline.model_path(_job([], **both)), 'fl2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['start_image', 'end_image'], **both)), 'fl2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['source_video'], **both)), 'fl2va.safetensors')
        # A workflow with one file (FastH3 Omni reads everything): that file.
        self.assertEqual(pipeline.model_path(_job(['reference_image'])), 'fl2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['reference_image'], referenceModel='')), 'fl2va.safetensors')

    def test_a_subject_no_model_of_the_job_takes_is_refused_before_the_creation(self):
        # (0.6.373) Said once the creation had begun, after the chat model was unloaded for it.
        from unittest import mock

        from runner.models import headers, minimax_h3

        base, omni = _header(), dict(_header(heads=32, gates=True), __metadata__={'source': 'transformer_ref'})
        subject = _job(['reference_image'])
        with self.assertRaisesRegex(ValueError, 'ne prend pas de sujet.*Modèle pour les sujets'):
            pipeline.check_subject(subject, base)
        # FastH3 Omni takes it; so does the file the workflow names for the subjects; without one, nothing to say.
        self.assertIsNone(pipeline.check_subject(subject, omni))
        self.assertIsNone(pipeline.check_subject(_job(['reference_image'], referenceModel='ref2va.safetensors'), base))
        for roles in ([], ['start_image', 'end_image'], ['source_video']):
            self.assertIsNone(pipeline.check_subject(_job(roles), base))
        # The check made before the chat model is unloaded says it, before the card is asked anything.
        asked = []
        with (
            mock.patch.object(headers, 'header', lambda path: asked.append(path) or base),
            mock.patch.object(minimax_h3, 'validate', lambda header: None),
            mock.patch.object(pipeline, 'too_large', lambda *args: self.fail('refused before the size is weighed')),
        ):
            with self.assertRaisesRegex(ValueError, 'ne prend pas de sujet'):
                pipeline.preflight(subject, {})
        self.assertEqual(asked, ['fl2va.safetensors'])

    def test_the_family_takes_both_step_counts_and_an_optional_second_file(self):
        manifest = family('minimax_h3')
        # (0.6.419) Each version of the model has its steps, any count: no list of two.
        steps = manifest['parameters']['steps']
        self.assertEqual((steps.get('choices'), steps['min'], steps['max']), (None, 1, 60))
        second = manifest['components']['referenceModel']
        self.assertFalse(second['required'])
        self.assertEqual(second['folder'], 'diffusion_models')
        self.assertEqual(second['signature'], manifest['components']['model']['signature'])


if __name__ == '__main__':
    unittest.main()
