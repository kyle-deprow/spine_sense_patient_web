#!/usr/bin/env bash
set -euo pipefail

# Rebuild the committed, non-PHI voice fixture used by prod Playwright.
# The test always uploads the checked-in WAV; this script documents and
# reproduces its synthetic source without recording a real person.

# Variant "long" rebuilds the >2 minute fixture used by the long-audio
# streaming test. Its narrative lives beside it in synthetic-voice-long.txt so
# the word count the spec derives its floors from stays in version control.
variant="${1:-short}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${variant}" in
  short) output_path="${2:-${script_dir}/synthetic-voice.wav}" ;;
  long) output_path="${2:-${script_dir}/synthetic-voice-long.wav}" ;;
  *) echo "usage: $0 [short|long] [output.wav]" >&2; exit 2 ;;
esac
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

if [[ "${variant}" == "long" ]]; then
  narrative_path="${script_dir}/synthetic-voice-long.txt"
  [[ -f "${narrative_path}" ]] || {
    echo "Missing narrative source ${narrative_path}." >&2
    exit 1
  }
  # -f, not a shell argument: the long narrative exceeds comfortable argv use.
  LC_ALL=C espeak-ng -D -v en-us -s 135 -p 45 -a 160 -g 8 --stdout \
    -f "${narrative_path}" \
    >"${work_dir}/source.wav"
else
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
fi

ffmpeg -hide_banner -loglevel error -y \
  -i "${work_dir}/source.wav" \
  -ac 1 \
  -ar 16000 \
  -c:a pcm_s16le \
  -fflags +bitexact \
  -flags:a +bitexact \
  -map_metadata -1 \
  "${output_path}"

if [[ "${variant}" == "long" ]]; then
  # The spec derives its word-count floor from this file rather than a magic
  # number, so it must be regenerated with the WAV or the floor drifts.
  word_count="$(wc -w <"${script_dir}/synthetic-voice-long.txt" | tr -d ' ')"
  duration="$(ffprobe -v error -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "${output_path}")"
  # Two tail markers, not one: the last marker sits closest to the trailing
  # `%noloop` silence and is the most exposed to a mis-hear, so requiring any
  # single one of them would undo the k-of-n tolerance.
  printf '{\n  "wordCount": %s,\n  "durationSeconds": %.3f,\n  "markers": ["harbor", "lantern", "beacon", "meridian"],\n  "tailMarkers": ["beacon", "meridian"]\n}\n' \
    "${word_count}" "${duration}" >"${script_dir}/synthetic-voice-long.json"
  echo "Generated ${output_path} (${word_count} words, ${duration}s)"
else
  echo "Generated ${output_path}"
fi
