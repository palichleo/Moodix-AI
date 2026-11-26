"""pi H3 (0.6.423): a step adapter of MiniMax's FL2VA. Which of its tensors go where, what it is refused
for, its schedule, the noise it starts from, and what its pixel head is given. On the processor."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from runner.models import minimax_h3
from runner.pipelines import minimax_h3 as pipeline

LAYERS = (('attn.out_proj', [5376, 7168]), ('mlp.fc1', [28672, 5376]), ('mlp.fc2', [5376, 14336]))
FINAL = (
    ('final_layer.norm.weight', [5376]),
    ('final_layer.adaln_proj.linear.weight', [10752, 8]),
    ('final_layer.adaln_proj.linear.bias', [10752]),
    ('final_layer.video_out.weight', [96, 5376]),
    ('final_layer.video_out.bias', [96]),
    ('final_layer.audio_out.weight', [32, 5376]),
    ('final_layer.audio_out.bias', [32]),
)


def shaped(*dimensions):
    return {'shape': list(dimensions)}


def base(blocks=3, heads=1, gates=False):
    """The header of a MiniMax-H3 checkpoint, a few blocks of it: what an adapter is checked against."""
    found = {'__metadata__': {}, 'adaln_t_table': shaped(1025, 8)}
    for index in range(blocks):
        stem = f'blocks.{index}.'
        found[stem + 'adaln_proj.linear.weight'] = shaped(96768, 8)
        found[stem + 'adaln_proj.linear.bias'] = shaped(96768)
        found[stem + 'attn.qkv_proj.weight'] = shaped(21504, 5376)
        for layer, shape in LAYERS:
            found[stem + layer + '.weight'] = shaped(*shape)
            found[stem + layer + '.weight_scale'] = shaped(shape[0], 1)
    for key, shape in FINAL:
        found[key] = shaped(*([shape[0] * heads, *shape[1:]] if '_out.' in key else shape))
    if gates:
        found['blocks.0.attn.to_gate_compress.weight'] = shaped(5376, 5376)
    return found


def adapter(blocks=3, rank=64):
    """The header of a pi H3 adapter for that model: LoRA pairs on all its blocks but the last, whose three
    layers it replaces; the AdaLN projection of each (its bias for the last alone); the final layer; and a
    pixel head."""
    found = {'__metadata__': {'policy_config': '{"image": {"mode": "grid", "type": "DX"}}'}}
    for index in range(blocks):
        stem = f'blocks.{index}.'
        found[stem + 'adaln_proj.linear.weight'] = shaped(96768, 8)
        for layer, (rows, columns) in LAYERS:
            if index < blocks - 1:
                found[stem + layer + '.lora_A.weight'] = shaped(rank, columns)
                found[stem + layer + '.lora_B.weight'] = shaped(rows, rank)
            else:
                found[stem + layer + '.weight'] = shaped(rows, columns)
                found[stem + layer + '.weight_scale'] = shaped(rows, 1)
                found[stem + layer + '.comfy_quant'] = shaped(72)
    found[f'blocks.{blocks - 1}.adaln_proj.linear.bias'] = shaped(96768)
    for key, shape in FINAL:
        found[key] = shaped(*shape)
    found['dwd_norm_out.linear.weight'] = shaped(10752, 8)
    found['dwd_pixel_refiner.proj_out.weight'] = shaped(3072, 2048)
    return found


class PiH3Weights(unittest.TestCase):
    def test_what_the_adapter_replaces_is_read_from_its_file_the_rest_from_the_models(self):
        mapping = minimax_h3.names(base(), adapter=adapter())
        told = lambda name: mapping[name][:2]  # noqa: E731
        # The AdaLN projection of every block; the three layers of the last one; the final layer.
        for index in range(3):
            key = f'blocks.{index}.adaln_proj.linear.weight'
            self.assertEqual(told(f'transformer_blocks.{index}.adaln_proj.linear.weight'), ('stepAdapter', key))
        last = 'transformer_blocks.2.'
        self.assertEqual(told(last + 'attn.to_out.0.weight'), ('stepAdapter', 'blocks.2.attn.out_proj.weight'))
        self.assertEqual(told('transformer_blocks.2.ff.net.0.proj.weight'), ('stepAdapter', 'blocks.2.mlp.fc1.weight'))
        self.assertEqual(told('transformer_blocks.2.ff.net.2.weight'), ('stepAdapter', 'blocks.2.mlp.fc2.weight'))
        for name, key in (
            ('norm_out.norm.weight', 'final_layer.norm.weight'),
            ('norm_out.linear.weight', 'final_layer.adaln_proj.linear.weight'),
            ('norm_out.linear.bias', 'final_layer.adaln_proj.linear.bias'),
            ('proj_out.weight', 'final_layer.video_out.weight'),
            ('audio_proj_out.bias', 'final_layer.audio_out.bias'),
        ):
            self.assertEqual(told(name), ('stepAdapter', key))
        # The layers it only adds a LoRA pair to stay the model's, as the attention's projection, which it
        # never touches; so does the bias it has none for.
        self.assertEqual(told('transformer_blocks.0.attn.to_out.0.weight'), ('model', 'blocks.0.attn.out_proj.weight'))
        self.assertEqual(told('transformer_blocks.2.attn.to_qkv.weight'), ('model', 'blocks.2.attn.qkv_proj.weight'))
        bias = 'adaln_proj.linear.bias'
        self.assertEqual(told('transformer_blocks.0.' + bias), ('model', 'blocks.0.' + bias))
        self.assertEqual(told(last + bias), ('stepAdapter', 'blocks.2.' + bias))
        # Neither its LoRA matrices, nor what is read beside a weight, nor its pixel head are parameters.
        apart = ('lora_', 'dwd_', 'comfy_quant')
        self.assertEqual({name for name in mapping if any(part in name for part in apart)}, set())
        self.assertEqual(len(minimax_h3.replaced(adapter())), 3 + 1 + 3 + 7)
        # Without one, as before.
        self.assertEqual(minimax_h3.names(base()), minimax_h3.names(base(), adapter=None))
        self.assertEqual({role for role, _key, _part in minimax_h3.names(base()).values()}, {'model'})

    def test_an_adapter_is_refused_unless_every_tensor_of_it_has_its_place_in_the_model(self):
        minimax_h3.validate_adapter(base(), adapter())
        # The real one, when it is on this computer: 544 tensors, each with its place in MiniMax's FL2VA.
        folder = Path('D:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/models')
        real = folder / 'loras' / 'pi_h3_4step_dwd_adapter_int8_convrot.safetensors'
        model = folder / 'diffusion_models' / 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
        if real.exists() and model.exists():
            from runner.models.headers import header

            minimax_h3.validate_adapter(header(model), header(real))
            self.assertEqual(len(minimax_h3.replaced(header(real))), 50 + 4 + 12 + 7)
        # A distilled model has its own steps.
        for distilled in (base(heads=32), base(gates=True)):
            with self.assertRaisesRegex(ValueError, 'de base \\(FL2VA\\).*distillé'):
                minimax_h3.validate_adapter(distilled, adapter())
        wrong = 'n’est pas un adaptateur pi H3'

        def refused(change):
            header = adapter()
            change(header)
            with self.assertRaisesRegex(ValueError, wrong):
                minimax_h3.validate_adapter(base(), header)

        # A pair of another shape than its layer, or of two ranks; a replaced tensor of another shape, or
        # that the model has not; a tensor that is nothing of all this; a scale without its weight.
        refused(lambda header: header.update({'blocks.0.mlp.fc1.lora_B.weight': shaped(5376, 64)}))
        refused(lambda header: header.update({'blocks.0.mlp.fc1.lora_A.weight': shaped(32, 5376)}))
        refused(lambda header: header.update({'blocks.1.adaln_proj.linear.weight': shaped(96768, 16)}))
        refused(lambda header: header.update({'blocks.7.adaln_proj.linear.weight': shaped(96768, 8)}))
        refused(lambda header: header.update({'something.else': shaped(4)}))
        refused(lambda header: header.update({'blocks.0.attn.out_proj.weight_scale': shaped(5376, 1)}))
        # No LoRA pair for this model at all (a LoRA of another model); several output heads; none.
        refused(lambda header: [header.pop(key) for key in list(header) if '.lora_' in key])
        refused(lambda header: header.update({'final_layer.video_out.weight': shaped(96 * 2, 5376)}))
        refused(lambda header: header.pop('final_layer.video_out.weight'))

    def test_an_adapter_tuned_on_another_model_of_the_same_shapes_is_told_by_its_values(self):
        try:
            import torch
            from safetensors.torch import save_file
        except ImportError:
            self.skipTest('torch is required')
        key = 'blocks.0.adaln_proj.linear.weight'
        generator = torch.Generator().manual_seed(7)
        own = torch.randn(64, 8, generator=generator)
        with tempfile.TemporaryDirectory() as folder:
            paths = {name: str(Path(folder) / (name + '.safetensors')) for name in ('fl2va', 'ref2va', 'small', 'pi')}
            save_file({key: own.half()}, paths['fl2va'])
            # Ref2VA: another basis for the curve table, the projections turned over (cosine -0.8 measured).
            save_file({key: (-0.8 * own + 0.6 * torch.randn(64, 8, generator=generator)).half()}, paths['ref2va'])
            save_file({key: own[:32].half()}, paths['small'])
            # The adapter: the model's own, barely moved (cosine 0.993 to 1.000 measured).
            save_file({key: (own + 0.05 * torch.randn(64, 8, generator=generator)).half()}, paths['pi'])
            self.assertTrue(minimax_h3.fits_base(paths['fl2va'], paths['pi']))
            self.assertFalse(minimax_h3.fits_base(paths['ref2va'], paths['pi']))
            self.assertFalse(minimax_h3.fits_base(paths['small'], paths['pi']))

    def test_the_job_is_refused_before_the_creation_and_takes_the_steps_of_its_adapter(self):
        job = lambda **components: dict(  # noqa: E731
            parameters=dict(steps=20), references=[], components=dict(model='fl2va.safetensors', **components)
        )
        # Without an adapter: nothing is read, nothing changes.
        self.assertIsNone(pipeline.check_adapter(job(), base()))
        self.assertIsNone(pipeline.adapter_path(job(stepAdapter='')))
        self.assertEqual(pipeline.check_steps(job(), base()), 20)
        checked = []
        from runner.models import headers, minimax_h3_dwd

        with (
            mock.patch.object(headers, 'header', lambda path: adapter()),
            mock.patch.object(minimax_h3_dwd, 'validate', lambda header: checked.append('head')),
            mock.patch.object(
                minimax_h3, 'fits_base', lambda model, tuned: checked.append((model, tuned)) or tuned != 'other'
            ),
        ):
            found = pipeline.check_adapter(job(stepAdapter='pi_h3_4step.safetensors'), base())
            self.assertEqual(found, adapter())
            self.assertEqual(checked, ['head', ('fl2va.safetensors', 'pi_h3_4step.safetensors')])
            with self.assertRaisesRegex(ValueError, 'fait pour le modèle MiniMax H3 de base \\(FL2VA\\).*Ref2VA'):
                pipeline.check_adapter(job(stepAdapter='other'), base())
            with self.assertRaisesRegex(ValueError, 'distillé'):
                pipeline.check_adapter(job(stepAdapter='pi_h3_4step.safetensors'), base(gates=True))
        # Its steps are the adapter's, whatever the job asks: nothing to choose.
        real = 'pi_h3_4step_dwd_adapter_int8_convrot.safetensors'
        self.assertEqual(pipeline.check_steps(job(stepAdapter=real), base()), 4)
        self.assertEqual(pipeline.check_steps(job(stepAdapter='x/pi_h3_2step_dwd_adapter.safetensors'), base()), 2)
        for name, steps in (('adapter.safetensors', 4), ('pi-8-steps.safetensors', 8), ('pi_1step.safetensors', 4)):
            self.assertEqual(pipeline.adapter_steps(name), steps, name)
        self.assertEqual(pipeline.adapter_steps('v2_footsteps.safetensors'), 4)

    def test_a_model_built_with_an_adapter_is_kept_for_that_adapter_only(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest('torch is required')
        from runner.models import kept

        keys = []

        def run(_job, _config, _progress, key, holder):
            keys.append(key)
            pool = SimpleNamespace(gpu={1: 1})
            holder[0] = holder[0] or SimpleNamespace(key=key, locked=True, pool=pool, drop=lambda: 0)
            return 'video'

        def job(**components):
            parameters = dict(width=768, height=448, frames=124)
            return dict(components=dict(model='fl2va', **components), loras=[], references=[], parameters=parameters)

        with (
            mock.patch('runner.models.conditioning.stamp', side_effect=lambda path: [path, 1, 1]),
            mock.patch.object(pipeline, '_generate', run),
        ):
            try:
                pipeline.generate(job(), {}, None)
                pipeline.generate(job(stepAdapter='pi4'), {}, None)
                pipeline.generate(job(stepAdapter='pi2'), {}, None)
            finally:
                kept._kept.clear()
        self.assertEqual([len(key) for key in keys], [3, 4, 4])
        self.assertEqual([key[3][0] for key in keys[1:]], ['pi4', 'pi2'])
        self.assertEqual(len({str(key) for key in keys}), 3)


class PiH3Sampling(unittest.TestCase):
    def test_the_schedule_is_the_models_on_the_grid_of_pi_h3(self):
        # The values of ComfyUI-piFlow's scheduler for 4 steps (max 0.96, last step 0.6), shifts 12 and 3.
        video, sound = pipeline.pi_sigmas(4, 12.0), pipeline.pi_sigmas(4, 3.0)
        tables = ((video, (0.996540, 0.964451, 0.899297, 0.695652)), (sound, (0.986301, 0.871508, 0.690647, 0.363636)))
        for found, expected in tables:
            self.assertEqual(len(found), 5)
            self.assertEqual(found[-1], 0.0)
            for value, wanted in zip(found, expected):
                self.assertAlmostEqual(value, wanted, places=6)
        # In two steps the grid starts lower (0.93).
        two = pipeline.pi_sigmas(2, 12.0), pipeline.pi_sigmas(2, 3.0)
        short = ((two[0], (0.993767, 0.865340)), (two[1], (0.975524, 0.616348)))
        for found, expected in short:
            self.assertEqual(len(found), 3)
            for value, wanted in zip(found, expected):
                self.assertAlmostEqual(value, wanted, places=6)
        # The raw grid: equal steps, the last one 0.6 times as long.
        unshift = lambda sigma: sigma / (12.0 - 11.0 * sigma)  # noqa: E731
        raw = [unshift(value) for value in video]
        for value, wanted in zip(raw, (0.96, 0.693333, 0.426667, 0.16, 0.0)):
            self.assertAlmostEqual(value, wanted, places=6)
        self.assertAlmostEqual((raw[3] - raw[4]) / (raw[0] - raw[1]), 0.6, places=6)

    def test_the_block_of_the_library_is_given_that_grid_whatever_it_asks(self):
        try:
            import torch
            from diffusers import MiniMaxH3Scheduler
        except ImportError:
            self.skipTest('diffusers is required')
        scheduler = pipeline.pi_scheduler(12.0, 4)
        self.assertIsInstance(scheduler, MiniMaxH3Scheduler)
        # (The block asks for the steps and one: the final 0.)
        scheduler.set_timesteps(5, device='cpu')
        self.assertEqual(scheduler.num_inference_steps, 4)
        self.assertTrue(torch.allclose(scheduler.sigmas, torch.tensor(pipeline.pi_sigmas(4, 12.0))))
        self.assertTrue(torch.allclose(scheduler.timesteps, 1 - torch.tensor(pipeline.pi_sigmas(4, 12.0)[:-1])))
        plain = MiniMaxH3Scheduler(shift=12.0)
        plain.set_timesteps(5, device='cpu')
        self.assertFalse(torch.allclose(scheduler.sigmas, plain.sigmas), 'not the grid from 1 to 0')
        sound = pipeline.pi_scheduler(3.0, 4)
        sound.set_timesteps(21)
        self.assertTrue(torch.allclose(sound.sigmas, torch.tensor(pipeline.pi_sigmas(4, 3.0))))
        # Its steps are the library's: from the first sigma to the second, towards what the model says.
        sample, velocity = torch.full((2, 3), 0.5), torch.full((2, 3), 2.0)
        after = scheduler.step(velocity, scheduler.timesteps[0], sample, return_dict=False)[0]
        first, second = pipeline.pi_sigmas(4, 12.0)[:2]
        clean = sample + first * velocity
        self.assertTrue(torch.allclose(after, clean + second / first * (sample - clean), atol=1e-5))

    def test_the_noise_is_the_blocks_own_draws_at_the_level_the_grid_starts_from(self):
        try:
            import torch
            from diffusers.utils.torch_utils import randn_tensor
        except ImportError:
            self.skipTest('diffusers is required')
        parameters = dict(width=768, height=448, frames=124)
        made = pipeline.pi_noise(parameters, torch.Generator('cpu').manual_seed(11), (0.9965, 0.9863), device='cpu')
        # As the block takes them: (1, 24, latent frames, latent rows, latent columns) and (2, 32, latents).
        self.assertEqual(tuple(made['latents'].shape), (1, 24, 37, 28, 48))
        self.assertEqual(tuple(made['audio_latents'].shape), (2, 32, 207))
        # The same draws as the block's, in its order: the video, then the sound in rows, channel-major.
        generator = torch.Generator('cpu').manual_seed(11)
        video = randn_tensor((1, 24, 37, 28, 48), generator=generator, device=torch.device('cpu'), dtype=torch.float32)
        rows = randn_tensor((207 * 2, 32), generator=generator, device=torch.device('cpu'), dtype=torch.float32)
        self.assertTrue(torch.equal(made['latents'], video * 0.9965))
        self.assertTrue(torch.equal(made['audio_latents'].permute(0, 2, 1).reshape(-1, 32), rows * 0.9863))
        self.assertAlmostEqual(float(made['latents'].std()), 0.9965, places=2)
        # A longer video: its latents, and those of its sound.
        long = dict(width=1344, height=768, frames=345)
        longer = pipeline.pi_noise(long, torch.Generator('cpu'), (1.0, 1.0), device='cpu')
        self.assertEqual(tuple(longer['latents'].shape), (1, 24, 102, 48, 84))
        self.assertEqual(tuple(longer['audio_latents'].shape), (2, 32, 575))

    def test_the_pixel_head_is_given_the_rows_of_the_generated_video_at_the_last_step(self):
        try:
            import torch
        except ImportError:
            self.skipTest('torch is required')

        class Norm(torch.nn.Module):
            def forward(self, hidden_states, temb, timestep_indices):
                return hidden_states * 0

        class Model(torch.nn.Module):
            """The end of the DiT as the library writes it: the blocks, then the final norm over every row,
            called with the rows, the embedding of each time and the time of each row."""

            def __init__(self):
                super().__init__()
                self.norm_out = Norm()

            def forward(self, hidden_states=None, timestep=None, timestep_indices=None, video_indices=None):
                rows = torch.arange(10, dtype=torch.float32)[None, :, None] * 10 + hidden_states
                return self.norm_out(rows, timestep[:, None] * 2, timestep_indices)

        dit, calls, held = Model(), {'step': 0}, {}
        hooks = pipeline.keep_last_rows(dit, calls, 4, 3, held)
        # The packed sequence: text, then the video (a condition of 2 rows, then 3 generated ones) at rows
        # 4 to 8 in another order than the sequence's, the sound last. Each row with the time of its kind.
        values = dict(
            timestep=torch.tensor([0.25, 0.5]),
            timestep_indices=torch.tensor([0, 0, 0, 0, 1, 1, 0, 0, 0, 0]),
            video_indices=torch.tensor([4, 5, 8, 6, 7]),
        )
        for step in range(4):
            calls['step'] = step
            dit(hidden_states=torch.full((1, 10, 2), float(step)), **values)
            if step < 3:
                self.assertIsNone(held.get('hidden'), 'nothing is kept before the last step')
        # The generated rows, in the order of the video's tokens (8, 6, 7), as the blocks left them.
        self.assertEqual(held['hidden'].tolist(), [[83.0, 83.0], [63.0, 63.0], [73.0, 73.0]])
        self.assertEqual(held['indices'].tolist(), [0, 0, 0])
        self.assertEqual(held['temb'].tolist(), [[0.5], [1.0]])
        # A copy: what the model does to its rows afterwards does not reach it.
        self.assertEqual(tuple(held['hidden'].shape), (3, 2))
        # The rows a continuation protects carry their own time: the head is told row by row.
        values['timestep_indices'] = torch.tensor([0, 0, 0, 0, 1, 1, 0, 0, 1, 0])
        dit(hidden_states=torch.zeros(1, 10, 2), **values)
        self.assertEqual(held['indices'].tolist(), [1, 0, 0])
        for hook in hooks:
            hook.remove()
        held.clear()
        dit(hidden_states=torch.zeros(1, 10, 2), **values)
        self.assertEqual(held, {})


if __name__ == '__main__':
    unittest.main()
