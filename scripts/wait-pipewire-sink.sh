#!/usr/bin/env bash
# Wait for both PulseAudio's setter and the app's PipeWire reader to agree.
set -euo pipefail

sink="${1:?usage: wait-pipewire-sink.sh SINK}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# pactl info can succeed before WirePlumber creates its default metadata.
# Retry the setter too: under set -e, a single early "Not supported" would
# otherwise abort the job before it ever reaches the readiness check.
for attempt in $(seq 1 30); do
  if pactl set-default-sink "$sink"; then
    if node - "$script_dir/../app/linux-loopback.js" "$sink" <<'NODE'
const { getDefaultSinkName } = require(process.argv[2]);
try {
  const actual = getDefaultSinkName();
  if (actual !== process.argv[3]) {
    console.error(`Waiting for default sink ${process.argv[3]}; currently ${actual}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
NODE
    then
      echo "PipeWire default sink ready: $sink (attempt $attempt)"
      exit 0
    fi
  fi
  if [ "$attempt" -lt 30 ]; then sleep 1; fi
done

echo "::error::PipeWire default sink did not converge to $sink" >&2
pactl list short sinks >&2 || true
pw-dump >&2 || true
exit 1
