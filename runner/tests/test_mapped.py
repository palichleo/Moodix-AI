"""(0.6.252) A file the engine does not keep in RAM is read through a read-only mapping of its own (residency.Mapped)
instead of safe_open's copy-on-write one, which Windows charges in full to the committed memory as it opens (20.07
GiB for the 20.03 GiB of LTX 2.5, 23/11): the same tensors, made the same way, for nothing."""

import gc
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMES = {
    'float64': 'F64', 'float32': 'F32', 'float16': 'F16', 'bfloat16': 'BF16', 'int64': 'I64', 'int32': 'I32',
    'int16': 'I16', 'int8': 'I8', 'uint8': 'U8', 'bool': 'BOOL', 'float8_e4m3fn': 'F8_E4M3', 'float8_e5m2': 'F8_E5M2',
    'uint16': 'U16',
}


def written(path, tensors, metadata=None):
    """A safetensors file written byte for byte with its tensors in the order given: an odd-length int8 tensor
    first puts all the others on odd bytes, as in files of the models folder (a text encoder whose every tensor
    starts on one)."""
    import torch

    header, blobs, offset = {}, [], 0
    if metadata is not None:
        header['__metadata__'] = metadata
    for name, tensor in tensors:
        data = tensor.contiguous().reshape(-1).view(torch.uint8).numpy().tobytes()
        header[name] = dict(dtype=NAMES[str(tensor.dtype).removeprefix('torch.')], shape=list(tensor.shape),
                            data_offsets=[offset, offset + len(data)])
        blobs.append(data)
        offset += len(data)
    raw = json.dumps(header).encode()
    raw += b' ' * (-(8 + len(raw)) % 8)
    with open(path, 'wb') as handle:
        handle.write(struct.pack('<Q', len(raw)) + raw + b''.join(blobs))


def octets(tensor):
    import torch

    return tensor.reshape(-1).view(torch.uint8).tolist()


class MappedTest(unittest.TestCase):
    def setUp(self):
        try:
            import torch
            from safetensors import safe_open  # noqa: F401
        except ImportError:
            self.skipTest('torch and safetensors are required')
        self.torch = torch
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        torch.manual_seed(0)
        self.tensors = [
            ('odd', torch.tensor([1, 2, 3], dtype=torch.int8)),
            ('bf16', torch.randn(7).to(torch.bfloat16)),
            ('f32', torch.randn(3, 5)),
            ('f64', torch.randn(2, 2, dtype=torch.float64)),
            ('f16', torch.randn(4).to(torch.float16)),
            ('i64', torch.arange(-3, 3, dtype=torch.int64)),
            ('i32', torch.arange(6, dtype=torch.int32).reshape(2, 3)),
            ('i16', torch.arange(5, dtype=torch.int16)),
            ('u8', torch.arange(9, dtype=torch.uint8)),
            ('mask', torch.tensor([True, False, True])),
            ('e4m3', torch.randn(6).to(torch.float8_e4m3fn)),
            ('e5m2', torch.randn(6).to(torch.float8_e5m2)),
            ('scalar', torch.tensor(2.5)),
            ('empty', torch.empty(0, 4)),
            ('a.later.name', torch.randn(3)),
        ]
        self.path = os.path.join(self.folder.name, 'weights.safetensors')
        written(self.path, self.tensors, metadata={'kind': 'test'})

    def test_the_tensors_safe_open_gives_views_of_the_file_never_copies(self):
        from safetensors import safe_open

        from runner.models.residency import Mapped

        mapped = Mapped(self.path)
        self.assertIsNone(mapped.safe)  # read by the mapping itself, not handed to safe_open
        with safe_open(self.path, framework='pt') as reference:
            self.assertEqual(mapped.keys(), reference.keys())
            self.assertEqual(mapped.metadata(), reference.metadata())
            for key in reference.keys():
                ours, theirs = mapped.get_tensor(key), reference.get_tensor(key)
                self.assertEqual((ours.dtype, tuple(ours.shape)), (theirs.dtype, tuple(theirs.shape)), key)
                self.assertEqual(octets(ours), octets(theirs), key)
                # A slice of storage of its own, as safe_open's, where the tensor is in the file (on an odd byte
                # too): nothing copied, nothing shared with the other tensors.
                self.assertEqual(ours.untyped_storage().nbytes(), theirs.untyped_storage().nbytes(), key)
                if ours.numel():
                    start = mapped.header[key]['data_offsets'][0]
                    self.assertEqual(ours.data_ptr(), mapped.storage.data_ptr() + mapped.base + start, key)
                self.assertEqual(mapped.get_slice(key).get_shape(), reference.get_slice(key).get_shape(), key)
            self.assertEqual(octets(mapped.get_slice('f32')[1:3]), octets(reference.get_slice('f32')[1:3]))
        self.assertTrue(any((mapped.base + mapped.header[key]['data_offsets'][0]) % tensor.element_size()
                            for key, tensor in self.tensors))
        for key, tensor in self.tensors:  # and against the tensors written
            self.assertEqual(octets(mapped.get_tensor(key)), octets(tensor), key)
        mapped.__exit__(None, None, None)

    def test_a_tensor_not_in_the_file_is_refused_as_safe_open_refuses_it(self):
        from safetensors import SafetensorError, safe_open

        from runner.models.residency import Mapped

        mapped = Mapped(self.path)
        with safe_open(self.path, framework='pt') as reference:
            for key in ('missing', '__metadata__'):
                with self.assertRaises(SafetensorError) as theirs:
                    reference.get_tensor(key)
                with self.assertRaises(SafetensorError) as ours:
                    mapped.get_tensor(key)
                self.assertEqual(str(ours.exception), str(theirs.exception))
        mapped.__exit__(None, None, None)

    def test_a_file_safe_open_refuses_is_refused_as_it_opens_in_its_words(self):
        from safetensors import SafetensorError, safe_open

        from runner.models.residency import Mapped

        def f32(start, end, count=4):
            return dict(dtype='F32', shape=[count], data_offsets=[start, end])

        cases = {
            'cut short': ({'a': f32(0, 16)}, 10),
            'longer than its tensors': ({'a': f32(0, 16)}, 20),
            'a gap': ({'a': f32(0, 16), 'b': f32(20, 36)}, 36),
            'an overlap': ({'a': f32(0, 16), 'b': f32(12, 28)}, 28),
            'a length its shape does not give': ({'a': f32(0, 12)}, 12),
            'not from the start': ({'a': f32(4, 20)}, 20),
            'an end before its start': ({'a': dict(dtype='F32', shape=[0], data_offsets=[8, 0])}, 8),
        }
        for index, (case, (header, length)) in enumerate(cases.items()):
            path = os.path.join(self.folder.name, f'malformed-{index}.safetensors')
            raw = json.dumps(header).encode()
            raw += b' ' * (-(8 + len(raw)) % 8)
            with open(path, 'wb') as handle:
                handle.write(struct.pack('<Q', len(raw)) + raw + bytes(length))
            with self.assertRaises(SafetensorError, msg=case) as theirs:
                safe_open(path, framework='pt')
            with self.assertRaises(SafetensorError, msg=case) as ours:
                Mapped(path)
            self.assertEqual(str(ours.exception), str(theirs.exception), case)

    @unittest.skipUnless(sys.platform == 'win32', 'what Windows refuses for a file held open without sharing')
    def test_a_file_held_can_still_be_renamed_or_deleted_as_with_safe_open(self):
        from runner.models.residency import Mapped

        mapped = Mapped(self.path)
        held = mapped.get_tensor('i64')
        mapped.__exit__(None, None, None)
        moved = self.path + '.moved'
        # With Python's own `open`: « [WinError 32] » for both.
        os.rename(self.path, moved)
        os.remove(moved)
        self.assertEqual(held.tolist(), [-3, -2, -1, 0, 1, 2])  # still read from what was mapped

    def test_tensors_are_made_on_the_processor_whatever_the_device_around(self):
        from runner.models.residency import Mapped

        torch = self.torch
        mapped = Mapped(self.path)
        with torch.device('meta'):
            value = mapped.get_tensor('i64')
            piece = mapped.get_slice('i32')[1:]
        self.assertEqual((value.device.type, value.tolist()), ('cpu', [-3, -2, -1, 0, 1, 2]))
        self.assertEqual((piece.device.type, piece.tolist()), ('cpu', [[3, 4, 5]]))
        mapped.__exit__(None, None, None)

    def test_a_slice_taken_is_a_copy_of_its_own_as_with_safe_open(self):
        from runner.models.residency import Mapped

        mapped = Mapped(self.path)
        piece = mapped.get_slice('f32')[1:3]
        start = mapped.storage.data_ptr()
        self.assertFalse(start <= piece.data_ptr() < start + mapped.storage.nbytes())
        self.assertEqual(octets(piece), octets(dict(self.tensors)['f32'][1:3]))
        mapped.__exit__(None, None, None)

    def test_a_type_the_arenas_do_not_read_is_left_to_safe_open(self):
        from safetensors import safe_open

        from runner.models.residency import Mapped

        torch = self.torch
        path = os.path.join(self.folder.name, 'other.safetensors')
        written(path, [('u16', torch.arange(5, dtype=torch.int16).view(torch.uint16)), ('f32', torch.randn(2))])
        mapped = Mapped(path)
        self.assertIsNotNone(mapped.safe)
        with safe_open(path, framework='pt') as reference:
            self.assertEqual(mapped.keys(), reference.keys())
            for key in reference.keys():
                self.assertEqual(octets(mapped.get_tensor(key)), octets(reference.get_tensor(key)), key)
        mapped.__exit__(None, None, None)

    def test_a_store_not_kept_in_ram_reads_through_it(self):
        from runner.models.residency import Mapped, open_store

        store = open_store(self.path, resident=False)
        self.assertIsInstance(store.mapping, Mapped)
        self.assertEqual(octets(store.get_tensor('f32')), octets(dict(self.tensors)['f32']))
        store.reopen()
        self.assertIsInstance(store.mapping, Mapped)
        self.assertEqual(octets(store.get_tensor('bf16')), octets(dict(self.tensors)['bf16']))
        self.assertEqual(store.keys(), sorted(dict(self.tensors)))
        store.close()

    def test_tensors_read_outlive_the_store_and_the_file_goes_with_the_last_of_them(self):
        # In a process of its own: a mapping let go under its tensors crashes the one that reads them.
        code = (
            'import gc, os, sys\n'
            'from runner.models.residency import open_store\n'
            'store = open_store(sys.argv[1], resident=False)\n'
            "first = store.get_tensor('i64')\n"
            'store.reopen()\n'
            "second = store.get_tensor('i16')\n"
            'store.close()\n'
            'print(first.tolist(), second.tolist(), flush=True)\n'
            'del first, second, store\n'
            'gc.collect()\n'
            # Windows refuses to shorten a file still mapped (« [WinError 1224] »), though it lets it be deleted.
            "open(sys.argv[1], 'r+b').truncate(0)\n"
            "print('let go')\n"
        )
        done = subprocess.run([sys.executable, '-s', '-c', code, self.path], cwd=ROOT, capture_output=True, text=True,
                              timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        self.assertEqual(done.stdout.split('\n')[:2], ['[-3, -2, -1, 0, 1, 2] [0, 1, 2, 3, 4]', 'let go'])

    def test_the_engine_stops_as_it_should_with_tensors_still_held(self):
        # The worker ends with its interpreter (runner.protocol.serve returns), weights still held: a mapping let go
        # in the wrong order there would end it on an access violation (3221225477), not 0.
        code = (
            'import sys\n'
            'from runner.models.residency import open_store\n'
            'store = open_store(sys.argv[1], resident=False)\n'
            "kept = [store.get_tensor('i64'), store.get_tensor('bf16')]\n"
            'closed = open_store(sys.argv[1], resident=False)\n'
            "also = closed.get_tensor('i16')\n"
            'closed.close()\n'
            'print(kept[0].tolist(), also.tolist(), flush=True)\n'
        )
        done = subprocess.run([sys.executable, '-s', '-c', code, self.path], cwd=ROOT, capture_output=True, text=True,
                              timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        self.assertEqual(done.stdout.split('\n')[0], '[-3, -2, -1, 0, 1, 2] [0, 1, 2, 3, 4]')

    @unittest.skipUnless(sys.platform == 'win32', 'committed memory is what Windows charges a copy-on-write mapping')
    def test_reading_a_file_through_the_store_charges_nothing_to_the_committed_memory(self):
        try:
            import psutil
        except ImportError:
            self.skipTest('psutil is required')
        from runner.models.residency import open_store

        # Written without torch: what its allocator keeps of tensors let go would hide copies made of the file.
        path, size = os.path.join(self.folder.name, 'large.safetensors'), 32 * 1024**2
        header = {f'block.{index}': dict(dtype='U8', shape=[size], data_offsets=[index * size, (index + 1) * size])
                  for index in range(8)}
        raw = json.dumps(header).encode()
        raw += b' ' * (-(8 + len(raw)) % 8)
        with open(path, 'wb') as handle:
            handle.write(struct.pack('<Q', len(raw)) + raw)
            for index in range(8):
                handle.write(bytes([index]) * size)
        process = psutil.Process()
        gc.collect()
        before = process.memory_info().private
        store = open_store(path, resident=False)
        # Held as a model holds its weights, a byte of every page read.
        held = [store.get_tensor(f'block.{index}') for index in range(8)]
        total = sum(int(tensor.reshape(-1)[::4096].sum()) for tensor in held)
        charged = process.memory_info().private - before
        del held
        store.close()
        self.assertEqual(total, sum(index * 8192 for index in range(8)))
        # 256 MiB read: safe_open charged all of them as it opened the file.
        self.assertLess(charged, 32 * 1024**2)


if __name__ == '__main__':
    unittest.main()
