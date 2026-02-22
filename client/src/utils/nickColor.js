/**
 * Deterministic nick color utility.
 * Maps a nickname string to a consistent color from the palette.
 * Uses a simple polynomial hash so the same nick always gets the same color.
 */

const PALETTE = [
  '#e05c5c', // red
  '#e08c5c', // orange
  '#d4c35c', // yellow
  '#7ec95c', // green
  '#5cc9a8', // teal
  '#5cb8c9', // cyan
  '#5c7ee0', // blue
  '#9c5ce0', // purple
  '#e05cb8', // pink
  '#c95c7e', // rose
  '#5ce08c', // mint
  '#e0c45c', // gold
];

/**
 * Returns a hex color string for a given nickname.
 * @param {string} nick
 * @returns {string} hex color, e.g. '#e05c5c'
 */
export function getNickColor(nick) {
  if (!nick) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < nick.length; i++) {
    h = (Math.imul(31, h) + nick.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}
