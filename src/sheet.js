import sharp from 'sharp';

import { SHEET_LAYOUT } from './prompts.js';

// Tripo multiview-to-model expects views in this order.
export const TRIPO_VIEW_ORDER = Object.freeze(['front', 'left', 'back', 'right']);
// The image model often draws dividing lines between panels despite the
// prompt; this fraction of each panel edge is painted white so they do not
// reach Tripo as part of the head.
const EDGE_MARGIN = 0.015;

/**
 * Splits a 2x2 sheet into equal quadrants keyed by view name.
 *
 * Quadrants are not trimmed individually: multiview reconstruction needs
 * every view at the same scale, which the sheet already guarantees.
 *
 * @param {Buffer} sheet encoded image
 * @returns {Promise<Record<string, Buffer>>} PNG per view
 */
export async function splitSheet(sheet, { layout = ['front','back','left','right'] } = {}) {
  if (!Array.isArray(layout) || layout.length !== 4 || new Set(layout).size !== 4 || layout.some(v => !TRIPO_VIEW_ORDER.includes(v))) {
    throw new RangeError('四个图块需要分别指定正面、背面、左侧、右侧，不能重复。');
  }
  const image = sharp(sheet, { limitInputPixels: 40_000_000 }).removeAlpha();
  const { width, height } = await image.metadata();
  if (!width || !height || width < 64 || height < 64) {
    throw new Error(`Sheet is too small to split (${width}x${height}).`);
  }
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);
  const margin = Math.max(1, Math.round(EDGE_MARGIN * Math.min(halfWidth, halfHeight)));
  const views = {};
  for (const [panel, view] of layout.entries()) {
    const left = (panel % 2) * halfWidth;
    const top = Math.floor(panel / 2) * halfHeight;
    const inner = await image
        .clone()
        .extract({
          left: left + margin,
          top: top + margin,
          width: halfWidth - 2 * margin,
          height: halfHeight - 2 * margin,
        })
        .toBuffer();
    views[view] = await sharp(inner)
        .extend({
          top: margin, bottom: margin, left: margin, right: margin,
          background: '#ffffff',
        })
        .png()
        .toBuffer();
  }
  return views;
}

/**
 * Orders view images for Tripo, optionally swapping the two profiles when the
 * image model drew them on the opposite sides.
 *
 * @template T
 * @param {Record<string, T>} views
 * @param {{ swapSides?: boolean }} [options]
 * @returns {T[]}
 */
export function tripoViews(views, { swapSides = false } = {}) {
  const order = swapSides ?
    TRIPO_VIEW_ORDER.map((view) => ({ left: 'right', right: 'left' })[view] ?? view) :
    TRIPO_VIEW_ORDER;
  return order.map((view) => views[view]);
}

/**
 * How to send a user's selection of the cropped views to Tripo.
 *
 * One view uses image-to-model. Two or more use the four multiview slots
 * [front, left, back, right], with unselected slots empty. Multiview
 * requires the front view. `swapSides` exchanges which file fills the left
 * and right slots, the same way `tripoViews` does.
 *
 * @param {string[]} selected
 * @param {{ swapSides?: boolean }} [options]
 * @returns {{ mode: 'image', view: string } | { mode: 'multiview', slots: (string|null)[] }}
 */
export function generationPlan(selected, { swapSides = false } = {}) {
  if (!Array.isArray(selected)) throw new RangeError('请选择 1 到 4 张视角图。');
  const unique = [...new Set(selected)];
  if (unique.length < 1 || unique.length > 4 ||
      unique.some((view) => !TRIPO_VIEW_ORDER.includes(view))) {
    throw new RangeError('请选择 1 到 4 张视角图。');
  }
  if (unique.length === 1) return { mode: 'image', view: unique[0] };
  if (!unique.includes('front')) {
    throw new RangeError('多视图生成必须包含正面。只用一张图时可以任选一个视角。');
  }
  const sourceForSlot = swapSides ?
    { front: 'front', left: 'right', back: 'back', right: 'left' } :
    { front: 'front', left: 'left', back: 'back', right: 'right' };
  return {
    mode: 'multiview',
    slots: TRIPO_VIEW_ORDER.map((slot) => {
      const from = sourceForSlot[slot];
      return unique.includes(from) ? from : null;
    }),
  };
}
