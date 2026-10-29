/**
 * Client half of the Bing daily wallpaper bundle.
 *
 * Renders the wallpaper behind the whole Web UI:
 *  - the image is painted by a fixed body::before layer (behind every surface);
 *  - theme surfaces are made translucent through the sanctioned
 *    ctx.theme.overrideTokens layer, so light/dark switching keeps working;
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

    /**
     * Translucent replacements for the opaque theme surfaces. The app stacks
     * several bg-base/sidebar-fill washes over the conversation area (frame,
     * center column, conversation root), so per-layer opacity must stay low:
     * the effective veil is the product of the stacked layers.
     */
    const TOKEN_OVERRIDES = {
      '--dsw-alias-bg-base': {
        light: 'rgba(250, 250, 250, 0.18)',
        dark: 'rgba(15, 15, 15, 0.25)',
      },
      '--dsw-alias-bg-layer-1': {
        light: 'rgba(255, 255, 255, 0.66)',
        dark: 'rgba(28, 28, 30, 0.68)',
      },
      '--dsw-alias-bg-layer-2': {
        light: 'rgba(245, 245, 245, 0.75)',
        dark: 'rgba(41, 41, 41, 0.74)',
      },
      '--dsw-specific-sidebar-fill': {
        light: 'rgba(247, 247, 248, 0.2)',
        dark: 'rgba(18, 18, 19, 0.28)',
      },
    };

    const zh = {
      overlayLabel: '必应壁纸',
      stripLabel: '必应每日壁纸信息',
      untitled: '必应每日壁纸',
      refresh: '刷新壁纸',
      gallery: '最近壁纸',
      galleryTitle: '最近 30 天壁纸',
      dailyMode: '每日自动更换',
      loading: '正在加载…',
      failed: '加载失败',
      close: '关闭',
      pinned: '已固定',
    };
    const en = {
      overlayLabel: 'Bing Wallpaper',
      stripLabel: 'Bing daily wallpaper info',
      untitled: 'Bing daily wallpaper',
      refresh: 'Refresh wallpaper',
      gallery: 'Recent wallpapers',
      galleryTitle: 'Wallpapers of the last 30 days',
      dailyMode: 'Refresh daily',
      loading: 'Loading…',
      failed: 'Failed to load',
      close: 'Close',
      pinned: 'Pinned',
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

    function wallpaperCss(info) {
      const url = String(info.imageUrl || '').replace(/["\\\n\r]/g, '');
      return `
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  background-image: url("${url}");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  filter: blur(2px) saturate(1.05);
  transform: translateZ(0) scale(1.03);
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
  max-height: min(560px, 70vh);
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
}
.dbw-gallery-item:hover img {
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
    function GalleryPanel({ state, t, onPick, onDaily, onClose }) {
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
              h('span', { className: 'dbw-gallery-date' }, item.date.slice(5)),
            ),
          ),
        );
      }
      return h(
        'div',
        { className: 'dbw-gallery', role: 'dialog', 'aria-label': t('galleryTitle') },
        h(
          'div',
          { className: 'dbw-gallery-head' },
          h('span', { className: 'dbw-gallery-title' }, t('galleryTitle')),
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
            className: 'dbw-gallery-daily' + (state.choice === null ? ' dbw-gallery-active' : ''),
            onClick: onDaily,
          },
          t('dailyMode'),
        ),
        body,
      );
    }

    function bindActions(props, t, names) {
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
      const { t, refresh, toggleGallery } = bindActions(props, null, ['refresh', 'toggleGallery']);
      return h(WallpaperStrip, { state, t, onRefresh: refresh, onToggleGallery: toggleGallery });
    }

    function OverlayEntry(props) {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const { t, pick, chooseDaily, closeGallery } = bindActions(props, null, [
        'pick',
        'chooseDaily',
        'closeGallery',
      ]);
      return h(GalleryPanel, {
        state,
        t,
        onPick: pick,
        onDaily: chooseDaily,
        onClose: closeGallery,
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
      };

      const applyWallpaper = (info) => {
        clearWallpaper();
        disposeCss = insertCss(wallpaperCss(info));
        const theme = typeof ctx.get === 'function' ? ctx.get('theme') : ctx.theme;
        if (theme && typeof theme.overrideTokens === 'function') {
          try {
            disposeTokens = theme.overrideTokens(PACKAGE, TOKEN_OVERRIDES);
          } catch (error) {
            console.error('bing-wallpaper: theme override failed', error);
          }
        }
      };

      const adopt = (info) => {
        store.patch({ info });
        applyWallpaper(info);
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
            store.patch({ galleryItems: data.items, galleryLoading: false });
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

      const actions = () => ({
        refresh,
        toggleGallery,
        pick: pinChoice,
        chooseDaily,
        closeGallery: () => store.patch({ galleryOpen: false }),
      });

      // ---- boot ------------------------------------------------------------
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
          clearWallpaper();
          store.patch({ info: null, galleryOpen: false });
        },
        'bing-wallpaper: teardown',
      );
    }

    return { inject, apply };
  },
});
