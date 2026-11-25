import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from runner.protocol import serve


class ProtocolTests(unittest.TestCase):
    def test_release_clears_pytorch_blas_workspace_before_ack(self):
        from runner.engine import release

        calls = []
        cuda = SimpleNamespace(
            is_initialized=lambda: True,
            synchronize=lambda: calls.append('sync'),
            empty_cache=lambda: calls.append('empty'),
            memory_allocated=lambda: 0 if 'blas' in calls else 8519680,
        )
        torch = SimpleNamespace(cuda=cuda, _C=SimpleNamespace(_cuda_clearCublasWorkspaces=lambda: calls.append('blas')))
        with patch.dict(sys.modules, torch=torch):
            self.assertEqual(release(), dict(released=True, allocatedGiB=0))
        self.assertLess(calls.index('sync'), calls.index('blas'))

    def test_release_gives_back_the_workspace_comfy_kitchen_keeps_for_its_products(self):
        from runner.engine import release

        # 4 MiB a card, kept by the library once a product went through cuBLAS (seen with the
        # small matrices of a test): left there, the card was said not to be empty.
        kitchen = SimpleNamespace(_cublas_workspaces={0: 'four mebibytes'})
        calls = []
        cuda = SimpleNamespace(
            is_initialized=lambda: True,
            synchronize=lambda: None,
            empty_cache=lambda: calls.append(dict(kitchen._cublas_workspaces)),
            memory_allocated=lambda: 4194304 if kitchen._cublas_workspaces else 0,
        )
        torch = SimpleNamespace(cuda=cuda, _C=SimpleNamespace())
        with patch.dict(sys.modules, {'torch': torch, 'comfy_kitchen.backends.cuda': kitchen}):
            self.assertEqual(release(), dict(released=True, allocatedGiB=0))
        # (Before the cache is emptied: its memory goes back to the driver with the rest.)
        self.assertEqual(calls, [{}])
        # A library that has none, or was never imported, changes nothing.
        for module in (SimpleNamespace(), None):
            modules = {'torch': torch} if module is None else {'torch': torch, 'comfy_kitchen.backends.cuda': module}
            with patch.dict(sys.modules, modules):
                if module is None:
                    sys.modules.pop('comfy_kitchen.backends.cuda', None)
                kitchen._cublas_workspaces.clear()
                self.assertEqual(release(), dict(released=True, allocatedGiB=0))

    def test_release_gives_back_the_rotation_matrix_comfy_kitchen_keeps_on_the_card(self):
        from runner.engine import release

        # (0.6.134) 64 x 64 values for the weights of Wan 2.2, rotated by groups of 64: 8 KiB kept
        # by the library, and the first real video ended on « GPU cleanup incomplete ».
        utils = SimpleNamespace(_HADAMARD_CACHE={(64, 'cuda:0', 'bfloat16'): 'eight kibibytes'})
        calls = []
        cuda = SimpleNamespace(
            is_initialized=lambda: True,
            synchronize=lambda: None,
            empty_cache=lambda: calls.append(dict(utils._HADAMARD_CACHE)),
            memory_allocated=lambda: 8192 if utils._HADAMARD_CACHE else 0,
        )
        torch = SimpleNamespace(cuda=cuda, _C=SimpleNamespace())
        with patch.dict(sys.modules, {'torch': torch, 'comfy_kitchen.tensor.int8_utils': utils}):
            self.assertEqual(release(), dict(released=True, allocatedGiB=0))
        self.assertEqual(calls, [{}])
        # A library without that cache, or never imported, changes nothing.
        with patch.dict(sys.modules, {'torch': torch, 'comfy_kitchen.tensor.int8_utils': SimpleNamespace()}):
            self.assertEqual(release(), dict(released=True, allocatedGiB=0))
        with patch.dict(sys.modules, {'torch': torch}):
            sys.modules.pop('comfy_kitchen.tensor.int8_utils', None)
            self.assertEqual(release(), dict(released=True, allocatedGiB=0))

    def _engine_torch(self, free_gib=10):
        fractions = []
        cuda = SimpleNamespace(
            is_available=lambda: True,
            mem_get_info=lambda: (free_gib * 1024**3, 12 * 1024**3),
            memory_reserved=lambda: 0,
            set_per_process_memory_fraction=fractions.append,
            empty_cache=lambda: fractions.append('empty'),
        )
        return SimpleNamespace(cuda=cuda, OutOfMemoryError=type('OutOfMemoryError', (RuntimeError,), {})), fractions

    def _generate(self, torch, attempt):
        from runner import engine

        module = SimpleNamespace(generate=attempt)
        with (
            patch.dict(sys.modules, torch=torch),
            patch.object(engine, 'preflight', lambda job, config: None),
            patch.object(engine, 'validate_config', lambda config: config),
            patch.object(engine, 'pipeline', lambda name: module),
        ):
            return engine.generate({'pipeline': 'any'}, {}, lambda **_: None)

    def test_generation_keeps_pytorch_inside_the_free_video_memory(self):
        torch, fractions = self._engine_torch()
        seen = []
        self.assertEqual(self._generate(torch, lambda *_: seen.append(list(fractions)) or 'video'), 'video')
        self.assertEqual(seen, [[9 / 12]])  # what is free less 1 GiB, while the pipeline runs
        self.assertEqual(fractions, [9 / 12, 1.0])

    def test_generation_that_needs_more_runs_again_without_the_ceiling(self):
        torch, fractions = self._engine_torch()
        attempts = []

        def attempt(*_):
            attempts.append(fractions[-1])
            if len(attempts) == 1:
                raise torch.OutOfMemoryError('CUDA out of memory')
            return 'video'

        self.assertEqual(self._generate(torch, attempt), 'video')
        self.assertEqual(attempts, [9 / 12, 'empty'])
        self.assertEqual(fractions, [9 / 12, 1.0, 'empty'])

    def test_other_failures_lift_the_ceiling_and_are_not_retried(self):
        torch, fractions = self._engine_torch()
        attempts = []

        def attempt(*_):
            attempts.append(1)
            raise ValueError('bad prompt')

        with self.assertRaises(ValueError):
            self._generate(torch, attempt)
        self.assertEqual((len(attempts), fractions), (1, [9 / 12, 1.0]))

    def test_no_ceiling_when_little_video_memory_is_free(self):
        torch, fractions = self._engine_torch(free_gib=3)
        self.assertEqual(self._generate(torch, lambda *_: 'image'), 'image')
        self.assertEqual(fractions, [])

    def test_ready_errors_recovery_and_shutdown_without_heavy_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(
                json.dumps({k: str(Path(directory) / k) for k in ('tokenizerPath', 'cacheRoot', 'outputRoot')})
            )
            code = 'import sys;sys.path.insert(0,sys.argv.pop(1));from runner.__main__ import main;main()'
            result = subprocess.run(
                [sys.executable, '-c', code, str(Path.cwd()), '--config', str(config)],
                input='bad json\n{"id":"a","method":"diagnostics","params":{}}\n'
                '{"id":"b","method":"release","params":{}}\n'
                '{"id":"c","method":"shutdown","params":{}}\n',
                text=True,
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(rows[0]['event'], 'ready')
            self.assertEqual(rows[0]['protocol'], 1)
            self.assertIsInstance(rows[0]['capabilities']['ltx25']['ready'], bool)
            self.assertEqual(rows[0]['capabilities']['ltx25']['mediaType'], 'video')
            self.assertIn('error', rows[1])
            self.assertFalse(rows[2]['result']['cudaInitialized'])
            self.assertFalse(rows[2]['result']['torchImported'])
            self.assertEqual(rows[3]['result'], dict(released=True, allocatedGiB=0))

    def test_nothing_printed_between_two_requests_reaches_the_pipe_of_the_protocol(self):
        # (0.6.359) The output was turned aside for one request at a time. What the libraries are imported by
        # goes on between them (runner.warm): one that prints as it is imported wrote a line that is not JSON,
        # and the application stops the engine on it (« Protocole Python : JSON invalide »).
        from runner import warm

        source = io.StringIO('{"id":1,"method":"release","params":{}}\n{"id":2,"method":"release","params":{}}\n')
        pipe, errors = io.StringIO(), io.StringIO()
        waited = warm.await_input

        def between(reading):
            print('hello again')
            return waited(reading)

        with (
            patch('sys.stdout', pipe),
            patch('sys.stderr', errors),
            patch('runner.protocol.release', lambda **_: dict(released=True, allocatedGiB=0)),
            patch.object(warm, 'await_input', between),
        ):
            serve({}, source)
            # Its standard output is given back once it ends.
            self.assertIs(sys.stdout, pipe)
        rows = [json.loads(line) for line in pipe.getvalue().splitlines()]
        self.assertEqual([row.get('id', row.get('event')) for row in rows], ['ready', 1, 2])
        self.assertEqual(errors.getvalue().count('hello again'), 3)

    def test_what_is_written_to_the_standard_output_of_the_process_never_reaches_the_application(self):
        # (0.6.359) C code and the programs the engine starts (a compiler) write to the descriptor 1 itself,
        # which no `sys.stdout` covers: the protocol keeps the pipe under a descriptor of its own.
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(
                json.dumps({k: str(Path(directory) / k) for k in ('tokenizerPath', 'cacheRoot', 'outputRoot')})
            )
            code = (
                'import os,subprocess,sys;sys.path.insert(0,sys.argv.pop(1));'
                'import runner.protocol as protocol;real=protocol.diagnostics\n'
                'def noisy(config):\n'
                '    os.write(1, b"from the descriptor\\n")\n'
                '    subprocess.run([sys.executable, "-c", "print(\'from a program started\')"], check=True)\n'
                '    return real(config)\n'
                'protocol.diagnostics=noisy\n'
                'print("before it serves")\n'
                'from runner.__main__ import main;main()'
            )
            result = subprocess.run(
                [sys.executable, '-u', '-c', code, str(Path.cwd()), '--config', str(config)],
                input=(
                    '{"id":"a","method":"diagnostics","params":{}}\n{"id":"é","method":"shutdown","params":{}}\n'
                ).encode(),
                capture_output=True,
                timeout=30,
                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            # What is printed before it serves is still its standard output: the first line apart.
            lines = result.stdout.decode('utf-8').splitlines()
            self.assertEqual(lines[0], 'before it serves')
            rows = [json.loads(line) for line in lines[1:]]
            self.assertEqual([row.get('id', row.get('event')) for row in rows], ['ready', 'a', 'é'])
            self.assertFalse(rows[1]['result']['torchImported'])
            said = result.stderr.decode('utf-8', 'replace')
            self.assertIn('from the descriptor', said)
            self.assertIn('from a program started', said)
            # Its lines end as they did (the application reads them one by one).
            self.assertEqual(result.stdout.count(b'\n'), 4)
            self.assertEqual(result.stdout.count(b'\r\n'), 4 if os.linesep == '\r\n' else 0)

    def test_generate_releases_before_ack_and_dependency_logs_go_to_stderr(self):
        source = io.StringIO('{"id":1,"method":"generate","params":{}}\n')
        destination = io.StringIO()
        calls = []

        def generate(job, config, progress):
            print('dependency output')
            progress(stage='denoising', step=1, total=1)
            calls.append('generated')
            return {'jobId': 'j', 'outputs': [], 'metadata': {}}

        def release(between=False):
            # The worker's own release: what the generation left for the next one stays.
            calls.append('released between' if between else 'released')
            return dict(released=True, allocatedGiB=0)

        with (
            patch('runner.protocol.generate', generate),
            patch('runner.protocol.release', release),
            patch('sys.stderr', io.StringIO()),
        ):
            serve({}, source, destination)
        rows = [json.loads(line) for line in destination.getvalue().splitlines()]
        self.assertEqual(calls, ['generated', 'released between', 'released'])
        self.assertEqual(rows[1], {'event': 'progress', 'id': 1, 'data': {'stage': 'denoising', 'step': 1, 'total': 1}})
        self.assertEqual(rows[2]['result']['jobId'], 'j')

    def test_what_a_generation_leaves_on_the_card_stays_until_a_release_is_asked(self):
        from runner import engine
        from runner.models import kept

        dropped = []
        held = {'bytes': 3 * 1024**3}
        cuda = SimpleNamespace(
            is_initialized=lambda: True,
            synchronize=lambda: None,
            empty_cache=lambda: None,
            memory_allocated=lambda: held['bytes'],
        )

        def model(name, key):
            def drop():
                dropped.append(name)
                held['bytes'] = 0

            return SimpleNamespace(key=key, allocated=3 * 1024**3, drop=drop)

        with patch.dict(sys.modules, torch=SimpleNamespace(cuda=cuda, _C=SimpleNamespace())):
            kept.put('ltx25', model('ltx25', 'a'))
            try:
                # After a generation: the model stays, and its memory is not a failed cleanup.
                self.assertEqual(engine.release(between=True), dict(released=True, allocatedGiB=0))
                self.assertEqual(dropped, [])
                # The same model is taken back for the same files; anything else makes it leave.
                found = kept.take('ltx25', 'a')
                self.assertEqual((found.key, dropped), ('a', []))
                kept.put('ltx25', found)
                self.assertIsNone(kept.take('ltx25', 'other files'))
                self.assertEqual(dropped, ['ltx25'])
                held['bytes'] = 3 * 1024**3
                kept.put('ltx25', model('ltx25', 'a'))
                self.assertFalse(kept.only('ltx25'))
                self.assertTrue(kept.only('krea2'))
                self.assertEqual(dropped, ['ltx25', 'ltx25'])
                self.assertFalse(kept.only('krea2'))
                # The application asks (chat model back, stop, close): everything leaves.
                held['bytes'] = 3 * 1024**3
                kept.put('ltx25', model('ltx25', 'a'))
                self.assertEqual(engine.release(), dict(released=True, allocatedGiB=0))
                self.assertEqual(dropped, ['ltx25'] * 3)
                # More than what was left is still a failed cleanup.
                held['bytes'] = 4 * 1024**3
                kept.put('ltx25', SimpleNamespace(key='a', allocated=3 * 1024**3, drop=lambda: None))
                with self.assertRaisesRegex(RuntimeError, 'GPU cleanup incomplete: 1.0'):
                    engine.release(between=True)
            finally:
                kept._kept.clear()

    def test_the_ceiling_counts_what_the_process_already_holds(self):
        from runner import engine

        torch, fractions = self._engine_torch(free_gib=3)
        # 3 GiB free and 7 held by the model left on the card: the ceiling is on the ten, less the margin.
        torch.cuda.memory_reserved = lambda: 7 * 1024**3
        self.assertTrue(engine._vram_ceiling(torch))
        self.assertAlmostEqual(fractions[0], 9 / 12)

    def test_a_request_stopped_by_a_library_that_would_not_import_says_so(self):
        # (0.6.110) The application no longer imports every library before each start of the worker;
        # told that one would not import, it checks its whole environment again.
        import importlib

        def gone(job, config):
            importlib.import_module('protocol_library_that_is_not_there')

        def broken(job, config):
            # (What a DLL PyTorch cannot load is: an OSError in the lines of the module.)
            importlib.import_module('protocol_library_that_does_not_open')

        def refused(job, config):
            raise ValueError('Invalid job')

        def failed(job, config):
            raise OSError('No space left on device')

        codes = []
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'protocol_library_that_does_not_open.py').write_text(
                "raise OSError('[WinError 126] Error loading c10.dll')\n", encoding='utf-8'
            )
            with (
                patch.object(sys, 'path', [folder, *sys.path]),
                patch('runner.protocol._log_failure', lambda *args: None),
                patch('runner.protocol.release', lambda **_: dict(released=True, allocatedGiB=0)),
            ):
                for preflight in (gone, broken, refused, failed):
                    destination = io.StringIO()
                    with patch('runner.protocol.preflight', preflight):
                        serve({}, io.StringIO('{"id":1,"method":"preflight","params":{}}\n'), destination)
                    codes.append(json.loads(destination.getvalue().splitlines()[1])['error']['code'])
        self.assertEqual(codes, ['LIBRARIES_FAILED', 'LIBRARIES_FAILED', 'INVALID_REQUEST', 'GENERATION_FAILED'])

    def test_a_library_that_wraps_what_stopped_its_import_is_still_a_library_that_would_not_import(self):
        # (0.6.360) diffusers imports its modules when they are asked for, in a function, and says what stopped
        # one in a RuntimeError raised from it: neither an ImportError nor a line of a module in its own trace.
        # The environment was not checked again, and every creation failed the same way until the next start.
        from runner.protocol import _code

        def lazily(cause):
            try:
                try:
                    raise cause
                except Exception as error:
                    said = f'Failed to import diffusers.models.x because of the following error:\n{error}'
                    raise RuntimeError(said) from error
            except RuntimeError as wrapped:
                return wrapped

        def handled(first, then):
            # Raised while another was handled, without « from »: only its context, which says nothing of it.
            try:
                try:
                    raise first
                except Exception:
                    raise then
            except Exception as error:
                return error

        self.assertEqual(_code(lazily(ImportError('DLL load failed while importing _C'))), 'LIBRARIES_FAILED')
        self.assertEqual(_code(lazily(ModuleNotFoundError("No module named 'sentencepiece'"))), 'LIBRARIES_FAILED')
        # A cause of a cause, as far as four: beyond, it is no longer looked for.
        self.assertEqual(_code(lazily(lazily(ImportError('x')))), 'LIBRARIES_FAILED')
        deep = ImportError('x')
        for _ in range(4):
            deep = lazily(deep)
        self.assertEqual(_code(deep), 'GENERATION_FAILED')
        # What has another cause, or only a context, is the failure it always was.
        self.assertEqual(_code(lazily(OSError('No space left on device'))), 'GENERATION_FAILED')
        optional = ImportError('optional, not there')
        self.assertEqual(_code(handled(optional, RuntimeError('out of memory'))), 'GENERATION_FAILED')
        self.assertEqual(_code(handled(ImportError('optional'), ValueError('Invalid job'))), 'INVALID_REQUEST')

    def test_a_library_the_worker_cannot_import_as_it_starts_is_said_in_a_line_of_its_own(self):
        from runner import warm

        destination = io.StringIO()
        self.addCleanup(setattr, warm, '_thread', None)
        warm._thread = None
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(warm, 'ALWAYS', ('protocol_library_that_is_not_there',)),
            patch('runner.protocol.release', lambda **_: dict(released=True, allocatedGiB=0)),
        ):
            serve(dict(cacheRoot=folder, warm=True), io.StringIO(''), destination)
            warm._thread.join(20)
        rows = [json.loads(line) for line in destination.getvalue().splitlines()]
        self.assertEqual(rows[0]['event'], 'ready')
        self.assertEqual(rows[1]['event'], 'libraries')
        self.assertIn('protocol_library_that_is_not_there', rows[1]['error'])

    def test_release_is_told_the_room_the_chat_model_needs(self):
        source = io.StringIO(
            '{"id":1,"method":"release","params":{"keepAbove":1000}}\n'
            '{"id":2,"method":"release","params":{"keepAbove":"all"}}\n'
            '{"id":3,"method":"unload","params":{"keepAbove":1000}}\n'
        )
        destination = io.StringIO()
        asked = []

        def release(keep_above=None):
            asked.append(keep_above)
            return dict(released=True, allocatedGiB=0, freedRamGiB=0)

        with patch('runner.protocol.release', release), patch('runner.protocol._log_failure', lambda *args: None):
            serve({}, source, destination)
        rows = [json.loads(line) for line in destination.getvalue().splitlines()]
        # The room asked, then the plain release of a worker that stops.
        self.assertEqual(asked, [1000, None])
        self.assertTrue(rows[1]['result']['released'])
        self.assertEqual(rows[2]['error']['message'], 'Invalid release parameters')
        self.assertEqual(rows[3]['error']['message'], 'This method accepts no parameters')

    def test_failed_generate_cleans_up_and_can_receive_next_request(self):
        source = io.StringIO('{"id":1,"method":"generate","params":{}}\n{"id":2,"method":"release","params":{}}\n')
        destination = io.StringIO()
        calls = []

        def fail(*args):
            raise RuntimeError('simulated OOM')

        with (
            patch('runner.protocol.generate', fail),
            patch(
                'runner.protocol.release',
                lambda **_: calls.append('release') or dict(released=True, allocatedGiB=0),
            ),
        ):
            serve({}, source, destination)
        rows = [json.loads(line) for line in destination.getvalue().splitlines()]
        self.assertEqual(rows[1]['error']['message'], 'simulated OOM')
        self.assertTrue(rows[2]['result']['released'])
        self.assertGreaterEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
