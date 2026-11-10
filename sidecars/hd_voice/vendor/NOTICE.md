# HD voice: third-party code and data

Kairos's HD voice (core/hd_voice.py, sidecars/hd_voice/server.py) runs Qwen3-TTS 0.6B with code copied into this
folder and reviewed line by line for network, process and file access before it was copied (2026-11-10). It runs only
in the HD voice sidecar, never inside the app's own Python runtime.

## qwen_tts/ (Apache-2.0)

The Qwen3-TTS model, processor and 12 Hz speech tokenizer code by the Alibaba Qwen team
(https://github.com/QwenLM/Qwen3-TTS), as packaged in **qwen-tts-hf 0.1.1.post1** (PyPI; an unofficial build of the
same code with the Transformers 5 patch from QwenLM/Qwen3-TTS#360, maintained by Andres Marafioti). Licence:
Apache License 2.0, full text in `LICENSE-qwen-tts.txt`. Copyright 2026 The Alibaba Qwen team.

Changes made by Kairos (every changed file carries a note at its top):
- Only the parts the 0.6B 12 Hz models use are kept: the 25 Hz tokenizer, the Gradio demo and the command line are
  left out, and `core/__init__.py` no longer imports the 25 Hz tokenizer.
- No network: the Hugging Face download helper in `core/models/modeling_qwen3_tts.py` raises instead of downloading,
  and audio can no longer be read from URLs or base64 strings (`inference/qwen3_tts_model.py`,
  `inference/qwen3_tts_tokenizer.py`): only local 16-bit WAV files and (array, rate) pairs.
- No librosa and no soundfile: `_audio.py` (new, Kairos) reads WAV files with the standard library, resamples with
  linear interpolation (never used: everything is 24 kHz), and builds the Slaney mel filter bank, which matches
  `librosa.filters.mel` to within 4e-9.
- Two `print` warnings became log warnings.

## qwen_fast/ (MIT)

The CUDA-graph runner from **faster-qwen3-tts 0.5.4** by Andres Marafioti (https://github.com/andimarafioti/faster-qwen3-tts),
MIT licence, full text in `LICENSE-faster-qwen3-tts.txt`. Copyright (c) 2026 Andres Marafioti. Renamed from
`faster_qwen3_tts` so it cannot be mistaken for the package.

Changes made by Kairos:
- Only the PyTorch CUDA-graph backend is kept: the GGML backend and the command line are left out.
- The reference clip is read with `qwen_tts/_audio.py` instead of soundfile.
- `streaming.py`: the first 8 codec frames of a sentence are handed out in pieces of 2 frames instead of 4, so the
  first sound arrives sooner (measured on an RTX 4090: about 140 to 250 ms to the first trimmed audio).

## Model weights (downloaded on request, not in this folder)

- Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice @85e237c1 and Qwen/Qwen3-TTS-12Hz-0.6B-Base @5d839924 (Hugging Face),
  Apache-2.0. Pinned by SHA-256 in `core/hd_voice_manifest.json`.

## The Iris voice clip (downloaded on request)

- kyutai/tts-voices `voice-donations/3973.wav` @323332d3 (Hugging Face): a volunteer's voice donated to the Unmute
  Voice Donation Project and published by Kyutai under **CC0** (the repository README, voice-donations section). The
  clip's own words are the donor's consent to voice cloning. Kairos clones it with the Base model as the Iris voice.
  Other folders of that repository carry other licences (expresso is non-commercial); only this CC0 clip is used.

## Python packages (downloaded on request into the HD voice environment)

PyTorch 2.9.1 with CUDA 12.8 (BSD-3-Clause, with the NVIDIA CUDA runtime libraries it bundles under NVIDIA's own
licence terms), Transformers 5.15.1 (Apache-2.0), Accelerate 1.12.0 (Apache-2.0), huggingface_hub 1.33.0
(Apache-2.0), tokenizers 0.22.2 (Apache-2.0), safetensors 0.8.0 (Apache-2.0), NumPy 2.5.4 (BSD-3-Clause and others),
and their small dependencies (filelock, typing_extensions, sympy, mpmath, networkx, Jinja2, MarkupSafe, fsspec, httpx,
httpcore, h11, anyio, idna, certifi (MPL-2.0), click, packaging, PyYAML, regex, tqdm, colorama, psutil): MIT, BSD,
Apache-2.0, PSF-2.0 or MPL-2.0, each as published on PyPI. Exact files and hashes: `core/hd_voice_manifest.json`.
