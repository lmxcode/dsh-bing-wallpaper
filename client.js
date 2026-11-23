/**
 * Client half of the Bing daily wallpaper bundle.
 *
 * Renders the wallpaper behind the whole Web UI:
 *  - the image is painted by a fixed body::before layer (behind every surface);
 *  - theme surfaces are made translucent through the sanctioned
 *    ctx.theme.overrideTokens layer, so light/dark switching keeps working;
 *    the surface scope (whole UI vs. chat canvas only) and the veil
 *    transparency are user-adjustable and persisted;
 *  - the composer dock (allocated space below the composer card, never
 *    overlapping it) carries a quiet info strip: wallpaper title, date,
 *    gallery toggle, refresh. The gallery of the last 30 days opens as a
 *    short-lived centered panel; picking a day pins that wallpaper, picking
 *    每日自动 (the default) keeps switching every day.
 *
 * Data comes from this bundle's Host routes (same-origin, no CORS) and is
 * cached per local day in localStorage, so an offline start still shows the
 * last known wallpaper until the network returns.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bing-wallpaper',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useSyncExternalStore = React.useSyncExternalStore;
    const useEffect = React.useEffect;

    const PACKAGE = 'dsh-bing-wallpaper';
    const NS = 'bingWallpaper';
    const TODAY_PATH = '/plugins/bing-wallpaper/today';
    const LIST_PATH = '/plugins/bing-wallpaper/list';
    const STORE_KEY = 'dsh-bing-wallpaper.v1';
    const CHOICE_KEY = 'dsh-bing-wallpaper.choice.v1';
    const PREFS_KEY = 'dsh-bing-wallpaper.prefs.v1';

    /**
     * Per-surface veil floors: the RGB of the shipped light/dark palettes and
     * the most transparent alpha we allow (readability floor). The app stacks
     * several bg-base/sidebar-fill washes over the conversation area (frame,
     * center column, conversation root), so the effective veil is the product
     * of the stacked layers and per-layer opacity must stay low.
     */
    const VEIL_FLOORS = {
      '--dsw-alias-bg-base': { light: [250, 250, 250, 0.12], dark: [15, 15, 15, 0.18] },
      '--dsw-specific-sidebar-fill': { light: [247, 247, 248, 0.15], dark: [18, 18, 19, 0.22] },
      '--dsw-alias-bg-layer-1': { light: [255, 255, 255, 0.6], dark: [28, 28, 30, 0.6] },
      '--dsw-alias-bg-layer-2': { light: [245, 245, 245, 0.68], dark: [41, 41, 41, 0.66] },
    };
    /** Surfaces veiled in whole-UI mode; chat-canvas mode uses the scroll hook. */
    const FULL_SCOPE = Object.keys(VEIL_FLOORS);

    const DEFAULT_PREFS = { mode: 'full', transparency: 95, quality: 'fhd' };

    /** The URL for the preferred quality, falling back to the fhd variant. */
    function effectiveUrl(info, quality) {
      if (quality === 'uhd' && typeof info.uhdUrl === 'string' && info.uhdUrl !== '') {
        return info.uhdUrl;
      }
      return info.imageUrl;
    }

    /** One veil alpha between opaque (transparency 0) and the floor (100). */
    function veilAlpha(floor, transparency) {
      const t = Math.min(100, Math.max(0, transparency)) / 100;
      const alpha = 1 - t * (1 - floor);
      return Math.round(alpha * 1000) / 1000;
    }

    function buildOverrides(prefs) {
      if (prefs.mode === 'conversation') {
        // Chat-canvas mode paints the wallpaper on the conversation scroll
        // container itself (stable host hook), so every other surface keeps
        // the host's opaque defaults; bg-base must be transparent for the
        // canvas to show through the stacked center-column washes.
        return {
          '--dsw-alias-bg-base': { light: 'transparent', dark: 'transparent' },
        };
      }
      const out = {};
      for (const name of FULL_SCOPE) {
        const floor = VEIL_FLOORS[name];
        out[name] = {
          light: `rgba(${floor.light[0]}, ${floor.light[1]}, ${floor.light[2]}, ${veilAlpha(floor.light[3], prefs.transparency)})`,
          dark: `rgba(${floor.dark[0]}, ${floor.dark[1]}, ${floor.dark[2]}, ${veilAlpha(floor.dark[3], prefs.transparency)})`,
        };
      }
      return out;
    }

    /** Veil painted over the chat-canvas wallpaper (conversation mode). */
    const CHAT_VEIL_FLOORS = { light: 0.25, dark: 0.3 };
    /**
     * Frosted floors for the layer surfaces INSIDE the conversation scroll
     * (stream-segment wrappers, tool cards): translucent enough that the
     * small boxes left behind by collapsed reasoning stop reading as solid
     * white bars, opaque enough to keep tool cards readable.
     */
    const CHAT_LAYER_FLOORS = {
      layer1: { light: 0.45, dark: 0.5 },
      layer2: { light: 0.55, dark: 0.58 },
    };

    const zh = {
      overlayLabel: '必应壁纸',
      stripLabel: '必应每日壁纸信息',
      untitled: '必应每日壁纸',
      refresh: '刷新壁纸',
      gallery: '最近壁纸',
      galleryTitle: '最近 30 天壁纸',
      dailyMode: '每日自动更换',
      appearance: '外观',
      today: '今日',
      loading: '正在加载…',
      failed: '加载失败',
      close: '关闭',
      pinned: '已固定',
      scopeLabel: '背景范围',
      scopeFull: '全界面',
      scopeConversation: '仅对话背景',
      transparencyLabel: '表面透明度',
      qualityLabel: '壁纸画质',
      qualityFhd: '1080P',
      qualityUhd: '4K',
    };
    const en = {
      overlayLabel: 'Bing Wallpaper',
      stripLabel: 'Bing daily wallpaper info',
      untitled: 'Bing daily wallpaper',
      refresh: 'Refresh wallpaper',
      gallery: 'Recent wallpapers',
      galleryTitle: 'Wallpapers of the last 30 days',
      dailyMode: 'Refresh daily',
      appearance: 'Appearance',
      today: 'Today',
      loading: 'Loading…',
      failed: 'Failed to load',
      close: 'Close',
      pinned: 'Pinned',
      scopeLabel: 'Background scope',
      scopeFull: 'Whole UI',
      scopeConversation: 'Chat canvas only',
      transparencyLabel: 'Surface transparency',
      qualityLabel: 'Image quality',
      qualityFhd: '1080P',
      qualityUhd: '4K',
    };

    // ---- tiny observable store -------------------------------------------
    let snapshot = {
      info: null, // applied wallpaper payload
      refreshing: false,
      choice: null, // null = daily mode; 'yyyy-mm-dd' = pinned day
      galleryOpen: false,
      galleryLoading: false,
      galleryError: '',
      galleryItems: [], // [{date, headline, title, copyright, imageUrl, thumbUrl}]
      galleryToday: '', // today's date from the list route
      prefs: { ...DEFAULT_PREFS }, // { mode, transparency, quality }
    };
    const listeners = new Set();
    const emit = () => {
      for (const fn of listeners) fn();
    };
    const store = {
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      getSnapshot() {
        return snapshot;
      },
      patch(part) {
        snapshot = { ...snapshot, ...part };
        emit();
      },
    };

    // ---- helpers ----------------------------------------------------------
    const localDay = () => {
      const d = new Date();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${mm}-${dd}`;
    };

    function readJson(key) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }

    function readCache() {
      const parsed = readJson(STORE_KEY);
      if (parsed === null || typeof parsed.day !== 'string') return null;
      if (parsed.info === null || typeof parsed.info !== 'object') return null;
      return parsed;
    }

    function writeCache(entry) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(entry));
      } catch {
        /* storage may be unavailable; the live fetch still works */
      }
    }

    /** The pinned choice: { date, info } or null for daily mode. */
    function readChoice() {
      const parsed = readJson(CHOICE_KEY);
      if (parsed === null) return null;
      if (typeof parsed.date !== 'string') return null;
      if (parsed.info === null || typeof parsed.info !== 'object') return null;
      if (typeof parsed.info.imageUrl !== 'string' || parsed.info.imageUrl === '') return null;
      return parsed;
    }

    function writeChoice(choice) {
      try {
        if (choice === null) localStorage.removeItem(CHOICE_KEY);
        else localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
      } catch {
        /* ignore storage failures */
      }
    }

    function readPrefs() {
      const parsed = readJson(PREFS_KEY);
      if (parsed === null) return { ...DEFAULT_PREFS };
      const mode = parsed.mode === 'conversation' ? 'conversation' : 'full';
      const raw = Number(parsed.transparency);
      const transparency = Number.isFinite(raw)
        ? Math.min(100, Math.max(0, Math.round(raw)))
        : DEFAULT_PREFS.transparency;
      const quality = parsed.quality === 'uhd' ? 'uhd' : 'fhd';
      return { mode, transparency, quality };
    }

    function writePrefs(prefs) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* ignore storage failures */
      }
    }

    /** Insert a package-owned stylesheet; prefer the loader builtin. */
    function insertCss(text) {
      if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
        try {
          return styles.insert(text);
        } catch {
          /* fall through to a manual tag */
        }
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE;
      tag.dataset.pluginCss = `${PACKAGE}/wallpaper.css`;
      tag.textContent = text;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    function wallpaperCss(info, prefs) {
      const url = String(effectiveUrl(info, prefs.quality) || '').replace(/["\\\n\r]/g, '');
      let backdrop;
      if (prefs.mode === 'conversation') {
        // Chat-canvas mode: the wallpaper lives on the conversation scroll
        // container (stable host hook) under a translucent veil; bubbles,
        // cards, composer, and the sidebar keep the host's opaque look.
        const lightVeil = veilAlpha(CHAT_VEIL_FLOORS.light, prefs.transparency);
        const darkVeil = veilAlpha(CHAT_VEIL_FLOORS.dark, prefs.transparency);
        const lightL1 = veilAlpha(CHAT_LAYER_FLOORS.layer1.light, prefs.transparency);
        const darkL1 = veilAlpha(CHAT_LAYER_FLOORS.layer1.dark, prefs.transparency);
        const lightL2 = veilAlpha(CHAT_LAYER_FLOORS.layer2.light, prefs.transparency);
        const darkL2 = veilAlpha(CHAT_LAYER_FLOORS.layer2.dark, prefs.transparency);
        backdrop = `
[data-conversation-scroll] {
  --dsw-alias-bg-layer-1: rgba(255, 255, 255, ${lightL1});
  --dsw-alias-bg-layer-2: rgba(245, 245, 245, ${lightL2});
  background-image:
    linear-gradient(rgba(250, 250, 250, ${lightVeil}), rgba(250, 250, 250, ${lightVeil})),
    var(--dbw-chat-wallpaper, none);
  background-size: cover, cover;
  background-position: center, center;
  background-repeat: no-repeat, no-repeat;
}
body[data-ds-dark-theme] [data-conversation-scroll] {
  --dsw-alias-bg-layer-1: rgba(28, 28, 30, ${darkL1});
  --dsw-alias-bg-layer-2: rgba(41, 41, 41, ${darkL2});
  background-image:
    linear-gradient(rgba(15, 15, 15, ${darkVeil}), rgba(15, 15, 15, ${darkVeil})),
    var(--dbw-chat-wallpaper, none);
}
[data-conversation-scroll] [data-chat-flow-kind='assistant-step'][data-dbw-card] {
  background: rgba(250, 250, 250, 0.96);
  border-radius: 10px;
  padding: 10px 14px;
  margin-inline: -14px;
}
body[data-ds-dark-theme]
  [data-conversation-scroll]
  [data-chat-flow-kind='assistant-step'][data-dbw-card] {
  background: rgba(20, 20, 21, 0.96);
}
[data-conversation-scroll] :not(pre) > code {
  background: var(--dsw-alias-bg-layer-1);
}
`.trim();
      } else {
        backdrop = `
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  background-image: url("${url}");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
`.trim();
      }
      return backdrop + `
/* Host 0.2.2+ shows a one-line "settled reasoning preview" after a reasoning
   block collapses (settledReasoningPreview in the standard/detailed/verbose
   work-step display modes). Hide just that preview so collapsing leaves a
   clean header row; the body already unmounts on its own. */
[data-conversation-scroll] [data-variant='think']:not([data-expanded]) [data-shimmer-decoration],
[data-conversation-scroll] [data-variant='think']:not([data-expanded]) [class*='_summary'] {
  display: none !important;
}
.dbw-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0 8px 2px;
  font-family: var(--dsw-font-family);
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  user-select: none;
}
.dbw-strip-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  max-width: 56vw;
  padding: 2px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-decoration: none;
}
.dbw-strip-main:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-primary);
}
.dbw-strip-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dbw-strip-date {
  flex: none;
  font-variant-numeric: tabular-nums;
}
.dbw-strip-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dbw-strip-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-primary);
}
.dbw-strip-btn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dbw-strip-btn-spin {
  animation: dbw-spin 0.9s linear infinite;
}
.dbw-strip-pin {
  flex: none;
  padding: 0 6px;
  height: 16px;
  line-height: 16px;
  border-radius: 4px;
  font-size: 10px;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-static-neutral-00, #fff);
}
@keyframes dbw-spin {
  to {
    transform: rotate(360deg);
  }
}
.dbw-gallery {
  position: fixed;
  left: 50%;
  top: 12vh;
  transform: translateX(-50%);
  width: min(560px, calc(100vw - 24px));
  max-height: min(600px, 74vh);
  display: flex;
  flex-direction: column;
  padding: 10px;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-overlay);
  border: 0.5px solid var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-soft);
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  pointer-events: auto;
  font-family: var(--dsw-font-family);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  z-index: 2;
  animation: dbw-pop 0.18s var(--ds-ease-in-out, ease-out);
}
@keyframes dbw-pop {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(-8px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0) scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dbw-gallery {
    animation: none;
  }
  .dbw-strip-btn-spin {
    animation: none;
  }
}
.dbw-gallery-scrim {
  position: fixed;
  inset: 0;
  z-index: 1;
  background: rgba(0, 0, 0, 0.06);
}
.dbw-gallery-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px 8px;
}
.dbw-gallery-title {
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dbw-gallery-count {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.dbw-gallery-spacer {
  flex: 1;
}
.dbw-gallery-section {
  padding: 2px 2px 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dbw-gallery-daily-icon {
  display: inline-flex;
  align-items: center;
  color: var(--dsw-alias-brand-primary);
}
.dbw-gallery-daily {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-bottom: 8px;
  padding: 6px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.dbw-gallery-daily:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
}
.dbw-gallery-active {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.dbw-gallery-prefs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
}
.dbw-gallery-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dbw-gallery-rowlabel {
  flex: none;
  color: var(--dsw-alias-label-secondary);
}
.dbw-gallery-seg {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.dbw-gallery-segbtn {
  padding: 2px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  cursor: pointer;
}
.dbw-gallery-segbtn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-primary);
}
.dbw-gallery-segbtn.dbw-gallery-active {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.dbw-gallery-range {
  flex: 1;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.dbw-gallery-value {
  flex: none;
  min-width: 38px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}
.dbw-gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
  overflow-y: auto;
  padding: 2px;
}
.dbw-gallery-item {
  position: relative;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 8px;
  overflow: hidden;
}
.dbw-gallery-item img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.dbw-gallery-item:hover img {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dbw-gallery-item.dbw-gallery-active img {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dbw-gallery-date {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.dbw-gallery-today {
  position: absolute;
  top: 4px;
  left: 4px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-static-neutral-00, #fff);
  font-size: 10px;
  line-height: 16px;
}
.dbw-gallery-check {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-static-neutral-00, #fff);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}
.dbw-gallery-status {
  padding: 16px 4px;
  color: var(--dsw-alias-label-secondary);
}
`.trim();
    }

    // ---- icons ------------------------------------------------------------
    function RefreshIcon({ spinning }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          className: spinning ? 'dbw-strip-btn-spin' : undefined,
        },
        h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.61-3.89' }),
        h('path', { d: 'M13.5 1.5v3h-3' }),
      );
    }

    function GridIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
        h('rect', { x: 1.5, y: 1.5, width: 5.5, height: 5.5, rx: 1.5 }),
        h('rect', { x: 9, y: 1.5, width: 5.5, height: 5.5, rx: 1.5 }),
        h('rect', { x: 1.5, y: 9, width: 5.5, height: 5.5, rx: 1.5 }),
        h('rect', { x: 9, y: 9, width: 5.5, height: 5.5, rx: 1.5 }),
      );
    }

    function CloseIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
        },
        h('path', { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9' }),
      );
    }

    // ---- composer-dock strip ----------------------------------------------
    function WallpaperStrip({ state, t, onRefresh, onToggleGallery }) {
      const info = state.info;
      if (!info) return null;
      const title = info.title || info.headline || t('untitled');
      const tooltip = [info.headline, info.copyright].filter(Boolean).join('\n');
      const site = info.pageUrl || 'https://bing.fullpx.com/';
      return h(
        'div',
        { className: 'dbw-strip', role: 'contentinfo', 'aria-label': t('stripLabel') },
        h(
          'a',
          {
            className: 'dbw-strip-main',
            href: site,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: tooltip || undefined,
          },
          h('span', { className: 'dbw-strip-title' }, title),
          info.date ? h('span', { className: 'dbw-strip-date' }, info.date) : null,
        ),
        state.choice !== null
          ? h('span', { className: 'dbw-strip-pin', title: t('pinned') }, t('pinned'))
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'dbw-strip-btn',
            onClick: onToggleGallery,
            'aria-label': t('gallery'),
            'aria-expanded': state.galleryOpen,
            title: t('gallery'),
          },
          h(GridIcon),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dbw-strip-btn',
            onClick: onRefresh,
            'aria-label': t('refresh'),
            title: t('refresh'),
          },
          h(RefreshIcon, { spinning: state.refreshing }),
        ),
      );
    }

    // ---- gallery panel -----------------------------------------------------
    function GalleryPanel({
      state,
      t,
      onPick,
      onDaily,
      onClose,
      onSetMode,
      onSetTransparency,
      onSetQuality,
    }) {
      useEffect(() => {
        if (!state.galleryOpen) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('keydown', onKey);
        };
      }, [state.galleryOpen, onClose]);
      if (!state.galleryOpen) return null;
      const appliedDate = state.info?.date ?? '';
      const prefs = state.prefs;
      let body;
      if (state.galleryLoading && state.galleryItems.length === 0) {
        body = h('div', { className: 'dbw-gallery-status' }, t('loading'));
      } else if (state.galleryError !== '' && state.galleryItems.length === 0) {
        body = h('div', { className: 'dbw-gallery-status' }, t('failed'));
      } else {
        body = h(
          'div',
          { className: 'dbw-gallery-grid' },
          state.galleryItems.map((item) =>
            h(
              'button',
              {
                key: item.date,
                type: 'button',
                className:
                  'dbw-gallery-item' + (item.date === appliedDate ? ' dbw-gallery-active' : ''),
                onClick: () => onPick(item),
                title: [item.title || item.headline, item.date].filter(Boolean).join('\n'),
              },
              h('img', {
                src: item.thumbUrl,
                alt: item.title || item.headline || item.date,
                loading: 'lazy',
                draggable: false,
              }),
              state.galleryToday === item.date
                ? h('span', { className: 'dbw-gallery-today' }, t('today'))
                : null,
              item.date === appliedDate ? h('span', { className: 'dbw-gallery-check' }, '✓') : null,
              h('span', { className: 'dbw-gallery-date' }, item.date.slice(5)),
            ),
          ),
        );
      }
      const segBtn = (current, value, label, onPickValue) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': current === value,
            className: 'dbw-gallery-segbtn' + (current === value ? ' dbw-gallery-active' : ''),
            onClick: () => onPickValue(value),
          },
          label,
        );
      const modeSeg = (value, label) => segBtn(prefs.mode, value, label, onSetMode);
      const qualitySeg = (value, label) => segBtn(prefs.quality, value, label, onSetQuality);
      const count = state.galleryItems.length;
      return h(
        React.Fragment,
        null,
        h('div', {
          className: 'dbw-gallery-scrim',
          'aria-hidden': true,
          onClick: onClose,
        }),
        h(
          'div',
          { className: 'dbw-gallery', role: 'dialog', 'aria-label': t('galleryTitle') },
          h(
            'div',
            { className: 'dbw-gallery-head' },
            h('span', { className: 'dbw-gallery-title' }, t('galleryTitle')),
            count > 0 ? h('span', { className: 'dbw-gallery-count' }, String(count)) : null,
            h('span', { className: 'dbw-gallery-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dbw-strip-btn',
                onClick: onClose,
                'aria-label': t('close'),
                title: t('close'),
              },
              h(CloseIcon),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className:
                'dbw-gallery-daily' + (state.choice === null ? ' dbw-gallery-active' : ''),
              onClick: onDaily,
            },
            h('span', { className: 'dbw-gallery-daily-icon' }, h(RefreshIcon, { spinning: false })),
            h('span', null, t('dailyMode')),
          ),
          h('div', { className: 'dbw-gallery-section' }, t('appearance')),
          h(
            'div',
            { className: 'dbw-gallery-prefs' },
            h(
              'div',
              { className: 'dbw-gallery-row' },
              h('span', { className: 'dbw-gallery-rowlabel' }, t('scopeLabel')),
              h(
                'div',
                { className: 'dbw-gallery-seg', role: 'radiogroup', 'aria-label': t('scopeLabel') },
                modeSeg('full', t('scopeFull')),
                modeSeg('conversation', t('scopeConversation')),
              ),
            ),
            h(
              'div',
              { className: 'dbw-gallery-row' },
              h('span', { className: 'dbw-gallery-rowlabel' }, t('transparencyLabel')),
              h('input', {
                type: 'range',
                min: 0,
                max: 100,
                step: 1,
                value: prefs.transparency,
                className: 'dbw-gallery-range',
                'aria-label': t('transparencyLabel'),
                onInput: (event) => onSetTransparency(Number(event.target.value)),
              }),
              h('span', { className: 'dbw-gallery-value' }, `${prefs.transparency}%`),
            ),
            h(
              'div',
              { className: 'dbw-gallery-row' },
              h('span', { className: 'dbw-gallery-rowlabel' }, t('qualityLabel')),
              h(
                'div',
                { className: 'dbw-gallery-seg', role: 'radiogroup', 'aria-label': t('qualityLabel') },
                qualitySeg('fhd', t('qualityFhd')),
                qualitySeg('uhd', t('qualityUhd')),
              ),
            ),
          ),
          body,
        ),
      );
    }

    function bindActions(props, names) {
      const bound = {};
      for (const name of names) {
        bound[name] =
          typeof props?.[name] === 'function'
            ? props[name]
            : () => {
                /* no-op without actions */
              };
      }
      bound.t = typeof props?.t === 'function' ? props.t : (key) => key;
      return bound;
    }

    function StripEntry(props) {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const { t, refresh, toggleGallery } = bindActions(props, ['refresh', 'toggleGallery']);
      return h(WallpaperStrip, { state, t, onRefresh: refresh, onToggleGallery: toggleGallery });
    }

    function OverlayEntry(props) {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const { t, pick, chooseDaily, closeGallery, setMode, setTransparency, setQuality } =
        bindActions(props, [
          'pick',
          'chooseDaily',
          'closeGallery',
          'setMode',
          'setTransparency',
          'setQuality',
        ]);
      return h(GalleryPanel, {
        state,
        t,
        onPick: pick,
        onDaily: chooseDaily,
        onClose: closeGallery,
        onSetMode: setMode,
        onSetTransparency: setTransparency,
        onSetQuality: setQuality,
      });
    }

    // ---- plugin body ------------------------------------------------------
    const inject = ['theme', 'slots', 'locale'];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'bing-wallpaper: dictionaries');

      let disposeCss = null;
      let disposeTokens = null;

      const clearWallpaper = () => {
        if (disposeCss !== null) {
          disposeCss();
          disposeCss = null;
        }
        if (disposeTokens !== null) {
          disposeTokens();
          disposeTokens = null;
        }
        document.body.style.removeProperty('--dbw-chat-wallpaper');
      };

      /**
       * Reading-card marker: CSS cannot select by rendered height, so a
       * rAF-batched MutationObserver tags assistant steps that are tall
       * enough to be real content (>= 48px). Collapsed reasoning summaries
       * and stream fragments (≈20px) stay untagged, so no stray white bars.
       */
      let cardObserver = null;
      let cardFrame = 0;
      const CARD_STEP_SELECTOR =
        "[data-conversation-scroll] [data-chat-flow-kind='assistant-step']";
      const markAssistantCards = () => {
        if (cardFrame !== 0) return;
        cardFrame = window.requestAnimationFrame(() => {
          cardFrame = 0;
          for (const step of document.querySelectorAll(CARD_STEP_SELECTOR)) {
            if (step.offsetHeight >= 48) step.setAttribute('data-dbw-card', '');
            else step.removeAttribute('data-dbw-card');
          }
        });
      };
      const startCardWatcher = () => {
        if (cardObserver !== null) return;
        cardObserver = new MutationObserver(markAssistantCards);
        cardObserver.observe(document.body, { childList: true, subtree: true });
        markAssistantCards();
      };
      const stopCardWatcher = () => {
        if (cardObserver !== null) {
          cardObserver.disconnect();
          cardObserver = null;
        }
        if (cardFrame !== 0) {
          window.cancelAnimationFrame(cardFrame);
          cardFrame = 0;
        }
        for (const el of document.querySelectorAll('[data-dbw-card]')) {
          el.removeAttribute('data-dbw-card');
        }
      };

      /** (Re)stack the translucent veil layer for the current prefs. */
      const applyTokensLayer = () => {
        if (disposeTokens !== null) {
          disposeTokens();
          disposeTokens = null;
        }
        const theme = typeof ctx.get === 'function' ? ctx.get('theme') : ctx.theme;
        if (theme && typeof theme.overrideTokens === 'function') {
          try {
            disposeTokens = theme.overrideTokens(PACKAGE, buildOverrides(snapshot.prefs));
          } catch (error) {
            console.error('bing-wallpaper: theme override failed', error);
          }
        }
      };

      /** Paint the wallpaper layer for the current info + prefs. */
      const applyWallpaper = () => {
        if (disposeCss !== null) {
          disposeCss();
          disposeCss = null;
        }
        const info = snapshot.info;
        if (info !== null && effectiveUrl(info, snapshot.prefs.quality)) {
          disposeCss = insertCss(wallpaperCss(info, snapshot.prefs));
          if (snapshot.prefs.mode === 'conversation') {
            const url = String(effectiveUrl(info, snapshot.prefs.quality)).replace(
              /["\\\n\r]/g,
              '',
            );
            document.body.style.setProperty('--dbw-chat-wallpaper', `url("${url}")`);
            startCardWatcher();
          } else {
            document.body.style.removeProperty('--dbw-chat-wallpaper');
            stopCardWatcher();
          }
        } else {
          stopCardWatcher();
        }
        applyTokensLayer();
      };

      const adopt = (info) => {
        store.patch({ info });
        applyWallpaper();
      };

      let inFlight = null;
      let controller = null;

      const fetchToday = async (signal) => {
        const response = await fetch(TODAY_PATH, {
          signal,
          headers: { accept: 'application/json' },
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || data === null || typeof data !== 'object' || data.ok !== true) {
          const reason =
            data !== null && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
          throw new Error(reason);
        }
        if (typeof data.imageUrl !== 'string' || data.imageUrl === '') {
          throw new Error('route payload has no imageUrl');
        }
        return data;
      };

      /** Daily-mode pipeline: fetch today and apply it. */
      const load = (force) => {
        const cached = readCache();
        if (!force && cached !== null && cached.day === localDay() && cached.info.imageUrl) {
          adopt(cached.info);
          return Promise.resolve();
        }
        if (inFlight !== null) return inFlight;
        controller = new AbortController();
        store.patch({ refreshing: true });
        const run = (async () => {
          try {
            const data = await fetchToday(controller.signal);
            const entry = { day: localDay(), info: data };
            writeCache(entry);
            adopt(data);
          } catch (error) {
            if (cached !== null && cached.info.imageUrl) {
              // keep the last known wallpaper visible while offline
              adopt(cached.info);
            } else {
              console.error('bing-wallpaper:', error);
            }
          } finally {
            store.patch({ refreshing: false });
            inFlight = null;
          }
        })();
        inFlight = run;
        return run;
      };

      /** Gallery pipeline: fetch the last-30-days list. */
      let listInFlight = null;
      const loadList = () => {
        if (listInFlight !== null) return listInFlight;
        store.patch({ galleryLoading: true, galleryError: '' });
        listInFlight = (async () => {
          try {
            const response = await fetch(LIST_PATH, { headers: { accept: 'application/json' } });
            const data = await response.json().catch(() => null);
            if (
              !response.ok ||
              data === null ||
              typeof data !== 'object' ||
              data.ok !== true ||
              !Array.isArray(data.items)
            ) {
              throw new Error(`list HTTP ${response.status}`);
            }
            store.patch({
              galleryItems: data.items,
              galleryToday: typeof data.today === 'string' ? data.today : '',
              galleryLoading: false,
            });
          } catch (error) {
            store.patch({ galleryLoading: false, galleryError: String(error?.message ?? error) });
            console.error('bing-wallpaper: list failed', error);
          } finally {
            listInFlight = null;
          }
        })();
        return listInFlight;
      };

      // ---- selection actions ----------------------------------------------
      const pinChoice = (item) => {
        const info = {
          ok: true,
          headline: item.headline || '',
          title: item.title || '',
          copyright: item.copyright || '',
          date: item.date || '',
          imageUrl: item.imageUrl,
          uhdUrl: typeof item.uhdUrl === 'string' ? item.uhdUrl : '',
          pageUrl: 'https://bing.fullpx.com/',
        };
        writeChoice({ date: info.date, info });
        store.patch({ choice: info.date, galleryOpen: false });
        adopt(info);
      };

      const chooseDaily = () => {
        writeChoice(null);
        store.patch({ choice: null, galleryOpen: false });
        load(true);
      };

      const toggleGallery = () => {
        const open = !snapshot.galleryOpen;
        store.patch({ galleryOpen: open });
        if (open && snapshot.galleryItems.length === 0) void loadList();
      };

      const refresh = () => {
        if (readChoice() !== null) {
          const choice = readChoice();
          if (choice !== null && choice.info.imageUrl) adopt(choice.info);
        } else {
          void load(true);
        }
      };

      // ---- preference actions ---------------------------------------------
      const setMode = (mode) => {
        if (mode !== 'full' && mode !== 'conversation') return;
        if (snapshot.prefs.mode === mode) return;
        const prefs = { ...snapshot.prefs, mode };
        writePrefs(prefs);
        store.patch({ prefs });
        applyWallpaper();
      };

      const setTransparency = (value) => {
        const transparency = Math.min(100, Math.max(0, Math.round(value)));
        if (snapshot.prefs.transparency === transparency) return;
        const prefs = { ...snapshot.prefs, transparency };
        writePrefs(prefs);
        store.patch({ prefs });
        applyWallpaper();
      };

      const setQuality = (quality) => {
        if (quality !== 'fhd' && quality !== 'uhd') return;
        if (snapshot.prefs.quality === quality) return;
        const prefs = { ...snapshot.prefs, quality };
        writePrefs(prefs);
        store.patch({ prefs });
        applyWallpaper();
      };

      const actions = () => ({
        refresh,
        toggleGallery,
        pick: pinChoice,
        chooseDaily,
        closeGallery: () => store.patch({ galleryOpen: false }),
        setMode,
        setTransparency,
        setQuality,
      });

      // ---- boot ------------------------------------------------------------
      store.patch({ prefs: readPrefs() });
      const savedChoice = readChoice();
      if (savedChoice !== null) {
        store.patch({ choice: savedChoice.date });
        adopt(savedChoice.info);
      } else {
        load(false);
      }

      // Swap the wallpaper shortly after local midnight (daily mode only).
      let midnightTimer = 0;
      const scheduleMidnight = () => {
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
        midnightTimer = window.setTimeout(() => {
          if (readChoice() === null) load(true);
          scheduleMidnight();
        }, Math.max(1000, next - now));
      };
      scheduleMidnight();

      // Refetch when the tab becomes visible again on a new local day.
      const onVisibility = () => {
        if (document.visibilityState !== 'visible') return;
        if (readChoice() !== null) return;
        const cached = readCache();
        if (cached === null || cached.day !== localDay()) load(true);
      };
      document.addEventListener('visibilitychange', onVisibility);

      // Info strip in the composer dock: allocated space below the composer
      // card, so it can never overlap the dialog or its controls. Ordered to
      // the far left so the host's own dock entries keep their positions.
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'bing-wallpaper',
            order: -1000,
            locale: NS,
            label: () => t('overlayLabel'),
            inject: actions,
          },
          StripEntry,
        ),
      );

      // The gallery panel floats above everything only while it is open.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'bing-wallpaper-gallery',
            order: -1000,
            locale: NS,
            label: () => t('galleryTitle'),
            inject: actions,
          },
          OverlayEntry,
        ),
      );

      ctx.effect(
        () => () => {
          window.clearTimeout(midnightTimer);
          document.removeEventListener('visibilitychange', onVisibility);
          controller?.abort();
          stopCardWatcher();
          clearWallpaper();
          store.patch({ info: null, galleryOpen: false });
        },
        'bing-wallpaper: teardown',
      );
    }

    return { inject, apply };
  },
});
