/*
 * Image Packs for SillyTavern
 * ---------------------------------------------------------------------------
 * Reusable image libraries ("packs") that can be pushed into ANY image file
 * input on the page — the native Gallery, Avatar Gallery, notsosillynotsoimages
 * reference slots, persona/character avatar uploads, backgrounds, and so on.
 *
 * How it works
 *   1. You load files (or a whole folder) into a pack once. Images live in
 *      IndexedDB as Blobs, so settings.json never gets bloated.
 *   2. The extension watches the DOM for <input type="file"> elements that
 *      accept images and attaches a small 📚 button next to each one.
 *   3. Clicking that button opens the picker. Selected images are converted
 *      back into File objects, stuffed into the input via DataTransfer and a
 *      synthetic `change`/`input` event is dispatched — exactly as if you had
 *      picked them through the OS file dialog. No other extension needs to be
 *      patched or even know we exist.
 *
 * Everything is local. Nothing is uploaded anywhere by this extension itself.
 */

(function () {
    'use strict';

    const MODULE_NAME = 'ST-ImagePacks';
    const EXT_PATH = `scripts/extensions/third-party/${MODULE_NAME}`;
    const SETTINGS_KEY = 'imagePacks';
    const LOG = `[${MODULE_NAME}]`;

    /* ============================================================
     * I18N — same lightweight layer used across my other extensions.
     * Strings live in i18n/<lang>.json; language follows ST's UI locale.
     * ============================================================ */
    const I18N_FALLBACK = 'en';
    const I18N_SUPPORTED = ['en', 'ru'];
    let I18N_LANG = I18N_FALLBACK;
    let I18N_STRINGS = {};
    let I18N_FALLBACK_STRINGS = {};

    function i18nDetectLang() {
        const candidates = [];
        try {
            const c = ctx();
            if (c) {
                if (typeof c.getCurrentLocale === 'function') candidates.push(c.getCurrentLocale());
                candidates.push(c?.powerUserSettings?.locale);
                candidates.push(c?.accountStorage?.getItem?.('language'));
            }
        } catch (e) { /* ignore */ }
        try { candidates.push(localStorage.getItem('language')); } catch (e) { /* ignore */ }
        try { candidates.push(navigator.language || navigator.userLanguage); } catch (e) { /* ignore */ }

        for (const raw of candidates) {
            if (typeof raw !== 'string' || !raw) continue;
            const lang = raw.toLowerCase().split(/[-_]/)[0];
            if (I18N_SUPPORTED.includes(lang)) return lang;
        }
        return I18N_FALLBACK;
    }

    async function i18nLoad() {
        I18N_LANG = i18nDetectLang();
        try {
            const res = await fetch(`/${EXT_PATH}/i18n/${I18N_FALLBACK}.json`);
            if (res.ok) I18N_FALLBACK_STRINGS = await res.json();
        } catch (e) {
            console.warn(`${LOG} i18n: failed to load fallback`, e);
        }
        if (I18N_LANG === I18N_FALLBACK) {
            I18N_STRINGS = I18N_FALLBACK_STRINGS;
            return;
        }
        try {
            const res = await fetch(`/${EXT_PATH}/i18n/${I18N_LANG}.json`);
            if (res.ok) {
                I18N_STRINGS = await res.json();
            } else {
                I18N_STRINGS = I18N_FALLBACK_STRINGS;
                I18N_LANG = I18N_FALLBACK;
            }
        } catch (e) {
            console.warn(`${LOG} i18n: failed to load ${I18N_LANG}`, e);
            I18N_STRINGS = I18N_FALLBACK_STRINGS;
            I18N_LANG = I18N_FALLBACK;
        }
    }

    /** Translate a key with {{var}} substitution. Falls back to EN, then key. */
    function t(key, params) {
        let str = I18N_STRINGS[key];
        if (str === undefined) str = I18N_FALLBACK_STRINGS[key];
        if (str === undefined) return key;
        if (!params) return str;
        return str.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in params ? String(params[k]) : m));
    }

    /** Locale-aware "N image(s)". */
    function tImages(n) {
        if (I18N_LANG === 'ru') {
            const m10 = n % 10, m100 = n % 100;
            if (m10 === 1 && m100 !== 11) return t('count.images.one', { count: n });
            if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return t('count.images.few', { count: n });
            return t('count.images.many', { count: n });
        }
        return t(n === 1 ? 'count.images.one' : 'count.images.many', { count: n });
    }

    /* ============================================================
     * ST context / settings
     * ============================================================ */
    function ctx() {
        try { return window.SillyTavern?.getContext?.() ?? null; } catch (e) { return null; }
    }

    const DEFAULTS = {
        enabled: true,
        showButtons: true,     // attach 📚 next to file inputs
        // How the hook buttons become visible:
        //   'auto'   — hover on desktop, reveal-mode on touch (default)
        //   'always' — always visible everywhere
        //   'tap'    — reveal-mode everywhere, even with a mouse
        revealMode: 'auto',
        fabPos: null,          // { x, y } of the floating reveal button
        maxSide: 1536,         // downscale longest side on import (0 = keep original)
        jpegQuality: 0.9,
        lastPackId: '',
        rememberLastPack: true,
    };

    function settings() {
        const c = ctx();
        const root = c?.extensionSettings ?? window.extension_settings;
        if (!root) return { ...DEFAULTS };
        if (!root[SETTINGS_KEY]) root[SETTINGS_KEY] = {};
        const s = root[SETTINGS_KEY];
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (s[k] === undefined) s[k] = v;
        }
        return s;
    }

    function saveSettings() {
        try { ctx()?.saveSettingsDebounced?.(); } catch (e) { /* ignore */ }
    }

    /* ============================================================
     * IndexedDB
     *   packs  : { id, name, created, updated, order }
     *   images : { id, packId, name, type, size, w, h, added, blob }
     * Blobs are stored directly — far cheaper than base64 and they convert
     * back into File objects for free.
     * ============================================================ */
    const DB_NAME = 'st_image_packs_db';
    const DB_VERSION = 1;
    const STORE_PACKS = 'packs';
    const STORE_IMAGES = 'images';
    let _dbPromise = null;

    function db() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains(STORE_PACKS)) {
                    d.createObjectStore(STORE_PACKS, { keyPath: 'id' });
                }
                if (!d.objectStoreNames.contains(STORE_IMAGES)) {
                    const os = d.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
                    os.createIndex('packId', 'packId', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return _dbPromise;
    }

    function tx(store, mode) {
        return db().then((d) => d.transaction(store, mode).objectStore(store));
    }

    function reqPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function dbGetAllPacks() {
        const os = await tx(STORE_PACKS, 'readonly');
        const all = await reqPromise(os.getAll()) || [];
        return all.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.created ?? 0) - (b.created ?? 0));
    }

    async function dbGetPack(id) {
        const os = await tx(STORE_PACKS, 'readonly');
        return (await reqPromise(os.get(id))) || null;
    }

    async function dbPutPack(pack) {
        const os = await tx(STORE_PACKS, 'readwrite');
        await reqPromise(os.put(pack));
        return pack;
    }

    async function dbDeletePack(id) {
        const imgs = await dbGetImages(id);
        const d = await db();
        await new Promise((resolve, reject) => {
            const t2 = d.transaction([STORE_PACKS, STORE_IMAGES], 'readwrite');
            t2.objectStore(STORE_PACKS).delete(id);
            const io = t2.objectStore(STORE_IMAGES);
            for (const im of imgs) io.delete(im.id);
            t2.oncomplete = () => resolve();
            t2.onerror = () => reject(t2.error);
        });
    }

    async function dbGetImages(packId) {
        const os = await tx(STORE_IMAGES, 'readonly');
        const idx = os.index('packId');
        const all = await reqPromise(idx.getAll(packId)) || [];
        return all.sort((a, b) => (a.added ?? 0) - (b.added ?? 0));
    }

    async function dbGetImage(id) {
        const os = await tx(STORE_IMAGES, 'readonly');
        return (await reqPromise(os.get(id))) || null;
    }

    async function dbPutImages(records) {
        const d = await db();
        await new Promise((resolve, reject) => {
            const t2 = d.transaction(STORE_IMAGES, 'readwrite');
            const os = t2.objectStore(STORE_IMAGES);
            for (const r of records) os.put(r);
            t2.oncomplete = () => resolve();
            t2.onerror = () => reject(t2.error);
        });
    }

    async function dbDeleteImages(ids) {
        const d = await db();
        await new Promise((resolve, reject) => {
            const t2 = d.transaction(STORE_IMAGES, 'readwrite');
            const os = t2.objectStore(STORE_IMAGES);
            for (const id of ids) os.delete(id);
            t2.oncomplete = () => resolve();
            t2.onerror = () => reject(t2.error);
        });
    }

    /* ============================================================
     * Helpers
     * ============================================================ */
    const uid = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function humanSize(bytes) {
        const b = Number(bytes) || 0;
        if (b < 1024) return `${b} B`;
        if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
        return `${(b / 1024 / 1024).toFixed(1)} MB`;
    }

    function toast(msg, type) {
        try {
            const fn = window.toastr?.[type || 'info'];
            if (fn) { fn(msg, t('app')); return; }
        } catch (e) { /* ignore */ }
        console.log(`${LOG} ${msg}`);
    }

    function loadImageEl(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('decode failed'));
            img.src = src;
        });
    }

    /** Downscale a File to `maxSide` if needed. Keeps transparency for PNG/WebP,
     *  re-encodes photos as JPEG. Returns { blob, type, w, h }. GIFs are never
     *  touched (canvas would kill the animation). */
    async function processFile(file, maxSide, quality) {
        const type = file.type || 'image/png';
        const url = URL.createObjectURL(file);
        try {
            const img = await loadImageEl(url);
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            const longest = Math.max(w, h);
            if (!maxSide || longest <= maxSide || type === 'image/gif' || type === 'image/svg+xml') {
                return { blob: file, type, w, h };
            }
            const scale = maxSide / longest;
            const nw = Math.max(1, Math.round(w * scale));
            const nh = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement('canvas');
            canvas.width = nw;
            canvas.height = nh;
            const g = canvas.getContext('2d');
            g.drawImage(img, 0, 0, nw, nh);
            // Preserve alpha where the source could have it.
            const outType = (type === 'image/png' || type === 'image/webp') ? type : 'image/jpeg';
            const blob = await new Promise((res) => canvas.toBlob(res, outType, quality));
            if (!blob) return { blob: file, type, w, h };
            return { blob, type: outType, w: nw, h: nh };
        } catch (e) {
            // Not decodable as an image by the browser — store as-is.
            return { blob: file, type, w: 0, h: 0 };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    /** Blob -> File with a sane name/extension so receivers see a normal upload. */
    function blobToFile(record) {
        const type = record.type || record.blob?.type || 'image/png';
        let name = record.name || 'image';
        if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
            const ext = ({
                'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
                'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
            })[type] || 'png';
            name = `${name}.${ext}`;
        }
        try {
            return new File([record.blob], name, { type, lastModified: Date.now() });
        } catch (e) {
            // Very old webviews: File constructor missing. Fake enough of it.
            const b = record.blob;
            b.name = name;
            b.lastModified = Date.now();
            return b;
        }
    }

    /* ============================================================
     * Object URL cache — thumbnails are recreated a lot while browsing, so
     * keep one URL per image id and revoke them when the modal closes.
     * ============================================================ */
    const urlCache = new Map();

    function objectUrl(record) {
        if (urlCache.has(record.id)) return urlCache.get(record.id);
        const u = URL.createObjectURL(record.blob);
        urlCache.set(record.id, u);
        return u;
    }

    function releaseUrls() {
        for (const u of urlCache.values()) {
            try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
        }
        urlCache.clear();
    }

    /* ============================================================
     * THE CORE TRICK — push our stored images into a real <input type="file">.
     *
     * DataTransfer lets us build a synthetic FileList. Assigning it to
     * input.files is allowed in every modern browser and is indistinguishable
     * from a user picking files, so any extension listening for `change`
     * (avatargallery, notsosillynotsoimages, ST's own gallery, ...) just works.
     *
     * `append` keeps whatever the input already held, for multi-file inputs.
     * ============================================================ */
    function pushFilesToInput(input, files, append) {
        if (!input || !files.length) return false;
        let list = files;
        if (append && input.files && input.files.length) {
            list = [...Array.from(input.files), ...files];
        }
        // A single-file input can only ever hold one file — take the first.
        if (!input.multiple && list.length > 1) list = [list[0]];

        try {
            const dt = new DataTransfer();
            for (const f of list) dt.items.add(f);
            input.files = dt.files;
        } catch (e) {
            console.error(`${LOG} DataTransfer failed`, e);
            toast(t('err.datatransfer'), 'error');
            return false;
        }

        // Fire the events a real pick would produce. jQuery-bound handlers
        // (ST uses plenty) listen on the same native events, so one dispatch
        // covers both worlds.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        try { window.jQuery?.(input).trigger('change'); } catch (e) { /* ignore */ }
        return true;
    }

    /* ============================================================
     * File input discovery
     * ============================================================ */
    const BTN_CLASS = 'ipk_hook_btn';
    const HOOKED_ATTR = 'data-ipk-hooked';

    /** Does this input want images? Accept an empty accept="" too — plenty of
     *  extensions omit it — but skip obvious non-image pickers (json/png cards
     *  are fine, .json-only imports are not). */
    function isImageInput(input) {
        if (!(input instanceof HTMLInputElement)) return false;
        if (input.type !== 'file') return false;
        const accept = (input.getAttribute('accept') || '').toLowerCase().trim();
        if (!accept) return true;
        if (accept.includes('image/')) return true;
        return /\.(png|jpe?g|webp|gif|avif|bmp)\b/.test(accept);
    }

    /** The visible element the user actually clicks. Hidden inputs are the norm
     *  (label-wrapped or JS-triggered), so anchor our button to something the
     *  user can see: the wrapping <label>, or the input's parent. */
    function anchorFor(input) {
        const label = input.closest('label');
        if (label) return label;
        if (input.id) {
            const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
            if (forLabel) return forLabel;
        }
        const p = input.parentElement;
        return p && p !== document.body ? p : input;
    }

    /* ------------------------------------------------------------
     * Slot grouping
     *
     * A single upload "slot" often owns several file inputs — notsosilly, for
     * example, has one behind the Upload button and another behind the
     * thumbnail overlay, both pointing at the same reference image. Hooking
     * every input gives you two identical buttons for one field, which is just
     * clutter. So inputs are grouped by their nearest shared container and the
     * group gets exactly ONE button, mounted on whichever anchor is physically
     * largest (the thumbnail beats the little button — bigger target, and it's
     * where you'd naturally tap to change the picture).
     * ------------------------------------------------------------ */
    const GROUP_ATTR = 'data-ipk-slot';
    const GROUP_MAX_DEPTH = 5;
    const GROUP_MAX_INPUTS = 4;   // above this it's a panel, not a slot

    function imageInputsIn(el) {
        return Array.from(el.querySelectorAll('input[type="file"]')).filter(isImageInput);
    }

    /** Nearest ancestor that looks like one upload slot, or null if the input
     *  stands alone. */
    function slotContainerFor(input) {
        let el = input.parentElement;
        let depth = 0;
        while (el && el !== document.body && depth < GROUP_MAX_DEPTH) {
            const found = imageInputsIn(el);
            if (found.length > 1) {
                // Too many inputs means we've climbed past the slot into the
                // whole panel — don't merge unrelated fields into one button.
                return found.length <= GROUP_MAX_INPUTS ? el : null;
            }
            el = el.parentElement;
            depth++;
        }
        return null;
    }

    function visibleArea(el) {
        if (!el) return 0;
        const r = el.getBoundingClientRect();
        return r.width * r.height;
    }

    /** Pick the anchor with the largest on-screen area — that's the thumbnail
     *  rather than the small "upload" button. */
    function bestAnchor(inputs) {
        let best = null;
        let bestArea = -1;
        for (const i of inputs) {
            const a = anchorFor(i);
            if (!a || a === document.body) continue;
            const area = visibleArea(a);
            if (area > bestArea) { bestArea = area; best = { anchor: a, input: i }; }
        }
        return best;
    }

    function hookInput(input, forcedAnchor) {
        if (!settings().showButtons) return;
        if (input.getAttribute(HOOKED_ATTR) === '1') return;
        input.setAttribute(HOOKED_ATTR, '1');

        const anchor = forcedAnchor || anchorFor(input);
        if (!anchor || anchor === document.body) return;
        // Don't double up if this anchor already carries a button.
        if (anchor.querySelector(`:scope > .${BTN_CLASS}`)) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `${BTN_CLASS} interactable`;
        btn.title = t('hook.title');
        btn.setAttribute('aria-label', t('hook.title'));
        btn.innerHTML = '<i class="fa-solid fa-images"></i>';

        btn.addEventListener('click', (e) => {
            // Critical: the anchor is usually a <label> that opens the OS file
            // dialog on click. Stop the event dead so our picker opens instead.
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            // Reveal mode is a one-shot: once you've picked a field, get the
            // buttons out of the way again.
            if (isRevealed()) setRevealed(false);
            openPicker(input);
        });
        // Labels also react to mousedown/touch in some browsers.
        for (const evt of ['mousedown', 'pointerdown', 'touchstart']) {
            btn.addEventListener(evt, (e) => { e.stopPropagation(); }, { passive: true });
        }

        // Anchors are often not positioned; make them so the button can sit in
        // the corner without disturbing the host layout.
        const pos = getComputedStyle(anchor).position;
        if (pos === 'static') anchor.classList.add('ipk_anchor_rel');
        anchor.classList.add('ipk_anchor');
        anchor.appendChild(btn);
        input.__ipkButton = btn;
    }

    function scanInputs(root) {
        if (!settings().enabled || !settings().showButtons) return;
        // Always scan the whole document: a slot's inputs can arrive in
        // separate mutations, and grouping needs to see all of them.
        const inputs = imageInputsIn(document);
        if (!inputs.length) return;

        // Hosts re-render their panels and can drop our button while keeping
        // the input alive. Un-mark those so they get hooked again below.
        for (const i of inputs) {
            if (i.getAttribute(HOOKED_ATTR) !== '1') continue;
            const btn = i.__ipkButton;
            if (btn && !document.contains(btn)) {
                i.__ipkButton = null;
                i.removeAttribute(HOOKED_ATTR);
            }
        }

        // Bucket inputs by their shared slot container. Ungrouped inputs get
        // their own bucket keyed by the element itself.
        const groups = new Map();
        for (const i of inputs) {
            if (i.getAttribute(HOOKED_ATTR) === '1') continue;
            let key;
            try { key = slotContainerFor(i) || i; } catch (e) { key = i; }
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(i);
        }

        for (const [key, list] of groups) {
            try {
                // Slot already has a button from an earlier pass — just mark
                // the newcomers as handled so they don't grow their own.
                if (key instanceof Element && key.querySelector(`.${BTN_CLASS}`)) {
                    for (const i of list) i.setAttribute(HOOKED_ATTR, '1');
                    continue;
                }
                const pick = bestAnchor(list) || { anchor: null, input: list[0] };
                if (key instanceof Element && list.length > 1) {
                    key.setAttribute(GROUP_ATTR, '1');
                }
                hookInput(pick.input, pick.anchor);
                // Everything else in the slot is covered by that one button.
                // They share the reference so a re-render that kills the button
                // un-marks the whole group, not just the one input.
                for (const i of list) {
                    i.setAttribute(HOOKED_ATTR, '1');
                    i.__ipkButton = pick.input.__ipkButton;
                }
            } catch (e) {
                console.warn(`${LOG} hook failed`, e);
            }
        }
    }

    function removeAllButtons() {
        document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => b.remove());
        document.querySelectorAll(`[${HOOKED_ATTR}]`).forEach((i) => i.removeAttribute(HOOKED_ATTR));
        document.querySelectorAll(`[${GROUP_ATTR}]`).forEach((i) => i.removeAttribute(GROUP_ATTR));
    }

    /* ============================================================
     * Reveal mode (mobile-friendly)
     *
     * Sprinkling always-visible buttons over every file field is fine with a
     * mouse but awful on a phone: they cover the host UI and get hit by
     * accident. So on touch devices the buttons stay hidden until you switch
     * the extension into "reveal mode" with the floating button. While reveal
     * mode is on, every hooked field shows a big, easy-to-hit target; tapping
     * one opens the picker and reveal mode turns itself back off.
     * ============================================================ */
    const REVEAL_CLASS = 'ipk_reveal_on';
    let fab = null;

    const isTouchDevice = () => window.matchMedia?.('(hover: none)')?.matches
        || 'ontouchstart' in window
        || navigator.maxTouchPoints > 0;

    /** Do buttons need an explicit reveal tap, or are they hover-discoverable? */
    function usesReveal() {
        const mode = settings().revealMode;
        if (mode === 'always') return false;
        if (mode === 'tap') return true;
        return isTouchDevice();
    }

    function isRevealed() {
        return document.body.classList.contains(REVEAL_CLASS);
    }

    function setRevealed(on) {
        document.body.classList.toggle(REVEAL_CLASS, !!on);
        fab?.classList.toggle('ipk_fab_active', !!on);
        if (on) {
            // Freshly opened panels may have appeared since the last scan.
            scanInputs(document);
            toast(t('toast.revealOn'), 'info');
        }
    }

    function toggleReveal() {
        setRevealed(!isRevealed());
    }

    /** Floating button: single tap toggles reveal mode, long-press (or a tap
     *  while revealed) opens the manager. Draggable so it can be moved out of
     *  the way of whatever it happens to cover. */
    function ensureFab() {
        if (!usesReveal() || !settings().enabled || !settings().showButtons) {
            fab?.remove();
            fab = null;
            return;
        }
        if (fab && document.body.contains(fab)) return;

        fab = document.createElement('div');
        fab.id = 'ipk_fab';
        fab.className = 'ipk_fab';
        fab.title = t('fab.title');
        fab.innerHTML = '<i class="fa-solid fa-images"></i>';
        document.body.appendChild(fab);
        restoreFabPos();

        let startX = 0, startY = 0, moved = false, dragging = false, longPress = null;

        const onDown = (e) => {
            const p = e.touches?.[0] || e;
            startX = p.clientX;
            startY = p.clientY;
            moved = false;
            dragging = true;
            fab.classList.add('ipk_fab_drag');
            longPress = setTimeout(() => {
                if (moved) return;
                dragging = false;
                fab.classList.remove('ipk_fab_drag');
                navigator.vibrate?.(15);
                openManager();
            }, 600);
        };

        const onMove = (e) => {
            if (!dragging) return;
            const p = e.touches?.[0] || e;
            const dx = p.clientX - startX;
            const dy = p.clientY - startY;
            if (!moved && Math.hypot(dx, dy) < 8) return;
            moved = true;
            clearTimeout(longPress);
            e.preventDefault();
            const r = fab.getBoundingClientRect();
            placeFab(r.left + dx, r.top + dy);
            startX = p.clientX;
            startY = p.clientY;
        };

        const onUp = () => {
            if (!dragging && !moved) return;
            clearTimeout(longPress);
            fab.classList.remove('ipk_fab_drag');
            if (dragging && !moved) toggleReveal();
            if (moved) saveFabPos();
            dragging = false;
        };

        fab.addEventListener('mousedown', onDown);
        fab.addEventListener('touchstart', onDown, { passive: true });
        document.addEventListener('mousemove', onMove);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchend', onUp);
        fab.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    function placeFab(x, y) {
        if (!fab) return;
        const w = fab.offsetWidth || 44;
        const h = fab.offsetHeight || 44;
        const nx = Math.max(4, Math.min(window.innerWidth - w - 4, x));
        const ny = Math.max(4, Math.min(window.innerHeight - h - 4, y));
        fab.style.left = `${nx}px`;
        fab.style.top = `${ny}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    }

    function saveFabPos() {
        if (!fab) return;
        const r = fab.getBoundingClientRect();
        settings().fabPos = { x: Math.round(r.left), y: Math.round(r.top) };
        saveSettings();
    }

    function restoreFabPos() {
        const p = settings().fabPos;
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) placeFab(p.x, p.y);
    }

    function applyRevealClasses() {
        document.body.classList.toggle('ipk_reveal_mode', usesReveal());
        if (!usesReveal()) document.body.classList.remove(REVEAL_CLASS);
        ensureFab();
    }

    let observer = null;
    let scanTimer = null;

    function startObserver() {
        if (observer) return;
        observer = new MutationObserver((records) => {
            let dirty = false;
            for (const r of records) {
                for (const n of r.addedNodes) {
                    if (n.nodeType === 1) { dirty = true; break; }
                }
                if (dirty) break;
            }
            if (!dirty) return;
            // Debounce: ST rerenders the chat constantly, no need to scan per node.
            clearTimeout(scanTimer);
            scanTimer = setTimeout(() => scanInputs(document), 250);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function stopObserver() {
        observer?.disconnect();
        observer = null;
    }

    /* ============================================================
     * State
     * ============================================================ */
    const state = {
        initialized: false,
        packs: [],
        activePackId: '',
        images: [],
        selected: new Set(),
        multiMode: false,    // taps toggle selection instead of inserting at once
        targetInput: null,   // set when the picker was opened from a hook button
        modal: null,
        dom: {},
    };

    async function refreshPacks() {
        state.packs = await dbGetAllPacks();
        if (!state.packs.length) {
            const p = { id: uid('pack'), name: t('pack.default'), created: Date.now(), updated: Date.now(), order: 0 };
            await dbPutPack(p);
            state.packs = [p];
        }
        if (!state.packs.some((p) => p.id === state.activePackId)) {
            const remembered = settings().rememberLastPack ? settings().lastPackId : '';
            const found = state.packs.find((p) => p.id === remembered);
            state.activePackId = found ? found.id : state.packs[0].id;
        }
    }

    async function loadActiveImages() {
        state.images = state.activePackId ? await dbGetImages(state.activePackId) : [];
    }

    /* ============================================================
     * Modal UI (built in JS — no template file needed)
     * ============================================================ */
    function buildModal() {
        if (state.modal) return state.modal;

        const modal = document.createElement('div');
        modal.id = 'ipk_modal';
        modal.className = 'ipk_modal ipk_hidden';
        modal.innerHTML = `
            <div class="ipk_backdrop" data-ipk-close="1"></div>
            <div class="ipk_panel">
                <div class="ipk_header">
                    <div class="ipk_title">
                        <i class="fa-solid fa-images"></i>
                        <span data-i18n="app"></span>
                    </div>
                    <div class="ipk_target" id="ipk_target_hint"></div>
                    <div class="ipk_header_actions">
                        <div class="ipk_icon_btn" id="ipk_close" data-i18n-title="btn.close">
                            <i class="fa-solid fa-xmark"></i>
                        </div>
                    </div>
                </div>

                <div class="ipk_toolbar">
                    <select id="ipk_pack_select" class="text_pole ipk_select"></select>
                    <div class="ipk_btn ipk_btn_sm" id="ipk_pack_new" data-i18n-title="btn.newPack">
                        <i class="fa-solid fa-plus"></i>
                    </div>
                    <div class="ipk_btn ipk_btn_sm" id="ipk_pack_rename" data-i18n-title="btn.renamePack">
                        <i class="fa-solid fa-pen"></i>
                    </div>
                    <div class="ipk_btn ipk_btn_sm ipk_danger" id="ipk_pack_delete" data-i18n-title="btn.deletePack">
                        <i class="fa-solid fa-trash"></i>
                    </div>
                    <div class="ipk_sep"></div>
                    <div class="ipk_btn" id="ipk_add_files">
                        <i class="fa-solid fa-file-arrow-up"></i>
                        <span data-i18n="btn.addFiles"></span>
                    </div>
                    <div class="ipk_btn" id="ipk_add_folder">
                        <i class="fa-solid fa-folder-open"></i>
                        <span data-i18n="btn.addFolder"></span>
                    </div>
                    <div class="ipk_spacer"></div>
                    <input type="search" id="ipk_search" class="text_pole ipk_search" data-i18n-placeholder="search.placeholder">
                </div>

                <div class="ipk_subbar">
                    <div class="ipk_summary" id="ipk_summary"></div>
                    <div class="ipk_spacer"></div>
                    <div class="ipk_link" id="ipk_select_all" data-i18n="btn.selectAll"></div>
                    <div class="ipk_link" id="ipk_select_none" data-i18n="btn.selectNone"></div>
                    <div class="ipk_link ipk_hidden" id="ipk_move_selected" data-i18n="btn.moveSelected"></div>
                    <div class="ipk_link ipk_hidden" id="ipk_copy_selected" data-i18n="btn.copySelected"></div>
                    <div class="ipk_link ipk_danger_text ipk_hidden" id="ipk_delete_selected" data-i18n="btn.deleteSelected"></div>
                </div>

                <div class="ipk_body">
                    <div class="ipk_grid" id="ipk_grid"></div>
                    <div class="ipk_empty ipk_hidden" id="ipk_empty">
                        <i class="fa-solid fa-images"></i>
                        <div data-i18n="empty.title"></div>
                        <small data-i18n="empty.hint"></small>
                    </div>
                    <div class="ipk_drop_hint" id="ipk_drop_hint" data-i18n="drop.hint"></div>
                </div>

                <div class="ipk_footer">
                    <div class="ipk_status" id="ipk_status"></div>
                    <div class="ipk_spacer"></div>
                    <label class="ipk_check" id="ipk_append_wrap">
                        <input type="checkbox" id="ipk_append">
                        <span data-i18n="opt.append"></span>
                    </label>
                    <div class="ipk_btn ipk_primary ipk_hidden" id="ipk_insert">
                        <i class="fa-solid fa-arrow-right-to-bracket"></i>
                        <span data-i18n="btn.insert"></span>
                    </div>
                </div>

                <input type="file" id="ipk_file_input" accept="image/*" multiple hidden>
                <input type="file" id="ipk_folder_input" webkitdirectory directory multiple hidden>
            </div>`;

        document.body.appendChild(modal);
        i18nApplyDom(modal);

        const $ = (id) => modal.querySelector(`#${id}`);
        state.dom = {
            panel: modal.querySelector('.ipk_panel'),
            targetHint: $('ipk_target_hint'),
            packSelect: $('ipk_pack_select'),
            packNew: $('ipk_pack_new'),
            packRename: $('ipk_pack_rename'),
            packDelete: $('ipk_pack_delete'),
            addFiles: $('ipk_add_files'),
            addFolder: $('ipk_add_folder'),
            search: $('ipk_search'),
            summary: $('ipk_summary'),
            selectAll: $('ipk_select_all'),
            selectNone: $('ipk_select_none'),
            moveSelected: $('ipk_move_selected'),
            copySelected: $('ipk_copy_selected'),
            deleteSelected: $('ipk_delete_selected'),
            grid: $('ipk_grid'),
            empty: $('ipk_empty'),
            dropHint: $('ipk_drop_hint'),
            status: $('ipk_status'),
            append: $('ipk_append'),
            appendWrap: $('ipk_append_wrap'),
            insert: $('ipk_insert'),
            fileInput: $('ipk_file_input'),
            folderInput: $('ipk_folder_input'),
            close: $('ipk_close'),
        };

        // Our own file inputs must never get a hook button on them.
        state.dom.fileInput.setAttribute(HOOKED_ATTR, '1');
        state.dom.folderInput.setAttribute(HOOKED_ATTR, '1');

        bindModal(modal);
        state.modal = modal;
        return modal;
    }

    function i18nApplyDom(root) {
        if (!root) return;
        root.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = t(el.getAttribute('data-i18n'));
        });
        const attrs = [
            ['data-i18n-title', 'title'],
            ['data-i18n-placeholder', 'placeholder'],
            ['data-i18n-aria-label', 'aria-label'],
        ];
        for (const [dataAttr, realAttr] of attrs) {
            root.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
                el.setAttribute(realAttr, t(el.getAttribute(dataAttr)));
            });
        }
    }

    function bindModal(modal) {
        const d = state.dom;

        modal.querySelectorAll('[data-ipk-close]').forEach((el) => {
            el.addEventListener('click', closeModal);
        });
        d.close.addEventListener('click', closeModal);

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (modal.classList.contains('ipk_hidden')) return;
            closeModal();
        });

        d.packSelect.addEventListener('change', async () => {
            state.activePackId = d.packSelect.value;
            settings().lastPackId = state.activePackId;
            saveSettings();
            state.selected.clear();
            await loadActiveImages();
            render();
        });

        d.packNew.addEventListener('click', onNewPack);
        d.packRename.addEventListener('click', onRenamePack);
        d.packDelete.addEventListener('click', onDeletePack);

        d.addFiles.addEventListener('click', () => d.fileInput.click());
        d.addFolder.addEventListener('click', () => d.folderInput.click());
        d.fileInput.addEventListener('change', (e) => onImportFiles(e.target.files, e.target));
        d.folderInput.addEventListener('change', (e) => onImportFiles(e.target.files, e.target));

        d.search.addEventListener('input', render);
        d.selectAll.addEventListener('click', () => {
            for (const im of visibleImages()) state.selected.add(im.id);
            if (state.targetInput) state.multiMode = true;
            render();
        });
        d.selectNone.addEventListener('click', () => {
            state.selected.clear();
            state.multiMode = false;
            render();
        });
        d.moveSelected.addEventListener('click', () => onTransferSelected(false));
        d.copySelected.addEventListener('click', () => onTransferSelected(true));
        d.deleteSelected.addEventListener('click', onDeleteSelected);
        d.insert.addEventListener('click', onInsert);

        // Drag & drop straight onto the grid.
        const body = modal.querySelector('.ipk_body');
        ['dragenter', 'dragover'].forEach((evt) => body.addEventListener(evt, (e) => {
            e.preventDefault();
            body.classList.add('ipk_dragging');
        }));
        ['dragleave', 'drop'].forEach((evt) => body.addEventListener(evt, (e) => {
            if (evt === 'dragleave' && body.contains(e.relatedTarget)) return;
            body.classList.remove('ipk_dragging');
        }));
        body.addEventListener('drop', (e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length) onImportFiles(files, null);
        });
    }

    function openModal() {
        buildModal();
        state.modal.classList.remove('ipk_hidden');
        document.body.classList.add('ipk_modal_open');
    }

    function closeModal() {
        if (!state.modal) return;
        state.modal.classList.add('ipk_hidden');
        document.body.classList.remove('ipk_modal_open');
        state.targetInput = null;
        state.selected.clear();
        state.multiMode = false;
        releaseUrls();
    }

    /* ============================================================
     * Rendering
     * ============================================================ */
    function visibleImages() {
        const q = (state.dom.search?.value || '').trim().toLowerCase();
        if (!q) return state.images;
        return state.images.filter((im) => (im.name || '').toLowerCase().includes(q));
    }

    function render() {
        const d = state.dom;
        if (!d.grid) return;

        // Pack dropdown
        d.packSelect.innerHTML = state.packs
            .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
            .join('');
        d.packSelect.value = state.activePackId;

        const list = visibleImages();
        const totalBytes = state.images.reduce((a, im) => a + (im.size || 0), 0);
        d.summary.textContent = `${tImages(state.images.length)} · ${humanSize(totalBytes)}`
            + (list.length !== state.images.length ? ` · ${t('search.found', { count: list.length })}` : '');

        d.grid.innerHTML = '';
        if (!list.length) {
            d.empty.classList.remove('ipk_hidden');
        } else {
            d.empty.classList.add('ipk_hidden');
            const frag = document.createDocumentFragment();
            for (const im of list) frag.appendChild(cardFor(im));
            d.grid.appendChild(frag);
        }

        const picking = !!state.targetInput;
        // The Insert button only matters once you're building a multi-image
        // selection — a plain tap already inserts.
        const showInsert = picking && (state.multiMode || state.selected.size > 0);
        d.insert.classList.toggle('ipk_hidden', !showInsert);
        d.appendWrap.classList.toggle('ipk_hidden', !showInsert || !state.targetInput?.multiple);
        const hasSel = state.selected.size > 0;
        d.deleteSelected.classList.toggle('ipk_hidden', !hasSel);
        // Move/copy need somewhere to go — pointless with a single pack.
        const canTransfer = hasSel && state.packs.length > 0;
        d.moveSelected.classList.toggle('ipk_hidden', !canTransfer);
        d.copySelected.classList.toggle('ipk_hidden', !canTransfer);
        d.grid.classList.toggle('ipk_multi', picking && state.multiMode);

        if (state.selected.size) {
            d.status.textContent = t('status.selected', { count: state.selected.size });
        } else if (picking) {
            d.status.textContent = t('status.tapHint');
        } else {
            d.status.textContent = '';
        }

        d.targetHint.textContent = picking ? t('target.hint', { name: describeInput(state.targetInput) }) : '';
    }

    function cardFor(im) {
        const card = document.createElement('div');
        card.className = 'ipk_card' + (state.selected.has(im.id) ? ' ipk_selected' : '');
        card.dataset.id = im.id;

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = objectUrl(im);
        img.alt = im.name || '';
        card.appendChild(img);

        const check = document.createElement('div');
        check.className = 'ipk_check_mark';
        check.innerHTML = '<i class="fa-solid fa-check"></i>';
        card.appendChild(check);

        const name = document.createElement('div');
        name.className = 'ipk_card_name';
        name.textContent = im.name || '';
        name.title = `${im.name || ''}\n${im.w || '?'}×${im.h || '?'} · ${humanSize(im.size)}`;
        card.appendChild(name);

        const del = document.createElement('div');
        del.className = 'ipk_card_del';
        del.title = t('btn.deleteImage');
        del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        del.addEventListener('click', async (e) => {
            e.stopPropagation();
            await dbDeleteImages([im.id]);
            state.selected.delete(im.id);
            urlCache.delete(im.id);
            await loadActiveImages();
            render();
        });
        card.appendChild(del);

        const toggle = () => {
            if (state.selected.has(im.id)) state.selected.delete(im.id);
            else state.selected.add(im.id);
            // Leaving the last item deselected drops us back to instant mode.
            if (!state.selected.size && state.targetInput) state.multiMode = false;
            render();
        };

        // One tap on a picture applies it straight away — that's the whole
        // point of the extension, no "now press Insert" ceremony. Multi-select
        // is opt-in: long-press (or ctrl/shift-click) arms it, after which
        // taps toggle selection until you insert or clear.
        card.addEventListener('click', (e) => {
            if (card.__ipkSkipClick) { card.__ipkSkipClick = false; return; }
            const wantsMulti = state.multiMode || e.ctrlKey || e.metaKey || e.shiftKey;
            if (!state.targetInput || wantsMulti) {
                if (e.ctrlKey || e.metaKey || e.shiftKey) state.multiMode = !!state.targetInput;
                toggle();
                return;
            }
            state.selected.clear();
            state.selected.add(im.id);
            onInsert();
        });

        // Long-press arms multi-select. Touch only needs ~450ms; the same
        // handler covers a held mouse button on desktop.
        let pressTimer = null;
        const startPress = () => {
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => {
                card.__ipkSkipClick = true;
                if (state.targetInput) state.multiMode = true;
                navigator.vibrate?.(15);
                toggle();
            }, 450);
        };
        const cancelPress = () => clearTimeout(pressTimer);
        card.addEventListener('touchstart', startPress, { passive: true });
        card.addEventListener('mousedown', startPress);
        for (const evt of ['touchend', 'touchmove', 'touchcancel', 'mouseup', 'mouseleave']) {
            card.addEventListener(evt, cancelPress, { passive: true });
        }
        card.addEventListener('contextmenu', (e) => {
            if (state.targetInput) e.preventDefault();
        });

        return card;
    }

    function describeInput(input) {
        if (!input) return '';
        const label = input.closest('label')?.textContent?.trim();
        if (label) return label.slice(0, 40);
        const aria = input.getAttribute('aria-label') || input.title || input.name || input.id;
        if (aria) return String(aria).slice(0, 40);
        const host = input.closest('[class*="extension"], [id]')?.id;
        return host ? String(host).slice(0, 40) : t('target.unknown');
    }

    /* ============================================================
     * Actions
     * ============================================================ */
    async function onNewPack() {
        const name = await promptText(t('prompt.newPack'), t('pack.newDefault'));
        if (!name) return;
        const p = { id: uid('pack'), name: name.trim(), created: Date.now(), updated: Date.now(), order: state.packs.length };
        await dbPutPack(p);
        await refreshPacks();
        state.activePackId = p.id;
        settings().lastPackId = p.id;
        saveSettings();
        await loadActiveImages();
        render();
    }

    async function onRenamePack() {
        const pack = await dbGetPack(state.activePackId);
        if (!pack) return;
        const name = await promptText(t('prompt.renamePack'), pack.name);
        if (!name) return;
        pack.name = name.trim();
        pack.updated = Date.now();
        await dbPutPack(pack);
        await refreshPacks();
        render();
    }

    async function onDeletePack() {
        const pack = await dbGetPack(state.activePackId);
        if (!pack) return;
        const ok = await confirmDialog(t('confirm.deletePack', { name: pack.name, count: state.images.length }));
        if (!ok) return;
        await dbDeletePack(pack.id);
        releaseUrls();
        state.activePackId = '';
        state.selected.clear();
        await refreshPacks();
        await loadActiveImages();
        render();
        toast(t('toast.packDeleted'), 'success');
    }

    async function onImportFiles(fileList, inputEl) {
        const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type));
        if (inputEl) inputEl.value = '';
        if (!files.length) {
            toast(t('toast.noImages'), 'warning');
            return;
        }
        const s = settings();
        const d = state.dom;
        let done = 0;
        const records = [];
        for (const f of files) {
            d.status.textContent = t('status.importing', { done: ++done, total: files.length });
            // Yield so the status text actually paints between files.
            await new Promise((r) => setTimeout(r, 0));
            try {
                const p = await processFile(f, s.maxSide, s.jpegQuality);
                records.push({
                    id: uid('img'),
                    packId: state.activePackId,
                    name: f.name || 'image',
                    type: p.type,
                    size: p.blob.size,
                    w: p.w,
                    h: p.h,
                    added: Date.now() + records.length,
                    blob: p.blob,
                });
            } catch (e) {
                console.warn(`${LOG} import failed for ${f.name}`, e);
            }
        }
        if (records.length) {
            await dbPutImages(records);
            const pack = await dbGetPack(state.activePackId);
            if (pack) { pack.updated = Date.now(); await dbPutPack(pack); }
        }
        await loadActiveImages();
        render();
        d.status.textContent = t('status.imported', { count: records.length });
        toast(t('toast.imported', { count: records.length }), 'success');
    }

    /* ------------------------------------------------------------
     * Moving / copying images between packs.
     *
     * Importing the same folder into three packs is silly, so selected images
     * can be shovelled into another pack directly. "Move" just rewrites the
     * packId on the existing record — no re-encoding, no duplicate blob.
     * "Copy" clones the record under a fresh id, which does duplicate the blob
     * but keeps the two packs independent (deleting from one won't gut the
     * other, which is what people expect from a copy).
     * ------------------------------------------------------------ */
    async function onTransferSelected(copy) {
        if (!state.selected.size) return;
        const targetId = await pickPackDialog(copy ? t('prompt.copyTo') : t('prompt.moveTo'));
        if (!targetId) return;

        const ids = new Set(state.selected);
        const records = state.images.filter((im) => ids.has(im.id));
        if (!records.length) return;

        const out = [];
        let base = Date.now();
        for (const rec of records) {
            const full = rec.blob ? rec : await dbGetImage(rec.id);
            if (!full) continue;
            out.push(copy
                ? { ...full, id: uid('img'), packId: targetId, added: base++ }
                : { ...full, packId: targetId, added: base++ });
        }
        if (!out.length) return;

        await dbPutImages(out);
        const target = await dbGetPack(targetId);
        if (target) { target.updated = Date.now(); await dbPutPack(target); }

        if (!copy) {
            // The records moved out of the current pack — drop their cached
            // object URLs so the grid doesn't show ghosts.
            for (const id of ids) urlCache.delete(id);
        }
        state.selected.clear();
        state.multiMode = false;
        await loadActiveImages();
        render();
        toast(t(copy ? 'toast.copied' : 'toast.moved', {
            count: out.length,
            name: target?.name || '',
        }), 'success');
    }

    /** Pack chooser. Built by hand rather than through ST's Popup: that API
     *  stringifies whatever it's handed, so passing an element rendered a
     *  literal "[object HTMLDivElement]". A plain list of buttons is also just
     *  nicer here — one tap picks the destination, no dropdown + confirm. */
    function pickPackDialog(title) {
        const others = state.packs.filter((p) => p.id !== state.activePackId);
        const NEW = '__ipk_new__';

        return new Promise((resolve) => {
            const back = document.createElement('div');
            back.className = 'ipk_pick_back';

            const box = document.createElement('div');
            box.className = 'ipk_pick_box';

            const head = document.createElement('div');
            head.className = 'ipk_pick_title';
            head.textContent = title;
            box.appendChild(head);

            const list = document.createElement('div');
            list.className = 'ipk_pick_list';

            let closed = false;
            const finish = (value) => {
                if (closed) return;
                closed = true;
                document.removeEventListener('keydown', onKey, true);
                back.remove();
                resolve(value);
            };
            const onKey = (e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();   // don't let the picker modal close too
                finish('');
            };

            for (const p of others) {
                const row = document.createElement('div');
                row.className = 'ipk_pick_row';
                row.innerHTML = '<i class="fa-solid fa-folder"></i>';
                const label = document.createElement('span');
                label.textContent = p.name;
                row.appendChild(label);
                row.addEventListener('click', () => finish(p.id));
                list.appendChild(row);
            }

            const newRow = document.createElement('div');
            newRow.className = 'ipk_pick_row ipk_pick_new';
            newRow.innerHTML = '<i class="fa-solid fa-plus"></i>';
            const newLabel = document.createElement('span');
            newLabel.textContent = t('pack.createNew');
            newRow.appendChild(newLabel);
            newRow.addEventListener('click', () => finish(NEW));
            list.appendChild(newRow);

            box.appendChild(list);

            const cancel = document.createElement('div');
            cancel.className = 'ipk_btn ipk_pick_cancel';
            cancel.textContent = t('btn.cancel');
            cancel.addEventListener('click', () => finish(''));
            box.appendChild(cancel);

            back.appendChild(box);
            back.addEventListener('click', (e) => {
                if (e.target === back) finish('');
            });
            document.addEventListener('keydown', onKey, true);

            // Mount inside our own modal so it stacks above it correctly.
            (state.modal || document.body).appendChild(back);
        }).then(async (chosen) => {
            if (chosen !== NEW) return chosen;
            const name = await promptText(t('prompt.newPack'), t('pack.newDefault'));
            if (!name) return '';
            const p = {
                id: uid('pack'), name: name.trim(),
                created: Date.now(), updated: Date.now(), order: state.packs.length,
            };
            await dbPutPack(p);
            await refreshPacks();
            return p.id;
        });
    }

    async function onDeleteSelected() {
        if (!state.selected.size) return;
        const ok = await confirmDialog(t('confirm.deleteImages', { count: state.selected.size }));
        if (!ok) return;
        const ids = [...state.selected];
        await dbDeleteImages(ids);
        for (const id of ids) urlCache.delete(id);
        state.selected.clear();
        await loadActiveImages();
        render();
    }

    async function onInsert() {
        const input = state.targetInput;
        if (!input) return;
        if (!document.contains(input)) {
            toast(t('err.inputGone'), 'error');
            closeModal();
            return;
        }
        if (!state.selected.size) {
            toast(t('toast.nothingSelected'), 'warning');
            return;
        }

        // Keep the on-screen order rather than click order — predictable.
        const ordered = state.images.filter((im) => state.selected.has(im.id));
        const files = [];
        for (const im of ordered) {
            const rec = im.blob ? im : await dbGetImage(im.id);
            if (rec?.blob) files.push(blobToFile(rec));
        }
        if (!files.length) return;

        const append = !!(state.dom.append?.checked && input.multiple);
        const ok = pushFilesToInput(input, files, append);
        if (!ok) return;

        toast(t('toast.inserted', { count: files.length }), 'success');
        closeModal();
    }

    /** Open the picker bound to a specific file input. */
    async function openPicker(input) {
        state.targetInput = input;
        buildModal();
        await refreshPacks();
        await loadActiveImages();
        state.selected.clear();
        state.multiMode = false;
        openModal();
        render();
        if (!state.images.length) {
            state.dom.status.textContent = t('status.emptyPack');
        }
    }

    /** Open the manager with no target input (pure library management). */
    async function openManager() {
        state.targetInput = null;
        buildModal();
        await refreshPacks();
        await loadActiveImages();
        state.selected.clear();
        state.multiMode = false;
        openModal();
        render();
    }

    /* ============================================================
     * Small dialogs — use ST's popup when available, otherwise fall back to
     * the browser's own prompt/confirm so nothing breaks on older builds.
     * ============================================================ */
    async function promptText(title, defaultValue) {
        const c = ctx();
        try {
            if (c?.Popup && c?.POPUP_TYPE) {
                const res = await c.Popup.show.input(title, null, defaultValue ?? '');
                return res ? String(res) : '';
            }
            if (typeof c?.callGenericPopup === 'function' && c?.POPUP_TYPE?.INPUT !== undefined) {
                const res = await c.callGenericPopup(title, c.POPUP_TYPE.INPUT, defaultValue ?? '');
                return res ? String(res) : '';
            }
        } catch (e) { /* fall through */ }
        const res = window.prompt(title, defaultValue ?? '');
        return res ? String(res) : '';
    }

    async function confirmDialog(text) {
        const c = ctx();
        try {
            if (c?.Popup && c?.POPUP_TYPE) {
                const res = await c.Popup.show.confirm(text, null);
                return !!res;
            }
            if (typeof c?.callGenericPopup === 'function' && c?.POPUP_TYPE?.CONFIRM !== undefined) {
                const res = await c.callGenericPopup(text, c.POPUP_TYPE.CONFIRM);
                return !!res;
            }
        } catch (e) { /* fall through */ }
        return window.confirm(text);
    }

    /* ============================================================
     * Wand menu button
     * ============================================================ */
    function addWandButton() {
        const container = document.getElementById('gallery_wand_container')
            || document.getElementById('extensionsMenu');
        if (!(container instanceof HTMLElement)) return false;
        if (document.getElementById('ipk_wand_button')) return true;

        const btn = document.createElement('div');
        btn.id = 'ipk_wand_button';
        btn.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
        btn.tabIndex = 0;
        btn.setAttribute('role', 'button');
        btn.style.cursor = 'pointer';
        btn.title = t('wand.title');

        const icon = document.createElement('div');
        icon.classList.add('fa-solid', 'fa-images', 'extensionsMenuExtensionButton');
        const text = document.createElement('span');
        text.textContent = t('app');
        btn.append(icon, text);

        // Touch devices can fire both touchend and a synthetic click.
        let lastFire = 0;
        const activate = (e) => {
            // Only preventDefault — letting the click bubble is what allows ST
            // to auto-close the wand dropdown.
            e.preventDefault();
            const now = Date.now();
            if (now - lastFire < 400) return;
            lastFire = now;
            openManager();
            try { document.getElementById('extensionsMenu')?.style.setProperty('display', 'none'); } catch (err) { /* ignore */ }
        };
        btn.addEventListener('click', activate);
        btn.addEventListener('touchend', activate, { passive: false });

        container.appendChild(btn);
        return true;
    }

    /* ============================================================
     * Settings panel (Extensions tab)
     * ============================================================ */
    function addSettingsPanel() {
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host || document.getElementById('ipk_settings')) return !!host;

        const s = settings();
        const wrap = document.createElement('div');
        wrap.id = 'ipk_settings';
        wrap.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b data-i18n="app"></b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="ipk_set_enabled">
                        <span data-i18n="set.enabled"></span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="ipk_set_buttons">
                        <span data-i18n="set.showButtons"></span>
                    </label>
                    <label for="ipk_set_reveal" data-i18n="set.revealMode"></label>
                    <select id="ipk_set_reveal" class="text_pole">
                        <option value="auto" data-i18n="set.reveal.auto"></option>
                        <option value="tap" data-i18n="set.reveal.tap"></option>
                        <option value="always" data-i18n="set.reveal.always"></option>
                    </select>
                    <small class="ipk_note" data-i18n="set.revealHint"></small>
                    <label class="checkbox_label">
                        <input type="checkbox" id="ipk_set_remember">
                        <span data-i18n="set.rememberPack"></span>
                    </label>
                    <label for="ipk_set_maxside" data-i18n="set.maxSide"></label>
                    <input type="number" id="ipk_set_maxside" class="text_pole" min="0" max="4096" step="128">
                    <small class="ipk_note" data-i18n="set.maxSideHint"></small>
                    <div class="menu_button menu_button_icon" id="ipk_set_open">
                        <i class="fa-solid fa-images"></i>
                        <span data-i18n="set.openManager"></span>
                    </div>
                    <small class="ipk_note" data-i18n="set.help"></small>
                </div>
            </div>`;
        host.appendChild(wrap);
        i18nApplyDom(wrap);

        const enabled = wrap.querySelector('#ipk_set_enabled');
        const buttons = wrap.querySelector('#ipk_set_buttons');
        const remember = wrap.querySelector('#ipk_set_remember');
        const maxSide = wrap.querySelector('#ipk_set_maxside');
        const reveal = wrap.querySelector('#ipk_set_reveal');

        enabled.checked = !!s.enabled;
        buttons.checked = !!s.showButtons;
        remember.checked = !!s.rememberLastPack;
        maxSide.value = s.maxSide;
        reveal.value = s.revealMode || 'auto';

        reveal.addEventListener('change', () => {
            settings().revealMode = reveal.value;
            saveSettings();
            applyEnabled();
        });

        enabled.addEventListener('change', () => {
            settings().enabled = enabled.checked;
            saveSettings();
            applyEnabled();
        });
        buttons.addEventListener('change', () => {
            settings().showButtons = buttons.checked;
            saveSettings();
            applyEnabled();
        });
        remember.addEventListener('change', () => {
            settings().rememberLastPack = remember.checked;
            saveSettings();
        });
        maxSide.addEventListener('change', () => {
            const v = Math.max(0, Math.min(4096, Number(maxSide.value) || 0));
            maxSide.value = v;
            settings().maxSide = v;
            saveSettings();
        });
        wrap.querySelector('#ipk_set_open').addEventListener('click', openManager);
        return true;
    }

    function applyEnabled() {
        const s = settings();
        if (s.enabled && s.showButtons) {
            scanInputs(document);
            startObserver();
            applyRevealClasses();
        } else {
            stopObserver();
            removeAllButtons();
            document.body.classList.remove('ipk_reveal_mode', REVEAL_CLASS);
            fab?.remove();
            fab = null;
        }
    }

    /* ============================================================
     * Boot
     * ============================================================ */
    async function init() {
        if (state.initialized) return;
        state.initialized = true;

        await i18nLoad();
        console.log(`${LOG} i18n locale: ${I18N_LANG}`);

        settings(); // materialize defaults

        // Wand button and settings panel may not exist yet — retry briefly.
        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            const a = addWandButton();
            const b = addSettingsPanel();
            if ((a && b) || tries > 40) clearInterval(timer);
        }, 500);
        addWandButton();
        addSettingsPanel();

        applyEnabled();

        // Slash command: /image-packs (alias /ipk)
        try {
            const c = ctx();
            const { SlashCommandParser, SlashCommand } = c || {};
            if (SlashCommandParser && SlashCommand) {
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: 'image-packs',
                    aliases: ['ipk'],
                    callback: () => { openManager(); return ''; },
                    helpString: t('slash.help'),
                }));
            }
        } catch (e) { /* optional */ }

        // Public API — lets other extensions/STscript push pack images too.
        window.STImagePacks = {
            openManager,
            openPicker,
            pushFilesToInput,
            listPacks: dbGetAllPacks,
            listImages: dbGetImages,
            rescan: () => scanInputs(document),
        };

        console.log(`${LOG} ready`);
    }

    if (window.jQuery) {
        window.jQuery(async () => {
            try { await init(); } catch (e) { console.error(`${LOG} init failed`, e); }
        });
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            init().catch((e) => console.error(`${LOG} init failed`, e));
        });
    }
})();
