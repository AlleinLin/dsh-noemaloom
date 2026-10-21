import assert from 'node:assert/strict';
import test from 'node:test';
import { getNativeAppearance, previewNativeAppearance, saveNativeAppearance } from '../src/client/native-appearance.js';
import { NATIVE_APPEARANCE_DEFAULTS } from '../src/shared/native-appearance.js';

test('native appearance draft previews immediately and leaves the saved state intact on dismissal', () => {
  saveNativeAppearance(NATIVE_APPEARANCE_DEFAULTS);
  saveNativeAppearance({ sidebarBrandText: 'Saved 中文 brand', sidebarBrandColor: '#AABBCC', homeTitle: 'Saved title' });
  previewNativeAppearance({ sidebarBrandText: '<b>Preview literal</b>', sidebarBrandColor: '#FF2200',
    homeTitle: 'Long English and 中文 '.repeat(20), homeBadgeEnabled: false });
  assert.equal(getNativeAppearance().sidebarBrandText, '<b>Preview literal</b>');
  assert.equal(getNativeAppearance().homeBadgeEnabled, false);
  previewNativeAppearance();
  assert.equal(getNativeAppearance().sidebarBrandText, 'Saved 中文 brand');
  assert.equal(getNativeAppearance().homeTitle, 'Saved title');
  saveNativeAppearance(NATIVE_APPEARANCE_DEFAULTS);
});
