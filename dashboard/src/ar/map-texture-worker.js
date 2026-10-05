/**
 * Worker: downscale ImageBitmap textures off the main thread.
 */
self.onmessage = async (event) => {
  const { id, bitmap, maxSize } = event.data;

  try {
    if (!bitmap || !maxSize) {
      self.postMessage({ id, bitmap }, bitmap ? [bitmap] : []);
      return;
    }

    const w = bitmap.width;
    const h = bitmap.height;
    const max = Math.max(w, h);

    if (max <= maxSize) {
      self.postMessage({ id, bitmap }, [bitmap]);
      return;
    }

    const scale = maxSize / max;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    const canvas = new OffscreenCanvas(nw, nh);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      self.postMessage({ id, bitmap }, [bitmap]);
      return;
    }

    ctx.drawImage(bitmap, 0, 0, nw, nh);
    bitmap.close?.();
    const out = await createImageBitmap(canvas);
    self.postMessage({ id, bitmap: out }, [out]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
