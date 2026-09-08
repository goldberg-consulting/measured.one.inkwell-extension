import importlib.util
from pathlib import Path
import tempfile
import unittest

from PIL import Image

SPEC = importlib.util.spec_from_file_location('raster_goldens', Path(__file__).parents[1] / 'scripts/check-raster-goldens.py')
GOLDENS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GOLDENS)


class RasterComparisonTests(unittest.TestCase):
    def test_identical_images_pass(self):
        image = Image.new('RGB', (100, 100), 'white')
        result, _ = GOLDENS.compare_images(image, image.copy())
        self.assertTrue(result['ok'])
        self.assertEqual(result['changedPixels'], 0)

    def test_ten_levels_are_allowed_but_eleven_in_one_channel_count(self):
        before = Image.new('RGB', (100, 100), (100, 100, 100))
        after = Image.new('RGB', (100, 100), (110, 90, 100))
        result, _ = GOLDENS.compare_images(before, after)
        self.assertEqual(result['changedPixels'], 0)
        after.putpixel((0, 0), (100, 111, 100))
        result, _ = GOLDENS.compare_images(before, after)
        self.assertEqual(result['changedPixels'], 1)

    def test_exact_half_percent_passes_and_one_more_pixel_fails(self):
        before = Image.new('RGB', (100, 100), 'white')
        after = before.copy()
        for x in range(50):
            after.putpixel((x, 0), (0, 255, 255))
        result, _ = GOLDENS.compare_images(before, after)
        self.assertTrue(result['ok'])
        self.assertEqual(result['changedFraction'], 0.005)
        after.putpixel((50, 0), (255, 255, 0))
        result, _ = GOLDENS.compare_images(before, after)
        self.assertFalse(result['ok'])
        self.assertEqual(result['changedPixels'], 51)

    def test_dimension_change_fails_even_if_both_pages_are_blank(self):
        result, _ = GOLDENS.compare_images(Image.new('RGB', (100, 100), 'white'), Image.new('RGB', (101, 100), 'white'))
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'page dimensions changed')

    def test_transparent_pixels_composite_on_white(self):
        result, _ = GOLDENS.compare_images(Image.new('RGB', (10, 10), 'white'), Image.new('RGBA', (10, 10), (0, 0, 0, 0)))
        self.assertTrue(result['ok'])

    def test_unknown_platform_or_tools_fail_without_rebaseline(self):
        current = {'schemaVersion': 1, 'platform': {'system': 'Darwin'}, 'toolchain': {'engine': 'XeTeX'}, 'rendererSettings': {'dpi': 120}}
        self.assertIsNone(GOLDENS.baseline_check(current, current))
        self.assertIn('schema', GOLDENS.baseline_check({}, current))
        changed = {**current, 'platform': {'system': 'Linux'}}
        self.assertIn('platform', GOLDENS.baseline_check(current, changed))
        changed = {**current, 'toolchain': {'engine': 'pdfTeX'}}
        self.assertIn('toolchain', GOLDENS.baseline_check(current, changed))
        changed = {**current, 'productInputs': {'template.sty': 'changed'}}
        self.assertIsNone(GOLDENS.baseline_check(current, changed), 'Product styles are compared as pixels, not toolchain pins.')

    def test_page_addition_and_removal_emit_review_artifacts_and_fail(self):
        with tempfile.TemporaryDirectory(prefix='inkwell-raster-unit-') as temporary:
            root = Path(temporary); baseline = root / 'baseline'; baseline.mkdir()
            review = root / 'review'; review.mkdir()
            one = root / 'one.png'; two = root / 'two.png'
            Image.new('RGB', (10, 10), 'white').save(one)
            Image.new('RGB', (10, 10), 'black').save(two)
            Image.new('RGB', (10, 10), 'white').save(baseline / 'page-001.png')
            result = GOLDENS.compare_pages([one, two], baseline, review)
            self.assertFalse(result['ok'])
            self.assertTrue((review / 'review-002.png').is_file())
            self.assertTrue((review / 'before-001.png').is_file())
            result = GOLDENS.compare_pages([], baseline, review)
            self.assertFalse(result['ok'])

    def test_missing_recorded_font_fails_and_records_resolve_relative_to_pwd(self):
        with tempfile.TemporaryDirectory(prefix='inkwell-raster-unit-') as temporary:
            root = Path(temporary); source = root / 'template.sty'; source.write_text('% template')
            recorder = root / 'document.fls'; recorder.write_text(f'PWD {root}\nINPUT template.sty\nINPUT template.sty\n')
            self.assertEqual(GOLDENS.recorder_inputs(recorder), [source.resolve()])
            recorder.write_text(f'PWD {root}\nINPUT missing.otf\n')
            with self.assertRaisesRegex(ValueError, 'missing'):
                GOLDENS.recorder_inputs(recorder)

    def test_type_one_font_names_are_read_from_source_metadata(self):
        with tempfile.TemporaryDirectory(prefix='inkwell-raster-unit-') as temporary:
            font = Path(temporary) / 'font.pfb'
            font.write_bytes(b'\x80\x01\x00/FontName /Fixture-Roman def\n')
            self.assertEqual(GOLDENS.font_names(font), {'Fixture-Roman'})

    def test_pdf_subset_and_encoding_suffix_do_not_change_font_source_identity(self):
        self.assertEqual(GOLDENS.normalized_font('ABCDEF+LMRoman10-Bold-Identity-H'), GOLDENS.normalized_font('LMRoman10-Bold'))


if __name__ == '__main__':
    unittest.main()
