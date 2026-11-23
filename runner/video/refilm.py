"""« Changer la caméra » of a video made (verb refilm_video, family ltx25_refilm): the same clip filmed
again from a camera placed by hand, by LTX 2.5 and the CrossView-Warp IC-LoRA.

Three stages, in one creation:

1. the clip as LTX reads it: 24 frames a second (the frame of each instant: a clip of 16 or 30 frames a
   second is timed again, never slowed down), its size cut down to multiples of 32 in its middle, or the
   smaller size chosen in the Studio (0.6.248: the clip shrunk on the processor to cover it, then cut in its
   middle), and one shot only (a cut would be filmed across as if it were a movement);
2. its guide: the depth of each frame (MoGe-2, on the card), then each frame drawn again from the new
   camera, on the processor (runner.video.camera_warp), magenta where the first camera saw nothing;
3. LTX 2.5 with the IC-LoRA, which reads the guide then the clip (runner.video.ic_reference) and films
   the clip again from there; the sound of the clip is put back on it.

Its rules are the family's (`refilm` in runner/families/ltx25_refilm.json), the ones the server and the
Studio hold too (lib/refilm.mjs, public/camera-orbit.mjs), in the same words: what is refused is said in
words before the card is asked for, never as a failed video. Only what cannot be made is refused (0.6.248):
a large or long clip takes longer, which the Studio says from what this computer took before (0.6.249:
`made`, from the history of times of the application; the time depends on the computer). Measured on 22/11
on a card of 12 GB (the fisherman, 121 frames, cold, from the start to the file): 132 s at 768 × 448, 223 s
at 1024 × 576, 354 s at 1280 × 704; 1600 × 896 took 67 s a step (some 12 minutes in all). The memory held
at every size (8.0 to 8.8 GiB at most): the larger the clip, the fewer weights stay on the card, the slower
each step.
"""

from fractions import Fraction
import math
import os
from pathlib import Path
import time

FAMILY = 'ltx25_refilm'
ROLE = 'refilm_source'
# What LTX 2.5 films at, and the sound put back (what save_video takes).
FPS = 24
SAMPLE_RATE = 48000
# Video memory MoGe-2 takes at its peak on a frame of 768 × 448 (1.64 GiB measured), with room to spare:
# below it, what a creation before left on the card leaves first.
DEPTH_GIB = 2.5
LORA_ID = 'crossview-warp'
# A camera that moves names its start whole (the server sends the three, the end's distance being 1).
START = ('start_azimuth', 'start_elevation', 'start_distance')
# The cuts of a clip (see `cut_at`): its frames compared as small grey pictures of about this many
# blocks, each brought to the same mean and spread (the whole picture lit more or less is no change);
# a frame almost even (black, white) is not compared at all; the picture jumps when it changes this
# much (in spreads) and this many times the usual change of the frames around; the shot after a cut
# holds this many frames, none of them back near the frame before it: within this share of the jump
# (else something passed before the camera, and went).
BLOCKS = (36, 64)
FLAT = 2.0
CUT_CHANGE = 0.5
CUT_RATIO = 3.0
CUT_AROUND = 8
CUT_BACK = 6
CUT_BACK_SHARE = 0.75
# The folders of the work (the guide, the clip timed again), in the temporary folder of the system;
# one a killed worker left is removed by the next creation, once this old.
WORK = 'moodix-refilm-'
STALE_SECONDS = 3600
# A clip is read this far at most: beyond, it is longer than the model films at any rate it takes (481
# frames at 24 a second, 20 s; 2400 frames are 20 s at 120 a second).
MOST_FRAMES = 2400

# The words of the refusals, those of the Studio (public/camera-orbit.mjs, ORBIT_WARNS) and of the server
# (lib/refilm.mjs, REFILM_SAID).
SAID = dict(
    out='Hors de ce que le modèle sait faire : il n’a pas appris cet angle.',
    near='Trop près de la caméra de la vidéo : à si peu d’écart, le modèle se comporte mal.',
    small='Vidéo trop petite pour changer sa caméra : il lui faut 64 pixels de côté au moins.',
    short='Vidéo trop courte pour changer sa caméra : il lui faut au moins 9 images.',
    invalid='Caméra : angles ou distance invalides.',
    changed='La vidéo à refilmer a changé depuis sa vérification : demandez de nouveau le changement de caméra.',
)


class Refused(ValueError):
    """What is not made, in the user's words: shown as it is said."""


def decimal(value, digits=1):
    """A number as a French sentence writes it: 5 → « 5 », 5.5 → « 5,5 », 29.97 → « 29,97 » (2 digits)."""
    scale = 10**digits
    rounded = math.floor(float(value) * scale + 0.5) / scale
    return f'{rounded:.{digits}f}'.rstrip('0').rstrip('.').replace('.', ',')


def long_said(seconds):
    """A clip longer than the model films (`seconds`: the most it does)."""
    return f'Vidéo trop longue pour changer sa caméra : {decimal(seconds)} s au plus.'


def size_said(width, height):
    """A size chosen larger than the clip (`width` × `height`: its own, cut down to multiples of 32)."""
    return f'Taille : au plus {width} × {height}, la taille de la vidéo.'


def shape_said(shape):
    """A size chosen of another shape than the clip's (`shape`: the share it may differ by)."""
    return f'Taille : elle garde le format de la vidéo, à {decimal(shape * 100)} % près.'


def fps_said(fps, bounds):
    low, high = bounds['sourceFps']['min'], bounds['sourceFps']['max']
    return (
        f'Cette vidéo est à {decimal(fps, 2)} images par seconde : la caméra se change sur une vidéo '
        f'de {decimal(low)} à {decimal(high)} images par seconde.'
    )


def cut_said(seconds):
    return (
        f'Cette vidéo change de plan à {decimal(seconds)} s : la caméra ne se change que sur une vidéo '
        'd’un seul plan.'
    )


# The camera ------------------------------------------------------------------------------------------


def poses_of(parameters):
    """(end, start) of a job: the camera at the end, held when it does not move (start None); each
    (azimuth, elevation, distance)."""
    end = (parameters['azimuth'], parameters['elevation'], parameters['distance'])
    named = [key in parameters for key in START]
    if any(named) and not all(named):
        raise ValueError('A moving camera names its whole start: ' + ', '.join(START))
    return end, (tuple(parameters[key] for key in START) if all(named) else None)


def zone(pose, zones):
    """« safe », « maybe » or « out »: an ellipse over the azimuth and the elevation for each zone, its
    height the one above or below as the camera is (orbitZone of public/camera-orbit.mjs)."""
    azimuth, elevation = pose[0], pose[1]

    def within(name):
        held = zones[name]
        height = held['up'] if elevation >= 0 else held['down']
        return (azimuth / held['azimuth']) ** 2 + (elevation / height) ** 2 <= 1

    return 'safe' if within('safe') else 'maybe' if within('maybe') else 'out'


def camera_refusal(end, start, bounds):
    """Why the camera is not made, '' when it is: a distance the model does not hold, a pose out of what
    it learnt, or a camera that hardly leaves the clip's (the one held; both ends of one that moves:
    starting from the clip's own camera is its ordinary case). As orbitWorst says it."""
    poses = [end] if start is None else [start, end]
    real = lambda value: type(value) in (int, float) and math.isfinite(value)  # noqa: E731
    if not all(real(value) for pose in poses for value in pose):
        return SAID['invalid']
    far = bounds['distance']
    if any(not far['min'] <= pose[2] <= far['max'] for pose in poses):
        return far.get('unavailable') or f'Distance : entre {decimal(far["min"])} et {decimal(far["max"])}.'
    if any(zone(pose, bounds['zones']) == 'out' for pose in poses):
        return SAID['out']
    if not any(math.hypot(pose[0], pose[1]) >= bounds['near'] for pose in poses):
        return SAID['near']
    return ''


def size_refusal(width, height, source_width, source_height, bounds):
    """Why a clip of `source_width` × `source_height` is not filmed again at `width` × `height`, '' when
    it is: at most its own size cut down to multiples of 32, which is always taken (the size without a
    choice), and of its shape within `shape` of the family (refilmSize of lib/refilm.mjs). Its multiples
    of 32 and its 64 pixels at least are the manifest's. A larger size only takes longer: never refused."""
    own = (source_width // 32 * 32, source_height // 32 * 32)
    if (width, height) == own:
        return ''
    if width > own[0] or height > own[1]:
        return size_said(*own)
    # (The same operations as the server's, so that both find the same at the edge.)
    if abs(width * source_height / (height * source_width) - 1) > bounds['shape']:
        return shape_said(bounds['shape'])
    return ''


def most_frames():
    """The most frames the model films a clip at: the last of the family's (481, 20 s at 24 a second)."""
    from runner.registry import family

    return max(family(FAMILY)['parameters']['frames']['choices'])


def covered(frames, fps):
    """The frames at 24 a second the frames of a clip at `fps` cover: those whose instant is at most
    that of its last frame."""
    return math.floor((frames - 1) / fps * FPS + 1e-6) + 1


def output_format(width, height, frames, fps, bounds):
    """What a clip of this size, this many frames, at `fps` (a Fraction, or a number) is refilmed at
    without a size chosen: `width`, `height` (cut down to multiples of 32), `frames` (8n + 1 at 24 a
    second) and how many frames at 24 it `covered`. Refused in words when it cannot be: a rate the model
    does not take, a clip too small, too short, or longer than the model films."""
    rate = bounds['sourceFps']
    if not rate['min'] <= fps <= rate['max']:
        raise Refused(fps_said(fps, bounds))
    made_width, made_height = width // 32 * 32, height // 32 * 32
    if min(made_width, made_height) < 64:
        raise Refused(SAID['small'])
    count = covered(frames, fps)
    made = (count - 1) // 8 * 8 + 1
    if made < 9:
        raise Refused(SAID['short'])
    most = most_frames()
    if made > most:
        raise Refused(long_said((most - 1) / FPS))
    return dict(width=made_width, height=made_height, frames=made, covered=count)


# The cuts of a clip ------------------------------------------------------------------------------------


def small(frame, blocks=BLOCKS):
    """A frame [H, W, 3] uint8 as a small grey picture of about `blocks` (rows, columns), each the mean of
    its pixels."""
    import numpy as np

    grey = frame.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    height, width = grey.shape
    tall, wide = max(1, height // blocks[0]), max(1, width // blocks[1])
    rows, columns = height // tall, width // wide
    return grey[: rows * tall, : columns * wide].reshape(rows, tall, columns, wide).mean(axis=(1, 3))


def normal(picture):
    """A small picture brought to a mean of 0 and a spread of 1, or None when it is almost even."""
    spread = float(picture.std())
    if spread < FLAT:
        return None
    return (picture - picture.mean()) / spread


def cut_at(pictures):
    """The first frame of the second shot of a clip (its index), or None for a clip of one shot.
    `pictures`: its frames as `small` gives them.

    A cut is a jump of the picture (a change far beyond the usual change around it), or two in a row (a
    frame that mixes both shots), after a frame that belongs to its shot, and none of the frames that
    follow comes back near that one. A pan, however fast, changes as much at each frame; a fade, the
    whole picture lit more or less, a camera that turns change little from one frame to the next once
    brought to the same spread; a flash, a frame that went wrong, something that passes before the camera
    come back to the shot; three jumps in a row or more are a camera whipped round. (So a cut within a
    camera that moves fast, whose every frame changes nearly as much as a cut, is not found, nor a shot
    that fades into the next: the model then films across them; nor is a cut in the first frames or the
    last ones. A light that changes much of the picture at once, and stays, is taken for a cut.)

    Tried on 22/11: the two clips of three shots LTX 2.5 made on 21/11 at 768 × 448 are cut at 4.00 s
    and 3.75 s, as they are; none of 62 clips of one shot made since 18/11, of 288 × 512 to 1088 × 1920,
    of 16 to 48 frames a second, nor those whose shots fade into each other."""
    import numpy as np

    seen = [normal(picture) for picture in pictures]

    def apart(first, second):
        one, other = seen[first], seen[second]
        return None if one is None or other is None else float(np.abs(other - one).mean())

    change = [None] + [apart(index - 1, index) for index in range(1, len(seen))]

    def jump(index):
        """How much the picture must change to jump at this frame, when it does (else None)."""
        first = max(1, index - CUT_AROUND)
        around = [
            value
            for at, value in enumerate(change[first : index + CUT_AROUND + 1], first)
            if at != index and value is not None
        ]
        if change[index] is None or not around:
            return None
        least = max(CUT_CHANGE, CUT_RATIO * float(np.median(around)))
        return least if change[index] >= least else None

    index = 1
    while index < len(seen):
        least = jump(index)
        if least is None:
            index += 1
            continue
        end = index
        while end + 1 < len(seen) and jump(end + 1) is not None:
            end += 1
        # (Frame index - 1 the last before the jump, if it belongs to its shot; frame end the first after.)
        if end - index < 2 and index >= 2 and change[index - 1] is not None and end + CUT_BACK <= len(seen):
            near = max(least, CUT_BACK_SHARE * change[index])
            later = [apart(index - 1, at) for at in range(end, end + CUT_BACK)]
            back = next((at for at, value in enumerate(later, end) if value is None or value < near), None)
            if back is None:
                return index
            # (What passed before the camera is gone: the shot goes on from the frame it came back on.)
            end = back
        index = end + 1
    return None


# The clip ----------------------------------------------------------------------------------------------

# What the clip of a job was found to be, by its file (path, size, time): the checks are asked twice for
# each creation (by the application, then by the worker), and the clip is read once.
_SEEN = {}


def source_of(job):
    return next(ref for ref in job['references'] if ref['role'] == ROLE)


def examine(path, bounds):
    """What a clip is, as it will be refilmed: its own size, frames, rate, length and whether it has a
    sound, and the format it is refilmed at without a size chosen (output_format). Refused in words for
    a rate, a size, a length the model does not take, or a second shot."""
    from runner.video.stream import frames as decode, probe

    stat = os.stat(path)
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    if key in _SEEN:
        found = _SEEN[key]
        if isinstance(found, Exception):
            raise found
        return found
    try:
        info = probe(path)
        rate = Fraction(info['fps'])
        if not bounds['sourceFps']['min'] <= rate <= bounds['sourceFps']['max']:
            raise Refused(fps_said(rate, bounds))
        pictures = []
        for frame in decode(path):
            pictures.append(small(frame))
            if len(pictures) > MOST_FRAMES:
                raise Refused(long_said((most_frames() - 1) / FPS))
        if not pictures:
            raise ValueError('The video to refilm has no frame')
        made = output_format(info['width'], info['height'], len(pictures), rate, bounds)
        seconds = len(pictures) / rate
        cut = cut_at(pictures)
        if cut is not None:
            raise Refused(cut_said(cut / rate))
        found = dict(
            made,
            sourceWidth=info['width'],
            sourceHeight=info['height'],
            sourceFrames=len(pictures),
            fps=rate,
            seconds=float(seconds),
            audio=bool(info['audio']),
        )
    except Refused as refusal:
        found = refusal
    if len(_SEEN) > 16:
        _SEEN.clear()
    _SEEN[key] = found
    if isinstance(found, Exception):
        raise found
    return found


def picked(found, count):
    """The frame of the clip shown at each of `count` frames at 24 a second: the nearest instant."""
    rate = found['fps']
    last = found['sourceFrames'] - 1
    return [min(last, math.floor(Fraction(index) * rate / FPS + Fraction(1, 2))) for index in range(count)]


def covering(source_width, source_height, width, height):
    """The size a clip is brought to before it is cut in its middle to `width` × `height`: its own when
    that is its size cut down to multiples of 32 (the size without a choice: nothing is shrunk), else the
    least that covers it, its shape kept."""
    if (width, height) == (source_width // 32 * 32, source_height // 32 * 32):
        return source_width, source_height
    scale = max(width / source_width, height / source_height)
    return max(width, round(source_width * scale)), max(height, round(source_height * scale))


def fitted(frame, width, height):
    """A frame [H, W, 3] uint8 at `width` × `height`: shrunk on the processor (Lanczos, which reads every
    pixel of the frame) to the size that covers it (covering), then cut in its middle."""
    import numpy as np
    from PIL import Image

    source_height, source_width = frame.shape[:2]
    wide, tall = covering(source_width, source_height, width, height)
    if (wide, tall) != (source_width, source_height):
        frame = np.asarray(Image.fromarray(frame).resize((wide, tall), Image.Resampling.LANCZOS))
    top, left = (tall - height) // 2, (wide - width) // 2
    return frame[top : top + height, left : left + width].copy()


def frames_of(path, found, count, size=None):
    """The `count` frames LTX films the clip at, [H, W, 3] uint8 each, at `size` (width, height; without
    it, the clip's own cut down to multiples of 32), and whether they are the clip's own frames as its file
    holds them (24 a second, the same size): the file is then read as it is."""
    from runner.video.stream import frames as decode

    width, height = size or (found['width'], found['height'])
    wanted = picked(found, count)
    needed, kept = set(wanted), {}
    for index, frame in enumerate(decode(path)):
        if index > wanted[-1]:
            break
        if index in needed:
            kept[index] = fitted(frame, width, height)
    if len(kept) != len(needed):
        raise Refused(SAID['changed'])
    exact = found['fps'] == FPS and (found['sourceWidth'], found['sourceHeight']) == (width, height)
    return [kept[index] for index in wanted], exact


# The job -----------------------------------------------------------------------------------------------


def check(job, family):
    """The rules of a refilm beyond the manifest: one clip, a whole camera, a pivot named whole, a camera
    the model holds, and a size the clip is filmed at that its own allows, when the server names the clip's
    (`source_width` × `source_height`; its file is read by preflight). No size nor length is refused for the
    time it takes (0.6.248): the Studio says it before, from what this computer took (0.6.249)."""
    parameters = job['parameters']
    if sum(ref['role'] == ROLE for ref in job['references']) != 1:
        raise ValueError('A camera is changed on one video exactly')
    # (Not required by the manifest: no workflow holds them, the server gives them to the job.)
    if any(key not in parameters for key in ('azimuth', 'elevation', 'distance')):
        raise ValueError('The camera of a refilm is named by azimuth, elevation and distance')
    if ('pivot_x' in parameters) != ('pivot_y' in parameters):
        raise ValueError('The pivot is named by pivot_x and pivot_y together')
    if ('source_width' in parameters) != ('source_height' in parameters):
        raise ValueError('The size of the clip is named by source_width and source_height together')
    bounds = family['refilm']
    said = camera_refusal(*poses_of(parameters), bounds)
    if said:
        raise Refused(said)
    if 'source_width' in parameters:
        said = size_refusal(
            parameters['width'], parameters['height'], parameters['source_width'], parameters['source_height'], bounds
        )
        if said:
            raise Refused(said)


def ltx_job(job, guide, source):
    """The job LTX 2.5 makes of it: the clip filmed again with the IC-LoRA, which reads the guide, then
    the clip, in that order. Without sound: the clip's own is put back (prepare)."""
    p = job['parameters']
    converted = dict(
        schemaVersion=job['schemaVersion'],
        id=job['id'],
        pipeline='ltx25',
        mediaType='video',
        workflowId=job['workflowId'],
        workflowDigest=job['workflowDigest'],
        parameters=dict(
            prompt=p['prompt'],
            seed=p['seed'],
            width=p['width'],
            height=p['height'],
            steps=p['steps'],
            frames=p['frames'],
            fps=FPS,
            stage='final',
            audio=False,
        ),
        components={role: job['components'][role] for role in ('model', 'textEncoder', 'vae', 'audioVae')},
        loras=[dict(id=LORA_ID, path=job['components']['guideLora'], strength=p['lora_strength'])],
        references=[
            dict(input='guide', role='reference_video', path=str(guide)),
            dict(input='source', role='reference_video', path=str(source)),
        ],
    )
    if 'outputName' in job:
        converted['outputName'] = job['outputName']
    return converted


def preflight(job, config, ltx_preflight):
    """On the processor, before the chat model leaves the card: the clip read and found to be refilmed
    as the job says, the depth model's file, then everything LTX 2.5 checks of the job it makes."""
    from runner.models import moge2
    from runner.models.headers import header
    from runner.registry import family, validate_job

    bounds = family(FAMILY)['refilm']
    p = job['parameters']
    path = source_of(job)['path']
    found = examine(path, bounds)
    # What the server read of the clip in its record, against its file: another size, or fewer frames, is a
    # clip replaced since (or a record that says another), never made at a size it was not checked at. The
    # size is the clip's own (`source_width` × `source_height`), not the one it is filmed at; a job without
    # it is filmed at the clip's size cut down to multiples of 32.
    if 'source_width' in p:
        changed = (p['source_width'], p['source_height']) != (found['sourceWidth'], found['sourceHeight'])
    else:
        changed = (p['width'], p['height']) != (found['width'], found['height'])
    if changed or p['frames'] > found['covered']:
        raise Refused(SAID['changed'])
    said = size_refusal(p['width'], p['height'], found['sourceWidth'], found['sourceHeight'], bounds)
    if said:
        raise Refused(said)
    moge2.validate_layout(header(job['components']['depth']))
    ltx_preflight(validate_job(ltx_job(job, path, path)), config)


def sweep(older_than=STALE_SECONDS):
    """Removes the folders of work a stopped worker left, once they are old."""
    import shutil
    import tempfile

    now = time.time()
    for entry in Path(tempfile.gettempdir()).glob(WORK + '*'):
        try:
            if entry.is_dir() and now - entry.stat().st_mtime > older_than:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def prepare(job, config, progress, folder):
    """The guide of the clip and the job LTX 2.5 makes of it, in `folder`: (that job, finish), where
    `finish(pixels, metadata)` writes the video as this job's, with the clip's sound."""
    import gc

    import numpy as np
    import torch

    from runner import hardware
    from runner.models import kept
    from runner.registry import family
    from runner.video import camera_warp
    from runner.video.audio_tail import read_audio

    bounds = family(FAMILY)['refilm']
    p = job['parameters']
    path = source_of(job)['path']
    began = time.perf_counter()
    progress(stage='reading video to refilm')
    found = examine(path, bounds)
    # The clip at the size it is filmed at: its own cut down to multiples of 32, or a smaller one chosen in the
    # Studio, the clip shrunk to cover it (fitted). Depth, guide and LTX are all made at that size.
    size = (p['width'], p['height'])
    clip, exact = frames_of(path, found, p['frames'], size)
    # The depth of each frame, on the card: what a creation before left there leaves first when the
    # depth model would not find its room beside it.
    if hardware.free_bytes(torch) / 1024**3 < DEPTH_GIB and kept.drop():
        gc.collect()
        torch.cuda.empty_cache()
    progress(stage='estimating depth', frame=0, frames=len(clip))
    lap = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    told = lambda done, total: progress(stage='estimating depth', frame=done, frames=total)  # noqa: E731
    estimated, lenses, _scales = camera_warp.depths(clip, job['components']['depth'], told)
    depth = dict(
        seconds=round(time.perf_counter() - lap, 1),
        peakGiB=round(torch.cuda.max_memory_allocated() / 1024**3, 3),
        hfov=[round(float(value), 1) for value in np.percentile(lenses, (0, 50, 100))],
    )
    estimated = camera_warp.steady(estimated)
    fx = camera_warp.focal(p['width'], p['hfov'])
    if 'pivot_x' in p:
        pivot = camera_warp.pivot_at(estimated[0], fx, p['pivot_x'], p['pivot_y'])
    else:
        pivot = camera_warp.pivot_of(estimated[0], fx)
    end, start = poses_of(p)
    keys = [(0, *end)] if start is None else [(0, *start), (len(clip) - 1, *end)]
    moves = camera_warp.path(keys, len(clip))
    # The guide, without loss: the model reads what was drawn, magenta included.
    lap = time.perf_counter()
    guide = Path(folder) / 'guide.mkv'
    writer = camera_warp.lossless(guide, p['width'], p['height'], FPS)
    holes = []
    try:
        for index, (frame, seen, camera) in enumerate(zip(clip, estimated, camera_warp.cameras(moves, pivot))):
            picture, hole = camera_warp.warp(frame, seen, camera, fx)
            writer.send(np.ascontiguousarray(picture))
            holes.append(float(hole.mean()))
            if index % 15 == 0 or index + 1 == len(clip):
                progress(stage='drawing new camera', frame=index + 1, frames=len(clip))
    finally:
        writer.close()
    drawn = round(time.perf_counter() - lap, 1)
    del estimated
    # The clip as LTX films it: its own file when it is at 24 a second and of that size already.
    source = Path(path)
    if not exact:
        source = Path(folder) / 'source.mkv'
        writer = camera_warp.lossless(source, p['width'], p['height'], FPS)
        try:
            for frame in clip:
                writer.send(np.ascontiguousarray(frame))
        finally:
            writer.close()
    del clip
    sound = read_audio(path, 0, p['frames'] / FPS, SAMPLE_RATE) if found['audio'] else None
    audio = (np.ascontiguousarray(sound.T), SAMPLE_RATE) if sound is not None else None
    pose = lambda value: dict(azimuth=value[0], elevation=value[1], distance=value[2])  # noqa: E731
    # (Shrunk: brought to a size below its own; cut: some of its picture left out, on its edges.)
    brought = covering(found['sourceWidth'], found['sourceHeight'], *size)
    summary = dict(
        camera=pose(end),
        **({'start': pose(start)} if start is not None else {}),
        pivot=[round(float(value), 4) for value in pivot],
        **({'pivotNamed': [p['pivot_x'], p['pivot_y']]} if 'pivot_x' in p else {}),
        hfov=p['hfov'],
        loraStrength=p['lora_strength'],
        holes=dict(first=round(holes[0], 4), middle=round(holes[len(holes) // 2], 4), last=round(holes[-1], 4)),
        depth=depth,
        guideSeconds=drawn,
        source=dict(
            width=found['sourceWidth'],
            height=found['sourceHeight'],
            frames=found['sourceFrames'],
            fps=round(float(found['fps']), 3),
            timedAgain=found['fps'] != FPS,
            shrunk=brought != (found['sourceWidth'], found['sourceHeight']),
            cut=brought != size,
            sound=audio is not None,
        ),
        seconds=round(time.perf_counter() - began, 1),
    )

    def finish(pixels, metadata):
        from runner.video.export import save_video

        made = dict(metadata, job=job, parameters=p, audio=audio is not None, refilm=summary)
        # (The stage of the job LTX made: this one has none.)
        made.pop('stage', None)
        return save_video(pixels, config, job, made, audio=audio)

    return ltx_job(job, guide, source), finish


def generate(job, config, progress, run):
    """The clip filmed again: its guide in a folder of its own, then LTX 2.5 (`run`: its own generate,
    which keeps its model under this family's name and writes the video with `finish`)."""
    import shutil
    import tempfile

    sweep()
    folder = tempfile.mkdtemp(prefix=WORK)
    try:
        converted, finish = prepare(job, config, progress, folder)
        return run(converted, config, progress, name=FAMILY, finish=finish)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
