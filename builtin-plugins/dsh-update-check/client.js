/**
 * dsh-update-check —— 侧栏左下角的「检查更新」。
 *
 * 单一轨道：应用本体 —— 源是本项目 GitHub Release，可应用内下载并拉起安装程序。
 * 内核（@deepseek-ai/dsh）随安装包整体发布，没有独立的运行期更新轨道；
 * 构建前用 `pnpm update-core` 把内核依赖升到最新即可。
 *
 * 全部实际动作（网络、落盘、启动安装器）都在主进程；这里只负责画界面。
 * 桌面客户端才有 window.ljanxNative，用手机局域网遥控打开时必须降级。
 */
window.__ModuleLoader__.load({
  id: 'dsh-update-check',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const SLOT = 'sidebar.footer.action'

    function native() {
      return typeof window !== 'undefined' ? window.ljanxNative : undefined
    }
    function bridge() {
      const n = native()
      return n && n.update ? n : null
    }

    const css = [
      '.duc{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center}',
      // 这里原本有三条 :has(.duc-wide) 规则把侧栏底栏从官方的上下两行压成一行，已撤掉。
      // 一行放不下：展开态 _footArea 可用宽 207px，而「齿轮+设置」按钮自然宽约 77px 再加
      // 四个 36px 图标（144px）= 221px，被 min-width:0 压扁的是设置区（实测只剩 63px），
      // 「设置」字样会溢出到图标底下。dsh-web-restart / dsh-mobile-plus 各有同样一套改造，
      // 只要有一个命中就塌成一行，所以三处一起撤（另两处走发行版补丁表）。
      // .duc-wide 类名本身继续保留，只是不再有规则挂它。
      '.duc-btn{appearance:none;position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:none;border-radius:50%;padding:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease,box-shadow 120ms ease}',
      '.duc-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary)}',
      '.duc-btn:active{background:var(--dsw-alias-interactive-bg-active)}',
      '.duc-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2),0 0 0 4px var(--dsw-alias-brand-primary)}',
      '.duc-btn.is-open{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary)}',
      '.duc-btn.is-busy svg{animation:ducSpin 1s linear infinite}',
      '.duc-btn svg{display:block;flex:none}',
      '.duc-dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary, #e5484d);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2, transparent)}',
      '.duc-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center}',
      '.duc-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}',
      '.duc-panel{position:relative;z-index:1;display:flex;flex-direction:column;gap:12px;width:min(500px,calc(100vw - 32px));max-height:min(680px,calc(100vh - 64px));box-sizing:border-box;padding:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:20px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}',
      '.duc-kicker{margin:0;color:var(--dsw-alias-brand-primary);font-size:12px;font-weight:600;letter-spacing:.04em;line-height:18px;text-transform:uppercase}',
      '.duc-body{display:flex;flex-direction:column;gap:12px;overflow:auto}',
      '.duc-detail{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.duc-detail-row{display:flex;gap:12px;font-size:12px;line-height:18px}',
      '.duc-detail-key{flex:none;width:76px;color:var(--dsw-alias-label-tertiary)}',
      '.duc-detail-val{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);word-break:break-all;font-variant-numeric:tabular-nums}',
      '.duc-versions{display:flex;gap:20px;flex-wrap:wrap;margin:0}',
      '.duc-version{display:flex;flex-direction:column;gap:2px}',
      '.duc-version dt{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.duc-version dd{margin:0;font-size:15px;font-weight:600;line-height:22px;font-variant-numeric:tabular-nums}',
      '.duc-state{margin:0;font-size:14px;line-height:22px}',
      '.duc-state.is-available{color:var(--dsw-alias-brand-primary)}',
      '.duc-state.is-latest{color:var(--dsw-alias-label-secondary)}',
      '.duc-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}',
      '.duc-label{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.duc-notes{margin:0;max-height:200px;overflow:auto;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;white-space:pre-wrap;word-break:break-word;font-family:inherit}',
      '.duc-log{display:flex;flex-direction:column;gap:10px;max-height:260px;overflow:auto;padding-right:2px}',
      '.duc-log-item{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}',
      '.duc-log-head{display:flex;align-items:baseline;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.duc-log-ver{font-size:13px;font-weight:600}',
      '.duc-log-date{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.duc-log-body{margin:0;padding:10px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;white-space:pre-wrap;word-break:break-word;font-family:inherit;max-height:190px;overflow:auto}',
      '.duc-bar{position:relative;height:8px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}',
      '.duc-bar-fill{position:absolute;inset:0 auto 0 0;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width 200ms ease}',
      '.duc-bar-text{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}',
      '.duc-restart{padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-subtle, rgba(77,107,254,.10));font-size:13px;line-height:20px}',
      '.duc-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:2px}',
      '.duc-action{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
      '.duc-action:hover:not(:disabled){background:var(--dsw-alias-button-floating-hover)}',
      '.duc-action:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2),0 0 0 4px var(--dsw-alias-brand-primary)}',
      '.duc-action:disabled{opacity:.55;cursor:default}',
      '.duc-action-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-on-brand, #fff)}',
      '.duc-action-primary:hover:not(:disabled){filter:brightness(1.06)}',
      '.duc-link{appearance:none;border:none;background:transparent;padding:0;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
      '.duc-right{margin-left:auto}',
      // 更新轨道开关（正式版 / 纯净版）与跨轨引导块
      '.duc-tracks{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.duc-track-row{display:flex;gap:6px;flex-wrap:wrap}',
      '.duc-track{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.duc-track:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.duc-track:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2),0 0 0 4px var(--dsw-alias-brand-primary)}',
      '.duc-track.is-on{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-on-brand, #fff)}',
      '.duc-track-flag{font-size:11px;opacity:.8}',
      '.duc-track-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}',
      '.duc-cross{padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-state-warning-border, var(--dsw-alias-border-l2));background:var(--dsw-alias-state-warning-subtle, rgba(255,155,0,.10));color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;display:flex;flex-direction:column;gap:6px}',
      '.duc-cross b{font-weight:600}',
      '@keyframes ducSpin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion: reduce){.duc-btn,.duc-action,.duc-bar-fill{transition:none}.duc-btn.is-busy svg{animation:none}}',
      // 设置中心侧边栏滚动修复：当插件较多时保证侧边栏可垂直滚动且首部标题不移位
      '[role="dialog"] nav,[aria-modal="true"] nav,nav[class*="_nav"]{height:100%!important;max-height:100%!important;min-height:0!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;box-sizing:border-box!important;padding-bottom:0!important}',
      '[role="dialog"] nav>div:first-child,[class*="_navTitle"]{flex:none!important}',
      '[role="dialog"] nav>div:last-child,[class*="_navList"]{flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;overflow-x:hidden!important;overscroll-behavior:contain!important;display:flex!important;flex-direction:column!important;gap:4px!important;padding-bottom:22px!important}',
      '[role="dialog"] nav button,[class*="_navCell"]{padding-right:12px!important}',
    ].join('')

    if (typeof document !== 'undefined') {
      const id = 'dsh-update-check/ui.css'
      let tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']')
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-update-check'
        tag.dataset.pluginCss = id
        document.head.appendChild(tag)
      }
      tag.textContent = css
    }

    if (typeof window !== 'undefined' && !window.__dshSettingsNavScrollHooked__) {
      window.__dshSettingsNavScrollHooked__ = true
      window.addEventListener(
        'wheel',
        (e) => {
          const dialog = e.target?.closest?.('[role="dialog"], [aria-modal="true"]')
          if (!dialog) return
          const nav = dialog.querySelector('nav')
          if (!nav || !nav.contains(e.target)) return
          const navList = nav.querySelector('[class*="navList"]') || nav.lastElementChild
          if (!navList || navList.contains(e.target)) return
          navList.scrollTop += e.deltaY
        },
        { passive: true }
      )
    }

    const copy = {
      zh: {
        trigger: '检查更新',
        kicker: '应用更新',
        title: '检查更新',
        current: '当前版本',
        latest: '最新版本',
        checking: '正在检查…',
        upToDate: '已是最新版本。',
        noRelease: '还没有已发布的版本，等作者发第一版后就能在这里更新。',
        available: (v) => `发现新版本 ${v}。`,
        sourceApp: '来源：GitHub Release（内核随安装包一起更新）',
        notes: '更新说明',
        noNotes: '（这一版没有填写更新说明）',
        download: '下载更新',
        downloading: '正在下载…',
        downloadedHint: '安装包已下载完成。',
        install: '立即安装',
        installHint: '安装程序已打开，请按提示完成。若提示文件被占用，请先退出本应用再重试。',
        recheck: '重新检查',
        openReleases: '打开发布页',
        close: '关闭',
        desktopOnly: '检查更新仅在桌面客户端内可用。用手机遥控打开时无法更新，请到电脑上操作。',
        failed: '检查更新失败',
        details: '当前应用',
        dApp: '应用版本',
        dCore: '内核底座',
        dMode: '运行模式',
        modeInstalled: '标准安装',
        modePortable: '便携模式',
        dPlatform: '系统平台',
        dRuntime: '运行时',
        dLocation: '安装位置',
        dData: '数据目录',
        trackLabel: '更新轨道',
        trackStable: '正式版',
        trackVanilla: '纯净版',
        trackInstalled: '当前',
        trackHint: '正式版自带全套自研与社区插件；纯净版只有官方内核本体（外加这个更新面板）。两条轨的包共用同一个应用标识。',
        crossTitle: (from, to, v) => `这是换轨道，不是升级：当前装的是${from}，你选的是${to}${v ? `（该轨道最新 ${v}）` : ''}。`,
        crossBody: '两条轨不能互相覆盖安装 —— 版本号上 -vanilla.N 比正式版更低，直接装过去是降级；而且数据目录会原样被另一条轨沿用。请先卸载当前版本，再从发布页下载目标轨道的安装包。',
        noReleaseForTrack: '这条轨道还没有发布过任何版本。',
        openUninstall: '打开系统卸载入口',
        uninstallOpened: '已打开系统的应用管理界面，请在列表里卸载当前版本后再安装。',
        uninstallFailed: '无法自动打开系统的应用管理界面，请手动到「设置 → 应用」里卸载当前版本。',
        dTrack: '更新轨道',
      },
      en: {
        trigger: 'Check for updates',
        kicker: 'App update',
        title: 'Check for updates',
        current: 'Current',
        latest: 'Latest',
        checking: 'Checking…',
        upToDate: 'You are on the latest version.',
        noRelease: 'No release published yet — this will work once the first version ships.',
        available: (v) => `Version ${v} is available.`,
        sourceApp: 'Source: GitHub Release (the bundled kernel updates with it)',
        notes: 'Release notes',
        noNotes: '(No release notes for this version)',
        download: 'Download update',
        downloading: 'Downloading…',
        downloadedHint: 'The installer has been downloaded.',
        install: 'Install now',
        installHint: 'The installer is open — follow its prompts. If it reports files in use, quit this app and try again.',
        recheck: 'Check again',
        openReleases: 'Open releases',
        close: 'Close',
        desktopOnly: 'Updates are only available in the desktop app, not over the mobile remote.',
        failed: 'Update check failed',
        details: 'Current app',
        dApp: 'App version',
        dCore: 'Kernel',
        dMode: 'Runtime mode',
        modeInstalled: 'Installed',
        modePortable: 'Portable',
        dPlatform: 'Platform',
        dRuntime: 'Runtime',
        dLocation: 'Install location',
        dData: 'Data directory',
        trackLabel: 'Update channel',
        trackStable: 'Stable',
        trackVanilla: 'Vanilla',
        trackInstalled: 'installed',
        trackHint: 'Stable ships the full plugin set; vanilla is the bare official kernel (plus this updater panel). Both builds share one app identity.',
        crossTitle: (from, to, v) => `This is a channel switch, not an update: you are on ${from}, you picked ${to}${v ? ` (latest ${v})` : ''}.`,
        crossBody: 'The two channels must not overwrite each other — a -vanilla.N version sorts below the stable one, so installing across is a downgrade, and the data directory would carry over. Uninstall the current app first, then install the target channel package from the releases page.',
        noReleaseForTrack: 'No release has been published on that channel yet.',
        openUninstall: 'Open uninstall settings',
        uninstallOpened: 'System app settings opened — uninstall the current version there, then install.',
        uninstallFailed: 'Could not open the system app settings automatically. Uninstall the current version from Settings → Apps first.',
        dTrack: 'Update channel',
      },
    }

    function locale() {
      const lang = typeof document !== 'undefined' ? document.documentElement.lang : ''
      return String(lang).toLowerCase().startsWith('en') ? copy.en : copy.zh
    }

    function formatBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return ''
      const mb = n / 1024 / 1024
      return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
    }

    function IconUpdate({ size = 18 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
        h('path', { d: 'M8 2.5v6.1', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' }),
        h('path', { d: 'M5.3 6.3 8 9l2.7-2.7', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M3.1 11v1.2c0 .6.5 1.1 1.1 1.1h7.6c.6 0 1.1-.5 1.1-1.1V11', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' }))
    }

    function Versions({ t, current, latest }) {
      return h('dl', { className: 'duc-versions' },
        h('div', { className: 'duc-version' },
          h('dt', null, t.current),
          h('dd', null, current ? `v${String(current).replace(/^v/i, '')}` : '—'),
        ),
        latest
          ? h('div', { className: 'duc-version' },
            h('dt', null, t.latest),
            h('dd', null, `v${String(latest).replace(/^v/i, '')}`),
          )
          : null,
      )
    }

    /**
     * 更新轨道开关。
     *
     * 默认且唯一自动选中的是**本机装的那条轨** —— 这是 v1.4.3 串台 bug 的教训：
     * 纯净版用户点一下「检查更新」就被推 260MB 的全插件包。要查另一条轨必须用户
     * 自己点，且主进程返回的结果里不会有 asset（见 src/main/update-tracks.js）。
     */
    function TrackPicker({ t, installedTrack, selected, onPick }) {
      const option = (id, label) => h('button', {
        type: 'button',
        key: id,
        className: 'duc-track' + (selected === id ? ' is-on' : ''),
        'aria-pressed': selected === id ? 'true' : 'false',
        onClick: () => { if (selected !== id) onPick(id) },
      },
        label,
        installedTrack === id ? h('span', { className: 'duc-track-flag' }, `· ${t.trackInstalled}`) : null,
      )
      return h('div', { className: 'duc-tracks' },
        h('p', { className: 'duc-label' }, t.trackLabel),
        h('div', { className: 'duc-track-row' },
          option('stable', t.trackStable),
          option('vanilla', t.trackVanilla),
        ),
        h('p', { className: 'duc-track-hint' }, t.trackHint),
      )
    }

    function Progress({ percent, received, total }) {
      return h('div', null,
        h('div', { className: 'duc-bar' },
          h('div', { className: 'duc-bar-fill', style: { width: `${percent || 0}%` } }),
        ),
        h('p', { className: 'duc-bar-text' },
          `${percent || 0}%` + (total ? `  ·  ${formatBytes(received)} / ${formatBytes(total)}` : ''),
        ),
      )
    }

    // ---------------------------------------------------------------- 应用详情

    function prettyPlatform(p) {
      if (!p) return '—'
      const [os, arch] = String(p).split('-')
      const osName = os === 'win32' ? 'Windows' : os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os
      return `${osName} ${arch || ''}`.trim()
    }

    function AppDetails({ t, info }) {
      const d = info && info.details
      if (!d) return null
      const runtime = [
        d.electron ? `Electron ${d.electron}` : '',
        d.node ? `Node ${d.node}` : '',
        d.chrome ? `Chromium ${d.chrome}` : '',
      ].filter(Boolean).join(' · ')
      const rows = [
        [t.dApp, d.appVersion ? `v${String(d.appVersion).replace(/^v/i, '')}` : '—'],
        [t.dCore, d.coreVersion ? `v${String(d.coreVersion).replace(/^v/i, '')}` : '—'],
        [t.dMode, d.runtimeMode === 'portable' ? t.modePortable : t.modeInstalled],
        [t.dTrack, (info && info.track) === 'vanilla' ? t.trackVanilla : t.trackStable],
        [t.dPlatform, prettyPlatform(d.platform)],
        [t.dRuntime, runtime || '—'],
        [t.dLocation, d.exePath || '—'],
        [t.dData, d.dataDir || '—'],
      ]
      return h('div', { className: 'duc-detail' },
        h('p', { className: 'duc-label' }, t.details),
        rows.map(([key, value]) => h('div', { className: 'duc-detail-row', key },
          h('span', { className: 'duc-detail-key' }, key),
          h('span', { className: 'duc-detail-val' }, value),
        )),
      )
    }

    // ---------------------------------------------------------------- 应用本体

    function AppTab({ t, api, onAvailability }) {
      const [phase, setPhase] = React.useState('idle')
      const [info, setInfo] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [filePath, setFilePath] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      // 用户主动选的轨道；空 = 跟随本机（installedTrack）。不持久化：换轨是一次
      // 需要当面确认后果的动作，下次打开面板必须回到安全的默认值。
      const [pickedTrack, setPickedTrack] = React.useState('')

      React.useEffect(() => {
        if (!api) return undefined
        return api.update.onProgress((p) => setProgress(p))
      }, [api])

      React.useEffect(() => {
        if (!api) return undefined
        let alive = true
        // 失败也要落地一个 info：轨道默认落在正式轨（保守侧），且让自动检查照常触发
        api.update.info().then((v) => { if (alive) setInfo(v && v.ok ? v : { ok: false }) }).catch(() => { if (alive) setInfo({ ok: false }) })
        return () => { alive = false }
      }, [api])

      const installedTrack = (info && info.track) === 'vanilla' ? 'vanilla' : 'stable'
      const track = pickedTrack || installedTrack

      const runCheck = React.useCallback(async (requested) => {
        if (!api) return
        const wanted = requested || installedTrack
        setPhase('checking'); setError(''); setNotice('')
        try {
          const v = await api.update.check(wanted)
          if (!v || v.ok !== true) {
            setPhase('error'); setError((v && v.error) || t.failed); onAvailability(false); return
          }
          setResult(v)
          if (v.status === 'available') { setPhase('available'); onAvailability(true) }
          // 跨轨道：单独一个阶段 —— 它既不是「有更新可装」也不是「已是最新」，
          // 混进后两者的话，用户会看到一句「已是最新」而完全不知道另一条轨存在。
          else if (v.status === 'cross-track') { setPhase('cross'); onAvailability(false) }
          else if (v.status === 'no-release' || v.status === 'no-release-for-track') { setPhase('no-release'); onAvailability(false) }
          else { setPhase('latest'); onAvailability(false) }
        } catch (err) {
          setPhase('error'); setError(err instanceof Error ? err.message : t.failed); onAvailability(false)
        }
      }, [api, t, installedTrack, onAvailability])

      React.useEffect(() => { if (phase === 'idle' && api && info) void runCheck(installedTrack) }, [phase, api, info, installedTrack, runCheck])

      const switchTrack = React.useCallback((next) => {
        setPickedTrack(next); void runCheck(next)
      }, [runCheck])


      const runDownload = React.useCallback(async () => {
        if (!api || !result || !result.asset) return
        setPhase('downloading'); setError('')
        setProgress({ received: 0, total: result.asset.size || 0, percent: 0 })
        try {
          const v = await api.update.download(result.asset)
          if (!v || v.ok !== true) { setPhase('available'); setError((v && v.error) || '下载失败。'); return }
          setFilePath(v.filePath || ''); setPhase('downloaded')
        } catch (err) { setPhase('available'); setError(err instanceof Error ? err.message : '下载失败。') }
      }, [api, result])

      const runInstall = React.useCallback(async () => {
        if (!api || !filePath) return
        setError('')
        const v = await api.update.install(filePath)
        if (!v || v.ok !== true) { setError((v && v.error) || '无法启动安装程序。'); return }
        setNotice(t.installHint)
      }, [api, filePath, t])

      const runUninstall = React.useCallback(async () => {
        if (!api) return
        setError('')
        const v = await api.update.openUninstall()
        if (!v || v.ok !== true) { setError((v && v.error) || t.uninstallFailed); return }
        setNotice(t.uninstallOpened)
      }, [api, t])

      const state = (() => {
        if (phase === 'checking') return h('p', { className: 'duc-state is-latest' }, t.checking)
        if (phase === 'latest') return h('p', { className: 'duc-state is-latest' }, t.upToDate)
        if (phase === 'no-release') return h('p', { className: 'duc-state is-latest' },
          result && result.status === 'no-release-for-track' ? t.noReleaseForTrack : t.noRelease)
        if (phase === 'available' || phase === 'downloading' || phase === 'downloaded') {
          return h('p', { className: 'duc-state is-available' }, t.available((result && result.latestVersion) || ''))
        }
        if (phase === 'cross') {
          const nameOf = (id) => (id === 'vanilla' ? t.trackVanilla : t.trackStable)
          return h('div', { className: 'duc-cross' },
            h('p', { className: 'duc-state is-available', style: { margin: 0 } },
              t.crossTitle(nameOf(result && result.installedTrack), nameOf(result && result.track), (result && result.latestVersion) || '')),
            h('p', { style: { margin: 0 } }, t.crossBody),
          )
        }
        return null
      })()

      return h('div', { className: 'duc-body' },
        h('p', { className: 'duc-state is-latest' }, t.sourceApp),
        h(TrackPicker, { t, installedTrack, selected: track, onPick: switchTrack }),
        h(Versions, { t, current: info && info.currentVersion, latest: result && result.latestVersion }),
        state,

        (phase === 'available' || phase === 'downloading' || phase === 'downloaded' || phase === 'cross')
          ? h('div', null,
            h('p', { className: 'duc-label' }, t.notes),
            h('pre', { className: 'duc-notes' }, (result && result.notes && result.notes.trim()) || t.noNotes),
          )
          : null,

        phase === 'downloading'
          ? h(Progress, { percent: (progress && progress.percent) || 0, received: progress && progress.received, total: progress && progress.total })
          : null,
        phase === 'downloaded' ? h('p', { className: 'duc-state is-latest' }, t.downloadedHint) : null,
        notice ? h('p', { className: 'duc-state is-latest', role: 'status' }, notice) : null,
        phase === 'error' && error ? h('p', { className: 'duc-error', role: 'alert' }, error) : null,

        h(AppDetails, { t, info }),

        h('div', { className: 'duc-actions' },
          h('button', {
            type: 'button', className: 'duc-link',
            onClick: () => { if (api) void api.update.openReleases() },
          }, t.openReleases),

          phase === 'downloading'
            ? h('button', { type: 'button', className: 'duc-action', disabled: true }, t.downloading)
            : null,

          phase === 'available'
            ? h('button', {
              type: 'button', className: 'duc-action duc-action-primary',
              disabled: !result || !result.asset,
              onClick: () => { void runDownload() },
            }, t.download)
            : null,

          phase === 'downloaded'
            ? h('button', {
              type: 'button', className: 'duc-action duc-action-primary',
              onClick: () => { void runInstall() },
            }, t.install)
            : null,

          // 跨轨道：只有「先去卸载」和「打开发布页」，没有任何安装/下载按钮
          phase === 'cross'
            ? h('button', {
              type: 'button', className: 'duc-action duc-action-primary',
              onClick: () => { void runUninstall() },
            }, t.openUninstall)
            : null,

          (phase === 'latest' || phase === 'no-release' || phase === 'error')
            ? h('button', { type: 'button', className: 'duc-action', onClick: () => { void runCheck() } }, t.recheck)
            : null,
        ),
      )
    }

    // ---------------------------------------------------------------- 入口

    function UpdateButton({ wide }) {
      const t = locale()
      const api = React.useMemo(() => bridge(), [])
      const [open, setOpen] = React.useState(false)
      const [appNew, setAppNew] = React.useState(false)

      // 左上角菜单「检查更新」→ 打开面板
      React.useEffect(() => {
        const n = native()
        if (!n || typeof n.onOpenPanel !== 'function') return undefined
        return n.onOpenPanel(() => setOpen(true))
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const dialog = open
        ? ReactDOM.createPortal(
          h('div', { className: 'duc-overlay', role: 'presentation' },
            h('div', { className: 'duc-mask', onClick: () => setOpen(false) }),
            h('div', { className: 'duc-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.title },
              h('p', { className: 'duc-kicker' }, t.kicker),
              api
                ? h(AppTab, { t, api, onAvailability: setAppNew })
                : h('div', { className: 'duc-body' }, h('p', { className: 'duc-state is-latest' }, t.desktopOnly)),
              h('div', { className: 'duc-actions' },
                h('button', { type: 'button', className: 'duc-action duc-right', onClick: () => setOpen(false) }, t.close),
              ),
            ),
          ),
          document.body,
        )
        : null

      // ⚠️ 必须放在 dialog 之后：它把 dialog 作为子节点，提前引用会踩 const 的 TDZ
      return h('div', { className: wide === false ? 'duc' : 'duc duc-wide' },
        h('button', {
          type: 'button',
          className: 'duc-btn' + (open ? ' is-open' : ''),
          title: t.trigger,
          'aria-label': t.trigger,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(true),
        },
          h(IconUpdate, { size: 18 }),
          appNew ? h('span', { className: 'duc-dot' }) : null,
        ),
        dialog,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject(SLOT, () => {
        let dispose
        try {
          dispose = ctx.slots.register({ name: SLOT, id: 'dsh-update-check', order: -90 },
            (props) => h(UpdateButton, { wide: props && props.wide }))
        } catch {
          dispose = undefined
        }
        return () => { if (dispose) dispose() }
      })
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
