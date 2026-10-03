# Changelog

## 1.4.0

- Discover upload fields incrementally; ignore chat streaming and the extension's own UI mutations. Scan known fields in short idle slices and pause scanning in hidden tabs.
- Load previews near the viewport using the same IntersectionObserver approach as ST-ImageManager. Show up to 120 cards per page; selection persists across pages and Select all covers all search results.
- Update selection without rebuilding image cards. Release previews, Blob references and pending press handlers when the picker closes.
- Resize imports in a Web Worker where supported, with an idle-yielding fallback. Save batches of eight images, keep the original destination pack when switching views, and prevent overlapping imports. Closing the picker stops the import after the current file and saves completed work.
- Dispatch a single native change event when inserting files; jQuery handlers receive it without a second synthetic upload.
- Clean up floating-button listeners and cancel pending scans when disabled. Ignore stale asynchronous pack loads.
