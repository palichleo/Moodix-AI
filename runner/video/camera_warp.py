"""A video as another camera would film it: each frame drawn again from its depth.

What the CrossView-Warp IC-LoRA reads beside the video it films again (runner.video.ic_reference):
every pixel of a frame put back in space with its depth, seen from the new camera and drawn there;
what the first camera did not see stays magenta, for the model to invent. The conventions are those
of the warp its author published with the LoRA (ComfyUI-CrossViewWarp, `crossview_warp_node.py`,
Apache-2.0), which mirrors how the LoRA's training warps were made, so that the model reads what it
learned from:

- the first camera at the origin, in the frame of OpenCV (x to the right, y down, z ahead);
- square pixels, fx = W / (2 tan(hfov / 2)), the centre at (W / 2, H / 2): a lens 50° wide unless
  said (MoGe's own estimate runs about 10 % short, the author measured);
- the new camera orbits a pivot: `azimuth` degrees to the right, `elevation` up, at `distance`
  times the pivot's own distance (1: as far as the first camera was); it looks where the first one
  looked (the point of its axis as far as the pivot), which is what the training data does;
- what has no depth, and the farthest half percent of a frame (the sky, the haze), is left out;
- each point is drawn as a square of 5 pixels in 25 passes, one offset each (rows then columns,
  from -2 to 2), the nearest point of a place in front within a pass and each pass over the ones
  before: the training warps are drawn so, which moves the picture 2 pixels right and down.

Written from those conventions; nothing of the node is copied. Runs on the processor: a guide
uses no video memory.
"""

import math

import numpy as np

HFOV = 50.0
SPLAT = 2
# Percentile of a frame's depth beyond which its points are left out.
FAR = 99.5
MAGENTA = np.array([255, 0, 255], dtype=np.uint8)
# Frames over which MoGe's metric scale is steadied (see `steady`).
STEADY = 12


def focal(width, hfov=HFOV):
    """The focal length, in pixels, of a lens `hfov` degrees wide on a picture `width` wide."""
    if not 20 <= hfov < 180:
        raise ValueError('A lens is 20 to 180 degrees wide')
    return width / (2 * math.tan(math.radians(hfov) / 2))


def rot_x(angle):
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def rot_y(angle):
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def look_at(eye, target):
    """The camera at `eye` looking at `target`, upright: [4, 4], its columns its right, down and
    forward axes and its place, in the frame of the first camera (y down)."""
    eye, target = np.asarray(eye, dtype=np.float64), np.asarray(target, dtype=np.float64)
    forward = target - eye
    forward = forward / (np.linalg.norm(forward) + 1e-9)
    right = np.cross([0.0, 1.0, 0.0], forward)
    if np.linalg.norm(right) < 1e-6:
        # Looking straight up or down: any axis across the view will do.
        right = np.cross([0.0, 0.0, 1.0], forward)
    right = right / (np.linalg.norm(right) + 1e-9)
    camera = np.eye(4)
    camera[:3, 0], camera[:3, 1], camera[:3, 2], camera[:3, 3] = right, np.cross(forward, right), forward, eye
    return camera


def orbit(azimuth, elevation, distance, pivot, aim=None):
    """The camera `azimuth` degrees to the right of the first one around `pivot`, `elevation`
    degrees above it, `distance` times as far from it, looking at `aim` (the pivot when None)."""
    pivot = np.asarray(pivot, dtype=np.float64)
    turn = rot_y(math.radians(-azimuth)) @ rot_x(math.radians(-elevation))
    eye = pivot + distance * (turn @ -pivot)
    return look_at(eye, pivot if aim is None else aim)


def source_aim(pivot):
    """Where the first camera looked, as far as the pivot: the point of its axis."""
    return np.array([0.0, 0.0, max(float(np.linalg.norm(pivot)), 1e-3)])


def path(keys, count, easing='linear'):
    """The (azimuth, elevation, distance) of each of `count` frames along `keys`, a list of
    (frame, azimuth, elevation, distance) with frames counted from 0. Before the first key and
    after the last, the camera holds; between two, it moves `easing` ('linear', or 'ease': slow
    at each key). Azimuths go the short way round."""
    keys = sorted(keys)
    if not keys:
        raise ValueError('A camera path needs at least one key')
    if len({key[0] for key in keys}) != len(keys):
        raise ValueError('Two keys of a camera path share a frame')
    azimuths = [float(keys[0][1])]
    for key in keys[1:]:
        azimuths.append(azimuths[-1] + (float(key[1]) - azimuths[-1] + 180.0) % 360.0 - 180.0)
    frames = [key[0] for key in keys]
    found = []
    for frame in range(count):
        if frame <= frames[0] or len(keys) == 1:
            place, ratio = 0, 0.0
        elif frame >= frames[-1]:
            place, ratio = len(keys) - 2, 1.0
        else:
            place = max(index for index, start in enumerate(frames[:-1]) if start <= frame)
            ratio = (frame - frames[place]) / (frames[place + 1] - frames[place])
        if easing == 'ease':
            ratio = 0.5 - 0.5 * math.cos(math.pi * ratio)
        elif easing != 'linear':
            raise ValueError('Unknown easing: ' + str(easing))
        following = min(place + 1, len(keys) - 1)

        def between(first, second):
            return first + (second - first) * ratio

        azimuth = (between(azimuths[place], azimuths[following]) + 180.0) % 360.0 - 180.0
        elevation = between(float(keys[place][2]), float(keys[following][2]))
        distance = between(float(keys[place][3]), float(keys[following][3]))
        found.append((azimuth, min(90.0, max(-90.0, elevation)), min(3.0, max(0.1, distance))))
    return found


def points(depth, fx):
    """The point in space of each pixel, [H, W, 3], from its depth [H, W] (the first camera's)."""
    height, width = depth.shape
    rows, columns = np.mgrid[0:height, 0:width]
    z = depth.astype(np.float64)
    return np.stack(((columns - width / 2) / fx * z, (rows - height / 2) / fx * z, z), -1)


def pivot_of(depth, fx):
    """The point the camera turns around: the median of the points in the middle of the first
    frame (rows H/8 to 4H/5, columns W/5 to 4W/5), its farthest 5 % left out."""
    height, width = depth.shape
    middle = np.zeros(depth.shape, dtype=bool)
    middle[height // 8 : 4 * height // 5, width // 5 : 4 * width // 5] = True
    valid = np.isfinite(depth) & (depth > 0) & middle
    if not valid.any():
        raise ValueError('The middle of the first frame has no depth')
    valid &= depth <= np.percentile(depth[valid], 95.0)
    return np.median(points(depth, fx)[valid], axis=0)


def pivot_at(depth, fx, x, y, radius=0.1):
    """The point the camera turns around when it is named on the first frame: `x` and `y` its place,
    fractions of the frame's width and height from its top left. The median of the points within
    `radius` of the frame around it (a tenth of its width and of its height each side), its farthest
    5 % left out: a subject on the side of the frame, which the middle would miss."""
    if not (0 <= x <= 1 and 0 <= y <= 1):
        raise ValueError('The pivot is named by fractions of the frame, from 0 to 1')
    height, width = depth.shape
    rows = slice(max(0, round((y - radius) * height)), max(1, round((y + radius) * height)))
    columns = slice(max(0, round((x - radius) * width)), max(1, round((x + radius) * width)))
    near = np.zeros(depth.shape, dtype=bool)
    near[rows, columns] = True
    valid = np.isfinite(depth) & (depth > 0) & near
    if not valid.any():
        raise ValueError('The point named on the first frame has no depth')
    valid &= depth <= np.percentile(depth[valid], 95.0)
    return np.median(points(depth, fx)[valid], axis=0)


def steady(depths, radius=STEADY):
    """Depths whose scale holds from frame to frame. MoGe gives each frame its own metric scale,
    and it flickers (the author measured 1.2 % on average, up to 6 %, on a still shot), which shakes
    the guide: each frame is scaled so that its median depth is the median of the medians of the
    frames around it, `radius` on each side. A slow real change (a camera that moves) stays."""
    medians = np.array([np.nanmedian(depth) for depth in depths])
    found = []
    for index, depth in enumerate(depths):
        target = np.median(medians[max(0, index - radius) : index + radius + 1])
        found.append(depth * (target / medians[index]))
    return found


def warp(rgb, depth, camera, fx, splat=SPLAT):
    """The frame `rgb` [H, W, 3] uint8 seen by `camera` (as `orbit` gives it), from its depth
    [H, W] (in the units of the camera's place; NaN or 0 where there is none): the picture
    [H, W, 3] uint8, magenta where nothing was seen, and those holes [H, W] (bool)."""
    height, width = depth.shape
    z = np.asarray(depth, dtype=np.float64)
    valid = np.isfinite(z) & (z > 0)
    if valid.any():
        valid &= z <= np.percentile(z[valid], FAR)
    inverse = np.linalg.inv(camera)
    seen = points(np.where(valid, z, 0.0), fx).reshape(-1, 3) @ inverse[:3, :3].T + inverse[:3, 3]
    ahead = seen[:, 2]
    keep = valid.ravel() & (ahead > 1e-9)
    with np.errstate(divide='ignore', invalid='ignore', over='ignore'):
        column = seen[:, 0] / ahead * fx + width / 2
        row = seen[:, 1] / ahead * fx + height / 2
    # Drawn a little beyond the frame too: a point just outside reaches into it by its square.
    keep &= np.isfinite(column) & np.isfinite(row)
    keep &= (column > -splat - 1) & (column < width + splat) & (row > -splat - 1) & (row < height + splat)
    column, row, ahead = np.round(column[keep]).astype(np.int64), np.round(row[keep]).astype(np.int64), ahead[keep]
    colours = rgb.reshape(-1, 3)[keep]
    inside = (column >= -splat) & (column < width + splat) & (row >= -splat) & (row < height + splat)
    column, row, ahead, colours = column[inside], row[inside], ahead[inside], colours[inside]
    # Each place of a canvas `splat` wider on every side takes its nearest point.
    span = width + 2 * splat
    place = (row + splat) * span + (column + splat)
    order = np.lexsort((ahead, place))
    first = np.ones(order.shape, dtype=bool)
    first[1:] = place[order][1:] != place[order][:-1]
    nearest = order[first]
    canvas = np.zeros(((height + 2 * splat) * span, 3), dtype=np.uint8)
    covered = np.zeros((height + 2 * splat) * span, dtype=bool)
    canvas[place[nearest]] = colours[nearest]
    covered[place[nearest]] = True
    canvas = canvas.reshape(height + 2 * splat, span, 3)
    covered = covered.reshape(height + 2 * splat, span)
    # The passes: each draws every point moved by one offset, over what the passes before drew.
    picture = np.empty((height, width, 3), dtype=np.uint8)
    picture[:] = MAGENTA
    filled = np.zeros((height, width), dtype=bool)
    for dy in range(-splat, splat + 1):
        for dx in range(-splat, splat + 1):
            window = (slice(splat - dy, splat - dy + height), slice(splat - dx, splat - dx + width))
            hit = covered[window]
            picture[hit] = canvas[window][hit]
            filled |= hit
    return picture, ~filled


def cameras(moves, pivot):
    """The camera of each frame for `moves` (from `path`), around `pivot`, keeping the first
    camera's aim."""
    aim = source_aim(pivot)
    return [orbit(azimuth, elevation, distance, pivot, aim) for azimuth, elevation, distance in moves]


def lossless(path, width, height, fps):
    """A writer that keeps RGB frames exactly (H.264 in RGB, quantizer 0): `send` each frame
    [H, W, 3] uint8, then `close`. The guide the model reads is what was drawn, magenta included:
    the 4:2:0 colours of the usual videos would bleed it over its edges."""
    import imageio_ffmpeg

    writer = imageio_ffmpeg.write_frames(
        str(path),
        (width, height),
        fps=float(fps),
        codec='libx264rgb',
        pix_fmt_in='rgb24',
        pix_fmt_out='rgb24',
        # (Without it, the library would add a constant rate factor beside the quantizer.)
        quality=None,
        macro_block_size=1,
        output_params=['-qp', '0'],
    )
    writer.send(None)
    return writer


def depths(frames, moge_path, progress=None):
    """MoGe-2's metric depth of each frame (NaN where it sees none: the sky), its own estimate of
    the lens (degrees) and its metric scale, frame by frame; on the GPU, one frame at a time.
    `progress(done, total)` is told every fifteen frames and at the last."""
    import torch

    from runner.models import moge2

    model = moge2.load(moge_path, 'cuda')
    found, lenses, scales = [], [], []
    try:
        for index, frame in enumerate(frames):
            result = moge2.estimate(model, frame)
            found.append(result['depth'])
            lenses.append(result['hfov'])
            scales.append(result['scale'])
            if progress and (index % 15 == 0 or index + 1 == len(frames)):
                progress(index + 1, len(frames))
    finally:
        del model
        torch.cuda.empty_cache()
    return found, lenses, scales
