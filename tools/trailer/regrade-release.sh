#!/usr/bin/env bash
# Regrade the launch trailer on the trailer-v1 release in place (same asset name, so the README
# link keeps working). Needs gh (signed in), ffmpeg and Python 3 with numpy. Run from the repo
# root in WSL/Linux/macOS (ffmpeg filter paths with a Windows drive colon break lut3d).
#
#   tools/trailer/regrade-release.sh            # download, grade, replace the release asset
#   DRY_RUN=1 tools/trailer/regrade-release.sh  # grade only; prints where the file is
#   tools/trailer/regrade-release.sh local.mp4  # grade a local copy of the original instead
#
# Refuses anything but the original ungraded upload (sha256 below), so it never grades twice.
set -euo pipefail

TAG=trailer-v1
NAME=Warsaw-Downtown-Launch-Trailer.mp4
ORIGINAL_SHA256=b82ad4518d258492049591ad3f7e36c2697e2bbd1ae799a065c8dcf070173310

work=$(mktemp -d)
src=${1:-}
if [ -z "$src" ]; then
  echo "Downloading $NAME from $TAG..."
  gh release download "$TAG" -p "$NAME" -D "$work"
  src="$work/$NAME"
fi
sum=$(sha256sum "$src" | cut -d' ' -f1)
if [ "$sum" != "$ORIGINAL_SHA256" ]; then
  echo "error: $src is not the original ungraded trailer (sha256 $sum); nothing changed." >&2
  exit 1
fi

python3 tools/trailer/grade.py cube "$work/grade.cube"
mkdir -p "$work/out"
out="$work/out/$NAME"
range='scale=in_range=full:out_range=full:in_color_matrix=bt601:out_color_matrix=bt601'
echo "Grading (about 10 min on 4 cores)..."
ffmpeg -v error -stats -y -i "$src" \
  -vf "$range,format=gbrp,lut3d=$work/grade.cube:interp=tetrahedral,$range,format=yuvj420p,unsharp=5:5:0.55:5:5:0" \
  -c:v libx264 -preset slow -crf 16 -profile:v high -color_range pc -colorspace bt470bg \
  -c:a copy -movflags +faststart "$out"

if [ -n "${DRY_RUN:-}" ]; then
  echo "Graded: $out"
  exit 0
fi
echo "Replacing $NAME on $TAG..."
gh release upload "$TAG" "$out" --clobber
echo "Done. Original kept at $src"
