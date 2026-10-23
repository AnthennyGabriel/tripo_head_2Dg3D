// One Nano Banana Pro edit: concept art in, a hairless-face turnaround out.
// It also takes a rendered head template in the sheet layout: told only in
// words, the image model draws the side views as three-quarter views at
// varying scales. The earlier, longer prompt is kept in prompts_v1.js.

// Panel each view is drawn in, row-major over the 2x2 sheet. Tripo's "left"
// view has the nose pointing to the left edge, i.e. it shows the character's
// left side.
export const SHEET_LAYOUT = Object.freeze({
  front: 0, // top-left
  back: 1, // top-right
  left: 2, // bottom-left
  right: 3, // bottom-right
});

// Tripo rejects image prompts longer than this.
export const MAX_PROMPT_LENGTH = 1800;
export const PROMPT_PROFILES = Object.freeze(['baseline', 'identity-v1']);

// Stubble is named on its own: "beard" alone leaves short stubble in place.
// The shaved skin is tied to the character's own face; asking for "smooth"
// skin makes the model reuse the blank template face instead.
const BALD = 'The head is completely bald.';
const SHAVEN = "The face is clean-shaven in every view: no beard, no moustache and no stubble; where it was, show the same skin as the rest of the character's face.";

const CHANGES = {
  keep: 'Keep the original head hair and facial hair unchanged.',
  auto: `Remove all of the character's head hair and all of their facial hair, both together. ${BALD} ${SHAVEN}`,
  hair: `Remove all of the character's head hair. ${BALD} Keep their facial hair as it is.`,
  beard: `Remove all of the character's facial hair. ${SHAVEN} Keep their head hair as it is.`,
};

export const REMOVAL_MODES = Object.freeze(Object.keys(CHANGES));

/** The only image edit. image[1] is the concept art, image[2] the camera template. */
export function faceSheetPrompt(mode = 'auto', profile = 'baseline') {
  const change = CHANGES[mode];
  if (!change) throw new RangeError(`Unknown removal mode "${mode}".`);
  if (!PROMPT_PROFILES.includes(profile)) throw new RangeError('未知提示词版本');
  if (profile === 'identity-v1') return `image[1] is the character reference. It may contain one portrait or several views of the SAME character: use all supplied views as evidence. image[2] is only a camera/framing guide, never an identity or anatomy target.
Create ONE consistent 2x2 turnaround: front top-left, back top-right, true profile nose pointing LEFT bottom-left, true profile nose pointing RIGHT bottom-right. No three-quarter profiles. Same head size, eye level and neck cut in every panel; leave white space around the whole head including hair and ears. Pure white background, no text, borders or dividing lines. Head and short neck only, no shoulders or clothing.
Faithfully preserve the reference person's face width-to-height, cheek volume, jaw taper, chin shape, nose projection, eye spacing, eyelids, lip shape and expression. Do not widen, inflate, beautify, average, masculinize or rejuvenate the face. Preserve age lines, freckles, skin tone, scars, eye colour and distinctive asymmetry. Keep an eyepatch or other accessory on the SAME anatomical side; do not mirror the person. Side views must agree with the front and any supplied profile. Infer only what the reference does not show.
${change}
Take only camera views and framing from image[2]. Do not copy its face, jaw width or head proportions.`;
  return `image[1] is concept art of a character. image[2] is a blank white mannequin head from four views: front (top left), back (top right), profile with the nose pointing to the left edge (bottom left), profile with the nose pointing to the right edge (bottom right). image[2] is only a camera guide, not the character.

Draw the character from image[1], not the mannequin, in the same four views, layout and framing as image[2]. Keep the character's own face, eyes, skin colour, skin texture, scars and anything they wear on the head. ${change}

Take nothing from image[2] except the views and framing. Pure white background, no text or dividing lines.`;
}
