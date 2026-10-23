// Backup of the first face sheet prompt (2026-10-11), replaced by the shorter
// one in prompts.js. Not used by the pipeline.

const BALD = `completely bald: no hair of any length anywhere on the scalp, with the skull the person's real skull, smaller than the volume the hair took up`;
const SHAVEN = `clean-shaven: no beard, moustache, stubble or beard shadow, the lower face the same skin tone as the forehead`;

const CHANGES = {
  auto: { result: `${BALD}, and ${SHAVEN}`, keep: '' },
  hair: { result: BALD, keep: ' Facial hair stays exactly as it is.' },
  beard: { result: SHAVEN, keep: ' Head hair stays exactly as it is.' },
};

export function faceSheetPromptV1(mode = 'auto') {
  const change = CHANGES[mode];
  if (!change) throw new RangeError(`Unknown removal mode "${mode}".`);
  return `Make a turnaround sheet of one character's head for a 3D model. Draw the person ${change.result}. Eyebrows and eyelashes stay.${change.keep}

image[1] is concept art, possibly from several angles, and the only source for identity, face, skin, marks, anything worn, colours and style. Do not copy hair or facial hair the result removes; where it hid the forehead, ears, neck or skull, draw skin and the real skull.

image[2] is a grey generic head that only sets the cameras and framing. Front top-left, back top-right, the head's left side bottom-left (nose to the left edge), its right side bottom-right (nose to the right edge): the profiles face away from each other, backs toward the centre. Side views are exact 90-degree profiles. Take nothing else from image[2].

The four panels are photographs of one head from cameras 90 degrees apart, and must agree like views of one object. A feature stays on its own side: visible in that side's view, hidden in the opposite one, continuing across the back. The profiles are not mirrors. Where image[1] omits a side, infer it from the sides it shows.

Head and neck only, cut off at the neck base. Eye-level orthographic cameras, neutral expression, pure white background, even lighting. No text, borders or dividing lines.`;
}
