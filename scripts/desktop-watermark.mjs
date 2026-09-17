import fs from 'node:fs/promises';
import path from 'node:path';

const variants = {
  light: { color: 0, opacity: 0.06 },
  dark: { color: 1, opacity: 0.06 },
  hcLight: { color: 0, opacity: 0.12 },
  hcDark: { color: 1, opacity: 0.12 }
};

/** Render the original mark in one color, removing its white canvas without changing the logo asset. */
export function watermarkSvg(logo, variant) {
  const { color, opacity } = variants[variant];
  if (!Buffer.isBuffer(logo) || logo.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Hydra watermark requires the README PNG logo.');
  // Alpha = 3a - r - g - b: white becomes transparent; both green tones become solid.
  // Constant RGB makes the entire mark monochrome. sRGB preserves the source silhouette.
  const matrix = `0 0 0 0 ${color} 0 0 0 0 ${color} 0 0 0 0 ${color} -1 -1 -1 3 0`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" opacity="${opacity}"><defs><filter id="hydra-monochrome" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${matrix}"/></filter></defs><image width="512" height="512" href="data:image/png;base64,${logo.toString('base64')}" filter="url(#hydra-monochrome)"/></svg>\n`;
}

export async function stageWatermarks(directory, logo) {
  for (const variant of Object.keys(variants)) await fs.writeFile(path.join(directory, `letterpress-${variant}.svg`), watermarkSvg(logo, variant));
}

export async function verifyWatermarks(directory, logo) {
  for (const variant of Object.keys(variants)) {
    const actual = await fs.readFile(path.join(directory, `letterpress-${variant}.svg`), 'utf8');
    if (actual !== watermarkSvg(logo, variant)) throw new Error(`Hydra ${variant} empty-editor watermark is missing or stale.`);
  }
}
