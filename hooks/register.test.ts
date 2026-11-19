import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const REMEMBER = 'mcp__mnemopi__mnemopi_remember'

// The engine beneath the plugin: an empty prompt box, a clock, a remember tool
// that stores (unless told not to), slash commands we record, a session id
// that /clear changes, and model requests whose model we record.
function world(on: On, opts: { box?: string; opening?: string } = {}) {
  const ran: { command: string; args: string }[] = []
  const filled: string[] = []
  const sent: string[] = []
  const session = { id: 'plan-1' }
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: session.id }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: { command: 'build' } }))
  on('prompt.read', () => ({ value: { text: opts.box ?? '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  const save = { fails: false, noId: false }
  on('tool.call', () =>
    save.fails
      ? { result: {}, text: 'mnemopi unavailable', isError: true }
      : save.noId
        ? { result: {}, text: '{"status":"stored"}' }
        : { result: {}, text: JSON.stringify({ status: 'stored', memory_id: 'abc123', content_preview: 'HANDOFF x' }) },
  )
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number; model: string }) {
    sent.push(e.model)
    yield* []
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] as never[] }
  } as never)
  const submitted: string[] = []
  const refuse = { plugin: false }
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') {
      if (refuse.plugin) return { drop: 'a Stop stands' }
      submitted.push(e.text)
    }
    return { text: e.text }
  })
  on('command.run', (_, e) => {
    ran.push({ command: e.command, args: e.args })
    if (e.command === 'clear') session.id = `fresh-${ran.length}`
    return { text: '' }
  })
  on('classic.SessionStart', () => (opts.opening ? { initialUserMessage: opts.opening } : {}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const engineRan = () => ran.filter(r => r.command !== 'build')
  return { engineRan, filled, clock, save, sent, session, submitted, refuse }
}

// What the mod submitted to start the build since the last look ('' if none).
async function started(w: { clock: { settle: () => Promise<unknown> }; submitted: string[] }): Promise<string> {
  await w.clock.settle()
  return w.submitted.splice(0).join('\n')
}

const turn = (turnId = 't1') => ({ text: 'go', turnId })

const ended = (reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string, turnId = 't1') => ({
  answer: 'plan saved',
  durationMs: 10,
  isAborted: reason === 'aborted',
  turnId,
  reason,
  ...(agentId ? { agentId } : {}),
})

const typed = (args = '', command = 'build') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

const typedPrompt = (turnId?: string) => ({
  text: 'wait, one more thing',
  wait: false,
  origin: { kind: 'composer' as const },
  ...(turnId ? { turnId } : {}),
})

const handoff = (metadata: unknown, extra: Record<string, unknown> = {}) => ({
  tool: REMEMBER,
  content: 'HANDOFF proj task 2026-11-18T00:00Z',
  metadata,
  ...extra,
})

// One model request; resolves to the model it went to.
async function step($: any, w: { sent: string[] }, agentId?: string, model = 'claude-opus-5-5'): Promise<string> {
  const s = $.turn.step({
    turnId: 'tx',
    index: 0,
    model,
    messageCount: 1,
    ...(agentId ? { agentId } : {}),
  })
  for await (const _ of s) {
    // drain
  }
  return w.sent[w.sent.length - 1] ?? ''
}

// The SessionStart a /clear raises, carrying the new session's id as the
// engine's does.
const opened = ($: any, w: { session: { id: string } }, id = w.session.id) =>
  $.classic.SessionStart({ source: 'clear', session_id: id } as never)

// Save a build handoff in turn t1 and let that turn end.
async function planTurn($: any) {
  await $.turn.start(turn('t1'))
  await $.tool.call(handoff({ kind: 'handoff', next: 'build', status: 'ready' }, { bank: 'proj-bank' }) as never)
  await $.turn.complete(ended() as never)
}

test('when the planning turn ends it clears (no /model), and the fresh session builds on sonnet', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(await step($, w)).toBe('claude-opus-5-5') // nothing routed before

  await $.turn.start(turn('t1'))
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }, { bank: 'proj-bank' }) as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([]) // nothing until the turn ends
  await $.turn.complete(ended() as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([{ command: 'clear', args: '' }])

  const first = await opened($, w)
  expect(first.initialUserMessage).toBeUndefined() // not honoured after /clear
  const opening = await started(w)
  expect(opening).toContain('abc123')
  expect(opening).toContain('proj-bank')
  expect(opening).toContain('ml:executing-plans')
  expect(await step($, w)).toBe('sonnet')
  expect(await step($, w, 'sub1')).toBe('claude-opus-5-5') // subagents keep theirs

  const second = await opened($, w)
  expect(second.additionalContext).toBeUndefined()
  expect(await started(w)).toBe('')
  await $.command.run(typed())
  await w.clock.settle()
  expect(w.engineRan()).toHaveLength(1) // consumed: /build no longer armed
})

test('a prompt the person sends in the fresh session before the build starts wins', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await opened($, w) // the start is scheduled, not yet run
  await $.prompt.submit(typedPrompt())
  expect(await started(w)).toBe('')
})

test('a /clear the person runs before the build starts cancels it', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await opened($, w)
  await $.command.run(typed('', 'clear'))
  expect(await started(w)).toBe('')
})

test('a refused start leaves the resume prompt in the box to send', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  w.refuse.plugin = true
  await opened($, w)
  expect(await started(w)).toBe('')
  expect(w.filled.join('\n')).toContain('Resume Mnemopi handoff abc123')
})

test('routing ends with the fresh session, not with the planning session ending late', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await opened($, w)
  expect(await step($, w)).toBe('sonnet') // learns the fresh session's id
  await $.session.end({ reason: 'clear', sessionId: 'plan-1', resume: { id: 'plan-1' } } as never)
  expect(await step($, w)).toBe('sonnet')
  await $.session.end({ reason: 'clear', sessionId: w.session.id, resume: { id: w.session.id } } as never)
  expect(await step($, w)).toBe('claude-opus-5-5')
})

test('once the fresh session has made a request, only its own end stops the routing', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await opened($, w)
  expect(await step($, w)).toBe('sonnet')
  await $.session.end({ reason: 'other', sessionId: 'unrelated-9', resume: { id: 'unrelated-9' } } as never)
  expect(await step($, w)).toBe('sonnet')
})

test("another plugin's /clear while ours is queued does not take the handoff; ours delivers it", async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle() // our clear is queued and launching is set
  await $.command.run({ ...typed('', 'clear'), origin: { kind: 'plugin', name: 'other-mod' } } as never)
  const theirs = await opened($, w, 'foreign-1')
  expect(theirs.additionalContext).toBeUndefined()
  expect(await started(w)).toBe('')
  const ours = await opened($, w, 'build-1')
  expect(ours.additionalContext?.join('\n')).toContain('abc123')
  expect(await started(w)).toContain('abc123')
  // The foreign clear's session ends late, before the build's first request.
  await $.session.end({ reason: 'clear', sessionId: 'foreign-1', resume: { id: 'foreign-1' } } as never)
  expect(await step($, w)).toBe('sonnet')
  // The build session's own end still stops it.
  await $.session.end({ reason: 'clear', sessionId: 'build-1', resume: { id: 'build-1' } } as never)
  expect(await step($, w)).toBe('claude-opus-5-5')
})

test('without session ids, a foreign session ending late still does not stop the routing', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await $.command.run({ ...typed('', 'clear'), origin: { kind: 'plugin', name: 'other-mod' } } as never)
  await opened($, w, '')
  await opened($, w, '')
  await $.session.end({ reason: 'clear', sessionId: 'foreign-1', resume: { id: 'foreign-1' } } as never)
  expect(await step($, w)).toBe('sonnet')
})

test("with session ids: a build cleared before its first request, then the foreign session's late end", async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await $.command.run({ ...typed('', 'clear'), origin: { kind: 'plugin', name: 'other-mod' } } as never)
  await $.classic.SessionStart({ source: 'clear', session_id: 'foreign-1' } as never)
  const ours = await $.classic.SessionStart({ source: 'clear', session_id: 'build-1' } as never)
  expect(ours.additionalContext?.join('\n')).toContain('abc123')
  expect(await started(w)).toContain('abc123')
  // The person clears the build session before it asks anything...
  await $.session.end({ reason: 'clear', sessionId: 'build-1', resume: { id: 'build-1' } } as never)
  // ...and the foreign session's end arrives late.
  await $.session.end({ reason: 'clear', sessionId: 'foreign-1', resume: { id: 'foreign-1' } } as never)
  expect(await step($, w)).toBe('claude-opus-5-5') // the next session is not routed
})

test('a second build is not stopped by the first build session ending late', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await opened($, w)
  expect(await step($, w)).toBe('sonnet')
  const firstBuild = w.session.id

  // The build session plans a follow-up and hands off again.
  await $.turn.start(turn('t9'))
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.turn.complete(ended('answer', undefined, 't9') as never)
  await w.clock.settle()
  await opened($, w)
  await $.session.end({ reason: 'clear', sessionId: firstBuild, resume: { id: firstBuild } } as never)
  expect(await step($, w)).toBe('sonnet')
})

test('clearing the fresh session before its first request still ends the routing', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await opened($, w)
  await $.session.end({ reason: 'clear', sessionId: w.session.id, resume: { id: w.session.id } } as never)
  expect(await step($, w)).toBe('claude-opus-5-5')
})

test('a step on another model (a fallback, a picker switch) is left alone and ends the routing', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await opened($, w)
  expect(await step($, w)).toBe('sonnet')
  expect(await step($, w, undefined, 'claude-haiku-5-5')).toBe('claude-haiku-5-5')
  expect(await step($, w)).toBe('claude-opus-5-5')
})

test('a /model the person runs takes over from the routing', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await opened($, w)
  expect(await step($, w)).toBe('sonnet')
  await $.command.run(typed('opus', 'model'))
  expect(await step($, w)).toBe('claude-opus-5-5')
})

test('a /clear typed by hand does not consume an armed handoff', async ($, on) => {
  const w = world(on)
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.command.run(typed('', 'clear'))
  const manual = await opened($, w)
  expect(manual.additionalContext).toBeUndefined()
  expect(await started(w)).toBe('')
  expect(await step($, w)).toBe('claude-opus-5-5')

  await $.command.run(typed())
  await w.clock.settle()
  const out = await opened($, w)
  expect(out.additionalContext?.join('\n')).toContain('abc123')
  expect(await started(w)).toContain('abc123')
})

test('a /clear typed while /build is queued does not launch; the /build clear still does', async ($, on) => {
  const w = world(on)
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.command.run(typed()) // queued: its clear waits on the clock
  await $.command.run(typed('', 'clear')) // typed by the person
  const manual = await opened($, w)
  expect(manual.additionalContext).toBeUndefined()
  expect(await started(w)).toBe('')

  await w.clock.settle()
  const out = await opened($, w)
  expect(out.additionalContext?.join('\n')).toContain('abc123')
  expect(await started(w)).toContain('abc123')
})

test('a second /build while the first is queued does nothing', async ($, on) => {
  const w = world(on)
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.command.run(typed())
  const again = await $.command.run(typed())
  expect(again.text).toContain('already')
  await w.clock.settle()
  expect(w.engineRan().map(r => r.command)).toEqual(['clear'])
})

test("another hook's opening message is kept, and ours still follows it", async ($, on) => {
  const w = world(on, { opening: 'other hook says hi' })
  await planTurn($)
  await w.clock.settle()
  const out = await opened($, w)
  expect(out.initialUserMessage).toBe('other hook says hi') // left as that hook set it
  expect(await started(w)).toContain('abc123')
})

test('metadata given as a JSON string still arms, and /build takes a model argument', async ($, on) => {
  const w = world(on)
  await $.tool.call(handoff(JSON.stringify({ kind: 'handoff', next: 'build' })) as never)
  await $.command.run(typed('haiku'))
  await w.clock.settle()
  const out = await opened($, w)
  expect(await started(w)).toContain('bank default')
  expect(await step($, w)).toBe('haiku')
})

test('an ordinary handoff does not arm anything', async ($, on) => {
  const w = world(on)
  await $.tool.call(handoff({ kind: 'handoff', status: 'ready' }) as never)
  await $.command.run(typed())
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
})

test('an interrupted turn does not launch; it offers /build, which still works', async ($, on) => {
  const w = world(on)
  await $.turn.start(turn())
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.turn.complete(ended('aborted') as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
  expect(w.filled).toEqual(['/build'])

  await $.command.run(typed())
  await w.clock.settle()
  expect(w.engineRan().map(r => r.command)).toEqual(['clear'])
})

test('a draft in the prompt box is left alone when /build is offered', async ($, on) => {
  const w = world(on, { box: 'half-typed thought' })
  await $.turn.start(turn())
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.turn.complete(ended('error') as never)
  expect(w.filled).toEqual([])
})

test("a subagent's turn ending does not launch; the main turn's does, once", async ($, on) => {
  const w = world(on)
  await $.turn.start(turn())
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.turn.complete(ended('answer', 'a1') as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
  await $.turn.complete(ended() as never)
  await $.turn.complete(ended() as never)
  await w.clock.settle()
  expect(w.engineRan().map(r => r.command)).toEqual(['clear'])
})

test('a handoff from an earlier turn whose end was missed does not launch at a later turn', async ($, on) => {
  const w = world(on)
  await $.turn.start(turn('t1'))
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.turn.start(turn('t2'))
  await $.turn.complete(ended('answer', undefined, 't2') as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
})

test('a turn that starts while the launch is queued cancels it; /build still works', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await $.turn.start(turn('t2'))
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
  await $.command.run(typed())
  await w.clock.settle()
  expect(w.engineRan().map(r => r.command)).toEqual(['clear'])
})

test('a prompt typed during the planning turn stops the auto-launch', async ($, on) => {
  const w = world(on)
  await $.turn.start(turn('t1'))
  await $.prompt.submit(typedPrompt('t1'))
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.turn.complete(ended() as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
})

test('a prompt submitted after the turn ends but before the launch runs cancels it', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await $.prompt.submit(typedPrompt())
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
})

test('a replacement save with no memory_id disarms the older handoff', async ($, on) => {
  const w = world(on)
  await $.turn.start(turn())
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  w.save.noId = true
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.turn.complete(ended() as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
})

test('a failed replacement save disarms the older handoff', async ($, on) => {
  const w = world(on)
  await $.turn.start(turn())
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  w.save.fails = true
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }) as never)
  await $.turn.complete(ended() as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
})

test('a turn that saved no build handoff launches nothing', async ($, on) => {
  const w = world(on)
  await $.turn.complete(ended() as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
})

test('startup, resume and compact never consume a launch', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  for (const source of ['startup', 'resume', 'compact'] as const) {
    const out = await $.classic.SessionStart({ source })
    expect(out.additionalContext).toBeUndefined()
  expect(await started(w)).toBe('')
  }
  expect(await step($, w)).toBe('claude-opus-5-5')
  const out = await opened($, w)
  expect(out.additionalContext?.join('\n')).toContain('abc123')
  expect(await started(w)).toContain('abc123')
})

test('a launch whose clear never came goes stale', async ($, on) => {
  const w = world(on)
  await planTurn($)
  await w.clock.settle()
  await w.clock.advance(3 * 60 * 1000)
  const out = await opened($, w)
  expect(out.additionalContext).toBeUndefined()
  expect(await started(w)).toBe('')
  expect(await step($, w)).toBe('claude-opus-5-5')
})

test('a handoff from a subagent does not arm', async ($, on) => {
  const w = world(on)
  await $.turn.start(turn())
  await $.tool.call(handoff({ kind: 'handoff', next: 'build' }, { agentId: 'a1' }) as never)
  await $.turn.complete(ended() as never)
  await w.clock.settle()
  expect(w.engineRan()).toEqual([])
})
