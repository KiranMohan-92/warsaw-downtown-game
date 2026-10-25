#!/bin/sh
# Visual QA of rendered frames by Codex (GPT-6 Sol), complementing code review.
# Run from Windows via WSL after `pnpm e2e` has produced screenshots:
#   wsl -e sh -lc 'cd /mnt/c/Users/kiran/myprojects/warsaw-downtown && sh tools/review/codex-visual-review.sh'
# Writes the report to e2e/artifacts/visual-review.md.
set -eu
IMGS=""
for f in e2e/artifacts/*.png; do
  [ -f "$f" ] && IMGS="$IMGS -i $f" # an unmatched glob stays literal in POSIX sh
done
[ -n "$IMGS" ] || { echo "no screenshots in e2e/artifacts — run pnpm e2e first"; exit 1; }
PROMPT='You are reviewing screenshots of a browser first-person shooter (three.js, WebGL2) for 3D rendering defects.
Each file name says what it shows (weather presets, weapons, knife, sparring partner, explosion, interior).
Report only concrete, visible defects, each with the file name, where in the frame, severity (P1/P2/P3) and the likely cause:
z-fighting/flicker, shadow acne or peter-panning, missing/incorrect shadows, light leaks through walls, wrong exposure or
blown-out whites, broken normals/faceting, texture stretching or seams, viewmodel clipping or wrong scale, HUD overlapping
important content, fog/sky mismatches, aliasing, post-processing artifacts (bloom halos, AO halos, banding).
Do not comment on the placeholder art style (greybox is intentional). If a frame looks correct, say so briefly.'
# shellcheck disable=SC2086
# -i takes several files, so the prompt goes via stdin (a trailing positional would be read as an image).
printf '%s\n' "$PROMPT" | ~/.local/bin/codex exec -c model="gpt-6-sol" --skip-git-repo-check $IMGS > e2e/artifacts/visual-review.md
echo "visual review → e2e/artifacts/visual-review.md"
