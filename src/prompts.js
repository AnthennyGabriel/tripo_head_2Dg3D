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
export function faceSheetPrompt(mode = 'auto') {
  const change = CHANGES[mode];
  if (!change) throw new RangeError(`Unknown removal mode "${mode}".`);
  return `image[1] is concept art of a character. image[2] is a blank white mannequin head from four views: front (top left), back (top right), profile with the nose pointing to the left edge (bottom left), profile with the nose pointing to the right edge (bottom right). image[2] is only a camera guide, not the character.

Draw the character from image[1], not the mannequin, in the same four views, layout and framing as image[2]. Keep the character's own face, eyes, skin colour, skin texture, scars and anything they wear on the head. ${change}

Take nothing from image[2] except the views and framing. Pure white background, no text or dividing lines.`;
}
