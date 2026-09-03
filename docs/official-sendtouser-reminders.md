# Official Grok Bot 0.30 SendToUser reminders

When stock Grok Bot 0.30 on the **Computer** reminds the model to **deliver** via SendToUser / SendMessage. This is the when-it-fires view of that family only. The complete injector dump is [official Grok Bot 0.30 harness injection](official-harness-injection.md).

Official host only. Do not mix this with OpenBot hop leftover-assistant mapping, `wrapSession`, or GenericHop.

---

## 1. Source

Same dump as [the harness catalog §1](official-harness-injection.md#1-scope-and-source):

| Item | Value |
| --- | --- |
| Product | Grok Bot 0.30 Computer host |
| Host `version` file | `eed587b` |
| Official host analyzed | `/home/box/sand-data/host-main.cjs.pre-openbot` (SHA-256 prefix `99d263f61322a77a`) |
| Prompt strings | Copied from the catalog (PR #39). This pass did not re-dump the binary. |

---

## 2. How to read this vs the catalog

| Want | Use |
| --- | --- |
| “Did the host just tell the model it forgot to SendToUser / SendMessage?” | This file |
| Every injector, wake cue, chrome tag, and predicate | [Harness catalog](official-harness-injection.md) |
| Exact prompt text of a delivery reminder | Quoted below (copied from the catalog). Catalog section numbers (`### 3.14` …) are the anchors. |

Seven families belong here: [3.14](official-harness-injection.md#314-reply-first-reminder-opening-user-message), [3.21](official-harness-injection.md#321-start-of-turn-ack-reminder-middleware), [3.22](official-harness-injection.md#322-sendtouser-watching-silence-reminder-middleware), [3.23](official-harness-injection.md#323-early-result-reminder-middleware), [3.27](official-harness-injection.md#327-delivery-owed-reply-nudge--ensureuserreply--reply_nudge_prompt), [3.28](official-harness-injection.md#328-closing-send-nudge--endedonsilenttoolcalls), [3.29](official-harness-injection.md#329-ack-redrive--system-recovery-idle-recovery).

Many other injectors **name** SendToUser / SendMessage while setting a scene (kickstart, channel, automation, group, …). Those are not “you forgot to deliver.” See the [appendix](#appendix-mentions-that-are-not-you-forgot-to-deliver).

---

## 3. Delivery accounting (catalog §2.4)

Reminders below read these counters. They are not themselves reminders.

```text
isDeliveryOwed(result)       <=>  result.sentMessageCount === 0 && !result.reacted
DELIVERY_TOOL_NAMES          =  { SendToUser, SendMessage, ReactToMessage }
isSandUserDeliveryToolName   =  SendToUser || SendMessage
```

- `sentMessageCount` increments on stream update `type: "send-message"`.
- `reacted` becomes true on a successful `react-to-message` update.
- A widget / attachment / cursor-agent card **does** increment `sentMessageCount` (it is a send-message).
- Start-of-turn ack ([3.21](official-harness-injection.md#321-start-of-turn-ack-reminder-middleware)) requires a **text** SendToUser (`args.type === "text"`). Widget / card / attachment does **not** count as that ack.
- Both **SendToUser** and **SendMessage** are accepted as user-delivery tools. [3.29](official-harness-injection.md#329-ack-redrive--system-recovery-idle-recovery) still says **SendMessage** in the prompt (legacy name).

`ReactToMessage` is in `DELIVERY_TOOL_NAMES` (clears `isDeliveryOwed` via `reacted`; walk-back for “since last delivery” treats it as a delivery tool-call). It is **not** `isSandUserDeliveryToolName`.

---

## 4. When it fires (timeline)

Person-opened turn = `hidden !== true && isGroupMemberTurn !== true`.

```text
person-opened runTurn
  assembleTurnAction (before first runner.run)
    → 3.14 reply-first <system_reminder>
       (same tag as 3.15 unfinished-tasks when both apply)
  runner.run → executor.stream (repeat)
    middleware NOT installed if subagent OR isSilenceAllowed OR isGroupMemberTurn
    → 3.21 start-of-turn ack     (threshold 1; text SendToUser only)
    → 3.22 watching silence      (threshold 6)
       else 3.23 early-result    (threshold 0; only if a delivery already happened this turn)
  after runner.run returns
    → 3.27 ensureUserReply       (hidden; up to 3) if isDeliveryOwed
    → 3.28 closing-send nudge    (hidden; once) if turnEndedOnSilentToolCalls
endSessionRun
    → scheduleAckRedriveAfterIdle (5000 ms)
       → 3.29 [System recovery]  (hidden; up to 3; does NOT run ensureUserReply)
```

Executor wiring (catalog §2): `StartOfTurnAckReminder(SendMessageReminder(disk))`. [3.22](official-harness-injection.md#322-sendtouser-watching-silence-reminder-middleware) / [3.23](official-harness-injection.md#323-early-result-reminder-middleware) live in the SendMessage reminder middleware; [3.23](official-harness-injection.md#323-early-result-reminder-middleware) is the **else-branch** of [3.22](official-harness-injection.md#322-sendtouser-watching-silence-reminder-middleware) (if the high-threshold reminder is chosen, early-result does not fire).

Catalog decision trees for the same gates: [§5.1–5.5](official-harness-injection.md#5-decision-trees).

### Compact table

| Phase | Catalog | Fires when | Does not fire | Hidden run? | Max | Model-visible chrome |
| --- | --- | --- | --- | --- | --- | --- |
| Opening person-turn | [3.14](official-harness-injection.md#314-reply-first-reminder-opening-user-message) | `appendReplyReminder: true` on person-opened `runTurn` | `hidden`; `SAND_DISABLE_USER_REPLY_REMINDER=1`; reminder not requested (kickstart / wakes) | No (skipped when `hidden`) | Once per assembled opening message | `<system_reminder>` **inside** the opening `<user_query>` |
| Mid-turn, next stream | [3.21](official-harness-injection.md#321-start-of-turn-ack-reminder-middleware) | No **text** SendToUser yet this turn **and** non-delivery tool-calls since last delivery `> 1` | Middleware absent (subagent / silence / group); last message already this ack; text SendToUser already happened; count `≤ 1` | No | One per silent streak (last-message short-circuit) | `<system_reminder>` as a **new** user message (then `<timestamp>` + `<user_query>`) |
| Mid-turn, next stream | [3.22](official-harness-injection.md#322-sendtouser-watching-silence-reminder-middleware) | `toolCallsSinceLastSend > 6` | Middleware absent; last message already this exact string; count `≤ 6` | No | Last-message short-circuit | Same `<system_reminder>` user-message wrap as 3.21 |
| Mid-turn, else of 3.22 | [3.23](official-harness-injection.md#323-early-result-reminder-middleware) | Count `> 0` **and** a delivery tool-call already this turn **and** no injected reminder in this silent streak | 3.22 already chosen; no SendToUser yet this turn; a reminder already in this streak; count `0` | No | Streak (`hasReminderFiredThisSilentStreak`) | Same wrap |
| After `runner.run` | [3.27](official-harness-injection.md#327-delivery-owed-reply-nudge--ensureuserreply--reply_nudge_prompt) | `isDeliveryOwed` (`sentMessageCount === 0 && !reacted`) | Any send-message (including widget/card); `reacted`; `pausedForUpgrade`; aborted; epoch changed; 3 nudges already | **Yes** | `MAX_REPLY_NUDGES = 3` | `[SAND_HIDDEN_PROMPT]` + nudge body (no 3.14) |
| After the 3.27 loop | [3.28](official-harness-injection.md#328-closing-send-nudge--endedonsilenttoolcalls) | `turnEndedOnSilentToolCalls` (ack then silent tools, ended without a follow-up SendToUser) | Predicate false; aborted; `awaitingUserSelection`; `completionReason === "send_to_user_end_turn"`; epoch mismatch; subagent / hidden settle never sets the flag | **Yes** | **One** | `[SAND_HIDDEN_PROMPT]` + closing body |
| Idle after `endSessionRun` | [3.29](official-harness-injection.md#329-ack-redrive--system-recovery-idle-recovery) | Ack obligation still open; 5s idle (or boot rehydrate) | No obligation; upgrade pause; `!canExecute`; disposed; group; agent gone; `redriveAttempts >= 3`; obligation cleared | **Yes** | `MAX_ACK_REDRIVES = 3` | `[SAND_HIDDEN_PROMPT]` + `[System recovery]` body (says **SendMessage**) |

`ensureHiddenTurnReply` (still [3.27](official-harness-injection.md#327-delivery-owed-reply-nudge--ensureuserreply--reply_nudge_prompt)): one extra hidden run, **no** max-3 loop, after kickstart / disk-saver / admin-broadcast when `sentMessageCount === 0`.

---

## 5. Families

### 5.1 [3.14](official-harness-injection.md#314-reply-first-reminder-opening-user-message) — reply-first `<system_reminder>`

| Field | Value |
| --- | --- |
| Symbols | `USER_MESSAGE_REPLY_REMINDER_BODY`, `appendUserMessageReminders`, `userReplyReminderEnabled` |
| Loop position | `assembleTurnAction`, **before** first `runner.run` |
| Hidden | **Skipped** when `hidden === true`. Also skipped if `process.env.SAND_DISABLE_USER_REPLY_REMINDER === "1"`. |
| Fires | Person-opened `runTurn` with `appendReplyReminder: true`. Combined with unfinished-tasks ([3.15](official-harness-injection.md#315-unfinished-tasks-reminder-interrupt)) in **one** `<system_reminder>` when both apply (`wrapSystemReminderBodies`, bodies joined by `\n\n`). |
| Does not fire | Hidden runs; env disable; `appendReplyReminder` not set (kickstart / wakes). Group-member turns are not person-opened. |
| Max | Once per assembled opening message. |
| Chrome | Model-visible `<system_reminder>` **appended after the user text**, so it sits **inside** `</user_query>` on the opening message. Not `[SAND_HIDDEN_PROMPT]`. |

`USER_MESSAGE_REPLY_REMINDER_BODY` (inner; wrapper is `<system_reminder>\n…\n</system_reminder>`):

```text
Reply to this message by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER delivered; only a real SendToUser tool invocation reaches the user, so if you don't invoke the tool they just see silence.
```

Wrapped form when 3.14 fires alone:

```text
<system_reminder>
Reply to this message by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER delivered; only a real SendToUser tool invocation reaches the user, so if you don't invoke the tool they just see silence.
</system_reminder>
```

[3.15](official-harness-injection.md#315-unfinished-tasks-reminder-interrupt) is **not** a SendToUser reminder. It can share the same `<system_reminder>` tag: `The user interrupted your work to send you a message. Make sure to complete any unfinished tasks from previous turns.`

---

### 5.2 [3.21](official-harness-injection.md#321-start-of-turn-ack-reminder-middleware) — start-of-turn ack

| Field | Value |
| --- | --- |
| Symbols | `START_OF_TURN_ACK_REMINDER_MESSAGE`, `DEFAULT_START_OF_TURN_ACK_THRESHOLD = 1`, `createStartOfTurnAckReminderMiddleware` |
| Flag | `providerOptions.cursor.sandStartOfTurnAckReminder = true` |
| Loop position | **After** a `stream` that produced tool calls, on the **next** `stream` in the same turn |
| Installed | `applyStartOfTurnAckReminder(applySendMessageReminder(diskPressureExecutor))` unless `host.isSubagentRunner \|\| isSilenceAllowed \|\| isGroupMemberTurn` |
| Hidden marker | **No** |
| Max | One per silent streak (last-message short-circuit). Threshold is tool-calls, not a timer. |

**Fires when all hold:**

1. Last message is not already this ack reminder.
2. `hasTextSendMessageSinceTurnStart` is false (no **text** SendToUser / SendMessage since the real user/system boundary, skipping injected reminders).
3. `countToolCallsSinceLastSendMessage > 1` (default threshold 1; counts **non-delivery** tool-calls on assistant messages, walking back until user/system or a delivery tool-call).

**Does not fire when:**

- Subagent / silence-allowed / group-member (middleware not installed).
- Already injected as last message.
- A **text** SendToUser already happened this turn (widget / attachment / cursor-agent card does **not** count).
- `toolCallsSinceLastSend <= 1`.

A widget that incremented `sentMessageCount` still leaves 3.21 eligible. That is why ack ≠ “any send-message.”

Full text:

```text
<system_reminder>
You opened this turn by calling tools without first acknowledging the user, so they are watching silence and may think the app froze. Acknowledge them RIGHT NOW by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Make that first SendToUser a one-line text acknowledgement, before any further tool call, then continue the work. A widget, attachment, or cursor-agent card does not count as this acknowledgement.
</system_reminder>
```

Because this is a **new** user message (not spliced into the opening query), AnysphereAgent wrapping on later streams presents it as its own `<timestamp>` + `<user_query>` block. `system_reminder` is not a notification-only tag, so the model sees `<user_query>` around it.

---

### 5.3 [3.22](official-harness-injection.md#322-sendtouser-watching-silence-reminder-middleware) — watching silence

| Field | Value |
| --- | --- |
| Symbols | `SEND_MESSAGE_REMINDER_MESSAGE`, `DEFAULT_SEND_MESSAGE_REMINDER_THRESHOLD = 6` |
| Flag | `providerOptions.cursor.sandSendMessageReminder = true` |
| Hidden marker | **No** |
| Installed | Same skip set as 3.21 |

**Fires when:** last message is not already this exact reminder string, **and** `toolCallsSinceLastSend > 6`.

**Does not fire when:** last message already is this reminder; count `<= 6`; middleware not installed.

If the high threshold does not fire, [3.23](official-harness-injection.md#323-early-result-reminder-middleware) may fire instead.

Full text:

```text
<system_reminder>
You have made several tool calls without a SendToUser, so the user is currently watching silence. Actually invoke the SendToUser tool now — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Send a brief, specific update on what you are doing or what you just found before continuing.
</system_reminder>
```

---

### 5.4 [3.23](official-harness-injection.md#323-early-result-reminder-middleware) — early-result

| Field | Value |
| --- | --- |
| Symbols | `EARLY_RESULT_REMINDER_MESSAGE`, `DEFAULT_EARLY_RESULT_REMINDER_THRESHOLD = 0` |
| Flag | `sandEarlyResultReminder: true` |
| Hidden marker | **No** (same middleware family as 3.22) |

**Fires when** (else-branch of 3.22):

- `toolCallsSinceLastSend > 0` (threshold 0), **and**
- `hasSendMessageSinceRealTurnStart` (a delivery tool-call already happened this turn, skipping injected reminders), **and**
- `!hasReminderFiredThisSilentStreak` (no injected reminder since last send / turn start).

**Does not fire when:** high-threshold 3.22 reminder already chosen; no SendToUser yet this turn; a reminder already sits in this silent streak; count is 0.

This is “you already delivered something this turn, then kept calling tools — if you now have the result, send it.” It does **not** fire on a still-silent turn that never sent (that path is 3.21 / 3.22 / later 3.27).

Full text:

```text
<system_reminder>
Remember: the user cannot see tool output or your thinking — only SendToUser reaches them. If you have produced a result or finished what they asked, send it now with a SendToUser tool call before continuing or ending the turn. If you are still mid-task, keep working and send the result once you have it.
</system_reminder>
```

`isInjectedReminderMessage` treats all of: `sandSendMessageReminder`, `sandEarlyResultReminder`, `sandStartOfTurnAckReminder`, `sandDiskPressureReminder`, `loopReminder`, or content including the send-message / early-result full strings.

---

### 5.5 [3.27](official-harness-injection.md#327-delivery-owed-reply-nudge--ensureuserreply--reply_nudge_prompt) — `ensureUserReply`

| Field | Value |
| --- | --- |
| Symbols | `SAND_ONBOARDING_REPLY_NUDGE_PROMPT`, `REPLY_NUDGE_PROMPT`, `MAX_REPLY_NUDGES = 3` |
| Loop position | **After** the whole first `runner.run` of a person-opened turn, before the turn returns |
| Hidden | `hidden: true` → `[SAND_HIDDEN_PROMPT]` prepended. `advanceChainOnDelivery: false`. Reply-first (3.14) is **not** appended on hidden runs. |
| Max | 3 (`attempts < 3`) |

Predicate: `isDeliveryOwed(latest)` ⇔ `sentMessageCount === 0 && !reacted`.

**Fires while:** `isDeliveryOwed(latest)` and `attempts < 3` and `epoch === currentTurnEpoch` and not aborted (loop breaks on `latest.aborted`).

**Does not fire when:** `sentMessageCount > 0` (including widget / attachment / cursor-agent card) or `reacted`; `result.pausedForUpgrade` (caller skips `ensureUserReply` entirely); `result.aborted`; epoch changed (new user send); already 3 nudges.

Also `ensureHiddenTurnReply`: **single** extra hidden run (no max-3 loop) after kickstart / disk-saver / admin-broadcast if `sentMessageCount === 0`.

Full prompt (`SAND_ONBOARDING_REPLY_NUDGE_PROMPT`):

```text
Your previous turn left the user without the result they're waiting on — you never called SendToUser that turn, or every SendToUser you tried failed to deliver. Either way they received nothing and are still waiting. Do not assume a send from an earlier turn covered it: an opening acknowledgement back then did not deliver this result (ack ≠ delivery). Deliver the result now by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence.
```

---

### 5.6 [3.28](official-harness-injection.md#328-closing-send-nudge--endedonsilenttoolcalls) — closing-send nudge

| Field | Value |
| --- | --- |
| Symbol | `CLOSING_SEND_NUDGE_PROMPT`; predicate `turnEndedOnSilentToolCalls` |
| Loop position | **One** hidden run after the reply-nudge loop |
| Hidden | `true`, `advanceChainOnDelivery: false` |
| Max | **One** |

**`turnEndedOnSilentToolCalls` true when:** walking the tail (skipping tool messages, blank assistant, injected reminders) the last real assistant has **non-delivery** tool-calls; walking from the user/system boundary, the **first** assistant tool-call message **does** include a delivery tool; later delivery tool-call ids are all **errored** (`highLevelToolCallResult.isError`); and this is not a subagent and `hidden` was false on settle.

In prose: the turn **had an ack**, then silent tools, and **ended without a follow-up SendToUser**.

**Does not fire when:** `endedOnSilentToolCalls` false; `aborted`; `awaitingUserSelection`; `completionReason === "send_to_user_end_turn"`; epoch mismatch.

Settle **does not set** `endedOnSilentToolCalls` for subagents or `args.hidden` turns.

Full prompt:

```text
Your previous turn acknowledged the user and then ran tool calls, but ended without a follow-up SendToUser — the last thing the user saw is that opening acknowledgement, so whatever the tool calls produced after it never reached them. If that work produced the result or answer they are waiting on, deliver it now by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them. If the work is genuinely unfinished, continue it and send the result once you have it.
```

---

### 5.7 [3.29](official-harness-injection.md#329-ack-redrive--system-recovery-idle-recovery) — ack-redrive

| Field | Value |
| --- | --- |
| Symbols | `buildAckRedrivePrompt`, `MAX_ACK_REDRIVES = 3`, `ACK_REDRIVE_IDLE_DELAY_MS = 5000` |
| Hidden | `true` |
| Message id | `ack-redrive-${uuid}` (model sees `[ack-redrive-…]` via address note) |
| `requestSource` | `"handoff-resume"` |
| Lane | `"background"` source `"ack-redrive"` |

The prompt still says **SendMessage** (legacy). `isSandUserDeliveryToolName` accepts both SendMessage and SendToUser.

**Timer:** `scheduleAckRedriveAfterIdle` on **every** `endSessionRun` (`ttlMs: 5000`). Also `"boot"` for persisted obligations. `fulfillAckObligation` requires a matching `ackToken` minted for that agent; SendToUser with that token clears the obligation.

**Does not fire / early returns:** no store/scheduler; `!canExecute`; disposed; `pausingForUpgrade`; no obligation; agent gone (`lost` / `agent_deleted`); `redriveAttempts >= 3` (`lost` / `max_redrives`); group session (clears store); obligation cleared before run; session resolve failure reschedules idle.

Does **not** run `ensureUserReply`. Empty delivery is telemetry only.

Full prompt:

```text
[System recovery] The user sent one or more messages that were never visibly acknowledged — the turns handling them were interrupted, or the app restarted before a reply went out. Their newest message may be MISSING from your context entirely. Respond now by actually invoking the SendMessage tool: if you can see their latest message and already completed what it asked, send a brief confirmation with the result; if you can see it but the work is not done, acknowledge them and continue the work; if you cannot be certain what they last asked, say you may have missed their latest message and ask them to resend it — NEVER guess or claim completion of work you cannot see. Plain assistant text is NEVER shown to the user; only a real SendMessage tool invocation reaches them. Do NOT end this turn with only thinking, an empty reply, or a plan to send later — ending the turn without a real SendMessage invocation delivers nothing and is a failure. Invoke SendMessage now, even if all you can send is a brief status update.
```

---

## Appendix. Mentions that are not “you forgot to deliver”

These injectors name SendToUser / SendMessage (or tell the model how to talk) while **setting a scene**. They are not the mid-turn / post-turn delivery-nudge family above. Bodies stay in the catalog.

| Catalog | Scene | Why it is not this family |
| --- | --- | --- |
| [3.30](official-harness-injection.md#330-onboarding-kickstart) | Onboarding kickstart | First-run cue; “nothing reaches the user unless it's inside a SendToUser.” If that run sends nothing, `ensureHiddenTurnReply` (3.27) may follow. |
| [3.31](official-harness-injection.md#331-disk-saver-kickstart) / [3.32](official-harness-injection.md#332-disk-saver-reaudit) | Disk-saver | Assignment + “deliver findings with SendToUser.” |
| [3.33](official-harness-injection.md#333-automation-routine-wake) | `[routine]` wake | Silence allowed; SendToUser only if worth surfacing. 3.21–3.23 **not** installed. |
| [3.33a](official-harness-injection.md#333a-automation-subagent-wrapper--buildautomationsubagentprompt) | Automation subagent | Parent-mediated: **WakeParent**, not SendToUser. Non-parent-mediated: SendToUser optional, silence contract. |
| [3.34](official-harness-injection.md#334-timeline-event-wake) | `[event]` wake | Optional ack; silence is fine. |
| [3.35](official-harness-injection.md#335-channel-inbound-wake) | `[inbound]` channel | How to reply on an outside channel (ack then short messages). |
| [3.36](official-harness-injection.md#336-channel-delivery-failure-wake) | `[channel-delivery-failed]` | Tell the user a **channel** send failed — a new wake, not a forgotten in-app turn. |
| [3.37](official-harness-injection.md#337-admin-broadcast-wake) | `[broadcast]` | Act on the owner’s broadcast, then reply. May then `ensureHiddenTurnReply`. |
| [3.38](official-harness-injection.md#338-agent-to-agent-inbound) | `[agent]` peer FYI | Stay silent on FYI; SendToUser only for a real user-visible result. |
| [3.39](official-harness-injection.md#339-subagent-revival) / [3.40](official-harness-injection.md#340-shell-command-revival) | Background revival | Saved-instruction delivery rule; 3.40 default text still says SendMessage. Room-origin note: SendToUser here is **not** the room. |
| [3.41](official-harness-injection.md#341-upgrade-resume) | Upgrade resume | Continue the interrupted run; tail says SendMessage. Person-opened `runTurn` **skips `ensureUserReply`** when `pausedForUpgrade`. |
| [3.42](official-harness-injection.md#342-box-hand-back-resume--buildboxhandbackprompt) | Box hand-back | Continue / blocked; “brief message” is scene copy, not 3.14. |
| [3.43](official-harness-injection.md#343-mcp-auth-resume) / [3.43a](official-harness-injection.md#343a-listener-connect-resume--resumeafterlistenerconnect) | MCP / listener resume | “Your first action is a SendMessage…” after a connector came back. |
| [3.44](official-harness-injection.md#344-voice-call-hidden-prompts--mainloopvoiceprompt) | Voice call | Often **do not** send to chat. |
| [3.48](official-harness-injection.md#348-system-prompt-rolesystem--not-a-per-turn-user-inject) | System prompt | Standing `## SendToUser is your only voice` / reply-first essay. Every turn, not a reminder that you already forgot. |
| [3.50](official-harness-injection.md#350-group-chat-member-turn--buildgroupturnprompt) / [3.50a](official-harness-injection.md#350a-group-redrive-note--buildgroupredrivenote) | Group / room | Member turn + DM-preempt redrive. 3.14 / 3.21–3.23 **not** installed. |
| [3.20](official-harness-injection.md#320-unanswered-widget--discarded-draft-hidden-note) / [3.57](official-harness-injection.md#357-draft-sent-resume--builddraftsentprompt) | Draft discarded / unconfirmed / sent | **Do not** send that draft yourself — opposite of a forgotten-delivery nudge. |
| [3.51](official-harness-injection.md#351-secret-request--widget--auto-review-cards-pending-chrome-resolutions-in-354359) | Awaiting-user tool error | `SAND_AWAITING_USER_SEND_MESSAGE_BLOCKED` is a **tool error**, not a user inject. |
| [3.53](official-harness-injection.md#353-cursor-only-leftovers-in-the-same-binary-not-grok-bot-turn-injectors) | Cursor project SendMessage visibility reminder | **ABSENT** from the Grok Bot executor stack. Grok Bot uses 3.22–3.23 instead. |

---

## Not these (OpenBot)

OpenBot hop leftover → SendToUser mapping, `wrapSession`, and GenericHop are **not** official harness reminders. Official leftover policy is catalog [§7.1](official-harness-injection.md#71-leftover-assistant-text-official-answer): plain assistant `text-delta` is inner monologue; only a real SendToUser / ReactToMessage reaches the user.
