# webm-convert

A wrapper for `ffmpeg` to easily convert most file types to WebM format using
the newer VP9 codec.

## Usage

```bash
Options:
  -r, --resolution  the input resolution of the video file/s
                                       [required] [choices: 360, 480, 720, 1080]
  -i, --input       glob pattern matching file/s                      [required]
```

Note: Files currently output relative to the working in the inside a directory.
e.g. `video_name/video_name.webm`

# Install

Using Deno

```bash
deno install -rf --allow-read --allow-write --allow-run --allow-env --allow-net -n webm-convert http://git.lousando.xyz:8929/lousando/webm-convert/raw/branch/master/mod.ts
```

# Config

If a config file isn't found at runtime, a new one will be generated at
`$HOME/.webm-convert.json`
