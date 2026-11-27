"""The pictures along a take and the loudness of its sound: what its piece shows on the timeline of the Bobine.

    python -m runner film --input clip.mp4 --wave wave.json [--strip strip.jpg] [--count 12] [--side 124]

Read once for each take: the application keeps both beside its thumbnail (lib/thumbnails.mjs).
`--wave`: its sound, twelve values a second from 0 (silence, or quieter than -54 dB) to 100 (0 dB, the
loudest a file holds), each the power of its twelfth of a second (RMS) on a scale of decibels;
`"sound": false` for a file without a sound, or with a silent one. `--strip`: `count` pictures of its
video taken at regular intervals (each the one shown at the middle of its share of the clip), square,
cut in their middle, `side` pixels, side by side in one JPEG. A one-shot command on the processor,
apart from the worker: PyAV (the libraries of FFmpeg), NumPy and Pillow; no model, nothing of torch.
"""

import argparse
import json
import math
import os
from pathlib import Path
import sys
import uuid

from runner.video.still import EXTENSIONS as VIDEOS

SOUNDS = ('.wav', '.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac')
# Twelve values a second, each the power of a thousand samples of the sound read in mono at 12 kHz.
RATE = 12
HERTZ = 12000
# What is quieter is drawn as nothing; 0 dB (the loudest a file holds) as the full height.
FLOOR = -54.0
# The pictures of a strip: two a second of video, four at least and 48 at most; 124 pixels (62 on the
# timeline, sharp on a screen of twice its density).
PER_SECOND = 2
FEWEST, MOST = 4, 48
SIDE = 124


def keep(output, save):
    """Writes `output` with `save(temporary_path)`, never half-written: under another name first, then moved."""
    output = Path(output)
    temporary = output.with_name(f'{output.name}.{uuid.uuid4().hex}.tmp')
    try:
        save(temporary)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def loudness(path, rate=RATE):
    """The envelope of the sound of `path`: { rate, sound, levels } (see the head of this file)."""
    import av
    import numpy as np

    with av.open(str(path)) as source:
        stream = next((item for item in source.streams if item.type == 'audio'), None)
        if stream is None:
            return dict(rate=rate, sound=False, levels=[])
        stream.thread_type = 'AUTO'
        resampler = av.AudioResampler(format='flt', layout='mono', rate=HERTZ)
        pieces = []

        def add(frames):
            for frame in frames:
                pieces.append(frame.to_ndarray().reshape(-1))

        try:
            for frame in source.decode(stream):
                add(resampler.resample(frame))
        except av.error.FFmpegError:
            # A file cut short keeps the sound decoded before the fault.
            if not pieces:
                raise
        add(resampler.resample(None))
    samples = np.concatenate(pieces).astype(np.float64) if pieces else np.zeros(0)
    window = HERTZ // rate
    count = -(-samples.size // window)
    if not count:
        return dict(rate=rate, sound=False, levels=[])
    squares = np.zeros(count * window)
    squares[: samples.size] = np.square(samples)
    # (The last twelfth is often shorter: its power is that of what it holds.)
    held = np.full(count, window, dtype=np.float64)
    held[-1] = samples.size - window * (count - 1)
    power = np.sqrt(squares.reshape(count, window).sum(axis=1) / held)
    decibels = 20 * np.log10(np.maximum(power, 1e-12))
    levels = np.clip(np.round((decibels - FLOOR) / -FLOOR * 100), 0, 100).astype(int)
    return dict(rate=rate, sound=bool(levels.any()), levels=levels.tolist())


def length(source, video):
    """How long the video lasts, in seconds, and when it starts: from what it declares, else from its packets."""
    import av

    start = float(video.start_time * video.time_base) if video.start_time is not None else 0.0
    if video.duration:
        return float(video.duration * video.time_base), start
    if source.duration:
        return float(source.duration) / av.time_base, start
    # Nothing declared: the end of its last packet (read without decoding anything), then from its start again.
    end = start
    for packet in source.demux(video):
        if packet.pts is not None:
            end = max(end, float((packet.pts + (packet.duration or 0)) * video.time_base))
    source.seek(video.start_time or 0, stream=video, backward=True, any_frame=False)
    return max(0.0, end - start), start


def pictures(path, count=None, side=SIDE):
    """`count` square pictures of the video `path` at regular intervals (by default two a second), and its length."""
    import av
    from PIL import Image, ImageOps

    with av.open(str(path)) as source:
        video = next((item for item in source.streams if item.type == 'video'), None)
        if video is None:
            raise ValueError('Ce fichier ne contient pas de vidéo.')
        video.thread_type = 'AUTO'
        seconds, start = length(source, video)
        if count is None:
            count = min(MOST, max(FEWEST, math.ceil(seconds * PER_SECOND - 1e-9)))
        # The picture shown at the middle of each share of the clip: the last one that starts before it.
        targets = [start + (index + 0.5) * seconds / count for index in range(count)]
        chosen, current = [], None

        def square(frame):
            return ImageOps.fit(frame.to_image().convert('RGB'), (side, side), method=Image.Resampling.LANCZOS)

        try:
            for frame in source.decode(video):
                time = frame.time
                while current is not None and time is not None and len(chosen) < count and time > targets[len(chosen)]:
                    chosen.append(square(current))
                if len(chosen) == count:
                    break
                current = frame
        except av.error.FFmpegError:
            # A file cut short keeps the pictures decoded before the fault.
            if current is None:
                raise
        if current is None:
            raise ValueError('Cette vidéo ne contient aucune image lisible.')
        # (The shares after the last picture, a length declared a little longer than the pictures: that picture.)
        last = square(current) if len(chosen) < count else None
        chosen.extend([last] * (count - len(chosen)))
    strip = Image.new('RGB', (side * count, side))
    for index, picture in enumerate(chosen):
        strip.paste(picture, (index * side, 0))
    return strip, seconds


def read(path, wave, strip=None, count=None, side=SIDE):
    """Writes the envelope of the sound of `path` as `wave` (JSON) and, asked, its strip of pictures as `strip`."""
    path = Path(path)
    if path.suffix.lower() not in VIDEOS + SOUNDS or not path.is_file():
        raise ValueError('Ce fichier n’est ni une vidéo ni un son lisible.')
    if strip and path.suffix.lower() not in VIDEOS:
        raise ValueError('Un son n’a pas d’images.')
    sound = loudness(path)
    text = json.dumps(sound, separators=(',', ':'))
    keep(wave, lambda temporary: Path(temporary).write_text(text, encoding='utf-8'))
    result = dict(sound=sound['sound'], seconds=len(sound['levels']) / RATE)
    if strip:
        image, seconds = pictures(path, count, side)
        keep(strip, lambda temporary: image.save(temporary, format='JPEG', quality=82))
        result.update(frames=image.width // side, side=side, seconds=round(seconds, 3))
    return result


def main(arguments=None):
    parser = argparse.ArgumentParser(prog='python -m runner film', description=__doc__.splitlines()[0])
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--wave', required=True, type=Path)
    parser.add_argument('--strip', type=Path)
    parser.add_argument('--count', type=int)
    parser.add_argument('--side', type=int, default=SIDE)
    args = parser.parse_args(arguments)
    try:
        if not 32 <= args.side <= 512:
            raise ValueError('Taille des images invalide.')
        if args.count is not None and not 1 <= args.count <= 96:
            raise ValueError('Nombre d’images invalide.')
        result = read(args.input, args.wave, args.strip, args.count, args.side)
    except Exception as error:
        # One line the application repeats to the user.
        print(str(error).strip().splitlines()[-1] if str(error).strip() else type(error).__name__, file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
