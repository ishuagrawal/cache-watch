import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheBreaker, CacheDemo, CacheMode, CacheSnap, CacheTick, CacheTtl } from '../types'

// ── state ────────────────────────────────────────────────────────────────────

const snapAtom = atom({ plugin: 'cache-watch', key: 'snap' } as const, null)
const ttlAtom = atom({ plugin: 'cache-watch', key: 'ttl' } as const, null)
const breakerAtom = atom({ plugin: 'cache-watch', key: 'breaker' } as const, null)
const tickAtom = atom({ plugin: 'cache-watch', key: 'tick' } as const, { now: 0, draftChars: 0 })
const modeAtom = atom({ plugin: 'cache-watch', key: 'mode' } as const, 'full')
const pathAtom = atom({ plugin: 'cache-watch', key: 'transcriptPath' } as const, null)
const demoAtom = atom({ plugin: 'cache-watch', key: 'demo' } as const, null)

// ── pricing ($ per million tokens; cache writes are 1.25× input for 5m, 2× for 1h) ──
// Anthropic first-party API list prices as of 2026-09-25. Bedrock and Vertex price differently.
// Order matters: longer ids first so 'claude-opus-5-5' wins over 'claude-opus-5'.

type Price = { input: number; output: number; cacheRead: number }

const PRICES: ReadonlyArray<readonly [string, Price]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
]

const FALLBACK_PRICE = PRICES[4][1]

function priceFor(model: string, isFast: boolean): { price: Price; isKnown: boolean } {
  const id = model.toLowerCase().replace(/\[.*\]$/, '').replace(/^.*?(claude-)/, '$1')
  const hit = PRICES.find(([prefix]) => id.startsWith(prefix))
  const base = hit?.[1] ?? FALLBACK_PRICE
  // Fast mode (Opus only) bills at 2× standard.
  const k = isFast ? 2 : 1

  return {
    price: { input: base.input * k, output: base.output * k, cacheRead: base.cacheRead * k },
    isKnown: hit !== undefined,
  }
}

const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const WRITE_MULT: Record<CacheTtl, number> = { '5m': 1.25, '1h': 2 }

// ── transcript parsing ───────────────────────────────────────────────────────

type Entry = {
  type?: string
  subtype?: string
  timestamp?: string
  isSidechain?: boolean
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      speed?: string
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
    }
  }
}

type Parsed = { snap: CacheSnap | null; ttl: CacheTtl | null; isCompactedAfter: boolean }

function parseTranscript(text: string): Parsed {
  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      entries.push(JSON.parse(line) as Entry)
    } catch {
      // the tail's first line is usually cut mid-record
    }
  }

  type Group = { first: number; last: number; entry: Entry }
  const groups: Group[] = []
  const byId = new Map<string, Group>()
  entries.forEach((entry, i) => {
    const m = entry.message
    if (entry.type !== 'assistant' || entry.isSidechain || !m?.usage || !m.id) return
    if (!m.model || m.model === '<synthetic>') return
    const g = byId.get(m.id)
    if (g) {
      g.last = i
      g.entry = entry
    } else {
      const fresh = { first: i, last: i, entry }
      byId.set(m.id, fresh)
      groups.push(fresh)
    }
  })

  const lastGroup = groups.at(-1)
  if (!lastGroup) return { snap: null, ttl: null, isCompactedAfter: false }

  // The request started when the entry it answered (a prompt, tool results, an
  // attachment) was written: the latest timestamped non-assistant entry before it.
  let startedAt = Date.parse(lastGroup.entry.timestamp ?? '') || 0
  for (let i = lastGroup.first - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'assistant' || !e.timestamp) continue
    const t = Date.parse(e.timestamp)
    if (!Number.isNaN(t)) startedAt = t
    break
  }

  // The TTL the account is actually writing with: the newest request that wrote.
  let ttl: CacheTtl | null = null
  for (let i = groups.length - 1; i >= 0 && ttl === null; i--) {
    const cc = groups[i].entry.message?.usage?.cache_creation
    if ((cc?.ephemeral_1h_input_tokens ?? 0) > 0) ttl = '1h'
    else if ((cc?.ephemeral_5m_input_tokens ?? 0) > 0) ttl = '5m'
  }

  const recent = groups.slice(-6).map(g => g.entry.message?.usage?.output_tokens ?? 0)
  const avgOutput = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length)

  const u = lastGroup.entry.message?.usage ?? {}
  const lastCc = u.cache_creation
  const ownTtl: CacheTtl | null =
    (lastCc?.ephemeral_1h_input_tokens ?? 0) > 0 ? '1h' : (lastCc?.ephemeral_5m_input_tokens ?? 0) > 0 ? '5m' : null

  const isCompactedAfter = entries
    .slice(lastGroup.last + 1)
    .some(e => e.type === 'system' && e.subtype === 'compact_boundary')

  return {
    snap: {
      startedAt,
      ttl: ownTtl,
      model: lastGroup.entry.message?.model ?? '',
      isFast: u.speed === 'fast',
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      avgOutput,
    },
    ttl,
    isCompactedAfter,
  }
}

// ── formatting ───────────────────────────────────────────────────────────────

function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m >= 10) return `${m} min`

  return `${m}:${String(sec).padStart(2, '0')}`
}

function fmtAgo(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m ago`

  return `${Math.floor(h / 24)}d ago`
}

function fmtUsd(x: number): string {
  if (x < 0.005) return '<$0.01'
  if (x < 10) return `$${x.toFixed(2)}`

  return `$${x.toFixed(1)}`
}

function shortModel(model: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model)
  if (!m) return model || '?'
  const family = m[1][0].toUpperCase() + m[1].slice(1)

  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

// ── cost model ───────────────────────────────────────────────────────────────

type Estimate = { warm: number; cold: number; out: number; context: number; isPriceKnown: boolean }

function estimate(snap: CacheSnap, ttl: CacheTtl, draftChars: number, model = snap.model): Estimate {
  const { price, isKnown } = priceFor(model, snap.isFast)
  // Everything the last request was answered over is now a cached prefix…
  const prefix = snap.input + snap.cacheRead + snap.cacheWrite
  // …and its reply plus the new prompt are the uncached tail, written at the TTL's rate.
  const tail = snap.output + Math.ceil(draftChars / 3.5) + 40
  const write = (price.input * WRITE_MULT[ttl]) / 1e6

  return {
    warm: (prefix * price.cacheRead) / 1e6 + tail * write,
    cold: (prefix + tail) * write,
    out: (snap.avgOutput * price.output) / 1e6,
    context: prefix + tail,
    isPriceKnown: isKnown,
  }
}

// ── refresh from the transcript ──────────────────────────────────────────────

let isRefreshing = false

async function transcriptPath($: EngineInterface): Promise<string | null> {
  const known = await read($, pathAtom)
  if (known) return known
  const id = await $.session.id()
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const found = await $.process.run(
    ['sh', '-c', 'ls -t "$1"/projects/*/"$2".jsonl 2>/dev/null | head -1', 'sh', configDir, id],
    { timeoutMs: 5000 },
  )
  const path = found.stdout.trim()
  if (!path) return null
  await update($, pathAtom, () => path)

  return path
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const path = await transcriptPath($)
    if (!path) return
    const tail = await $.process.run(['tail', '-c', '2000000', path], { timeoutMs: 5000 })
    if (tail.exitCode !== 0) return
    const parsed = parseTranscript(tail.stdout)
    if (!parsed.snap) return
    const snap = parsed.snap

    const prior = await read($, snapAtom)
    const isNewRequest = prior === null || prior.startedAt !== snap.startedAt
    await update($, snapAtom, () => snap)
    if (parsed.ttl) {
      await update($, ttlAtom, () => parsed.ttl)
      void $.store.set('lastTtl', parsed.ttl)
    }
    if (parsed.isCompactedAfter) {
      await update($, breakerAtom, () => ({ kind: 'compact', detail: 'context compacted' }) as CacheBreaker)
    } else if (isNewRequest) {
      // A request ran since the breaker was raised: the cache was rebuilt.
      await update($, breakerAtom, () => null)
    }

  } catch {
    // a missing or unreadable transcript just leaves the last snapshot
  } finally {
    isRefreshing = false
  }
}

// ── what the band says ───────────────────────────────────────────────────────

type View = { color: string; status: string; cost: string }

const GREEN = '#22c55e'
const YELLOW = '#eab308'
const RED = '#ef4444'

function liveView(snap: CacheSnap, ttl: CacheTtl, breaker: CacheBreaker | null, tick: CacheTick, isWorking: boolean): View {
  const left = snap.startedAt + TTL_MS[ttl] - tick.now
  const est = estimate(snap, ttl, tick.draftChars)
  const warmCost = `~${fmtUsd(est.warm + est.out)}`
  const coldCost = `~${fmtUsd(est.cold + est.out)}`

  if (isWorking) return { color: GREEN, status: '● Cache warm', cost: 'Claude is working' }
  if (breaker?.kind === 'model') {
    const switched = estimate(snap, ttl, tick.draftChars, breaker.toModel)

    return { color: RED, status: '▲ Model changed, cache resets', cost: `next message ~${fmtUsd(switched.cold + switched.out)}` }
  }
  if (breaker?.kind === 'compact') return { color: YELLOW, status: '▲ Compacted, cache resets', cost: 'next message rebuilds it' }
  if (left <= 0) return { color: RED, status: `▲ Cache expired ${fmtAgo(-left)}`, cost: `next message ${coldCost} (was ${warmCost})` }
  if (left < (ttl === '1h' ? 10 * 60_000 : 90_000)) {
    return { color: YELLOW, status: `● Cache expires in ${fmtLeft(left)}`, cost: `next message ${warmCost}, after that ${coldCost}` }
  }

  return { color: GREEN, status: `● Cache warm · ${fmtLeft(left)} left`, cost: `next message ${warmCost}` }
}

// Every state the band can be in, with typical numbers (Opus 5.5, ~190k tokens of context).
const DEMO: Record<CacheDemo, View> = {
  warm: { color: GREEN, status: '● Cache warm · 47 min left', cost: 'next message ~$0.10' },
  expiring: { color: YELLOW, status: '● Cache expires in 1:12', cost: 'next message ~$0.10, after that ~$1.60' },
  expired: { color: RED, status: '▲ Cache expired 4m ago', cost: 'next message ~$1.60 (was ~$0.10)' },
  model: { color: RED, status: '▲ Model changed, cache resets', cost: 'next message ~$0.80' },
  compacted: { color: YELLOW, status: '▲ Compacted, cache resets', cost: 'next message rebuilds it' },
  working: { color: GREEN, status: '● Cache warm', cost: 'Claude is working' },
}
const DEMO_ORDER = Object.keys(DEMO) as CacheDemo[]
const DEMO_STEP_MS = 3000

let demoTimer: { cancel: () => void } | null = null

function showDemo($: EngineInterface, states: CacheDemo[], stepMs: number): void {
  demoTimer?.cancel()
  const [first, ...rest] = states
  void update($, demoAtom, () => first ?? null)
  demoTimer = $.clock.after(stepMs, () => {
    if (first === undefined) return
    showDemo($, rest, stepMs)
  })
}

// ── hooks ────────────────────────────────────────────────────────────────────

const MODES: CacheMode[] = ['full', 'off']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await $.command.register({
      name: 'cachewatch',
      description: 'Prompt-cache band: /cachewatch [on|off|demo|refresh]',
    })

    const savedMode = await $.store.get('mode')
    if (typeof savedMode === 'string' && (MODES as string[]).includes(savedMode)) {
      await update($, modeAtom, () => savedMode as CacheMode)
    }
    const lastTtl = await $.store.get('lastTtl')
    if ((lastTtl === '5m' || lastTtl === '1h') && (await read($, ttlAtom)) === null) {
      await update($, ttlAtom, () => lastTtl)
    }

    void refresh($)

    $.clock.every(1000, async () => {
      if ((await read($, modeAtom)) === 'off' || (await read($, snapAtom)) === null) return
      const now = await $.clock.now()
      const { text } = await $.prompt.read()
      await update($, tickAtom, () => ({ now, draftChars: text.length }) as CacheTick)
    })

    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await update($, pathAtom, () => e.transcript_path)
    if (e.source === 'clear') {
      await update($, snapAtom, () => null)
      await update($, breakerAtom, () => null)
    } else if (e.source === 'compact') {
      await update($, breakerAtom, () => ({ kind: 'compact', detail: 'context compacted' }) as CacheBreaker)
    } else {
      void refresh($)
    }

    return result
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    await update($, pathAtom, () => e.transcript_path)
    await refresh($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) void refresh($)

    return result
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, ttlAtom)) === null) await update($, ttlAtom, () => e.cache_ttl)
    if (e.prompt_cache_warm && e.from_model !== e.to_model) {
      const breaker: CacheBreaker = {
        kind: 'model',
        detail: `${shortModel(e.from_model)} → ${shortModel(e.to_model)}`,
        toModel: e.to_model,
      }
      await update($, breakerAtom, () => breaker)
    }

    return result
  })

  on('command.run', { command: 'cachewatch' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/^on$/, 'full')
    if (arg === 'demo') {
      showDemo($, DEMO_ORDER, DEMO_STEP_MS)

      return { text: `cache-watch: previewing all ${DEMO_ORDER.length} states, ${DEMO_STEP_MS / 1000} s each` }
    }
    const pinned = /^demo\s+(\w+)$/.exec(arg)?.[1]
    if (pinned !== undefined) {
      if (!(DEMO_ORDER as string[]).includes(pinned)) {
        return { text: `cache-watch: states are ${DEMO_ORDER.join(', ')}` }
      }
      showDemo($, [pinned as CacheDemo], 15_000)

      return { text: `cache-watch: showing "${pinned}" for 15 s` }
    }
    if (arg === 'refresh') {
      await update($, pathAtom, () => null)
      await refresh($)

      return { text: 'cache-watch: re-read the transcript.' }
    }
    const current = await read($, modeAtom)
    const nextMode: CacheMode = (MODES as string[]).includes(arg)
      ? (arg as CacheMode)
      : MODES[(MODES.indexOf(current) + 1) % MODES.length]
    await update($, modeAtom, () => nextMode)
    await $.store.set('mode', nextMode)

    return { text: `cache-watch: ${nextMode === 'off' ? 'off' : 'on'}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    let view: View
    const demo = await read($, demoAtom)
    if (demo !== null) {
      view = DEMO[demo]
    } else {
      const snap = await read($, snapAtom)
      if ((await read($, modeAtom)) === 'off' || snap === null) return next(e)
      const ttl: CacheTtl = snap.ttl ?? (await read($, ttlAtom)) ?? '5m'
      const tick = await read($, tickAtom)
      const now = tick.now || (await $.clock.now())
      view = liveView(snap, ttl, await read($, breakerAtom), { ...tick, now }, e.props.isWorking)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        <Text color={view.color} wrap="truncate-end">
          {view.status}
        </Text>
        <Text dimColor wrap="truncate-end">
          {' · '}
          {view.cost}
        </Text>
      </Box>
    )
  })
}
