const FADE = 0.5; // seconds — matches iMovie's default "Fade to Black"

/**
 * Return the video and audio filter strings to apply a fade-in at the start
 * and a fade-out at the end of a single clip.
 *
 * When multiple clips are concatenated, applying these to every clip produces a
 * "fade to black" at each junction (clip N fades out → black → clip N+1 fades in),
 * which is exactly iMovie's default cross-clip behaviour.
 *
 * @param {number} duration - clip duration in seconds
 * @param {number} fps      - clip frame rate (used for frame-count calculation)
 * @returns {{ vf: string, af: string }}
 */
export function buildFadeFilters(duration, fps) {
  const fadeOutStart = Math.max(0, duration - FADE);
  // FFmpeg fade filter accepts time in seconds via st= (start time)
  const vf = `fade=t=in:st=0:d=${FADE},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE}`;
  const af = `afade=t=in:st=0:d=${FADE},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE}`;
  return { vf, af };
}
