window.__ModuleLoader__.load({
  id: 'dsh-update-check',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const SLOT = 'sidebar.footer.action'

    /** 只有桌面客户端里的页面才有这个桥；浏览器/手机遥控打开时为 null。 */
    function bridge() {
      const native = typeof window !== 'undefined' ? window.jackdshNative : undefined
      return native && native.update ? native.update : null
    }

    const css = [
      '.duc{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center}',
      // 与 dsh-web-restart 同款：把侧栏 footer 改成一行排布，让两个按钮并排
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
      // 有新版时按钮右上角挂一个小圆点
      '.duc-dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary, #e5484d);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2, transparent)}',
      '.duc-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center}',
      '.duc-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}',
      '.duc-panel{position:relative;z-index:1;display:flex;flex-direction:column;gap:12px;width:min(460px,calc(100vw - 32px));max-height:min(640px,calc(100vh - 64px));box-sizing:border-box;padding:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:20px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}',
      '.duc-kicker{margin:0;color:var(--dsw-alias-brand-primary);font-size:12px;font-weight:600;letter-spacing:.04em;line-height:18px;text-transform:uppercase}',
      '.duc-title{margin:0;font-size:18px;font-weight:600;line-height:26px}',
      '.duc-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.duc-versions{display:flex;gap:16px;flex-wrap:wrap;margin:0}',
      '.duc-version{display:flex;flex-direction:column;gap:2px}',
      '.duc-version dt{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.duc-version dd{margin:0;font-size:15px;font-weight:600;line-height:22px;font-variant-numeric:tabular-nums}',
      '.duc-state{margin:0;font-size:14px;line-height:22px}',
      '.duc-state.is-available{color:var(--dsw-alias-brand-primary)}',
      '.duc-state.is-latest{color:var(--dsw-alias-label-secondary)}',
      '.duc-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}',
      '.duc-notes-label{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.duc-notes{margin:0;max-height:190px;overflow:auto;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;white-space:pre-wrap;word-break:break-word}',
      '.duc-bar{position:relative;height:8px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}',
      '.duc-bar-fill{position:absolute;inset:0 auto 0 0;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width 200ms ease}',
      '.duc-bar-text{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}',
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
        available: (v) => `发现新版本 v${v}。`,
        notes: '更新说明',
        noNotes: '（这一版没有填写更新说明）',
        download: '下载更新',
        downloading: '正在下载…',
        downloadedHint: '安装包已下载完成。',
        install: '立即安装',
        installing: '已启动安装程序',
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
        available: (v) => `Version v${v} is available.`,
        notes: 'Release notes',
        noNotes: '(No release notes for this version)',
        download: 'Download update',
        downloading: 'Downloading…',
        downloadedHint: 'The installer has been downloaded.',
        install: 'Install now',
        installing: 'Installer launched',
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

    function IconUpdate({ size = 18 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
        h('path', {
          d: 'M8 2.5v6.1',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M5.3 6.3 8 9l2.7-2.7',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3.1 11v1.2c0 .6.5 1.1 1.1 1.1h7.6c.6 0 1.1-.5 1.1-1.1V11',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
        }))
    }

    function formatBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return ''
      const mb = n / 1024 / 1024
      return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
    }

    function UpdateButton({ wide }) {
      const t = locale()
      const api = React.useMemo(() => bridge(), [])

      const [open, setOpen] = React.useState(false)
      const [phase, setPhase] = React.useState('idle') // idle|checking|latest|no-release|available|downloading|downloaded|error
      const [info, setInfo] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [filePath, setFilePath] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      const closeRef = React.useRef(null)

      // 下载进度：订阅 + 卸载时务必退订，否则每次开关面板都会堆一个监听器
      React.useEffect(() => {
        if (!api) return undefined
        return api.onProgress((p) => setProgress(p))
      }, [api])

      React.useEffect(() => {
        if (!api) return undefined
        let alive = true
        api.info().then((value) => {
          if (alive && value && value.ok) setInfo(value)
        }).catch(() => {})
        return () => { alive = false }
      }, [api])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const runCheck = React.useCallback(async () => {
        if (!api) return
        setPhase('checking')
        setError('')
        setNotice('')
        try {
          const value = await api.check()
          if (!value || value.ok !== true) {
            setPhase('error')
            setError((value && value.error) || t.failed)
            return
          }
          setResult(value)
          if (value.status === 'available') setPhase('available')
          else if (value.status === 'no-release') setPhase('no-release')
          else setPhase('latest')
        } catch (err) {
          setPhase('error')
          setError(err instanceof Error ? err.message : t.failed)
        }
      }, [api, t])

      // 打开面板时自动查一次，省掉一次点击
      React.useEffect(() => {
        if (!open || !api) return
        if (phase === 'idle') void runCheck()
      }, [open, api, phase, runCheck])

      const runDownload = React.useCallback(async () => {
        if (!api || !result || !result.asset) return
        setPhase('downloading')
        setError('')
        setProgress({ received: 0, total: result.asset.size || 0, percent: 0 })
        try {
          const value = await api.download(result.asset)
          if (!value || value.ok !== true) {
            setPhase('available')
            setError((value && value.error) || '下载失败。')
            return
          }
          setFilePath(value.filePath || '')
          setPhase('downloaded')
        } catch (err) {
          setPhase('available')
          setError(err instanceof Error ? err.message : '下载失败。')
        }
      }, [api, result])

      const runInstall = React.useCallback(async () => {
        if (!api || !filePath) return
        setError('')
        const value = await api.install(filePath)
        if (!value || value.ok !== true) {
          setError((value && value.error) || '无法启动安装程序。')
          return
        }
        setNotice(t.installHint)
      }, [api, filePath, t])

      function stateLine() {
        if (!api) return h('p', { className: 'duc-state is-latest' }, t.desktopOnly)
        if (phase === 'checking') return h('p', { className: 'duc-state is-latest' }, t.checking)
        if (phase === 'latest') return h('p', { className: 'duc-state is-latest' }, t.upToDate)
        if (phase === 'no-release') return h('p', { className: 'duc-state is-latest' }, t.noRelease)
        if (phase === 'available' || phase === 'downloading' || phase === 'downloaded') {
          const v = result && result.latestVersion
          return h('p', { className: 'duc-state is-available' }, t.available(v || ''))
        }
        if (phase === 'error') return h('p', { className: 'duc-error', role: 'alert' }, error || t.failed)
        return null
      }

      const dialog = open
        ? ReactDOM.createPortal(
          h('div', { className: 'duc-overlay', role: 'presentation' },
            h('div', { className: 'duc-mask', onClick: () => setOpen(false) }),
            h('div', {
              className: 'duc-panel',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t.title,
            },
              h('p', { className: 'duc-kicker' }, t.kicker),
              h('h2', { className: 'duc-title' }, t.title),

              h('dl', { className: 'duc-versions' },
                h('div', { className: 'duc-version' },
                  h('dt', null, t.current),
                  h('dd', null, `v${(info && info.currentVersion) || '—'}`),
                ),
                result && result.latestVersion
                  ? h('div', { className: 'duc-version' },
                    h('dt', null, t.latest),
                    h('dd', null, `v${result.latestVersion}`),
                  )
                  : null,
              ),

              stateLine(),

              // 更新说明
              (phase === 'available' || phase === 'downloading' || phase === 'downloaded')
                ? h('div', null,
                  h('p', { className: 'duc-notes-label' }, t.notes),
                  h('pre', { className: 'duc-notes' }, (result && result.notes && result.notes.trim()) || t.noNotes),
                )
                : null,

              // 下载进度
              phase === 'downloading'
                ? h('div', null,
                  h('div', { className: 'duc-bar' },
                    h('div', {
                      className: 'duc-bar-fill',
                      style: { width: `${(progress && progress.percent) || 0}%` },
                    }),
                  ),
                  h('p', { className: 'duc-bar-text' },
                    `${(progress && progress.percent) || 0}%`
                    + (progress && progress.total
                      ? `  ·  ${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
                      : ''),
                  ),
                )
                : null,

              // 已下载
              phase === 'downloaded'
                ? h('p', { className: 'duc-state is-latest' }, t.downloadedHint)
                : null,

              notice ? h('p', { className: 'duc-state is-latest', role: 'status' }, notice) : null,
              phase === 'error' && error ? h('p', { className: 'duc-error', role: 'alert' }, error) : null,

              h('div', { className: 'duc-actions' },
                h('button', {
                  type: 'button',
                  className: 'duc-link',
                  onClick: () => { if (api) void api.openReleases() },
                }, t.openReleases),

                h('button', {
                  ref: closeRef,
                  type: 'button',
                  className: 'duc-action duc-right',
                  onClick: () => setOpen(false),
                }, t.close),

                phase === 'downloading'
                  ? h('button', { type: 'button', className: 'duc-action', disabled: true }, t.downloading)
                  : null,

                phase === 'available'
                  ? h('button', {
                    type: 'button',
                    className: 'duc-action duc-action-primary',
                    disabled: !result || !result.asset,
                    onClick: () => { void runDownload() },
                  }, t.download)
                  : null,

                phase === 'downloaded'
                  ? h('button', {
                    type: 'button',
                    className: 'duc-action duc-action-primary',
                    onClick: () => { void runInstall() },
                  }, t.install)
                  : null,

                phase === 'latest' || phase === 'no-release' || phase === 'error'
                  ? h('button', {
                    type: 'button',
                    className: 'duc-action',
                    onClick: () => { void runCheck() },
                  }, t.recheck)
                  : null,
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
          className: 'duc-btn'
            + (open ? ' is-open' : '')
            + (phase === 'checking' || phase === 'downloading' ? ' is-busy' : ''),
          title: t.trigger,
          'aria-label': t.trigger,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(true),
        },
          h(IconUpdate, { size: 18 }),
          phase === 'available' || phase === 'downloaded' ? h('span', { className: 'duc-dot' }) : null,
        ),
        dialog,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      // sidebar.footer.action —— 侧栏左下角（与「设置」同区）的动作槽位。
      // order -90：排在 dsh-web-restart(-100) 右边，两者并排不打架。
      ctx.slots.inject(SLOT, () => {
        let dispose
        try {
          dispose = ctx.slots.register({
            name: SLOT,
            id: 'dsh-update-check',
            order: -90,
          }, (props) => h(UpdateButton, { wide: props && props.wide }))
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
