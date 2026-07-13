#!/usr/bin/env bash
set -euo pipefail

# Rebuild the committed, non-PHI voice fixture used by prod Playwright.
# The test always uploads the checked-in WAV; this script documents and
# reproduces its synthetic source without recording a real person.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_path="${1:-${script_dir}/synthetic-voice.wav}"
work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

command -v espeak-ng >/dev/null || {
  echo "espeak-ng is required to generate the synthetic voice fixture." >&2
  exit 1
}
command -v ffmpeg >/dev/null || {
  echo "ffmpeg is required to generate the synthetic voice fixture." >&2
  exit 1
}

required_espeak_version="1.52.0"
required_ffmpeg_version="7.1.1-1ubuntu1.3"
espeak_version="$(espeak-ng --version 2>&1 | sed -n '1s/^eSpeak NG text-to-speech: \([^ ]*\).*/\1/p')"
ffmpeg_version="$(ffmpeg -version | sed -n '1s/^ffmpeg version \([^ ]*\).*/\1/p')"
if [[ "${espeak_version}" != "${required_espeak_version}" || "${ffmpeg_version}" != "${required_ffmpeg_version}" ]]; then
  echo "Fixture generation requires espeak-ng ${required_espeak_version} and ffmpeg ${required_ffmpeg_version}." >&2
  echo "Found espeak-ng ${espeak_version:-unknown} and ffmpeg ${ffmpeg_version:-unknown}." >&2
  exit 1
fi

LC_ALL=C espeak-ng \
  -D \
  -v en-us \
  -s 135 \
  -p 45 \
  -a 160 \
  -g 8 \
  --stdout \
  "This is a synthetic Spine Sense test recording. The transcription service is working correctly." \
  >"${work_dir}/source.wav"

ffmpeg -hide_banner -loglevel error -y \
  -i "${work_dir}/source.wav" \
  -ac 1 \
  -ar 16000 \
  -c:a pcm_s16le \
  -fflags +bitexact \
  -flags:a +bitexact \
  -map_metadata -1 \
  "${output_path}"

echo "Generated ${output_path}"
