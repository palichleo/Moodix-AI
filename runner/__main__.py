"""Start the offline worker: python -m runner --config PATH.

One command runs apart from the worker and ends: python -m runner frame … (runner.video.still),
the first or the last picture of a video.
"""

import argparse
import json
import os
from pathlib import Path
import sys


def main():
    # Nothing of the worker is loaded for it: no model, nothing of torch.
    if sys.argv[1:2] == ['frame']:
        from runner.video.still import main as still

        sys.exit(still(sys.argv[2:]))
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    from runner.contracts import validate_config
    from runner.media import sweep
    from runner.models.headers import unique_object
    from runner.protocol import serve

    config = validate_config(json.loads(args.config.read_text(encoding='utf-8-sig'), object_pairs_hook=unique_object))
    # The temporary files a worker killed half-way left in the folder of the outputs (old ones only).
    sweep(config)
    serve(config, destination=_protocol_pipe())


def _protocol_pipe():
    """(0.6.359) Where the protocol is written: the pipe the application reads, kept under a descriptor of its
    own, while the descriptor 1 is turned to the error output. `sys.stdout` covers what Python prints
    (runner.protocol); C code and the programs the engine starts (a compiler) write to the descriptor itself,
    and one line that is not JSON there stops the engine. Written as the standard output was: its encoding,
    its ends of lines, nothing held back. None where the descriptors cannot be set apart: as before then."""
    import io

    try:
        sys.stdout.flush()
        kept = os.dup(1)
        try:
            os.dup2(2, 1)
        except OSError:
            os.close(kept)
            raise
    except (OSError, ValueError, AttributeError):
        return None
    return io.TextIOWrapper(
        io.FileIO(kept, 'w'), encoding=sys.stdout.encoding, errors=sys.stdout.errors, write_through=True
    )


if __name__ == '__main__':
    main()
