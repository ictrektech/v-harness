#!/bin/sh
set -eu
skill_root=/opt/v-harness/skills
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
for name in archify mnemon ppt-design-skill vox-director pgv; do
    grep -qx "name: $name" "$skill_root/$name/SKILL.md"
done
test -s "$skill_root/pgv/references/native.md"
test -s "$skill_root/pgv/references/connector.md"
psql --version
redis-cli --version
test ! -e "$skill_root/browser-skill"
! command -v bsk >/dev/null 2>&1

node "$skill_root/archify/bin/archify.mjs" demo "$scratch"
test -s archify-demo.html
grep -q '<svg' archify-demo.html

mkdir tenant-a tenant-b
HOME="$scratch/tenant-a" mnemon remember "The release fixture uses an amber notebook" --cat fact --imp 3 --source agent
HOME="$scratch/tenant-a" mnemon recall "amber notebook" --limit 5 | grep -qi 'amber notebook'
HOME="$scratch/tenant-b" mnemon remember "The second release fixture uses a purple envelope" --cat fact --imp 3 --source agent
! HOME="$scratch/tenant-b" mnemon recall "amber notebook" --limit 5 | grep -qi 'amber notebook'

/usr/local/share/vh-pptx-designer/bin/python - <<'PY'
from pptx import Presentation
from pptx_designer import generate_ppt
from pptx_designer.renderer.theme import ThemeComposer

generate_ppt(
    content={"title": "Editable fixture", "pages": [{"goal": "hook", "title": "Editable fixture"}]},
    theme=ThemeComposer().compose(style="dark-tech", seed=17),
    output="fixture.pptx",
)
deck = Presentation("fixture.pptx")
assert any("Editable fixture" in shape.text for slide in deck.slides
           for shape in slide.shapes if shape.has_text_frame)
PY
sh "$skill_root/ppt-design-skill/scripts/render_pptx.sh" fixture.pptx preview
test -s preview/fixture.pdf
test -s preview/slide-1.png

ffmpeg -hide_banner -loglevel error -f lavfi -i 'color=c=blue:s=320x180:r=24' -t 1 -c:v libx264 motion.mp4
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:duration=1' tone.wav
python3 - <<'PY'
import json
from pathlib import Path
Path("beats.json").write_text(json.dumps({
    "beats": [{"id": "one", "clip_path": "motion.mp4", "dur": 1, "narration_dur": 0.5,
               "narration": "这是用于验证中文纸拼贴视频字幕和换行的测试句子",
               "narration_audio": "tone.wav"}],
    "bgm_path": "tone.wav",
}))
PY
python3 "$skill_root/vox-director/scripts/assemble.py" "$scratch"
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 final.mp4 | grep -qx h264
printf '%s\n' 'Bundled skill smoke tests passed.'
