#!/usr/bin/env python3
"""Compare existing PDFs with explicitly recorded, platform-pinned PNG baselines."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid

from PIL import Image, ImageChops, ImageDraw, __version__ as PIL_VERSION

CHANNEL_THRESHOLD = 10
MAX_CHANGED_FRACTION = 0.005
Image.MAX_IMAGE_PIXELS = 100_000_000
FONT_SUFFIXES = {'.otf', '.ttf', '.ttc', '.pfb', '.pfa', '.tfm', '.pk'}
PACKAGE_SUFFIXES = {'.sty', '.cls', '.tex', '.def', '.cfg', '.clo', '.fd', '.map', '.enc', '.cnf', '.ldf'}
SUPPORT_SUFFIXES = {'.cls', '.sty', '.bst', '.bib', '.def', '.fd', '.cfg', '.clo', '.ldf', '.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.ttf', '.otf', '.woff', '.woff2'}


def sha256(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def json_write(file: Path, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    temporary.replace(file)


def rgb(image: Image.Image) -> Image.Image:
    if image.mode == 'RGBA':
        base = Image.new('RGB', image.size, 'white')
        base.paste(image, mask=image.getchannel('A'))
        return base
    return image.convert('RGB')


def compare_images(expected: Image.Image, actual: Image.Image):
    """A changed pixel has ANY RGB channel differing by strictly more than 10."""
    expected, actual = rgb(expected), rgb(actual)
    if expected.size != actual.size:
        size = (max(expected.width, actual.width), max(expected.height, actual.height))
        return {'ok': False, 'reason': 'page dimensions changed', 'expectedSize': list(expected.size),
                'actualSize': list(actual.size), 'changedFraction': 1.0}, Image.new('RGB', size, '#ff00ff')
    difference = ImageChops.difference(expected, actual)
    red, green, blue = difference.split()
    maximum = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    mask = maximum.point(lambda value: 255 if value > CHANNEL_THRESHOLD else 0)
    changed = mask.histogram()[255]
    pixels = actual.width * actual.height
    # Integer comparison avoids a floating-point boundary error at exactly 0.5%.
    result = {'ok': changed * 1000 <= pixels * 5, 'changedPixels': changed, 'totalPixels': pixels,
              'changedFraction': changed / pixels, 'size': list(actual.size)}
    overlay = actual.convert('RGBA')
    overlay.paste(Image.new('RGBA', actual.size, (255, 0, 255, 255)), mask=mask)
    return result, overlay.convert('RGB')


def contact_sheet(before: Image.Image | None, after: Image.Image, difference: Image.Image, file: Path):
    width = 640
    images = [before or Image.new('RGB', after.size, '#dddddd'), after, difference]
    panels = []
    for label, image in zip(['BEFORE', 'AFTER', 'DIFFERENCE'], images):
        image = rgb(image)
        height = max(1, round(image.height * width / image.width))
        thumb = image.resize((width, height))
        panel = Image.new('RGB', (width, height + 30), 'white')
        ImageDraw.Draw(panel).text((10, 8), label, fill='black')
        panel.paste(thumb, (0, 30)); panels.append(panel)
    canvas = Image.new('RGB', (width * 3, max(panel.height for panel in panels)), 'white')
    for index, panel in enumerate(panels):
        canvas.paste(panel, (width * index, 0))
    canvas.save(file)


def tool_version(binary: str, arguments: list[str]) -> dict:
    resolved = shutil.which(binary) if not Path(binary).is_absolute() else binary
    if not resolved or not Path(resolved).is_file():
        raise ValueError(f'Required tool is unavailable: {binary}')
    result = subprocess.run([resolved, *arguments], text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=15, check=True)
    version = (result.stdout + '\n' + result.stderr).strip().splitlines()[0]
    return {'version': version, 'sha256': sha256(Path(resolved).resolve())}


def packaged_resolver(extension_root: Path | None, template: str):
    if extension_root is None:
        return lambda source: None
    manifest_path = extension_root / 'out/assets-manifest.json'
    contract = json.loads(manifest_path.read_text())
    files = contract.get('files', {})
    prefix = f'templates/{template}/'
    assets = []
    for relative, expected in sorted(files.items()):
        if not relative.startswith(prefix) or Path(relative).suffix.lower() not in SUPPORT_SUFFIXES:
            continue
        file = (extension_root / relative).resolve()
        if not file.is_relative_to(extension_root) or not file.is_file() or sha256(file) != expected.get('sha256'):
            raise ValueError(f'Packaged template asset failed its contract: {relative}')
        assets.append([relative[len(prefix):], expected['sha256']])
    cache_prefix = hashlib.sha256(json.dumps(assets, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()[:16]

    def resolve(source: Path):
        match = re.search(r'/inkwell-template-assets-[^/]+/([a-f0-9]{16})-[^/]+/(.+)$', str(source))
        if not match:
            return None
        if match[1] != cache_prefix:
            raise ValueError('Deleted template cache does not match the supplied artifact support-file fingerprint.')
        relative = prefix + match[2]
        candidate = (extension_root / relative).resolve()
        if not candidate.is_relative_to(extension_root) or relative not in files or not candidate.is_file() or sha256(candidate) != files[relative]['sha256']:
            raise ValueError(f'Cannot verify deleted recorder input in supplied artifact: {source}')
        return candidate
    return resolve


def recorder_inputs(file: Path, resolve_missing=lambda source: None) -> list[Path]:
    if not file.is_file() or file.stat().st_size > 16 * 1024 * 1024:
        raise ValueError(f'Missing or oversized TeX recorder: {file}')
    directory = file.parent
    inputs = set()
    for line in file.read_text(errors='strict').splitlines():
        if line.startswith('PWD '):
            directory = Path(line[4:])
        elif line.startswith('INPUT '):
            source = Path(line[6:])
            if not source.is_absolute():
                source = directory / source
            source = source.resolve()
            if source.is_file():
                inputs.add(source)
            elif source.suffix.lower() in FONT_SUFFIXES | PACKAGE_SUFFIXES | SUPPORT_SUFFIXES:
                replacement = resolve_missing(source)
                if replacement is None:
                    raise ValueError(f'Recorded font/package/product input is missing: {source}')
                inputs.add(replacement)
    if not inputs:
        raise ValueError(f'TeX recorder has no readable input files: {file}')
    return sorted(inputs)


def font_names(file: Path) -> set[str]:
    """Read only OpenType name tables, including TTC members; no font execution."""
    names = set()
    if file.suffix.lower() in {'.pfb', '.pfa'}:
        with file.open('rb') as stream:
            data = stream.read(128 * 1024)
        return {value.decode('ascii') for value in re.findall(rb'/FontName\s*/([^\s/]+)\s+def', data)}
    if file.suffix.lower() not in {'.otf', '.ttf', '.ttc'}:
        return names
    try:
        with file.open('rb') as stream:
            size = file.stat().st_size
            header = stream.read(12)
            offsets = [0]
            if header[:4] == b'ttcf':
                count = struct.unpack('>I', header[8:12])[0]
                if count > 128:
                    return names
                offsets = list(struct.unpack('>' + 'I' * count, stream.read(4 * count)))
            for offset in offsets:
                stream.seek(offset); header = stream.read(12)
                count = struct.unpack('>H', header[4:6])[0]
                if count > 256:
                    continue
                tables = stream.read(count * 16)
                for position in range(0, len(tables), 16):
                    tag, _, start, length = struct.unpack('>4sIII', tables[position:position + 16])
                    if tag != b'name' or length > 4 * 1024 * 1024 or start + length > size:
                        continue
                    stream.seek(start); data = stream.read(length)
                    _, records, strings = struct.unpack('>HHH', data[:6])
                    for number in range(min(records, 4096)):
                        platform_id, _, _, name_id, count, index = struct.unpack('>HHHHHH', data[6 + number * 12:18 + number * 12])
                        if name_id != 6 or strings + index + count > len(data):
                            continue
                        encoding = 'utf-16-be' if platform_id in {0, 3} else 'mac_roman'
                        names.add(data[strings + index:strings + index + count].decode(encoding).strip())
    except (OSError, ValueError, struct.error, UnicodeError):
        return set()
    return names


def normalized_font(name: str) -> str:
    core = re.sub(r'^[A-Z]{6}\+', '', name)
    core = re.sub(r'-Identity-[HV]$', '', core)
    return re.sub(r'[^a-z0-9]', '', core.lower())


class FontCatalog:
    def __init__(self, extra_directories=()):
        self.names: dict[str, set[Path]] = {}
        self.scanned: set[Path] = set()
        self.system_scanned = False
        self.extra_directories = list(extra_directories)

    def add(self, file: Path):
        file = file.resolve()
        if file in self.scanned:
            return
        self.scanned.add(file)
        for name in font_names(file):
            self.names.setdefault(normalized_font(name), set()).add(file)

    def system(self):
        if self.system_scanned:
            return
        self.system_scanned = True
        roots = ([Path('/System/Library/Fonts'), Path('/Library/Fonts'), Path.home() / 'Library/Fonts']
                 if sys.platform == 'darwin' else [Path('/usr/share/fonts'), Path('/usr/local/share/fonts'), Path.home() / '.local/share/fonts', Path.home() / '.fonts'])
        for root in roots + self.extra_directories:
            if root.is_dir():
                for directory, _, files in os.walk(root, followlinks=False):
                    for name in files:
                        if Path(name).suffix.lower() in {'.otf', '.ttf', '.ttc'}:
                            self.add(Path(directory) / name)
        if len(self.scanned) > 10_000:
            raise ValueError('Font catalog exceeds 10,000 files; provide explicit fontFiles in the fixture.')

    def selected(self, pdf, inputs: list[Path], explicit: list[Path]) -> list[dict]:
        recorded = [file for file in inputs if file.suffix.lower() in FONT_SUFFIXES]
        for file in recorded + explicit:
            self.add(file)
        selected = {}
        pdf_names = sorted({font[3] for page in pdf for font in page.get_fonts(full=True) if font[3]})
        for name in pdf_names:
            normalized = normalized_font(name)
            candidates = {file for file in explicit if normalized in {normalized_font(value) for value in font_names(file)}}
            if not candidates:
                candidates = {file for file in recorded if normalized in {normalized_font(value) for value in font_names(file)}}
            if not candidates:
                candidates = self.names.get(normalized, set())
            if not candidates:
                self.system(); candidates = self.names.get(normalized, set())
            if not candidates:
                candidates = {file for file in recorded if normalized_font(file.stem) == normalized}
            if not candidates:
                raise ValueError(f'Cannot identify actual source file for PDF font {name}; supply fontFiles explicitly.')
            hashes = {sha256(file) for file in candidates}
            if len(hashes) != 1:
                raise ValueError(f'Ambiguous installed files for PDF font {name}; supply the actual file in fontFiles.')
            selected[normalized] = {'postscriptName': re.sub(r'^[A-Z]{6}\+', '', name), 'sha256': hashes.pop()}
        if not selected:
            raise ValueError('The PDF has no identifiable font resources.')
        return [selected[key] for key in sorted(selected)]


def input_identity(inputs: list[Path]):
    packages, fonts, products = {}, {}, {}
    for file in inputs:
        suffix = file.suffix.lower()
        parts = file.parts
        marker = next((index for index, part in enumerate(parts) if part in {'texmf-dist', 'texmf-local'}), None)
        if suffix in FONT_SUFFIXES:
            fonts[(str(Path(*parts[marker:])) if marker is not None else file.name)] = sha256(file)
        elif marker is not None and suffix in PACKAGE_SUFFIXES:
            packages[str(Path(*parts[marker:]))] = sha256(file)
        elif suffix in PACKAGE_SUFFIXES:
            # Bundled/custom template .sty/.cls/.tex are product inputs. Their
            # changed contents must produce a raster diff, not a toolchain error.
            products[file.name] = sha256(file)
    if not packages:
        raise ValueError('Recorder does not identify installed TeX package source files.')
    return packages, fonts, products


def compare_pages(actual_pages: list[Path], baseline: Path, review: Path):
    before_pages = sorted(baseline.glob('page-*.png')) if baseline.is_dir() else []
    result = {'ok': len(actual_pages) == len(before_pages), 'expectedPages': len(before_pages), 'actualPages': len(actual_pages), 'pages': []}
    for index in range(max(len(actual_pages), len(before_pages))):
        old = Image.open(before_pages[index]) if index < len(before_pages) else None
        new = Image.open(actual_pages[index]) if index < len(actual_pages) else Image.new('RGB', old.size, 'white')
        metrics, difference = compare_images(old, new) if old is not None and index < len(actual_pages) else ({'ok': False, 'reason': 'page added or removed', 'changedFraction': 1.0}, Image.new('RGB', new.size, '#ff00ff'))
        result['ok'] = result['ok'] and metrics['ok']
        metrics['page'] = index + 1; result['pages'].append(metrics)
        new.save(review / f'after-{index + 1:03}.png')
        if old is not None:
            old.save(review / f'before-{index + 1:03}.png')
        difference.save(review / f'diff-{index + 1:03}.png')
        contact_sheet(old, new, difference, review / f'review-{index + 1:03}.png')
        if old is not None:
            old.close()
        new.close()
    return result


def baseline_check(metadata, current):
    if metadata.get('schemaVersion') != 1:
        return 'Unknown baseline schema; explicit recording and review are required.'
    for key in ['platform', 'toolchain', 'rendererSettings']:
        if metadata.get(key) != current.get(key):
            return f'Pinned {key} differs; normal checks never rebaseline.'
    return None


def run(args):
    import fitz
    manifest_file = Path(args.manifest).resolve()
    value = json.loads(manifest_file.read_text())
    fixtures = value if isinstance(value, list) else value.get('fixtures')
    artifact = args.artifact_sha256 or (value.get('artifactSha256') if isinstance(value, dict) else None)
    if not isinstance(fixtures, list) or not fixtures or len(fixtures) > 100:
        raise ValueError('Manifest must contain 1–100 fixtures.')
    if not artifact or not re.fullmatch('[a-f0-9]{64}', artifact):
        raise ValueError('An actual artifact SHA-256 is required, using --artifact-sha256 or manifest.artifactSha256.')
    if args.record != args.allow_baseline_write:
        raise ValueError('Recording requires both --record and --allow-baseline-write; normal runs never write baselines.')
    output = Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
    goldens = Path(args.goldens).resolve()
    platform_id = {'system': platform.system(), 'release': platform.release(), 'machine': platform.machine()}
    platform_key = f'{sys.platform}-{platform.machine()}'
    renderer = tool_version(args.pdftoppm, ['-v']); pandoc = tool_version(args.pandoc, ['--version'])
    report = {'schemaVersion': 1, 'ok': False, 'recorded': args.record, 'requiresVisualReview': args.record,
              'artifactSha256': artifact, 'platform': platform_id, 'platformKey': platform_key,
              'threshold': {'anyChannelGreaterThan': CHANNEL_THRESHOLD, 'maximumChangedFraction': MAX_CHANGED_FRACTION}, 'fixtures': []}
    catalog = FontCatalog([Path(directory).resolve() for directory in args.font_dir]); used = set()
    for fixture in fixtures:
        identifier = fixture.get('id', '')
        if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', identifier) or identifier.lower() in used:
            raise ValueError(f'Unsafe or duplicate fixture ID: {identifier}')
        used.add(identifier.lower())
        review = output / identifier; review.mkdir(parents=True, exist_ok=True)
        item = {'id': identifier, 'template': fixture.get('template'), 'ok': False}
        try:
            pdf_path = Path(fixture['pdfPath']).resolve(); log = Path(fixture['logPath']).resolve()
            fls = Path(fixture.get('flsPath') or log.with_name(pdf_path.stem + '.fls')).resolve()
            engine_log = Path(fixture.get('engineLogPath') or fls.with_suffix('.log')).resolve()
            engine = engine_log.read_text(errors='replace').splitlines()[0]
            if not re.match(r'This is (?:XeTeX|pdfTeX|LuaHBTeX|LuaTeX)', engine):
                raise ValueError(f'Actual engine log is unavailable or unrecognized: {engine_log}')
            # The timestamp at the end of TeX's first line is not a tool version.
            engine = re.sub(r'\s+\d{1,2} [A-Z]{3} \d{4} \d{2}:\d{2}\s*$', '', engine)
            extension_root = Path(args.extension_root).resolve() if args.extension_root else None
            inputs = recorder_inputs(fls, packaged_resolver(extension_root, fixture.get('template', '')))
            packages, font_inputs, products = input_identity(inputs)
            with fitz.open(pdf_path) as pdf:
                if not 1 <= len(pdf) <= args.max_pages:
                    raise ValueError(f'PDF page count is outside 1–{args.max_pages}.')
                page_count = len(pdf)
                fonts = catalog.selected(pdf, inputs, [Path(file).resolve() for file in fixture.get('fontFiles', [])])
            metadata = {'schemaVersion': 1, 'id': identifier, 'template': fixture.get('template'), 'artifactSha256': artifact,
                        'pdfSha256': sha256(pdf_path), 'platform': platform_id,
                        'rendererSettings': {'dpi': args.dpi, 'antialiasText': True, 'antialiasVector': True, 'pillow': PIL_VERSION},
                        'toolchain': {'engine': engine, 'pandoc': pandoc, 'renderer': renderer, 'packages': packages,
                                      'recordedFontInputs': font_inputs, 'selectedFonts': fonts},
                        'productInputs': products, 'recorderSha256': sha256(fls), 'pageCount': page_count}
            baseline = goldens / platform_key / identifier
            old_metadata = json.loads((baseline / 'baseline.json').read_text()) if (baseline / 'baseline.json').is_file() else None
            pin_error = baseline_check(old_metadata, metadata) if old_metadata else 'Missing platform/fixture baseline; explicit recording and review are required.'
            render_dir = review / 'rendered'; render_dir.mkdir(exist_ok=True)
            for old in render_dir.glob('page-*.png'):
                old.unlink()
            subprocess.run([args.pdftoppm, '-r', str(args.dpi), '-png', '-aa', 'yes', '-aaVector', 'yes',
                            '-f', '1', '-l', str(page_count), str(pdf_path), str(render_dir / 'page')],
                           check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            pages = sorted(render_dir.glob('page-*.png'), key=lambda file: int(file.stem.rsplit('-', 1)[1]))
            if len(pages) != page_count:
                raise ValueError('Renderer did not produce exactly the PDF page count.')
            comparison = compare_pages(pages, baseline, review)
            item.update({'comparison': comparison, 'pinError': pin_error, 'metadata': metadata,
                         'reviewDirectory': str(review), 'baselineDirectory': str(baseline)})
            if args.record:
                baseline.parent.mkdir(parents=True, exist_ok=True)
                staging = Path(tempfile.mkdtemp(prefix=f'.{identifier}-', dir=baseline.parent))
                backup = baseline.with_name('.' + identifier + '-previous-' + uuid.uuid4().hex)
                try:
                    for index, file in enumerate(pages):
                        shutil.copyfile(file, staging / f'page-{index + 1:03}.png')
                    json_write(staging / 'baseline.json', metadata)
                    if baseline.exists():
                        baseline.replace(backup)
                    try:
                        staging.replace(baseline)
                    except Exception:
                        if backup.exists():
                            backup.replace(baseline)
                        raise
                    if backup.exists():
                        shutil.rmtree(backup)
                finally:
                    if staging.exists():
                        shutil.rmtree(staging)
                item['ok'] = True; item['recorded'] = True; item['requiresVisualReview'] = True
            else:
                item['ok'] = not pin_error and comparison['ok']
        except Exception as error:
            item['error'] = str(error)
        report['fixtures'].append(item)
        json_write(output / 'report.json', report)
    report['ok'] = all(item['ok'] for item in report['fixtures'])
    json_write(output / 'report.json', report)
    print(json.dumps({'ok': report['ok'], 'recorded': args.record, 'requiresVisualReview': args.record, 'report': str(output / 'report.json')}))
    return 0 if report['ok'] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--goldens', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--artifact-sha256')
    parser.add_argument('--extension-root', help='Verified unpacked artifact, used to recover deleted template-cache inputs by support fingerprint.')
    parser.add_argument('--font-dir', action='append', default=[value for value in os.environ.get('INKWELL_PDF_FONT_DIRS', '').split(os.pathsep) if value], help='Additional actual source-font directory, e.g. the run interpreter matplotlib/mpl-data/fonts directory.')
    parser.add_argument('--record', action='store_true')
    parser.add_argument('--allow-baseline-write', action='store_true')
    parser.add_argument('--dpi', type=int, choices=range(72, 201), default=120)
    parser.add_argument('--max-pages', type=int, choices=range(1, 101), default=100)
    bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm'
    parser.add_argument('--pdftoppm', default=os.environ.get('INKWELL_PDFTOPPM') or (str(bundled) if bundled.is_file() else 'pdftoppm'))
    parser.add_argument('--pandoc', default=os.environ.get('INKWELL_PANDOC_BIN') or 'pandoc')
    args = parser.parse_args()
    try:
        return run(args)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
