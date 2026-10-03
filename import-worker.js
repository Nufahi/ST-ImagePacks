/* Decode and resize imports off the UI thread. One file at a time bounds memory. */
'use strict';

self.onmessage = async ({ data: { file, maxSide, quality } }) => {
    let bitmap = null;
    try {
        const type = file.type || 'image/png';
        // Preserve animations and vector originals; the caller reads dimensions.
        if (type === 'image/gif' || type === 'image/svg+xml') {
            self.postMessage(null);
            return;
        }
        bitmap = await createImageBitmap(file);
        const { width: w, height: h } = bitmap;
        const longest = Math.max(w, h);
        if (!maxSide || longest <= maxSide) {
            self.postMessage({ blob: file, type, w, h });
            return;
        }
        const scale = maxSide / longest;
        const nw = Math.max(1, Math.round(w * scale));
        const nh = Math.max(1, Math.round(h * scale));
        const canvas = new OffscreenCanvas(nw, nh);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, nw, nh);
        const outType = (type === 'image/png' || type === 'image/webp') ? type : 'image/jpeg';
        const blob = await canvas.convertToBlob({ type: outType, quality });
        self.postMessage({ blob, type: blob.type || outType, w: nw, h: nh });
    } catch (e) {
        // Unsupported codec/API: let the normal browser image loader try it.
        self.postMessage(null);
    } finally {
        bitmap?.close();
    }
};
