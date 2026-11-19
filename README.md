# cc-build-handoff

Plan in one Claude Code session, build in a fresh one, with no keypress.

When a turn saves a **build handoff**, this mod waits for that turn to end, runs `/clear`, starts the fresh session on the handoff, and sends that session's requests to Sonnet. The planning context never reaches the build model, and your saved default model is never changed.

It is a Claude Code mod (a plugin of function hooks). The mod API is early access; this was built and tested on Claude Code v2.1.328.

## Install

At the prompt of a terminal session:

```
/plugin install build-handoff --marketplace seanperkins/cc-build-handoff
```

Answer `y` to add the marketplace, then pick a scope.

## The flow

```
planning session                         fresh session (after the mod's /clear)
────────────────                         ──────────────────────────────────────
1. plan is approved and committed        4. SessionStart: the handoff note is added
2. model saves a build handoff              to context; routing to Sonnet begins
   → toast: "When this turn ends:         5. the mod submits "Resume handoff <id> …"
     /clear, then build on sonnet"           as the first prompt
3. turn ends → mod runs /clear           6. the build runs, every main-loop request
                                            on Sonnet (subagents keep their own)
```

**The trigger.** The mod arms on a successful main-loop call to `mcp__mnemopi__mnemopi_remember` whose `metadata` has `kind: "handoff"` and `next: "build"` (we keep handoffs as Mnemopi memory records, through its MCP server). To use a different handoff store, change the `tool.call` matcher and the `memoryIdFrom` / `resumeMessage` helpers in `hooks/register.ts`; everything after "armed" is store-agnostic.

**The resume prompt** names our plan-execution skill, `ml:executing-plans` (from a private plugin). Edit `resumeMessage` in `hooks/register.ts` to name your own skill, or to say "build the plan it names" with none.

**Doing it by hand.** `/build [model]` runs the same launch while a handoff is armed: after a cancel, after a launch that failed, or to pick a model other than Sonnet. A handoff whose save failed is not armed; save it again.

## What cancels it

A prompt you send always wins over the launch:

- Esc (an interrupted turn), an API error or a refusal: no clear; `/build` is put in the prompt box.
- Sending a prompt (pressing Enter) during the planning turn, or after it but before the clear runs. An unsent draft in the box does not cancel anything.
- A new turn starting while the clear is queued.
- A `/clear` you run yourself.
- A later save of the build handoff that fails or returns no id (it never falls back to an older handoff).
- In the fresh session: sending a prompt before the resume prompt goes out, or `/clear`.

Routing to Sonnet stops when you run `/model`, when the engine falls back to another model or you switch in the picker, or when the build session ends.

## Notes for anyone building the same thing

These cost us three live runs to find:

1. **Don't switch models with `/model`.** In current builds `/model` also saves the choice as the default for every new session (it rewrites `~/.claude/settings.json`). That changes the user's default behind their back, and the settings write hot-reloads mods, wiping module state mid-launch. Instead, rewrite the model per request in a `turn.step` hook: `yield* next({ ...e, model })`. The header and `/model` keep showing the session's model; a status line says where requests go.
2. **`initialUserMessage` does not start a turn after `/clear`.** A `classic.SessionStart` (source `clear`) result's `additionalContext` is applied, but `initialUserMessage` is ignored. Start the fresh session with `$.prompt.submit({ text, asUser: true })` from `$.clock.after(0, …)` once SessionStart has run, and check the result for `{ drop }`.
3. **`$.command.run` rejects inside a hook the turn waits on.** Queue the `/clear` from `$.clock.after(0, …)`; commands run once the session is idle.
4. **Tie the launch to its turn.** Arm on the save, launch on the `turn.complete` with the same `turnId`, and treat any `prompt.submit` that is not yours as "the person has more to say".
5. **The planning session's `session.end` can fire before or after the fresh session's `SessionStart`.** Keep the planning session's id, and take the fresh session's id from SessionStart's `session_id`, so routing stops on the right session's end.

[cc-clear-handoff](https://github.com/STRML/cc-clear-handoff) by Samuel Reed solves the neighbouring problem (a curated alternative to `/compact`, auto-loaded after you `/clear`). Points 1 to 3 apply to automating its `/clear` and "resume" steps too.

## Develop

```
claude --plugin-dir /path/to/cc-build-handoff   # run a session with the mod loaded
claude plugin validate .                          # check manifest and module
claude plugin test .                              # 32 tests
```

## License

MIT © Sean Perkins
