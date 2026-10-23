// Turns a photo the admin picks into a small passport-shaped JPEG (7:9, 210 x 270 px, a few KB) and returns its base64.
// Browser only. The crop is the middle of the picture, a little high so heads aren't cut off.

export const PASSPORT_W = 210, PASSPORT_H = 270;

export async function passportJpeg(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('That isn’t a picture.');
  if (file.size > 20e6) throw new Error('That picture is too big (over 20 MB).');
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const c = document.createElement('canvas');
    c.width = PASSPORT_W; c.height = PASSPORT_H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    const want = PASSPORT_W / PASSPORT_H;
    let sw = bmp.width, sh = bmp.height;
    if (sw / sh > want) sw = Math.round(sh * want); else sh = Math.round(sw / want);
    const sx = Math.round((bmp.width - sw) / 2);
    const sy = Math.round(Math.max(0, Math.min(bmp.height - sh, (bmp.height - sh) * 0.3)));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const b64 = c.toDataURL('image/jpeg', 0.82).split(',')[1];
    if (!b64 || b64.length > 70000) throw new Error('That picture came out too large; try another.');
    return b64;
  } finally { bmp.close?.(); }
}
