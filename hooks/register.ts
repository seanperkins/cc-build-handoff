import type { Hook, Register } from 'claude-code'

// Plan → build boundary, hands-free.
// 1. The planning session saves a Mnemopi handoff whose metadata has
//    kind "handoff" and next "build". This module notes its id.
// 2. When that turn ends with an answer, it runs /clear.
// 3. The SessionStart that this /clear raises opens the fresh session with
//    "resume handoff <id>", and from then on a turn.step hook sends that
//    session's main-loop requests to the build model (default sonnet).
//
// No /model: it saves the model as the person's default for every new
// session, and that settings write reloads this mod mid-launch. Routing each
// request with turn.step changes neither, and the planning context is never
// sent to the build model (the first request after /clear is the fresh one).
//
// State lives in this module's memory, not $.store: the launch and the /clear
// it runs happen in this one process, so no other session (another terminal
// in the same checkout) can see or consume it. A restart or mod reload drops
// it; the handoff itself stays in Mnemopi.

const REMEMBER = 'mcp__mnemopi__mnemopi_remember'
const DEFAULT_MODEL = 'sonnet'
const LAUNCH_WINDOW_MS = 2 * 60 * 1000
const CANCELLED = 'build-handoff: a new prompt came in; not clearing. /build runs it when you are ready.'

type Api = Parameters<Hook<'session.start'>>[0]
type Handoff = { bank: string; id: string }

let armed: Handoff | undefined
// Set just before our /clear is queued; consumed by the SessionStart it raises.
let launching: (Handoff & { model: string; at: number }) | undefined
let inFlight = false
// Armed by a handoff saved this turn: launch when *that* turn ends.
let autoPending = false
let currentTurn: string | undefined
let armedTurn: string | undefined
// Set when a prompt or a new main-loop turn arrives while a launch is queued:
// that new work must not be cleared.
let abortLaunch = false
// The main-loop turn a person typed over (their prompt is queued behind it).
let promptDuring: string | undefined
// The fresh session's model, applied to every main-loop request until the
// session ends or the person picks a model with /model.
let buildModel: string | undefined
// The planning session our /clear ends: its own end, whenever it fires, is the
// one session end that must not stop the routing.
let planningSession: string | undefined
// The model the engine names for the fresh session's requests. A step that
// names another (a fallback, a switch through the picker or /config) ends
// the routing: the engine's or the person's choice wins.
let baseModel: string | undefined
// The fresh session's id, learned on its first routed request; from then on
// only its own end stops the routing.
let freshSession: string | undefined
// Another plugin's /clear ran while ours was queued: the SessionStart it
// raises is not ours to consume; the one our own /clear raises is.
let foreignClear = false
// Sessions a foreign /clear opened during this launch whose end has not been
// seen yet: each one's end, early or late, is not the build session's.
let foreignSessions = 0
// Their ids, when the SessionStart that opened them said (session_id).
const foreignIds = new Set<string>()
// The resume prompt waiting to be submitted in the fresh session.
let pendingStart: string | undefined

function metadataOf(raw: unknown): Record<string, unknown> {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function memoryIdFrom(text: string | undefined): string | undefined {
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.memory_id === 'string' && parsed.memory_id) return parsed.memory_id
  } catch {
    // fall through to the pattern below
  }
  return /"memory_id"\s*:\s*"([^"]+)"/.exec(text)?.[1]
}

function resumeMessage(p: Handoff): string {
  return (
    `Resume Mnemopi handoff ${p.id} in bank ${p.bank}. Fetch it with mnemopi_get, ` +
    `check the checkout and branch it names, then build the plan it names with ml:executing-plans.`
  )
}

const isPerson = (kind: string) => kind === 'composer' || kind === 'bridge'

async function offerManual($: Api): Promise<void> {
  const box = await $.prompt.read()
  if (box.text.trim() === '') await $.prompt.fill({ text: '/build' })
}

// abortLaunch is read synchronously right before /clear is queued, with no
// await between the check and the queueing.
async function clearForBuild($: Api, handoff: Handoff, model: string): Promise<void> {
  const at = await $.clock.now()
  const ending = await $.session.id()
  if (abortLaunch) {
    $.ui.toast(CANCELLED)
    return
  }
  launching = { ...handoff, model, at }
  planningSession = ending
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    launching = undefined
    throw err
  }
}

// Outside any dispatch the turn waits on: the command queues and runs once the
// session is idle.
function launch($: Api, handoff: Handoff, model: string): void {
  inFlight = true
  autoPending = false
  abortLaunch = false
  foreignClear = false
  foreignSessions = 0
  foreignIds.clear()
  $.clock.after(0, () => {
    clearForBuild($, handoff, model)
      .catch(async err => {
        $.ui.toast(`build-handoff: launch failed: ${String(err)}. /build retries.`)
        await offerManual($).catch(() => {})
      })
      .finally(() => {
        inFlight = false
      })
  })
}

// Submits the resume prompt, unless the person got there first. A refused
// submission leaves the prompt in an empty box for the person to send.
async function startBuild($: Api): Promise<void> {
  const text = pendingStart
  pendingStart = undefined
  if (text === undefined) return
  let refused: string | undefined
  try {
    const res = await $.prompt.submit({ text, asUser: true })
    refused = res.drop
  } catch (err) {
    refused = String(err)
  }
  if (refused === undefined) return
  $.ui.toast(`build-handoff: the build did not start (${refused}). Press Enter on the prompt to start it.`)
  const box = await $.prompt.read()
  if (box.text.trim() === '') await $.prompt.fill({ text })
}

function stopRouting($: Api): void {
  pendingStart = undefined
  if (buildModel === undefined) return
  buildModel = undefined
  baseModel = undefined
  freshSession = undefined
  $.ui.status(undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'build',
      description: 'Clear this session and build the saved plan from its Mnemopi handoff on Sonnet',
      argumentHint: '[model, default sonnet]',
    })
    return next(e)
  })

  // Arm: a main-loop build handoff was stored.
  on('tool.call', { tool: REMEMBER }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) return ran

    const args = e as unknown as Record<string, unknown>
    const meta = metadataOf(args.metadata)
    if (meta.kind !== 'handoff' || meta.next !== 'build') return ran
    if (ran.deny !== undefined || ran.isError) {
      // A failed replacement must not leave the older handoff to auto-launch.
      if (armed && !inFlight) {
        armed = undefined
        autoPending = false
        $.ui.toast('build-handoff: build handoff save failed; nothing will launch.')
      }
      return ran
    }

    const id = memoryIdFrom(ran.text)
    if (!id) {
      // Same as a failed save: never fall back to an older handoff.
      if (!inFlight) {
        armed = undefined
        autoPending = false
      }
      $.ui.toast('build-handoff: handoff saved, but no memory_id in the result; nothing will launch.')
      return ran
    }
    armed = { bank: typeof args.bank === 'string' && args.bank ? args.bank : 'default', id }
    autoPending = true
    armedTurn = currentTurn
    $.ui.toast(`Build handoff ${id} saved. When this turn ends: /clear, then build on ${DEFAULT_MODEL}. Esc cancels.`)
    return ran
  })

  // Any prompt not ours (typed, even queued mid-turn; a notification; a peer)
  // means there is more to do here: drop the auto-launch, cancel a queued one.
  on('prompt.submit', ($, e, next) => {
    const ours = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name
    if (!ours) {
      if (pendingStart !== undefined) {
        // The person spoke first in the fresh session: their prompt wins.
        pendingStart = undefined
        $.ui.toast(`build-handoff: you typed first, so the build was not started (this session is still on ${buildModel ?? DEFAULT_MODEL}; /model to change). Say "build" to start it.`)
      }
      if (e.turnId) promptDuring = e.turnId
      if (autoPending) {
        autoPending = false
        $.ui.toast(CANCELLED)
      }
      if (inFlight) abortLaunch = true
    }
    return next(e)
  })

  // A new main-loop turn: an auto-launch left from an earlier turn lapses, and
  // a launch still queued is cancelled so it never clears the new work.
  on('turn.start', ($, e, next) => {
    if (!e.agentId) {
      currentTurn = e.turnId
      autoPending = false
      if (inFlight) abortLaunch = true
    }
    return next(e)
  })

  // The fresh session's main-loop requests go to the build model.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId || buildModel === undefined) return yield* next(e)
    if (baseModel === undefined) {
      baseModel = e.model
      if (freshSession === undefined) freshSession = await $.session.id()
    } else if (e.model !== baseModel) {
      stopRouting($)
      return yield* next(e)
    }
    return yield* next({ ...e, model: buildModel })
  })

  // Hands-free: the main-loop turn that saved the handoff has ended.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId || !autoPending || !armed || e.turnId !== armedTurn) return out
    autoPending = false
    if (inFlight) return out
    if (promptDuring === e.turnId) {
      // Typed ahead before the handoff was saved: that prompt runs next.
      $.ui.toast(CANCELLED)
      return out
    }
    if (e.reason !== 'answer') {
      $.ui.toast(`build-handoff: turn ended (${e.reason}); not clearing. /build runs it.`)
      await offerManual($)
      return out
    }
    launch($, armed, DEFAULT_MODEL)
    return out
  })

  // /build [model]: by hand, after a cancel or failure, or to pick a model.
  on('command.run', { command: 'build' }, async ($, e) => {
    if (!armed) {
      return {
        text: 'No build handoff is armed in this session. Save a Mnemopi handoff with metadata.next = "build" first.',
        isTextDisplayOnly: true,
      }
    }
    if (inFlight) {
      return { text: '/build is already clearing.', isTextDisplayOnly: true }
    }
    const model = (e.args ?? '').trim() || DEFAULT_MODEL
    const handoff = armed
    launch($, handoff, model)
    return {
      text: `Clearing; handoff ${handoff.id} opens the fresh session on ${model}.`,
      isTextDisplayOnly: true,
    }
  })

  // The person picking a model ends the routing: their choice wins.
  on('command.run', { command: 'model' }, ($, e, next) => {
    if (isPerson(e.origin.kind)) stopRouting($)
    return next(e)
  })

  // A /clear the person runs cancels a pending launch. Another plugin's /clear
  // while ours is queued is let through, but its SessionStart is skipped so
  // ours still opens the build. Our own queued /clear, reached after a prompt
  // came in, is dropped (where the engine routes a plugin's command through
  // its own hooks; a plugin's origin carries its manifest name).
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const ours = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name
    if (isPerson(e.origin.kind)) {
      launching = undefined
      pendingStart = undefined
    } else if (!ours && e.origin.kind === 'plugin' && launching) foreignClear = true
    else if (ours && launching && abortLaunch) {
      launching = undefined
      $.ui.toast(CANCELLED)
      return { text: '' }
    }
    return next(e)
  })

  // The fresh session's end stops the routing. Before its first request its
  // id is unknown, so then any end but the planning session's (which may fire
  // before or after our SessionStart) counts: a /clear of the fresh session
  // before it ever asked anything never carries the build model onward.
  on('session.end', ($, e, next) => {
    if (e.sessionId === planningSession) return next(e)
    if (foreignIds.delete(e.sessionId)) return next(e)
    if (freshSession === undefined && foreignSessions > 0) {
      foreignSessions -= 1 // a foreign clear's session ending, early or late
      return next(e)
    }
    const fresh = freshSession === undefined || e.sessionId === freshSession
    if (fresh) stopRouting($)
    return next(e)
  })

  // Consume once, on the SessionStart raised by our /clear.
  on('classic.SessionStart', async ($, e, next) => {
    const out = await next(e)
    if (e.source !== 'clear' || !launching) return out
    if (foreignClear) {
      foreignClear = false
      if (e.session_id) foreignIds.add(e.session_id)
      else foreignSessions += 1
      return out
    }
    const launch = launching
    launching = undefined
    if ((await $.clock.now()) - launch.at > LAUNCH_WINDOW_MS) return out
    armed = undefined

    const message = resumeMessage(launch)
    if (abortLaunch) {
      // A prompt came in after our /clear was queued and the clear still ran.
      $.ui.toast('build-handoff: a prompt came in before this clear; not starting the build.')
      return {
        ...out,
        additionalContext: [
          ...(out.additionalContext ?? []),
          `build-handoff: the planning session was cleared to build here. Do not start building until the user asks. Then: ${message}`,
        ],
      }
    }
    buildModel = launch.model
    baseModel = undefined // learned on the fresh session's first request
    // Known now when the SessionStart says; else learned on the first request.
    freshSession = e.session_id || undefined
    $.ui.status(`requests go to ${launch.model}; /model to change`)
    // initialUserMessage does not start a turn after a /clear (seen live), so
    // the build starts as a prompt this mod submits once the fresh session is
    // idle. Our prompt.submit hook knows its own origin and cancels nothing.
    // Anything the person does first (a prompt, /clear, /model) cancels it.
    pendingStart = message
    $.clock.after(0, () => {
      startBuild($).catch(() => {})
    })
    return {
      ...out,
      additionalContext: [
        ...(out.additionalContext ?? []),
        `build-handoff: /build cleared the planning session to build here, on ${launch.model}. ${message}`,
      ],
    }
  })
}
