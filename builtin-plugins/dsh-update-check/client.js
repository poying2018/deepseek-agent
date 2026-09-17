/**
 * dsh-update-check —— 侧栏左下角的「检查更新」。
 *
 * 单一轨道：应用本体 —— 源是本项目 GitHub Release，可应用内下载并拉起安装程序。
 * 内核（@deepseek-ai/dsh）随安装包整体发布，没有独立的运行期更新轨道；
 * 构建前用 `pnpm update-core` 把内核依赖升到最新即可。
 *
 * 全部实际动作（网络、落盘、启动安装器）都在主进程；这里只负责画界面。
 * 桌面客户端才有 window.jackdshNative，用手机局域网遥控打开时必须降级。
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
      return typeof window !== 'undefined' ? window.jackdshNative : undefined
    }
    function bridge() {
      const n = native()
      return n && n.update ? n : null
    }

    const css = [
      '.duc{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center}',
      '[class*="_footArea"]:has(.duc-wide){flex-direction:row;align-items:center;gap:4px}',
      '[class*="_footArea"]:has(.duc-wide) [class*="_settingsArea"]{flex:1 1 auto;width:auto;min-width:0}',
      '[class*="_footArea"]:has(.duc-wide) [class*="_footerActions"]{order:2;flex:none;width:auto;align-items:center;justify-content:flex-end}',
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
      '@keyframes ducSpin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion: reduce){.duc-btn,.duc-action,.duc-bar-fill{transition:none}.duc-btn.is-busy svg{animation:none}}',
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

    // ---------------------------------------------------------------- 应用本体

    function AppTab({ t, api, onAvailability }) {
      const [phase, setPhase] = React.useState('idle')
      const [info, setInfo] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [filePath, setFilePath] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        if (!api) return undefined
        return api.update.onProgress((p) => setProgress(p))
      }, [api])

      React.useEffect(() => {
        if (!api) return undefined
        let alive = true
        api.update.info().then((v) => { if (alive && v && v.ok) setInfo(v) }).catch(() => {})
        return () => { alive = false }
      }, [api])

      const runCheck = React.useCallback(async () => {
        if (!api) return
        setPhase('checking'); setError(''); setNotice('')
        try {
          const v = await api.update.check()
          if (!v || v.ok !== true) {
            setPhase('error'); setError((v && v.error) || t.failed); onAvailability(false); return
          }
          setResult(v)
          if (v.status === 'available') { setPhase('available'); onAvailability(true) }
          else if (v.status === 'no-release') { setPhase('no-release'); onAvailability(false) }
          else { setPhase('latest'); onAvailability(false) }
        } catch (err) {
          setPhase('error'); setError(err instanceof Error ? err.message : t.failed); onAvailability(false)
        }
      }, [api, t, onAvailability])

      React.useEffect(() => { if (phase === 'idle' && api) void runCheck() }, [phase, api, runCheck])

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

      const state = (() => {
        if (phase === 'checking') return h('p', { className: 'duc-state is-latest' }, t.checking)
        if (phase === 'latest') return h('p', { className: 'duc-state is-latest' }, t.upToDate)
        if (phase === 'no-release') return h('p', { className: 'duc-state is-latest' }, t.noRelease)
        if (phase === 'available' || phase === 'downloading' || phase === 'downloaded') {
          return h('p', { className: 'duc-state is-available' }, t.available((result && result.latestVersion) || ''))
        }
        return null
      })()

      return h('div', { className: 'duc-body' },
        h('p', { className: 'duc-state is-latest' }, t.sourceApp),
        h(Versions, { t, current: info && info.currentVersion, latest: result && result.latestVersion }),
        state,

        (phase === 'available' || phase === 'downloading' || phase === 'downloaded')
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
