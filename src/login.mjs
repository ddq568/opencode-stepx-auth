// Guided browser sign-in (the only login path). Opens a throwaway Chrome/
// Edge profile, watches the Step Studio session via CDP, and returns the
// cookie header once verified against /identity/me. Kept as its own module
// so the npm entry stays thin; it performs NO calls unless the user starts
// a login.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { api, SITE, defaultTransport } from './transport.mjs'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe' : '',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

function findChrome(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p
  return null
}

/** Minimal CDP JSON-RPC over the browser websocket. */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    let d
    try {
      d = JSON.parse(ev.data)
    } catch {
      return
    }
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'))
  })
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      return new Promise((res) => {
        pending.set(id, res)
        ready.then(() => ws.send(JSON.stringify({ id, method, params })))
        setTimeout(() => {
          if (pending.has(id)) {
            pending.get(id)({ error: { message: 'cdp timeout' } })
            pending.delete(id)
          }
        }, 15_000).unref?.()
      })
    },
    close() {
      try {
        ws.close()
      } catch {}
    },
  }
}

async function harvestStepxCookies(devUrl) {
  const conn = cdp(devUrl)
  await conn.ready
  try {
    const r = await conn.send('Storage.getCookies')
    const cookies = r?.result?.cookies ?? []
    const jar = {}
    for (const c of cookies) {
      if (/(^|\.)stepx\.com$/i.test(c.domain) && !c.name.startsWith('__')) jar[c.name] = c.value
    }
    if (!jar._uticket || !jar._ckk) return null
    const header = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
    const me = await api(defaultTransport, header, '/identity/me').catch(() => null)
    if (me?.status !== 200 || !me.json?.userId) return null
    return { cookie: header, userId: me.json.userId, nickname: me.json.nickname ?? '' }
  } finally {
    conn.close()
  }
}

export function chromeSignIn({ chromePath } = {}) {
  return {
    url: '',
    instructions:
      '将打开一个 Chrome 窗口访问 studio.stepx.com，请在里面完成登录（扫码或手机号）。登录成功后窗口会自动关闭并回到 magpie；无需其他操作，10 分钟内有效。',
    method: 'auto',
    async callback() {
      const exe = findChrome(chromePath)
      if (!exe)
        return {
          type: 'failed',
          error:
            '未找到 Chrome/Edge。请安装 Chrome，或在插件 options 里设置 chromePath（magpie plugin options stepx \'{"chromePath":"C:/path/to/chrome.exe"}\'）',
        }

      const port = 30000 + Math.floor(Math.random() * 20000)
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stepx-login-'))
      const child = spawn(
        exe,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-gpu',
          '--window-size=1100,800',
          SITE + '/',
        ],
        { stdio: 'ignore', detached: false },
      )

      const kill = () => {
        try {
          child.kill()
        } catch {}
        try {
          fs.rmSync(profile, { recursive: true, force: true })
        } catch {}
      }
      const deadline = Date.now() + 600_000
      try {
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2500))
          const v = await fetch(`http://127.0.0.1:${port}/json/version`)
            .then((r) => r.json())
            .catch(() => null)
          if (!v?.webSocketDebuggerUrl) continue
          const got = await harvestStepxCookies(v.webSocketDebuggerUrl).catch(() => null)
          if (got) {
            try {
              const c = cdp(v.webSocketDebuggerUrl)
              await c.ready
              await c.send('Browser.close').catch?.(() => {})
              c.close()
            } catch {}
            await new Promise((r) => setTimeout(r, 800))
            kill()
            return {
              type: 'success',
              key: got.cookie,
              accountId: got.nickname || got.userId,
              metadata: { userId: got.userId, nickname: got.nickname, login: 'browser' },
            }
          }
        }
        return { type: 'failed', error: '登录超时（10 分钟未完成）' }
      } finally {
        kill()
      }
    },
  }
}
