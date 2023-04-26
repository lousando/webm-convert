# webm-convert

A wrapper for `ffmpeg` to easily convert most file types to WebM format using
the newer VP9 codec.

## Usage

```bash
Usage: 
webm-convert <input_file_1> [input_file_2]...
```

Note: Files currently output relative to the working in the inside a directory.
e.g. `video_name/video_name.webm`

# Install

Using Deno

```bash
deno install -rf --allow-read --allow-write --allow-run --allow-env --allow-net -n webm-convert https://git.lousando.xyz/lousando/webm-convert/raw/branch/master/mod.ts
```

# Config

If a config file isn't found at runtime, a new one will be generated at
`$HOME/.webm-convert.json`
