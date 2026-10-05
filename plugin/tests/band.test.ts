import { expect, mock, test } from 'claude-code/testing'

// The band as text: every Text's children, in order.
function text(el: any): string {
  if (typeof el === 'string') return el
  if (el === null || typeof el !== 'object') return ''

  return (el.children ?? []).map(text).join('')
}

const props = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

const STATES: Array<[string, string]> = [
  ['warm', 'Cache warm · 47 min left · next message ~$0.05'],
  ['expiring', 'Cache expires in 1:12 · next message ~$0.05, ~$1.53 once it expires'],
  ['expired', 'Cache expired 4m ago · next message ~$1.53 (was ~$0.05)'],
  ['model', 'Model changed, cache resets · next message ~$0.77'],
  ['compacted', 'Compacted, cache resets · next message rebuilds it'],
  ['working', 'Cache warm · Claude is working'],
]

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: every state draws, and the band stays out of the way otherwise`, async ($, on: any) => {
    const T: any = $
    mock.clock(on)
    on('session.start', ($: any, e: any) => e)
    on('command.register', () => ({ value: {} }))
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ value: undefined }))
    // What the engine draws in the band when no plugin does: nothing.
    on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, {}))
    // No transcript in a test: the mod has no request to time, so it draws nothing live.
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
    await T.session.start({ source: 'startup', cwd: '/tmp', model: 'claude-opus-5-5', sessionId: 's' })

    const ui: any = await $.ui.mount({ plugin: 'cache-watch', surface, component: 'AbovePrompt', props } as any)
    expect(text(await ui.drawn())).not.toContain('Cache')

    for (const [state, want] of STATES) {
      await T.command.run({ command: 'cachewatch', args: `demo ${state}`, origin: { kind: 'user' }, presentation: {} })
      expect(text(await ui.drawn())).toContain(want)
    }

    const listed = await T.command.run({ command: 'cachewatch', args: 'demo nope', origin: { kind: 'user' }, presentation: {} })
    expect(listed.text).toContain('warm, expiring, expired, model, compacted, working')
  })
}

test('reads the TTL from the transcript, counts down from the request start, and prices the next message', async ($, on: any) => {
  const T: any = $
  const clock = mock.clock(on)
  await clock.set(Date.UTC(2026, 9, 5, 15, 0))
  const t0 = clock.now()
  const at = (ms: number) => new Date(t0 + ms).toISOString()
  // One prompt, answered by Opus 5.5 over ~191k tokens, the new part written with a 1-hour TTL.
  const transcript = [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      timestamp: at(9_000),
      message: {
        id: 'msg_1',
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 190_000,
          cache_creation_input_tokens: 1_000,
          output_tokens: 1_000,
          speed: 'standard',
          cache_creation: { ephemeral_1h_input_tokens: 1_000, ephemeral_5m_input_tokens: 0 },
        },
      },
    },
  ].map(e => JSON.stringify(e)).join('\n')

  on('session.start', ($: any, e: any) => e)
  on('command.register', () => ({ value: {} }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, {}))
  on('classic.Stop', () => ({}))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('process.run', ($: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'tail' ? transcript : '', stderr: '' } }))
  await T.session.start({ source: 'startup', cwd: '/tmp', model: 'claude-opus-5-5', sessionId: 's' })
  await T.classic.Stop({ transcript_path: '/fake/s.jsonl', stop_hook_active: false })

  const ui: any = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props } as any)
  const band = async () => text(await ui.drawn())

  // Warm: the hour runs from when the request started, not when the reply landed.
  await clock.set(t0 + 13 * 60_000)
  expect(await band()).toContain('Cache warm · 47 min left · next message ~$0.05')

  // Ten minutes out, it warns, with what waiting would cost.
  await clock.set(t0 + 52 * 60_000)
  expect(await band()).toContain('Cache expires in 8:00 · next message ~$0.05, ~$1.54 once it expires')

  // Past the hour, the whole context is written again.
  await clock.set(t0 + 64 * 60_000)
  expect(await band()).toContain('Cache expired 4m ago · next message ~$1.54 (was ~$0.05)')
})
