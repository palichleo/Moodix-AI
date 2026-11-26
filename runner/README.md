# Moodix's generation engine

This folder is Moodix's own generation engine: local PyTorch/Diffusers pipelines, started by the Node server. It never imports the ComfyUI runtime; the separate `comfy-kitchen` package only supplies CUDA INT8 kernels.

The Node server owns one Python worker (`python -m runner --config …`), idle on the processor between two jobs. Before a generation the server validates the resolved job, unloads a local chat model and its vision projector, runs the pipeline, checks that video memory was released, then reloads the chat model. Cancelling terminates and reaps the worker. A worker failure does not close the chat server.

## What runs here

A family (`runner/families/*.json`) describes a model: its components, its settings, the tasks it takes and the hardware it needs. Its pipeline is in `runner/pipelines/`, its model code in `runner/models/`, and what videos share (frames, continuation, export, sound) in `runner/video/`.

| Family | Tasks | Needs an NVIDIA card |
| --- | --- | --- |
| Krea 2 | images, edits of an image | yes |
| MOSS Image | images: posters, layouts, written text | yes |
| Qwen-Image-Edit (`qwen_image_edit`; 0.6.264: Qwen-Image-Edit-2511 and its Lightning LoRA, 8 steps; in the Studio, offered to Moodix AI only once « Proposé à Moodix AI » is switched on) | an image modified with words, from one to three images | yes |
| LTX 2.5 | videos with sound, continuations | yes |
| MiniMax H3 | videos with sound, continuations | yes |
| Wan 2.1 SCAIL-2 | a character replaced in a video; the character of an image animated by a video (`mode: animate`, 0.6.185: the engine only, not asked by the application yet) | yes |
| Wan 2.2 | an image animated (image to video, two models) | yes |
| Wan 2.2 Caméra (`wan22_camera`; shipped since 0.6.223, its two files converted to INT8 on the user's computer once downloaded) | an image animated along a camera movement that is named: Wan 2.2 Fun Camera, the two models of Wan 2.2 with an adapter that reads where the camera is at each frame (`runner/video/camera.py`) | yes |
| Changer la caméra (`ltx25_refilm`; 0.6.242, asked by hand in the Studio only) | a video made filmed again from another camera, its scene, gestures and sound kept: the depth of each frame by MoGe-2 (`runner/models/moge2.py`), the clip drawn from the new camera (`runner/video/camera_warp.py`), then LTX 2.5 with the CrossView-Warp IC-LoRA and its two reference videos (`runner/video/refilm.py`) | yes |
| SeedVR2 | image upscaling and restoration | yes |
| Real-ESRGAN (image, video) | upscaling | no |
| RIFE | frame interpolation | no |
| ACE-Step 1.5 | music | no |
| MOSS-SoundEffect v2 | sound effects | no |

Every family has its pipeline here, **MOSS Image** included since 0.6.124 (`runner/pipelines/moss.py`): no other program is asked for a creation.

The workflows shipped with Moodix are the JSON files of `runner/workflows/`, replaced by updates; `runner/workflow-history.json` lists the fingerprints of their earlier versions, so that a copy the user never edited follows the new one. The user's own workflows and edits live in `workflow/` at the root (`npm run ship-workflows` publishes them into `runner/workflows/`). `runner/downloads.json` says where each file of a shipped workflow can be downloaded from, with its size, its SHA-256 and its license.

## Setup

On Windows and Linux x64, Moodix prepares a private Python 3.13 environment and its libraries in `data/runtime/` the first time generation needs it. No system Python is required or modified: Python is not registered with Windows and the system PATH is not changed. The first setup downloads several GB; later launches reuse the environment. The chat stays available meanwhile.

The [uv-managed Python installation](https://docs.astral.sh/uv/guides/install-python/) and the versions of the libraries are pinned: `pyproject.toml` declares the supported packages, and `uv.lock` locks their transitive dependencies and wheel hashes. PyTorch comes from the official CUDA 13.0 wheel index. Python, uv, libraries, temporary files and caches stay in `data/`, which Git ignores and updates preserve.

At every start `uv sync --locked` makes sure each locked package is installed. The libraries are then imported in a process of its own (7 s) to make sure they open: once per lock, and again whenever uv installed or removed something; while nothing changed and the engine imports its libraries as it starts, that import is left to the engine (0.6.110), which says when one does not open. The application then makes the whole check again.

After an application update, the libraries are checked by the new version, once its sources (including `pyproject.toml` and `uv.lock`) are in place. Synchronization keeps the same `data/runtime/venv`, installs only the missing or changed locked packages and reuses the others. If it is interrupted, the chat stays available, generation stays unavailable until it succeeds, and a later launch tries again.

For a release that changes the libraries, update `pyproject.toml`, regenerate `uv.lock` with `uv lock --project runner`, test and publish both files together. Startup uses `uv sync --locked`: a stale or missing lockfile produces a visible environment error instead of resolving untested versions on the user's computer.

The worker starts offline (`HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`) and with `-s`, apart from the user's own Python packages. It downloads nothing: model files are downloaded by the Node server, and only when the user asks.

## Diagnosis

Each stage of a generation (time, video memory, what failed) is appended to `data/generation-journal.jsonl` as it happens, so a generation that hangs, fails or is cancelled can be read afterwards; the file keeps the recent ones. `data/runner-errors.log` keeps the tracebacks.

## Measurements

`python -s -m runner.bench <family> …` runs a pipeline alone, outside the application, to measure it (see the top of `bench.py`).

Measured in November 2026 on the development RTX 4070 Super (12 GB), with INT8 ConvRot model files. These are local measurements, not guarantees:

| Pipeline | Case | Pipeline time | Peak torch VRAM |
| --- | --- | --- | --- |
| Krea 2 | 512², 8 steps, three LoRAs | 16.68 s | 7.597 GiB |
| Krea 2 | 1448², 8 steps, three LoRAs | 36.45 s | 8.199 GiB |
| LTX 2.5 distilled | 384×256, 25 frames, 24 fps, 8 steps | 65.99 s | 6.634 GiB |
| LTX 2.5 distilled | Same size, start and end images | 65.14 s | 7.308 GiB |
| LTX 2.5 distilled | Video with 48 kHz stereo sound, 384×256 | 68.14 s | 6.634 GiB |
| LTX 2.5 distilled | 768×512, 25 frames | 108.22 s | 6.779 GiB |
| LTX 2.5 distilled | 896×1600, 121 frames with sound, start image, two passes | 192 s | under the 12 GB of the card |
| LTX 2.5 distilled | 896×1600, 193 frames (8 s) with sound, start image, two passes (17 Nov, 0.6.74) | 184 s | 8.76 GiB |
| LTX 2.5 distilled | 896×1600, 121 frames with sound, from text, two passes (17 Nov, 0.6.74) | 96 s | 8.67 GiB |
| Qwen-Image-Edit 2511 | 768×1344, 8 steps (Lightning), the angles LoRA, one image given: the first image of the engine (24 Nov, 0.6.265) | 35.5 to 36.9 s | 7.87 GiB |
| Qwen-Image-Edit 2511 | Same, the model kept on the card: a new angle (its prompt read beside it) | 19.0 to 21.8 s | 8.71 GiB |
| Qwen-Image-Edit 2511 | Same, the same angle again (prompt, image and modulations kept on the disk) | 14.4 to 14.9 s | 7.87 GiB |

Startup, the state of the disk cache and the first compilation of the kernels change the total time.

The Qwen-Image-Edit lines compare with the trial of 23 November: diffusers as it is, with the same files, angles, seed and 8 steps, gave 34.4 s for its first image and then 23 s an image (2.6 to 2.9 s a step, against 1.67 s here), with its prompts already read. The engine's images keep the trial's framing and subjects, their details differ (PSNR 22 to 34 dB to the trial's), and they are the same from one run to the next. comfy-kitchen's INT8 attention (`INT8_ATTENTION`) takes a step to 1.29 to 1.35 s (11.8 to 12.0 s for the last line, 14.8 to 17.4 s for a new angle), but its images are further from the trial's (PSNR 20 to 28 dB): it stays off until they are judged.

The two lines of 17 November were measured once the embedding of a timestep was kept once per different timestep instead of once per token (`runner/models/ltx25_block.py`): before it, the copies of these embeddings took 7.5 GiB for the 35 000 tokens of the 8-second video, whose refining pass ran out of the memory of the card.

**Large LTX 2.5 videos run in two passes**, as the model's own recipe does, when the optional `upscaler` component (the ×2 latent spatial upscaler) is set and the shorter side is at least 512 px: eight steps at half the size, the latents doubled by the upscaler, then three steps at the full size with the start image held exactly. On the 12 GB card at 896×1600, 121 frames: 48 s for the first pass, 65 s for the three full-size steps, 60 s to decode. Without the upscaler the eight steps run at the full size: several times slower, and beyond what 12 GB holds at this size.

The distilled LTX 2.5 pipeline takes 8 steps, CFG 1, dimensions divisible by 32 and frame counts of 8n+1. Its audio VAE is required even when no sound is exported.

## Formats of a model file

The engine reads safetensors files, in the precision they store: INT8 ConvRot (the note `.comfy_quant` beside each layer), 8-bit floats (« fp8 scaled » or not), 16 and 32-bit floats. On an RTX 4070 Super the INT8 files are the fast ones: a layer computes three times faster from 8-bit integers than from floats, whatever the floats were stored as (LTX 2.5: 1.25 s a step against 2.74 s from an « fp8 scaled » file), and INT8 ConvRot rounds less than 8-bit floats do (measured on 19 November 2026).

`python -s -m runner.convert SOURCE TARGET.safetensors` writes any 8-bit file again as INT8 ConvRot: an « fp8 scaled » safetensors file, or a GGUF file (Q8_0, Q4_0, Q4_1, Q5_0, Q5_1, Q4_K, Q5_K, Q6_K; `runner/models/gguf.py` reads them without llama.cpp). 20 GiB of LTX 2.5 take 40 s. GGUF files are not read in place: they are converted first. With `--device cpu` it runs on the processor (86 s for 14 GiB of Wan 2.2 Fun Camera, 30 s on the card): what the application does of a file it downloaded in a format the engine does not read (`convert` in `downloads.json`, `lib/model-downloads.mjs`), so that the card stays with whatever holds it.

## Checks

From the root of the repository, with the interpreter of the private environment (`data/runtime/venv/Scripts/python.exe` on Windows, `data/runtime/venv/bin/python` on Linux):

```sh
python -s -m unittest discover -s runner/tests
```

The tests need no graphics card and no model file. Code style: `ruff format --config runner/pyproject.toml` on the files you touch (lines of 120 characters at most).

Generation on Linux has not been tried on a real card yet.
