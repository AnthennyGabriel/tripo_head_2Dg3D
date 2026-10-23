import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import {
  faceSheetPrompt,
  MAX_PROMPT_LENGTH,
  REMOVAL_MODES,
  SHEET_LAYOUT,
} from '../src/prompts.js';
import { generationPlan, splitSheet, tripoViews, TRIPO_VIEW_ORDER } from '../src/sheet.js';

const COLORS = [
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 255, b: 0 },
];

async function quadrantSheet(size) {
  const half = size / 2;
  const tiles = await Promise.all(COLORS.map((background) =>
    sharp({ create: { width: half, height: half, channels: 3, background } }).png().toBuffer()));
  return sharp({ create: { width: size, height: size, channels: 3, background: '#000' } })
      .composite(tiles.map((input, panel) => ({
        input, left: (panel % 2) * half, top: Math.floor(panel / 2) * half,
      })))
      .png()
      .toBuffer();
}

test('splits each view from the panel the prompt puts it in', async () => {
  const views = await splitSheet(await quadrantSheet(256));
  for (const [view, panel] of Object.entries(SHEET_LAYOUT)) {
    const { data, info } = await sharp(views[view]).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 132);
    assert.equal(info.height, 132);
    const center = (66 * 132 + 66) * info.channels;
    assert.deepEqual([...data.subarray(center, center + 3)], Object.values(COLORS[panel]), view);
    // Added margins are white; the original boundary is preserved.
    assert.deepEqual([...data.subarray(0, 3)], [255, 255, 255], view);
    const boundary=(2*132+2)*info.channels;
    assert.deepEqual([...data.subarray(boundary,boundary+3)],Object.values(COLORS[panel]));
  }
});

test('orders views for Tripo and can swap the profiles', () => {
  const views = { front: 'F', left: 'L', back: 'B', right: 'R' };
  assert.deepEqual(TRIPO_VIEW_ORDER, ['front', 'left', 'back', 'right']);
  assert.deepEqual(tripoViews(views), ['F', 'L', 'B', 'R']);
  assert.deepEqual(tripoViews(views, { swapSides: true }), ['F', 'R', 'B', 'L']);
});

test('one selected view is a single-image generation, several are multiview slots', () => {
  for (const view of TRIPO_VIEW_ORDER) {
    assert.deepEqual(generationPlan([view]), { mode: 'image', view });
  }
  assert.deepEqual(generationPlan(['front', 'front']), { mode: 'image', view: 'front' });
  assert.deepEqual(generationPlan(['front', 'left']), {
    mode: 'multiview',
    slots: ['front', 'left', null, null],
  });
  assert.deepEqual(generationPlan(['back', 'right', 'front'], { swapSides: true }), {
    mode: 'multiview',
    // The right-hand panel fills Tripo's left slot when the profiles are swapped.
    slots: ['front', 'right', 'back', null],
  });
  assert.deepEqual(
      generationPlan(['front', 'left', 'back', 'right'], { swapSides: true }).slots,
      ['front', 'right', 'back', 'left'],
  );
  assert.throws(() => generationPlan([]), /1 到 4/);
  assert.throws(() => generationPlan(['left', 'right']), /必须包含正面/);
  assert.throws(() => generationPlan(['front', 'nose']), /1 到 4/);
});

test('the one prompt fits Tripo and names exactly the images it is sent', () => {
  for (const mode of REMOVAL_MODES) {
    const prompt = faceSheetPrompt(mode);
    assert.ok(prompt.length <= MAX_PROMPT_LENGTH, `${mode} ${prompt.length}`);
    assert.ok(prompt.includes('image[2]') && !prompt.includes('image[3]'), mode);
  }
  assert.match(faceSheetPrompt('auto'), /completely bald/);
  assert.match(faceSheetPrompt('auto'), /clean-shaven/);
  assert.match(faceSheetPrompt('auto'), /no stubble/);
  // Removing hair and beard is one unconditional instruction, not a choice.
  assert.doesNotMatch(faceSheetPrompt('auto'), /\bIf\b|hair or|beard or/);
  assert.doesNotMatch(faceSheetPrompt('hair'), /clean-shaven/);
  assert.doesNotMatch(faceSheetPrompt('beard'), /completely bald/);
  assert.throws(() => faceSheetPrompt('wig'), RangeError);
});
