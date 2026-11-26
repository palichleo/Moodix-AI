from pathlib import Path
import struct
import tempfile
import unittest

from runner.contracts import validate_config
from runner.models.headers import header
from runner.registry import validate_job


def job():
    return dict(
        schemaVersion=1,
        id='job-one',
        pipeline='krea2',
        mediaType='image',
        workflowId='preset',
        workflowDigest='a' * 64,
        parameters=dict(prompt='a tree', seed=7, width=64, height=64, steps=1, cfg=1, denoise=1),
        components={k: str(Path.cwd() / f'{k}.safetensors') for k in ('model', 'textEncoder', 'vae')}
        | {'tokenizer': str(Path.cwd() / 'tokenizer')},
        loras=[],
        references=[],
    )


class ContractTests(unittest.TestCase):
    def test_concrete_job_is_valid_without_loading_files(self):
        value = job()
        self.assertEqual(validate_job(value), value)

    def test_rejects_policy_unknown_fields_and_nonfinite_numbers(self):
        for field, value in [
            ('seed', True),
            ('seed', 2**53),
            ('width', 65),
            ('steps', 0),
            ('cfg', 2),
            ('denoise', float('nan')),
            ('denoise', 0),
            ('prompt', {'policy': 'model'}),
            ('expandPrompt', 'true'),
            ('unknown', 1),
        ]:
            candidate = job()
            candidate['parameters'][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_job(candidate)
        for key, value in [
            ('schemaVersion', 2),
            ('pipeline', 'exec'),
            ('mediaType', 'video'),
            ('workflowDigest', 'bad'),
            ('extra', 1),
        ]:
            candidate = job()
            candidate[key] = value
            with self.assertRaises(ValueError):
                validate_job(candidate)

    def test_rejects_unsafe_paths_duplicate_loras_and_unsupported_refs(self):
        candidate = job()
        candidate['components']['model'] = '../file'
        with self.assertRaises(ValueError):
            validate_job(candidate)
        candidate = job()
        candidate['loras'] = [dict(id='x', path=candidate['components']['model'], strength=0.5)] * 2
        with self.assertRaises(ValueError):
            validate_job(candidate)
        candidate = job()
        candidate['references'] = [dict(input='start', role='startImage', path=candidate['components']['model'])]
        with self.assertRaises(ValueError):
            validate_job(candidate)

    def test_trusted_config(self):
        value = {k: str(Path.cwd() / k) for k in ('cacheRoot', 'outputRoot')}
        self.assertEqual(validate_config(value), value)
        with self.assertRaises(ValueError):
            validate_config(value | {'cacheGiB': float('inf')})

    def test_signed_lora_strength_bounds(self):
        candidate = job()
        candidate['loras'] = [dict(id='style', path=candidate['components']['model'], strength=-0.5)]
        self.assertEqual(validate_job(candidate), candidate)
        candidate['loras'][0]['strength'] = -4.01
        with self.assertRaises(ValueError):
            validate_job(candidate)

    def test_safetensors_header_rejects_truncation_invalid_offsets_and_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fake.safetensors'
            for raw, payload in [
                (b'{}', b''),
                (b'{"x":{"dtype":"F32","shape":[2],"data_offsets":[0,8]}}', b'1234'),
                (b'{"x":1,"x":2}', b''),
                (b'{"x":{"dtype":"F32","shape":[1],"data_offsets":[]}}', b'1234'),
                (b'{"__metadata__":{"bad":12},"x":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}', b'1234'),
            ]:
                path.write_bytes(struct.pack('<Q', len(raw)) + raw + payload)
                with self.assertRaises(ValueError):
                    header(path)

    def test_an_empty_tensor_is_accepted_wherever_the_header_lists_it(self):
        # (0.6.369) The mark of a « scaled » fp8 file is a tensor of no value, at the place where the next one
        # begins. Written by another tool with its names sorted, it comes after that one in the header.
        import json

        def write(path, entries):
            raw = json.dumps(entries).encode()
            size = max(entry['data_offsets'][1] for entry in entries.values())
            path.write_bytes(struct.pack('<Q', len(raw)) + raw + bytes(size))

        empty = dict(dtype='F32', shape=[0, 4], data_offsets=[0, 0])
        first = dict(dtype='F32', shape=[2], data_offsets=[0, 8])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'marked.safetensors'
            for entries in ({'empty': empty, 'a': first}, {'a': first, 'empty': empty}):
                write(path, entries)
                self.assertEqual(set(header(path)), {'a', 'empty'}, list(entries))
            # In the middle and at the end of the file too, listed last.
            second = dict(dtype='F32', shape=[1], data_offsets=[8, 12])
            write(path, {'b': second, 'a': first, 'mark': dict(dtype='I8', shape=[0], data_offsets=[8, 8])})
            self.assertEqual(len(header(path)), 3)
            write(path, {'a': first, 'mark': dict(dtype='I8', shape=[0], data_offsets=[8, 8])})
            self.assertEqual(len(header(path)), 2)
            # Tensors that overlap, or leave a hole, are still refused.
            for offsets in ([4, 8], [12, 16]):
                write(path, {'a': first, 'b': dict(dtype='F32', shape=[1], data_offsets=offsets)})
                with self.assertRaisesRegex(ValueError, 'Invalid tensor data offsets'):
                    header(path)

    def test_what_is_no_safetensors_file_is_refused_at_its_first_bytes_wherever_it_is_read(self):
        # (0.6.370) The check of the headers bounded the length it reads; the loading and the conversion did not.
        from runner import convert
        from runner.models import residency

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.safetensors'
            # A GGUF (13 GiB said by its first bytes), a ZIP (80 GiB), a length of nothing, one of a single byte.
            others = (b'GGUF' + struct.pack('<I', 3), b'PK' + bytes([3, 4, 20, 0, 0, 0]), bytes(8), bytes([1]) + bytes(7))
            for first in others:
                path.write_bytes(first + b'{}' * 64)
                for read in (residency._header, convert._safetensors_header, header):
                    with self.assertRaisesRegex(ValueError, 'Invalid safetensors header size'):
                        read(path)
            path.write_bytes(b'GGUF')
            for read in (residency._header, convert._safetensors_header, header):
                with self.assertRaisesRegex(ValueError, 'Truncated safetensors header'):
                    read(path)
            # A real one is read as it was, by each.
            raw = b'{"__metadata__":{"kind":"test"},"x":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}'
            path.write_bytes(struct.pack('<Q', len(raw)) + raw + bytes(4))
            entries, base = residency._header(path)
            self.assertEqual((sorted(entries), base), (['__metadata__', 'x'], 8 + len(raw)))
            self.assertEqual(convert._safetensors_header(path), ({'x': entries['x']}, {'kind': 'test'}))
            self.assertEqual(header(path)['x'], entries['x'])


if __name__ == '__main__':
    unittest.main()
