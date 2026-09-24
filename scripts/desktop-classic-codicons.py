"""Build desktop/codicon-classic.ttf: Hydra's pinned codicon font with the classic
glyph designs Cursor users know (from @vscode/codicons 0.0.41, the last release
before the redesign, CC BY 4.0: https://github.com/microsoft/vscode-codicons).

Every icon that exists in both fonts under the same code point and name takes
the 0.0.41 outline; icons added after 0.0.41 keep the pinned design. Code points
never change, so the editor uses the font exactly as before.

    python scripts/desktop-classic-codicons.py <pinned codicon.ttf> <0.0.41 codicon.ttf>

scripts/desktop.mjs refuses to use the output unless the pinned font matches
BASE_SHA256 below, so regenerate this file when the upstream pin changes.
"""
import copy
import hashlib
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

BASE_SHA256 = '9e69844919a0f8c6dbcfc686363f81ace3a6b3e8363260aea8d969a609b0ba67'


def main(pinned_path: str, classic_path: str) -> None:
    pinned_bytes = Path(pinned_path).read_bytes()
    if hashlib.sha256(pinned_bytes).hexdigest() != BASE_SHA256:
        raise SystemExit('The pinned codicon.ttf changed; update BASE_SHA256 after checking the new font.')
    pinned = TTFont(pinned_path, recalcTimestamp=False)
    classic = TTFont(classic_path, recalcTimestamp=False)
    if pinned['head'].unitsPerEm != classic['head'].unitsPerEm:
        raise SystemExit('The fonts use different units per em.')
    pinned_cmap, classic_cmap = pinned.getBestCmap(), classic.getBestCmap()
    replaced = kept = 0
    for code_point, name in sorted(pinned_cmap.items()):
        if classic_cmap.get(code_point) != name:
            kept += 1
            continue
        glyph = copy.deepcopy(classic['glyf'][name])
        if glyph.isComposite():
            raise SystemExit(f'{name} is a composite glyph; copy it by hand.')
        pinned['glyf'][name] = glyph
        pinned['hmtx'][name] = classic['hmtx'][name]
        replaced += 1
    out = Path(__file__).resolve().parent.parent / 'desktop' / 'codicon-classic.ttf'
    pinned.save(out)
    print(f'{replaced} glyphs take the classic design, {kept} keep the pinned design')
    print('sha256', hashlib.sha256(out.read_bytes()).hexdigest())


if __name__ == '__main__':
    main(*sys.argv[1:3])
