"""A camera movement as a model reads it: where the camera is at each frame, then the line of
sight of each pixel.

Wan 2.2 Fun Camera (runner.models.wan22, its `control_adapter`) is given the camera of every frame
of the video it draws: for each pixel, the line through the centre of the camera and that pixel, as
six numbers (its Plücker coordinates: the moment `centre x direction`, then the direction). Written
after VideoX-Fun (github.com/aigc-apps/VideoX-Fun, Apache-2.0: `process_pose_file` and
`ray_condition` of `videox_fun/data/utils.py`, the grouping of
`videox_fun/pipeline/pipeline_wan2_2_fun_control.py`, the movements of `asset/*.txt`), whose rays
are those of CameraCtrl (github.com/hehao13/CameraCtrl, Apache-2.0, `inference.py`).

The camera is OpenCV's: x to the right, y down, z forward. A pose is the camera as seen from where
it was at the first frame, a 4 x 4 matrix [R | C]: the directions of its three axes, and its
centre. The first pose is always the identity.

Distances have no unit a scene could be measured with: the model learnt what the movements of
VideoX-Fun look like, which go 1.5 to the side or upwards and 3 forwards in 81 frames, and a
distance is to be read against those.

Two kinds of movement are told apart, by what is known of them:

- those VideoX-Fun ships and documents, the camera moving without turning (it names them « Pan
  Left », « Pan Up », « Zoom In »: they are a truck, a crane and a dolly): `dolly_*`, `truck_*`,
  `crane_*`, `static`. Their poses are the published ones, number for number;
- those written here for the same reading, the camera turning (`pan_*`, `tilt_*`) or going round a
  point in front of it while looking at it (`orbit_*`). Nothing published says how well the model
  follows them: they are to be judged on the videos. Judged so far, on the real videos of
  22/11/2026: `orbit_left`, by the user (« Oui, elle tourne »: the camera goes round the subject,
  where the same words in a prompt left it still); `pan_left` slides the picture as far as its 30
  degrees say (282 px of 768), which he has not judged. The others were never drawn.

Any other path is a list of poses given to `rays`: the adapter reads poses, not names.
"""

import math

# The frames a movement covers its whole distance in, at a speed of 1: VideoX-Fun's files hold 81
# poses, the i-th at i / 81 of the way. A shorter clip stops earlier on the same path.
SPAN = 81
# How far the camera goes in `SPAN` frames (VideoX-Fun: 1.5 times a unit to the side or upwards,
# times two units forwards).
SIDE = 1.5
FORWARD = 3.0
# How far it turns: on itself, to the side (a third of the width of the picture goes by) and
# upwards; round a point, which is then `PIVOT` away, so that it goes as far to the side as a truck.
TURN = 30.0
LIFT = 20.0
ROUND = 30.0
PIVOT = SIDE / math.sin(math.radians(ROUND))
# The focal length over the height of a 16:9 picture: VideoX-Fun's files say 0.532139961 of the
# width and 0.946026558 of the height of a picture of 1280 x 720.
FOCAL = 0.946026558
WIDE = 16 / 9

# Each movement: where the centre goes (`shift`, to the right, down, forwards), how far the camera
# turns on itself to the right (`yaw`) and upwards (`pitch`), in degrees, or how far it goes round
# the point in front of it, to the left (`round`).
MOVES = {
    'static': {},
    'dolly_in': dict(shift=(0.0, 0.0, FORWARD)),
    'dolly_out': dict(shift=(0.0, 0.0, -FORWARD)),
    'truck_left': dict(shift=(-SIDE, 0.0, 0.0)),
    'truck_right': dict(shift=(SIDE, 0.0, 0.0)),
    'crane_up': dict(shift=(0.0, -SIDE, 0.0)),
    'crane_down': dict(shift=(0.0, SIDE, 0.0)),
    'pan_left': dict(yaw=-TURN),
    'pan_right': dict(yaw=TURN),
    'tilt_up': dict(pitch=LIFT),
    'tilt_down': dict(pitch=-LIFT),
    'orbit_left': dict(round=ROUND),
    'orbit_right': dict(round=-ROUND),
}
# Those VideoX-Fun documents, under the names it gives them.
PUBLISHED = {
    'static': 'Static',
    'dolly_in': 'Zoom In',
    'dolly_out': 'Zoom Out',
    'truck_left': 'Pan Left',
    'truck_right': 'Pan Right',
    'crane_up': 'Pan Up',
    'crane_down': 'Pan Down',
}


def _turned(yaw=0.0, pitch=0.0):
    """The axes of a camera turned `yaw` radians to the right, then `pitch` upwards."""
    cos, sin = math.cos(yaw), math.sin(yaw)
    aside = ((cos, 0.0, sin), (0.0, 1.0, 0.0), (-sin, 0.0, cos))
    cos, sin = math.cos(pitch), math.sin(pitch)
    up = ((1.0, 0.0, 0.0), (0.0, cos, -sin), (0.0, sin, cos))
    return [[sum(aside[row][k] * up[k][column] for k in range(3)) for column in range(3)] for row in range(3)]


def pose(move, done):
    """The camera of `move` once it has gone `done` of its way (1: all of it; more: further on the
    same path), 4 rows of 4 numbers."""
    if move not in MOVES:
        raise ValueError('Unknown camera movement: ' + str(move))
    how = MOVES[move]
    if 'round' in how:
        # Round the point `PIVOT` ahead, the camera turned towards it all the way.
        angle = math.radians(how['round']) * done
        axes = _turned(yaw=angle)
        centre = (-PIVOT * math.sin(angle), 0.0, PIVOT * (1 - math.cos(angle)))
    else:
        axes = _turned(math.radians(how.get('yaw', 0.0)) * done, math.radians(how.get('pitch', 0.0)) * done)
        centre = tuple(value * done for value in how.get('shift', (0.0, 0.0, 0.0)))
    return [[*axes[row], centre[row]] for row in range(3)] + [[0.0, 0.0, 0.0, 1.0]]


def poses(move, frames, speed=1.0):
    """The camera at each of `frames` frames, [frames, 4, 4] in float32: the i-th has gone
    i / 81 of the way, times `speed`."""
    import torch

    if not math.isfinite(speed) or speed <= 0:
        raise ValueError('A camera speed is a number above 0')
    return torch.tensor([pose(move, index / SPAN * speed) for index in range(frames)], dtype=torch.float32)


def focal(width, height):
    """The focal length, in pixels, of the camera of a picture: the one VideoX-Fun reads its poses
    with, a 16:9 view that covers the picture (the same in both directions)."""
    return FOCAL * max(height, width / WIDE)


def rays(cameras, width, height):
    """The line of sight of every pixel of every camera, [cameras, 6, height, width]: the moment
    (three numbers), then the direction (three), in the frame of the first camera.

    `cameras` is [count, 4, 4], poses as `poses` gives them or any other path. A pixel is seen
    through its centre; the picture's own centre is on the axis of the camera."""
    import torch

    cameras = torch.as_tensor(cameras, dtype=torch.float32)
    if cameras.ndim != 3 or tuple(cameras.shape[1:]) != (4, 4):
        raise ValueError('Camera poses are 4 x 4 matrices')
    kind = dict(dtype=torch.float32, device=cameras.device)
    length = focal(width, height)
    across = (torch.arange(width, **kind) + 0.5 - width / 2) / length
    down = (torch.arange(height, **kind) + 0.5 - height / 2) / length
    seen = torch.stack(
        [across.expand(height, width), down[:, None].expand(height, width), torch.ones(height, width, **kind)], dim=-1
    )
    seen = seen / seen.norm(dim=-1, keepdim=True)
    directions = torch.einsum('cij,hwj->chwi', cameras[:, :3, :3], seen)
    centres = cameras[:, None, None, :3, 3].expand_as(directions)
    moments = torch.linalg.cross(centres, directions, dim=-1)
    return torch.cat([moments, directions], dim=-1).permute(0, 3, 1, 2).contiguous()


def places(frames):
    """Which frame each of the four places of a latent frame reads, [latent frames][4]: the first
    frame four times (the VAE keeps it alone), then the others four by four."""
    if frames % 4 != 1:
        raise ValueError('A camera is read over 4n + 1 frames')
    order = [0, 0, 0, *range(frames)]
    return [order[start : start + 4] for start in range(0, len(order), 4)]


def grouped(cameras, width, height, first=0, count=None, dtype=None):
    """What the adapter reads for `count` latent frames from `first` on, [count, 24, height,
    width]: for each of the six numbers of a line of sight, its four frames one after the other.

    Asked a few latent frames at a time: 81 frames at 768 x 448 are 660 MB of rays in float32."""
    import torch

    cameras = torch.as_tensor(cameras, dtype=torch.float32)
    wanted = places(cameras.shape[0])[first : None if count is None else first + count]
    found = []
    for frames in wanted:
        four = rays(cameras[frames], width, height)
        # [4, 6, height, width] to [6 x 4, height, width]: the numbers first, their frames within.
        found.append(four.transpose(0, 1).reshape(-1, height, width))
    result = torch.stack(found) if found else torch.empty(0, 24, height, width, device=cameras.device)
    return result if dtype is None else result.to(dtype)
