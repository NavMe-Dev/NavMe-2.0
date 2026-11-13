"""The real UI boot callback must preserve the active view's accessible label."""
from pathlib import Path
import subprocess

import pytest


@pytest.mark.parametrize("active_3d,translation_throws", [(True, False), (False, False), (True, True)])
def test_translation_boot_keeps_mode_label_in_sync(active_3d, translation_throws):
    root = Path(__file__).resolve().parents[1]
    script = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[1], 'utf8');
let locale = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const laterLocale = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const active3d = process.argv[4] === 'true';
let translationThrows = process.argv[5] === 'true';
// Execute the actual helper and boot callback, so removing/misordering the
// production synchronization call reproduces the late-translation failure.
const helper = source.match(/const syncViewMode = \(\) => \{[\s\S]*?\n    \};/);
const boot = source.match(/Promise\.resolve\(ready\)\.then\(async \(\) => \{([\s\S]*?)\n    \}\)\.catch/);
assert.ok(helper && boot, 'UI boot/helper source must remain identifiable');
const attributes = { 'data-i18n-aria-label': 'viewer.switch3d' };
const button = { textContent: '', setAttribute: (key, value) => { attributes[key] = value; },
                 getAttribute: key => attributes[key] };
const view = { ui: { components: ['zoom', 'compass', 'attribution'] } };
let current3d = !active3d;
const translate = key => key.split('.').reduce((node, part) => node?.[part], locale) || key;
const i18n = { applyDom: () => {
  if (translationThrows) throw new Error('Dictionary DOM application unavailable');
  button.setAttribute('aria-label', translate(button.getAttribute('data-i18n-aria-label')));
} };
let bootCleared = false;
const context = {
  wf: { is3D: () => current3d, view: () => view },
  $: id => id === 'btn3D' ? button : null,
  t: translate, WFi18n: i18n, window: { WFi18n: i18n, WFStartup: null },
  isMpMode: () => false, applyDeepLink: async () => {}, showHome: () => {},
  clearBoot: () => { bootCleared = true; }, updateFloorPicker: () => {}, console,
  advanceView: () => { current3d = active3d; },
};
(async () => {
  // Model a view that changed before the translation-ready callback. The boot
  // resync must work even if the UI missed the earlier view-change event.
  await vm.runInNewContext(`(async () => { ${helper[0]} syncViewMode(); advanceView(); ${boot[1]} })()`, context);
  assert.equal(button.textContent, active3d ? '2D' : '3D');
  assert.equal(attributes['aria-label'], translate(active3d ? 'viewer.switch2d' : 'viewer.switch3d'));
  assert.deepEqual(Array.from(view.ui.components), ['attribution']);
  assert.equal(bootCleared, true, 'Translation handling must not strand the boot overlay');
  locale = laterLocale;
  translationThrows = false;
  i18n.applyDom();
  assert.equal(attributes['data-i18n-aria-label'], active3d ? 'viewer.switch2d' : 'viewer.switch3d');
  assert.equal(attributes['aria-label'], translate(active3d ? 'viewer.switch2d' : 'viewer.switch3d'),
               'A later translation pass must use the current target-mode key');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
"""
    result = subprocess.run(
        ["node", "-e", script, str(root / "viewer/ui.js"), str(root / "locales/en.json"),
         str(root / "locales/fr.json"),
         str(active_3d).lower(), str(translation_throws).lower()],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
