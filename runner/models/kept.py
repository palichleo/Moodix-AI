"""What a pipeline leaves on the GPU for its next generation.

A video model is built and the share of its weights that stays on the GPU is read from the disk
at every generation: 3.5 s of the 12 an LTX 2.5 draft takes (RAM is full of what the steps copy,
so the system's file cache does not keep that share from one video to the next). The Studio makes
its creations one after the other with the same model: the pipeline leaves it here, and the next
generation takes it back if it is the model it wants.

It leaves when anything else needs the card: another pipeline's generation, the chat model
coming back (the application then asks the worker to release, see runner.engine.release), the
application stopping its models or closing. One model at a time.
"""

import gc
import sys

_kept = {}


def take(name, key):
    """What `name` left for a generation made with `key` (its files and LoRAs), or None; it is
    then the caller's again, to put back or to drop. Anything else kept is dropped.

    (0.6.273) What is dropped here goes back to the driver, as runner.engine gives back what another
    family left: kept in PyTorch's reserve, it was missing from the free memory the encoder of the
    prompt reads to size its share (runner.models.pool.room), which then streamed what it could have
    kept on the card (the same model at another strength of its LoRA, say)."""
    found = _kept.pop(name, None)
    dropped = drop()
    if found is not None and found.key != key:
        found.drop()
        found, dropped = None, True
    if dropped:
        _give_back()
    return found


def _give_back():
    # As runner.engine.release: a card nothing has used yet has nothing in its reserve.
    torch = sys.modules.get('torch')
    if torch is not None and torch.cuda.is_initialized():
        gc.collect()
        torch.cuda.empty_cache()


def put(name, value):
    drop()
    _kept[name] = value


def only(name):
    """A generation of `name` starts: what any other pipeline left goes. True when something did."""
    others = [found for found in _kept if found != name]
    for other in others:
        _kept.pop(other).drop()
    return bool(others)


def drop():
    """Everything kept leaves the GPU. True when something did."""
    left = bool(_kept)
    while _kept:
        _kept.popitem()[1].drop()
    return left


def allocated():
    """Bytes of video memory what is kept holds, as each measured it when it was put here."""
    return sum(value.allocated for value in _kept.values())
