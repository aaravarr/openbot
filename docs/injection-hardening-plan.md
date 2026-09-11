# OpenBot Injection Hardening Plan

[README.md](../README.md) · [README.zh-CN.md](../README.zh-CN.md)

> Status: proposal only. This PR adds documentation; it does not change product code, the official host, or the structural message converter.

## 1. Executive summary

OpenBot can successfully receive a POST /v1/chat/completions response and still show the user nothing: plain assistant text is inner transcript content, while only a real SendToUser (or accepted delivery tool) reaches the user. The incident in §2 is exactly that case. The official Grok Bot has detection and follow-up mechanisms, but the custom wrap/hop path did not deliver those mechanisms to the gateway.

This plan adds a named, opt-in InjectionHardeningStrategy at the OpenBot hop boundary:

- **L1 — before generation:** append the official reply-first/start-of-turn/silence/early-result reminders when the reconstructed ledger reaches the official thresholds.
- **L2 — after generation:** the key patch for this incident. The upstream response is converted into host-boundary chat-completions events incrementally. Every text, reasoning, and tool-call delta is forwarded immediately. Only the terminal event or events carrying finish_reason are held. At that point, a local decision checks the trusted person-opened permission gate and whether the current response has finish_reason=stop with no tool calls. An eligible silent stop always attempts one bounded second upstream run, regardless of earlier delivery calls or tool history, subject only to the existing lease, budget, timeout, and one-attempt guardrails. The exact §3.27 hidden suffix is appended to the canonical context; the second response continues the same host stream and supplies its terminal close. Any second-run failure releases the original held terminal immediately. There is no whole-response capture or response-size admission rule; provider continuation is not used.
- **L3 — between host requests (limited):** if the next request's history and a trusted host ledger prove that the preceding person-opened epoch is still owed, append a §3.27 or §3.28 nudge before sending the next upstream request. §3.29 idle/boot ack-redrive is explicitly out of scope; L3 must not claim to implement it.

The strategy is deliberately outside toOpenAIMessages. That function remains a pure structural conversion. The strategy records an upstream assistant delivery call as **call-emitted**; it records **delivery-observed** only when a trusted host success event confirms delivery. It never maps leftover text to SendToUser, never forces finish_reason, and never claims delivery from plain text or a call alone.

### Latency and blast radius

Normal turns — a current response that contains any tool call, or a request rejected by the person-opened permission gate — have zero extra model calls, zero response buffering, and no first-byte delay. The only work on an eligible response is a local, millisecond-scale observation and the immediate release of the tiny terminal event unless the response is a silent stop selected for the one bounded L2 attempt. The same is true for hidden, group, subagent, routine, and silence-allowed turns: the permission gate skips intervention while the ordinary stream remains unchanged.

Only a trusted person-opened turn whose current response ends with finish_reason=stop and contains no tool calls can incur a second model call. Its body has already been streamed to the host, so the extra wait is confined to that silent-tail cohort and does not delay the first byte of normal turns. Earlier delivery calls in the same turn do not change this gate: an opening acknowledgement followed by later tool execution is still eligible when the current response silently closes. This is an intentional trade-off: if the model already delivered the result and then adds a plain-text closing sentence, the nudge may produce one extra short confirmation. One extra message is far better than one missing reply. The affected set is approximately the silent-ending user-facing cohort (4 of 170 sample turns, about 2.4%); removing the old chronology suppression does not expand the impact surface, it only stops leaking people from that cohort.

### Goals

1. Close the proven gap without changing the official host or its reminders.
2. Preserve prompt-cache prefixes, the existing bidirectional protocol conversion, and the host-boundary response contract.
3. Keep normal streaming latency unchanged; bound only the terminal hold, the optional extra call, and its time/cost budget.
4. Make every decision visible in request logs and reversible with a hot configuration switch.

### Non-goals

- Rewriting assistant text as a tool call.
- Dropping or replacing SendToUser calls.
- Adding a reminder inside toOpenAIMessages.
- Modifying /home/box/sand-data/host-main.cjs.pre-openbot, the stock host, or the official executor.
- Guaranteeing delivery when the model ignores a valid nudge; the gateway must remain honest in that case.
- Recovering or deleting the first response after it has been sent to the host. That text is intentionally retained in the session record.
## 2. Background and evidence

### 2.1 Incident record

The control-page request log identifies the affected request as:

| Field | Observed value |
| --- | --- |
| Log id | 336ecdb8-af5d-42fa-b2ba-138cc5dc4d31 |
| Timestamp | 2026-09-10T17:45:46.078Z (Beijing time 2026-09-11 01:45:46) |
| Channel / status | hop / 200 |
| Model | deepseek-flash |
| Bot / chat type | 7a1ef5de-2f61-4344-b309-3b8eafea1b83 / dm |
| Usage | promptTokens=84530, completionTokens=254, reasoningTokens=42, cachedTokens=82816 |
| Latency | 4604 ms |
| Finish | finish_reason="stop" |
| Delivery | no tool_calls; assistant emitted Chinese plain text |

The text said, in substance, that OpenGrok leftovers had been removed and asked whether a sentence should also be changed. It was not a SendToUser invocation. Therefore the host completed with status 200 while the user-visible delivery count remained zero.

### 2.2 Timeline

| Time (UTC) | Host/hop | Observation |
| --- | --- | --- |
| 17:45:39.810 / .821 | custom-host / hop | Normal turn with tool_calls. |
| 17:45:46.070 / .078 | custom-host / hop | The incident turn: finish_reason=stop, no tool calls, plain text. |
| 17:45:50.763 / .773 | custom-host / hop | botId empty; promptTokens=1417, completionTokens=1112; remove: … / log: … memory/summary entries. This was memory extraction, not delivery remediation. |
| 17:48:28.778 | — | The next request arrived **162.7 s after the incident** and carried the user's new message **“继续”**. The user had to resend it to make progress. |
| Whole window | — | Requests with status != 200: **0**; there was no failed-request retry. |

The evidence establishes that official delivery remediation equivalent to ensureUserReply did not reach the gateway after the incident run, and the gateway performed no remediation of its own. The 17:45:50 call must not be counted as a response attempt merely because it followed the incident. The user's later “继续” was a new request, not evidence that the original result had been delivered; the forced resend is the user-visible impact this plan is intended to avoid.

### 2.3 Read-only authorities

The two repository documents below are the source of truth and must not be modified by this plan:

- Delivery ledger: [docs/official-harness-injection.md:104-114](official-harness-injection.md), especially §2.4.
- Seven delivery injectors and literal prompt bodies: [docs/official-sendtouser-reminders.md:100-295](official-sendtouser-reminders.md), §§5.1–5.7 (catalog anchors §3.14, §3.21–§3.23, and §3.27–§3.29).

## 3. Official mechanism summary

### 3.1 Delivery ledger

The official predicate is:

~~~text
isDeliveryOwed(result) <=> result.sentMessageCount === 0 && !result.reacted
DELIVERY_TOOL_NAMES = { SendToUser, SendMessage, ReactToMessage }
isSandUserDeliveryToolName = SendToUser || SendMessage
~~~

sentMessageCount increments on stream update type: "send-message"; widgets, cards, and attachments are send-message updates too. A successful react-to-message update sets reacted=true. Thus a widget may clear the owed predicate while still not satisfying the start-of-turn text acknowledgement. A real text SendToUser has args.type === "text"; ReactToMessage clears isDeliveryOwed but is not user-delivery text. These details are documented at docs/official-harness-injection.md:104-114 and docs/official-sendtouser-reminders.md:36-52.

OpenBot must preserve the same semantic split, while declaring which values the gateway can actually observe:

- sentMessageCount: a known count only when a trusted host event/snapshot reports successful send-message delivery; otherwise unknown.
- reacted: true/false only when a trusted host event/snapshot reports the ReactToMessage result; otherwise unknown.
- deliveryCallsEmitted: gateway-normalized assistant calls named SendToUser, SendMessage, or ReactToMessage, whether or not the host later confirms them.
- deliveryObserved: only host-confirmed successful delivery events; it is distinct from deliveryCallsEmitted and may be unavailable.
- Plain assistant text is never a delivery event.

### 3.2 Seven injectors and order

A person-opened turn is positively established only by trusted host/transport metadata: hidden=false, requestSource="person" (or an explicitly allow-listed equivalent), isSubagent=false, isSilenceAllowed=false, routine/automation=false, and an explicit non-group chat type/flag. A trusted `chatType="group"` or group flag always excludes the request, even when `isGroupMemberTurn` is absent or false; missing or ambiguous required values fail closed. A visible-prompt/transcript regex is never an identity source (see §5.2 and §9.1). The order is:

~~~text
opening assembly / first upstream run
  -> §3.14 reply-first (once, in the opening user message)

next stream(s) in the same turn
  -> §3.21 start-of-turn text acknowledgement (non-delivery calls > 1)
  -> §3.22 watching silence (toolCallsSinceLastSend > 6)
       else §3.23 early result (calls > 0, a delivery tool-call already occurred)

after the person-opened run
  -> §3.27 ensureUserReply (hidden follow-up, delivery owed, up to 3)
  -> §3.28 closing-send nudge (one hidden follow-up for ack + silent tools)

endSessionRun
  -> §3.29 ack-redrive after 5 seconds idle or boot rehydrate, up to 3,
     with an ackToken; it does not call ensureUserReply
~~~

| Catalog family | Phase | Trigger and official bound |
| --- | --- | --- |
| §3.14 reply-first | Before generation | Person-opened opening message; after user text inside the opening <user_query>; once per assembled opening message. Skips hidden/wake runs and SAND_DISABLE_USER_REPLY_REMINDER=1. |
| §3.21 start-of-turn ack | Stream-to-stream | No **text** SendToUser/SendMessage in this turn and non-delivery tool calls since the last delivery > 1; one per silent streak with last-message short-circuit. |
| §3.22 watching silence | Stream-to-stream | toolCallsSinceLastSend > 6; exact-last-message short-circuit. It has precedence over §3.23. |
| §3.23 early result | Stream-to-stream | toolCallsSinceLastSend > 0, a delivery call already happened in this turn, and no reminder has fired in the current silent streak. |
| §3.27 ensureUserReply | After run | isDeliveryOwed; hidden runner.run; up to MAX_REPLY_NUDGES=3; stops on epoch change, abort, pause, or observed delivery. |
| §3.28 closing-send | After §3.27 | turnEndedOnSilentToolCalls: an opening ack was seen, later non-delivery tools ran, and no follow-up SendToUser succeeded; one hidden run. |
| §3.29 ack-redrive | After session / idle | Open ack obligation after endSessionRun; 5 seconds idle or boot replay; up to 3 with ackToken; no ensureUserReply. |

The three phases matter for this proposal: §3.14 is generation-time assembly; §3.21–§3.23 are stream-time middleware; §3.27–§3.29 are post-turn/recovery work. The custom hop can implement bounded equivalents only at its own boundary: L1, same-request §3.27-style L2, and next-request §3.27/§3.28-style L3. It cannot assume the official executor is present, and it does not claim §3.29 equivalence.

### 3.3 Literal official templates

The following bodies are copied verbatim from the official catalog. Implementations must keep them as named constants and test exact equality. Do not translate, shorten, or “improve” them. The wrapper and marker are part of the placement rules, not a license to change the body.

#### §3.14 reply-first body

~~~text
Reply to this message by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER delivered; only a real SendToUser tool invocation reaches the user, so if you don't invoke the tool they just see silence.
~~~

When used as the official opening reminder, its wrapper is:

~~~text
<system_reminder>
Reply to this message by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER delivered; only a real SendToUser tool invocation reaches the user, so if you don't invoke the tool they just see silence.
</system_reminder>
~~~

#### §3.21 start-of-turn ack

~~~text
<system_reminder>
You opened this turn by calling tools without first acknowledging the user, so they are watching silence and may think the app froze. Acknowledge them RIGHT NOW by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Make that first SendToUser a one-line text acknowledgement, before any further tool call, then continue the work. A widget, attachment, or cursor-agent card does not count as this acknowledgement.
</system_reminder>
~~~

#### §3.22 watching silence

~~~text
<system_reminder>
You have made several tool calls without a SendToUser, so the user is currently watching silence. Actually invoke the SendToUser tool now — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Send a brief, specific update on what you are doing or what you just found before continuing.
</system_reminder>
~~~

#### §3.23 early result

~~~text
<system_reminder>
Remember: the user cannot see tool output or your thinking — only SendToUser reaches them. If you have produced a result or finished what they asked, send it now with a SendToUser tool call before continuing or ending the turn. If you are still mid-task, keep working and send the result once you have it.
</system_reminder>
~~~

#### §3.27 delivery owed (REPLY_NUDGE_PROMPT)

~~~text
Your previous turn left the user without the result they're waiting on — you never called SendToUser that turn, or every SendToUser you tried failed to deliver. Either way they received nothing and are still waiting. Do not assume a send from an earlier turn covered it: an opening acknowledgement back then did not deliver this result (ack ≠ delivery). Deliver the result now by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence.
~~~

#### §3.28 closing-send nudge

~~~text
Your previous turn acknowledged the user and then ran tool calls, but ended without a follow-up SendToUser — the last thing the user saw is that opening acknowledgement, so whatever the tool calls produced after it never reached them. If that work produced the result or answer they are waiting on, deliver it now by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them. If the work is genuinely unfinished, continue it and send the result once you have it.
~~~

Official §3.27 and §3.28 follow-ups use hidden: true, which makes the model-visible prompt start with [SAND_HIDDEN_PROMPT]; they do not append §3.14. OpenBot must preserve that marker and must not strip or rewrite any existing <system_reminder> or [SAND_HIDDEN_PROMPT].

## 4. Gap diagnosis

### 4.1 What exists officially

The official host has both detection and remediation:

1. Stream updates maintain sentMessageCount and reacted.
2. Middleware can add §3.21–§3.23 during later streams.
3. runTurn calls ensureUserReply after a person-opened run when the owed predicate remains true (§3.27).
4. Closing-send and idle/boot redrives cover two additional recovery shapes (§3.28–§3.29).

None of these turns plain text into a fake delivery. The official follow-up is another model run that asks the model to make a real tool call.

### 4.2 What failed in this chain

The custom-host/hop pair produced a successful upstream response with finish_reason=stop and no tool calls, then returned it. There was no second hop request carrying the §3.27 body, and no gateway event indicating an attempted nudge. The subsequent botId-empty memory extraction is a different lane. The evidence supports one high-confidence observation, but it does not identify the internal missing component:

- **High-confidence observation:** no subsequent hop request carried a remediation run, so any post-run remediation equivalent to ensureUserReply did not reach the gateway. A zero-tool-call response cannot prove that the official stream middleware was absent: official §3.21–§3.23 predicates are evaluated on tool-call streaks and do not fire for this zero-tool-call shape.
- **Unresolved alternatives (medium/low confidence):** the custom path may not have installed the official StartOfTurnAck/SendMessage middleware, or the post-run ensureUserReply path may not have been triggered/exposed by a wrapper gate. The available evidence cannot distinguish those causes; do not label either one high confidence until the wrapped executor composition and host events are instrumented.

The log population is small and must be reported rather than generalized:

| Population | Count | Interpretation |
| --- | ---: | --- |
| All captured logs | 508 | Full observation window. |
| Hop requests | 192 | Custom hop subset. |
| hop responses with finish_reason=stop, no tool_calls, and non-empty content | 26 | Candidate plain-text stops before identity filtering. |
| Of those, botId missing/empty internal calls | 22 | Internal memory/summary or similar calls that should remain silent and are not remediation candidates. |
| Of those, botId present and person-facing | 4 | All four belong to the same bot; this is the only relevant sample for this plan. |

The 17:45:50 memory call must not be counted as a response attempt merely because it followed the incident, and it is not evidence that delivery remediation happened.

### 4.3 Why we must not patch the official path

The official host is a separate product binary and its source-of-truth dump is explicitly read-only. Patching it would couple OpenBot to an opaque host release, alter stock behavior, and still would not solve a custom hop that bypasses the executor. OpenBot owns the custom hop boundary, so the reliable place to add a guarded equivalent is the request pipeline we control.

The repository constraints are binding:

- Do **not** map leftover assistant text onto SendToUser.
- Do **not** add a SendToUser drop or forced finish=stop on GenericHop.
- Do **not** insert a reminder in toOpenAIMessages.
- Do not remove or alter official <system_reminder> / [SAND_HIDDEN_PROMPT] strings.
- Use a named opt-in strategy as a separate union; the structural converter stays pure.

### 4.4 Existing bidirectional protocol conversion

The repository already supplies the protocol capability L2 needs; this is not a new converter design:

- Request direction: `src/hop/protocol-converters.ts:36` exports `chatToResponses(body)` and `:81` exports `chatToAnthropic(body)`. At `payload/hop-handler.cjs:1393`, `apiType === "responses"` selects `chatToResponses`, `apiType === "anthropic"` selects `chatToAnthropic`, and chat-completions leaves the canonical body as-is. The L2 second request therefore reuses the same adapter selected for the first request.
- Non-stream response direction: `src/hop/protocol-converters.ts:76` exports `responsesToChat(payload)` and `:111` exports `anthropicToChat(payload)`; `payload/hop-handler.cjs:1149` invokes the corresponding converter.
- Stream response direction: `src/hop/protocol-converters.ts:149`/`:150` export `responsesSseToChat(raw)` and `anthropicSseToChat(raw)`. These existing helpers define the provider-to-chat SSE mapping, including the terminal chunk and `[DONE]`; the implementation must drive that mapping through incremental parser state rather than collect the raw stream.

Accordingly, L2 reuses the existing reverse converters at the host boundary and consumes their event mapping incrementally. The adapters expose the normalized chat-completions finish/tool-call events needed for one shared classifier; they do not collect provider SSE, converted text, reasoning, or tool-call deltas into a response buffer. The terminal event is the only L2 hold. No new multi-protocol fallback path is needed. Protocol differences belong in incremental adapter fixtures and the test matrix, not in a response-buffer admission gate.

## 5. Design and request pipeline

### 5.1 Boundary and naming

Introduce a conceptual named strategy (implementation can choose the final module name):

~~~text
InjectionHardeningStrategy = off | dry-run | enforce
~~~

The strategy has one fixed injection stage: the custom hop runs it after the host transcript is converted into canonical chat messages and before any provider-specific payload conversion or serialization. In particular, it must run before adapters such as chatToResponses or chatToAnthropic. A provider payload is too late: appending a canonical role: "user" suffix there may be ignored or become an invalid provider shape. L1 and L3 mutate canonical messages at this stage. L2 uses the same canonical context when it needs to start its second upstream run; it does not make a private full-response copy.

~~~text
host request
  -> parse/route/credentials
  -> authenticated HostRequestContext and canonical chat messages
       (toOpenAIMessages; structural conversion only)
  -> person-opened permission gate (local, before upstream)
  -> provider adapter/payload conversion
       (chatToResponses / chatToAnthropic / other provider serializers)
  -> image/tool-id/protocol finalization for that provider
  -> first upstream request
  -> incremental reverse adapter at the host boundary
       (every non-terminal delta is written to host immediately)
  -> terminal hold and local L2 decision
  -> optional second request using the same adapter
  -> second terminal release or original-terminal release
~~~

The strategy may append a new model-visible canonical role: "user" suffix or append to the opening user content as specified below. It must not edit old assistant text, tool results, tool IDs, system messages, or finish reasons. It must carry a local fingerprint for every insertion; that fingerprint is never sent as an invented provider field.

### 5.2 Common policy gates

All layers require every gate below:

1. Configuration mode is enforce (or dry-run for observation only).
2. The request must carry an authenticated host/transport context with explicit hidden, requestSource, isSubagent, isSilenceAllowed, routine/automation, chatType, and group-state fields. A person-opened turn requires hidden=false, requestSource="person" (or an explicitly allow-listed equivalent), isSubagent=false, isSilenceAllowed=false, routine/automation=false, and a trusted non-group chat type/flag. `chatType="group"` or any trusted group flag is always excluded, even if `isGroupMemberTurn` is omitted or false; missing or ambiguous required values fail closed and skip rather than inferring a person turn. No value may be extracted from visible prompt/transcript text with a regex.
3. botId and conversationId are required non-empty opaque values from that same trusted host/transport context. An empty or missing botId, including the 17:45:50 memory call, is unconditionally ineligible; a prompt-derived or otherwise inferred identity may not override this. The ledger key must contain trusted conversationId + botId + host-supplied epoch when the selected layer needs epoch state.
4. For predicates that use delivery or completion state, such as L3 and ledger alignment, the required host ledger fields must be explicitly observed under the contract in §9.1. Unknown is not zero/false: missing or ambiguous state fails closed and skips that layer. The L2 response-level silent-stop gate intentionally does not use delivery history, so unknown delivery state does not suppress an otherwise eligible L2 attempt.
5. A per-conversation/epoch turn lease prevents two concurrent requests from injecting the same epoch. The lease is acquired only for the terminal decision/second run; it is not a response-buffer reservation.

Every layer also honors the global and per-layer enabled switch. Turning the mode to off takes effect on the next request; it never requires a host bounce.

### 5.3 L2 request-level person-opened permission gate

The request-level pre-screen has one purpose: decide whether the hop is permitted to intervene at the end of this request. It is not a prediction of the response, not a delivery decision, and not a control for buffering cost. It runs once from the authenticated context and canonical request metadata before the first upstream byte:

- Pass only when hidden=false, requestSource="person" (or an explicitly allow-listed equivalent), isSubagent=false, isSilenceAllowed=false, routine/automation=false, and the trusted chat type is explicitly non-group.
- Reject hidden, wake, subagent, routine/automation, silence-allowed, group, unknown, unsigned, or ambiguous contexts. chatType="group" and groupFlag=true always reject; a missing group field cannot be treated as non-group.
- Require non-empty trusted botId, conversationId, and the host epoch when the implementation needs epoch state. These identifiers bind the permission decision and the terminal lease; they are never extracted from prompt text.
- Do not inspect response size, allocate response capture, reserve response storage, or decide whether a second call will be needed. Protocol type is not a permission rejection: chat-completions, responses, and anthropic all use the same later host-boundary decision.

A rejected request immediately follows the existing single-run path. It still forwards every delta and releases its terminal event normally. An accepted request also streams normally; acceptance merely enables the local terminal decision. Dry-run records the gate result but never holds the terminal or dispatches L2.

## 6. L1 — pre-generation injection

L1 mirrors §3.14 and §3.21–§3.23. It runs at the fixed canonical-message stage: after toOpenAIMessages has structurally converted the host transcript and before chatToResponses/chatToAnthropic or any provider-specific payload conversion. It is not part of the conversion function.

### 6.1 Trigger and placement table

| Family | Eligibility | Placement | Bound and reset |
| --- | --- | --- | --- |
| §3.14 reply-first | First eligible opening request of a new person-opened epoch; appendReplyReminder equivalent is true; no hidden/wake/subagent/group. | Append the exact <system_reminder>…</system_reminder> after the real user text in the opening user row. If the opening row cannot be identified safely, **skip L1**; never append a new row or mutate an unrelated row. | Once per assembled opening message. Skip if the exact body is already present; reset only on a trusted new epoch. |
| §3.21 start-of-turn ack | No text SendToUser/SendMessage since the epoch boundary and non-delivery tool calls since the last delivery > startOfTurnAckThreshold (default 1, therefore >1). | Append the exact full §3.21 block as one new role: "user" message at the tail. | At most once per silent streak; exact-last-message short-circuit. Reset on a real delivery call/result, a new user/system boundary, or a new epoch. |
| §3.22 watching silence | toolCallsSinceLastSend > watchingSilenceThreshold (default 6). It wins over §3.23. | Append the exact full §3.22 block as one new tail user message. | At most once per silent streak; exact-last-message short-circuit. |
| §3.23 early result | Else branch of §3.22: toolCallsSinceLastSend > earlyResultThreshold (default 0), a delivery tool-call already occurred in this turn/epoch, and no reminder fired in this silent streak. **Officially this tests call presence, not successful delivery.** | Append the exact full §3.23 block as one new tail user message. | At most once per silent streak; exact-last-message short-circuit. |

A request gets no more than one L1 reminder selection: evaluate §3.22 first, then §3.23, with §3.21 as the start-of-turn acknowledgement gate. The detector ignores prior injected reminder messages when walking the ledger, but the exact text still participates in duplicate detection. Existing official reminder strings remain untouched.

### 6.2 Cache-safe suffix rule

Append reminders at the end of the assembled prompt. Do not prepend to the system prompt or rewrite the transcript prefix. For §3.14, appending to the existing opening user row means the user text and all cached history stay byte-for-byte unchanged before the suffix. For §3.21–§3.23, adding a final user row likewise preserves the prefix. This matters for the incident's cachedTokens=82816 of promptTokens=84530.

### 6.3 Dry-run behavior

In dry-run, L1 computes the same family, body, position, and fingerprint, but does not append it. It records wouldInject=true, threshold values, and a body hash. It must never alter the upstream request or delivery ledger. This is the first rollout mode.

## 7. L2 — post-generation same-request remediation

L2 is the key patch for the incident and is a bounded gateway-side analogue of §3.27 across chat-completions, responses, and anthropic. It is **terminal-only**: the first response is not buffered. The host receives every converted text, reasoning, and tool-call delta as soon as it is available. Only the small terminal event or events carrying finish_reason are held long enough to make a local decision. L2 is a second model run, not response post-processing, and it never fabricates a delivery call or a finish reason.

### 7.1 Terminal decision and eligibility

At the host boundary, the incremental reverse adapter supplies normalized chat-completions events. The classifier keeps only bounded counters, IDs, event sequence numbers, and the current-response finish/tool-call facts needed below. Delivery and tool observations may still be recorded for the ledger and later L3, but no delivery-versus-execution chronology is used for the L2 decision. It does not retain the response body.

L2 can start only when all of these facts hold at the instant the terminal event is held:

1. The request passed the authenticated person-opened permission gate in §5.3, L2 is enabled, the client sink is still usable, and the per-conversation/epoch lease is available.
2. The terminal event set is complete and every relevant choice ends with finish_reason="stop". A terminal finish_reason="tool_calls" is not eligible; release it immediately.
3. The current upstream response/stream contains no assistant tool call anywhere, whether delivery or non-delivery. This is the silent-close test: if any tool call appears in this response, release the terminal immediately without a second request. Earlier tool calls in the same host turn do not change this current-response test.
4. Earlier delivery calls, delivery-observed events, and their relative order with tools are not eligibility predicates. In particular, an opening SendToUser acknowledgement before later tool work does not suppress remediation, and a prior delivery does not count as this response's result. The L2 silent-stop gate does not require deliveryOwed; delivery ledger facts remain available for official accounting and L3.
5. This trusted turn/epoch has not already consumed the one L2 attempt, the deadline and token/cost budgets leave room for it, and the canonical context can be reconstructed from existing structured host/adapter state without retaining a private full-response copy.

The resulting trigger is a single response-level predicate: authenticated person-opened permission plus a complete finish_reason="stop" plus zero tool calls in the current response. Once it passes, L2 attempts one bounded second run, subject only to the existing lease, budget, timeout, and one-attempt guardrails. No earlier delivery-call history, including whether an opening acknowledgement preceded later tools, can turn this eligible silent stop into a skip.

### 7.2 Algorithm

~~~text
permission = personOpenedPermission(authenticatedContext)
base = canonical messages after L1/L3, before provider conversion
first = upstream(providerPayload(base, apiType))

for each event from the incremental reverse adapter:
    observe finish and current-response assistant tool calls
    record trusted delivery/tool host events for the ledger and L3 only
    if event carries finish_reason:
        heldTerminal.append(event)       # host-boundary event only
        continue
    if event is the protocol terminator after a held terminal (for example [DONE]):
        heldTerminal.append(event)       # framing tail, not response content
        continue
    write event to host immediately   # text, reasoning, and tool-call deltas

if first upstream/parser/process failure:
    releaseHeldTerminalOrPropagateOriginalError()
    return

silentStop = terminalSetComplete
    and every relevant finish_reason == "stop"
    and currentResponse.assistantToolCalls.length == 0

if !permission or !silentStop or mode != enforce:
    releaseHeldTerminal(reason)
    return

if l2AdditionalRuns >= 1:
    mark unresolved/finalNoTool for this trusted epoch
    releaseHeldTerminal("l2-attempt-exhausted")
    return

acquire the L2 lease and run local budget/deadline checks
if any check fails:
    releaseHeldTerminal(budget_or_lease_reason)
    return

secondBase = reconstruct canonical context from the existing host/adapter state
secondMessages = secondBase
    + [{ role: "user", content: "[SAND_HIDDEN_PROMPT]" + exact §3.27 body }]
second = upstream(providerPayload(secondMessages, apiType, bounded L2 parameters))

for each non-terminal event from second:
    write event to host immediately
if second completes with a valid terminal:
    release second terminal and its framing tail
    discard the first held terminal (it was intentionally superseded)
    return

# every second-run failure path
discard any second held terminal/framing bytes
releaseHeldTerminal(original_first_terminal_reason)
return
~~~

The second request uses the complete canonical conversation already available to the host/adapter, then appends one new tail user message whose content is exactly [SAND_HIDDEN_PROMPT] immediately followed by the official §3.27 body, with no inserted newline. Existing paired tool results remain paired and ordered. If a tool call or its result cannot be reconstructed safely, the gateway releases the original terminal and skips L2; it never invents a tool call, tool result, ID, or delivery count. The first response's text has already been sent to and recorded by the host. Do not try to recall, retract, or delete it.

When the second run succeeds, its non-terminal events continue the same host response after the first response's already visible content. The host therefore sees one continuous legal response: first text/reasoning and any earlier real tool events, followed by the second run's events (including a real delivery tool call when the model makes one), and finally the second run's terminal event. The first terminal event is never sent because it would close the stream early. If the second valid response still ends in a silent stop (finish_reason=stop with no tool calls), return it once, mark the epoch unresolved/finalNoTool, and do not start a third run or forge delivery. Any second response with tool calls is forwarded as real model output, but the one-attempt cap still forbids another remediation run.

### 7.3 Terminal hold, streaming, and protocol unification

The host-boundary terminal hold is an event hold, not a response capture:

- For SSE, the existing Responses/Anthropic/chat-completions conversion logic runs incrementally. Every converted delta is written to the host immediately. Hold only the finish-bearing chunk or chunks and the mandatory [DONE] framing that would otherwise close the host stream; these bytes are tiny and are accounted for as heldTerminalBytes. Do not buffer provider SSE, converted SSE, text, reasoning, or tool-call deltas. If the current converter API accepts raw SSE text, provide its existing mapping through a streaming parser/state wrapper rather than collecting raw text.
- For JSON, the existing protocol adapter necessarily parses one complete JSON object because JSON has no delta framing. That normal protocol parse is not an L2 response capture. Classify its normalized host object and serialize one legal host response; never send two concatenated JSON documents. JSON and SSE still share the same normalized finish/tool-call predicates and the same second-context construction. JSON has no streaming first-byte promise, while the streaming path must preserve first-byte timing.
- The terminal hold is created after conversion to the host chat-completions shape. Provider-specific finish names are normalized by the existing reverse adapters. No provider-original bytes are used as a host fallback, and no new protocol-specific converter is introduced.
- If the first terminal cannot be parsed or converted, release the raw/converted terminal bytes immediately, mark classification failure, and disable L2 for that request. A parser failure must never leave an event waiting for a decision.

First-response content that already reached the host remains in the session history. This is an intentional trade-off: the model did say that content, and keeping it means a second-run failure cannot erase the only response the host has. The implementation must not attempt to reclaim it or pretend that the first text was never sent.

### 7.4 Hard timeout and failure-release invariant

The pre-retry terminal decision has a watchdog independent of the upstream retry deadline. Parsing, classification, and lease acquisition must finish within terminalDecisionTimeoutMs (default 250 ms); if that hard local limit is exceeded, release every held original terminal event immediately and skip L2. After L2 starts, its in-flight terminal hold is bounded by the separate retry timeout and the existing overall request deadline; neither timeout may leave the original event pending.

The release invariant is non-negotiable: once an original terminal event is held, every exit path must either intentionally supersede it with a completed second terminal or immediately replay the original event exactly once. The implementation must use an idempotent releaseHeldTerminal guard and a finally/abort path that proves heldTerminalBytes is zero before the handler returns. If the first upstream fails before emitting any terminal event, there is no event to replay; propagate that ordinary upstream error while proving that no hold exists. Every failure after a terminal has been held must release that original event. Cover all of these paths explicitly:

- upstream 5xx/non-2xx, network error, first-run timeout, or malformed first response;
- second-run 5xx/non-2xx, network error, timeout, malformed response, reverse-conversion error, or exhausted overall deadline;
- client disconnect or response-writer abort while the second run is pending;
- prompt-token, completion-token, or cost budget refusal;
- lease contention, configuration reload, cancellation, and any in-process exception or unexpected throw;
- terminal parser timeout, incomplete terminal set, or invalid framing.

On each failure, call releaseHeldTerminal before returning or cancelling. If the socket has already closed and the bytes cannot physically be written, the release operation still runs synchronously, records the closed-writer reason, clears the hold, and leaves no pending state; a closed transport must never turn a held terminal into an indefinitely stuck request. A fake/recording writer in tests must observe the attempted original-terminal replay. There is no “held but not released” state and no size-based branch.

If the second run has already emitted some non-terminal deltas before failing, those deltas cannot be retracted. The original held terminal is still released immediately so the host can close the response normally; log the partial-continuation failure rather than hiding or rewriting it.

### 7.5 Bounds and outcome semantics

- Default and hard maximum: maxAdditionalRuns=1. L2 can issue at most one second upstream request for an epoch/request.
- The second run uses a separate bounded timeout (default 15,000 ms), token caps, and worst-case cost reservation. It cannot extend the first request deadline.
- One in-flight L2 attempt per trusted conversation/epoch. Client close cancels the second request and invokes the original-terminal release path.
- A valid second response with a delivery call is recorded first as call-emitted; only a trusted host success event can upgrade it to delivery-observed. A valid second response without a delivery call is finalNoTool/unresolved and never causes a third run.
- A first terminal released without intervention is outcome normal-release. A first terminal held while the second run is attempted is outcome l2-triggered; a second-run failure that replays it is outcome l2-fallback-original-terminal. The original terminal is not counted as a second assistant turn.
- Hashes and counters may be computed incrementally from host-boundary bytes/events. Do not retain full prompt or response bodies solely to explain an injection.

### 7.6 Latency and blast radius

The non-functional requirement is explicit: requests whose current response contains any tool call, or whose person-opened permission gate rejects intervention, have zero extra model calls, zero whole-response buffering, and zero first-byte delay. They pay only the local millisecond-scale terminal observation and release. Non-person and other excluded turns do not enter the intervention decision.

Only trusted person-opened turns whose current response ends with finish_reason=stop and contains no tool calls can incur the extra model call and its timeout. The first text/reasoning deltas for those turns have already been delivered, so the added wait is confined to the silent-tail cohort. A prior opening SendToUser followed by later tool execution remains eligible, just like a turn with no earlier delivery call; no delivery chronology can suppress L2. This is an intentional trade-off: a model that already delivered the result and then adds a plain-text closing sentence may receive one nudge and emit one extra short confirmation. One extra message is far better than one missing reply. The affected set is approximately the silent-ending user-facing cohort (4 of 170 sample turns, about 2.4%); removing the old chronology suppression does not expand the impact surface, it only stops leaking people from that cohort.

## 8. L3 — between-turn safety net

L3 covers the case where the gateway cannot keep a same-request L2 run alive, but it is a **next-request-only** safety net. It is not a general background scheduler.

**Explicit boundary:** L3 implements only the historical-tail forms of §3.27 and §3.28. Official §3.29 ack-redrive is **out of scope** for this proposal: it is driven by a 5-second idle/boot scheduler, persisted ack obligations, and an ackToken tied to the host agent. The hop cannot own that lifecycle or mint/validate that token from an ordinary request, so L3 must not claim equivalence to §3.29. A future host event/scheduler integration would be a separate design and acceptance plan.

### 8.1 Trigger and family selection

On the next eligible host request, at the fixed canonical-message stage (after structural conversion and before provider payload conversion), inspect the historical tail for the immediately preceding **trusted** person-opened epoch:

- **Plain/stop owed tail:** the previous epoch ended with finish_reason="stop" and no delivery tool call emitted, and the trusted host ledger explicitly states deliveryOwed=true (`sentMessageCount === 0 && reacted === false`). Append one new canonical `role: "user"` message whose content is **`[SAND_HIDDEN_PROMPT]` immediately followed by** the exact §3.27 body; do not insert a newline. A missing ledger snapshot is unknown and skips L3. A tail with an emitted delivery call is not this no-call form; L3 may consider that separate historical failed-delivery shape only when every such call has an explicit `delivery-error-observed` event. This L3 rule does not relax L2's terminal-only pure-text-stop gate; L2 uses the current response's tool-call count and never uses delivery chronology.
- **Ack + silent-tools tail:** select this family only when the trusted host contract supplies the official §3.28 facts: the first assistant tool-call message had a text delivery acknowledgement, later non-delivery tools ran, every later delivery call is explicitly reported as errored, the tail ended on non-delivery tools, and `awaitingUserSelection` is false/absent and `completionReason` is not `"send_to_user_end_turn"`. Append the same canonical user message with `[SAND_HIDDEN_PROMPT]` directly concatenated to the exact §3.28 body. Any missing/ambiguous fact skips; a call-emitted signal alone is insufficient.

The selector uses normalized chat/Responses/Anthropic events, not provider-specific raw shapes. If the tail is only a memory/summary lane, botId is empty/missing, any identity flag is untrusted, the turn is hidden/routine/subagent/group, the host epoch is unavailable, or a newer real user message supersedes the old obligation, skip L3. A tail marked `finalNoTool=true` by an exhausted L2 valid-no-tool response is also ineligible: this is the final-no-tool suppression rule and prevents L3 from selecting §3.27 again for the same epoch.

### 8.2 Placement, dedupe, and bounds

- Append one new canonical `role: "user"` tail message. The hidden content is exactly `[SAND_HIDDEN_PROMPT]` + the named template body; preserve the marker spelling and do not wrap the follow-up in an invented system role or add a marker newline.
- Never append into old assistant text or tool results. Never remove an existing reminder.
- Use an exact body check plus fingerprint(trusted conversationId, botId, host epoch, family, templateVersion) to avoid duplicate injection when the host retries an identical request. Do not invent an epoch from a transcript hash; if the host does not supply a trusted epoch, skip.
- Default maxRedrivesPerEpoch=1, hard maximum 3, and default obligation TTL 300,000 ms (5 minutes). Once the cap is reached or TTL expires, mark unresolved and wait for a new trusted real-user epoch; do not nag every request forever.
- Only an explicit host `delivery-observed` event (successful send-message or react-to-message) clears the obligation and fingerprint. A gateway-visible `call-emitted` signal is not success. If the host event is absent or ambiguous, keep the state unknown and fail closed rather than redrive or claim owed/cleared.
- A new trusted real-user epoch clears the old L3 budget. It does not resurrect a `finalNoTool` tail from the prior epoch; that suppression lasts for that exact epoch/tail.
- In dry-run, record the selected family and would-be suffix only through the non-blocking observation path in §7.3; never hold a terminal, block a delta, or change first-token latency. In off mode, the next request is byte-for-byte unchanged.
## 9. Ledger implementation

### 9.1 Canonical per-request observation

**Identity trust root.** The only trusted source for identity and turn gates is an authenticated host/transport context, never visible prompt or transcript text. The implementation must provide a host-generated, request-bound HostRequestContext v1; one concrete wire shape is a signed/encrypted metadata envelope in x-openbot-host-context with a matching x-openbot-host-context-signature (an equivalent in-process typed context is acceptable). The gateway must reject client-controlled or unsigned copies of these headers/body fields. The envelope contains:

~~~text
HostRequestContext v1 {
  requestId, conversationId, botId, epochId
  hidden, requestSource, isSubagent, isSilenceAllowed, isRoutine
  chatType, isGroupMemberTurn?, groupFlag?
  auth: { keyId, signature } | inProcessHostBinding
}
~~~

conversationId, botId, and the host-supplied epochId (when the selected layer needs epoch state) are non-empty opaque identifiers. requestSource is an explicit allow-listed value such as person, subagent, memory, routine, or automation; chatType must be an explicit trusted non-group value (for example dm) to enter a person gate. chatType="group" or groupFlag=true always skips, regardless of isGroupMemberTurn; absent/unknown/ambiguous identity or group fields skip. A value parsed from messages[].content, a visible prompt, a model response, a reminder body, or a regex over any of them is data only and can never establish botId, conversationId, epoch, person status, or non-group status.

The gateway can directly observe the normalized upstream response, every converted stream event, and the assistant's emitted tool calls. It normally cannot observe the official host's successful send-message update, successful reaction, every errored delivery call, awaitingUserSelection, or completionReason. Those signals must never be inferred from plain text, a tool-call name, an HTTP 200, or a provider role: tool result.

Use a versioned, request/epoch-bound host event contract for any state that the hop cannot see itself. The transport must use the authenticated HostRequestContext v1 trust root above (or an equivalent in-process binding), never user/model content; the gateway accepts only events bound to the current request, non-empty trusted conversationId/botId, and trusted epoch. Unsigned/client-supplied event fields are unknown and fail closed. The host emits only after its own operation reaches the stated phase:

~~~text
HostDeliveryEvent v1 {
  eventId, requestId, conversationId, botId, epochId, sequence, observedAt
  kind: "delivery-observed" | "delivery-error-observed" | "tool-execution-observed" | "turn-state"
  toolCallId, toolName, deliveryType?
  sentMessageCount?, reacted?, awaitingUserSelection?, completionReason?
}
~~~

- delivery-observed is a host-confirmed successful send-message or react-to-message update. Its required observedAt is the host operation-completion timestamp and is copied into deliveryObservedAt; gateway receipt time is diagnostic only and cannot replace it. The event, or an explicit corresponding field in a trusted turn-state snapshot, may set sentMessageCount/reacted to a known value; a ReactToMessage success sets reacted=true, while SendToUser/SendMessage success updates the count according to the official accounting. Fields not supplied by either trusted event form remain unknown.
- delivery-error-observed is an explicit host error tied to a particular emitted delivery call. A missing error event does not mean the call failed.
- tool-execution-observed is an explicit host confirmation that a tool call ran. A paired canonical role: tool result may supply the same fact when the existing host transcript contract defines it as execution; a provider tool-call request alone is not execution.
- turn-state may carry a host snapshot of sentMessageCount, reacted, awaitingUserSelection, and completionReason, but each field is independently optional and unknown when absent. The event must be authenticated/paired with the request and trusted epoch; user-supplied metadata is not sufficient.
- The gateway itself records call-emitted whenever normalized assistant tool_calls contains SendToUser, SendMessage, or ReactToMessage. call-emitted means only that the model asked for the call; it is distinct from delivery-observed and never proves host execution or success.

If the host cannot provide this contract, the unavailable fields remain unknown and any predicate that needs them fails closed. In particular, do not assert owedAtStart, owedAtEnd, delivered-tool, or a successful delivery from gateway-visible calls alone.

Normalize each provider response into a small internal observation before applying the policy. This can be shared by JSON and SSE paths and by chat-completions, Responses, and Anthropic adapters:

~~~text
TurnObservation {
  finishReasons: string[]
  terminalEvents: [{ sequence, finishReason, bytes }]
  assistantToolCalls: [{ name, id, args, choiceIndex, sequence }]  # current upstream response
  currentResponseToolCallCount: number
  deliveryCallsEmitted: [{ name, id, args, choiceIndex, sequence }]
  deliveryObserved: [{ name, id, eventId, deliveryType? }]
  deliveryErrorsObserved: [{ name, id, eventId }]
  toolExecutionsObserved: [{ name, id, sequence, eventId? }]
  textDeliveryCallsEmitted: number
  nonDeliveryToolCalls: number
  sentMessageCount: number | "unknown"
  reacted: boolean | "unknown"
  awaitingUserSelection: boolean | "unknown"
  completionReason: string | "unknown"
  firstByteForwardedAt?: number
  firstContentAt?: number
  terminalHoldState: "none" | "held" | "released" | "superseded" | "replayed"
  heldTerminalBytes: number
  parserComplete: boolean
}
~~~

Tool names are compared against the canonical set {SendToUser, SendMessage, ReactToMessage} after provider normalization. deliveryCallsEmitted is a call-presence ledger; deliveryObserved is a separate host-confirmed-success ledger. Tool-call presence alone is not a successful delivery, and a provider tool result/error is not promoted to a host success/error event unless the trusted contract says so. A successful SendToUser/SendMessage widget, card, or attachment still increments sentMessageCount; it is excluded from the text-ack counter when args.type !== "text". For §3.23, the official condition is delivery-call presence, so use textDeliveryCallsEmitted/call presence rather than requiring deliveryObserved.

For a host transcript, walk assistant tool_calls and their paired role: "tool" results to reconstruct the conversation, but do not label a delivery as observed without the host event. For a live stream, consume every converted delta and terminal event. Assign a monotonic sequence at the host boundary for event ordering, deduplication, and call/result correlation; no sequence comparison decides L2 eligibility. Never count a string SendToUser in assistant content, a reminder body, or a tool description as a call.

### 9.2 Turn and epoch boundary

Key state only by the authenticated host/transport conversationId + non-empty botId + host-supplied epoch id. There is no local fallback epoch and no prompt/transcript-regex fallback for any of these values. A trusted host user-message id may serve as the epoch boundary only when the contract explicitly defines it that way; a locally generated transcript hash is a deduplication fingerprint, never an epoch. Define and reuse the epoch as follows:

1. An explicit trusted host turn/epoch id, or a host user-message id explicitly designated as an epoch boundary, creates the new epoch.
2. If the request has a real user message but no trusted epoch id, the gateway may recognize that a boundary is ambiguous, but it must not assign an epoch; skip L1/L2/L3 rather than create one from content.
3. A repeated request containing the same trusted epoch and real-user tail with only additional assistant/tool rows is the same epoch.
4. A hidden marker, exact policy body, memory/summary row, botId-empty routine row, visible-prompt regex match, or model-generated identity string never creates a person-opened epoch. Missing/ambiguous identity or group fields also never do so.
5. On process restart, rebuild state only from a trusted epoch/event in the transcript tail; do not persist raw user content solely for the ledger. If no safe trusted boundary can be proven, skip L1/L2/L3.

Maintain a bounded in-memory state/lease map keyed by the trusted conversation, bot, and epoch with counts, host-event sequence, silent-streak id, fingerprints, terminal release state, finalNoTool flag, L2/L3 budgets, and last-seen timestamp. Rehydrate only from trusted host state; eviction must not invent an epoch or turn unknown into owed. Use an atomic per-key lease around the terminal decision and L2 so two host requests cannot both send a remediation run. The state map stores event references/counters needed to reconstruct a safe canonical tail; it is not a raw response copy.

### 9.3 Alignment with isDeliveryOwed

At every policy decision, preserve the official predicate but evaluate it only when both inputs are known:

~~~text
ledger.isDeliveryOwed =
  (ledger.sentMessageCount !== unknown && ledger.reacted !== unknown)
    ? ledger.sentMessageCount === 0 && ledger.reacted === false
    : unknown  # fail closed; do not treat unknown as 0/false
~~~

Only a trusted delivery-observed event may clear an obligation. A call-emitted delivery call, a 200 response, or a plain assistant answer does not. ReactToMessage remains in the owed-clearing set exactly as official, although it is not user-visible text. SendToUser and SendMessage are the user-visible delivery set. These ledger predicates, the unknown path, the response-level L2 silent-stop predicate, and the terminal-release invariant must be unit-tested independently. L2 does not consult delivery history: an earlier acknowledgement, a later delivery, or any delivery/tool ordering in the same turn never suppresses an eligible current response with finish_reason=stop and no tool calls.

## 10. Guardrails

### 10.1 No forged delivery

The gateway must never:

- Create an assistant tool_calls entry for SendToUser, SendMessage, or ReactToMessage.
- Convert leftover assistant text into a tool call.
- Set a synthetic finish_reason="tool_calls" or force finish=stop.
- Increment sentMessageCount/reacted without an explicit trusted host event; an upstream tool call is not a success event.
- Drop an upstream delivery call or alter the official reminder strings.
- Treat the first response's already streamed text as if it had not been said or reclaim it from the host session.

A nudge is only a user-role prompt asking the model to make a real call. If the model does not call a tool, the result remains unresolved and is reported as such. Suppressing the first terminal event while a second run is in progress is allowed only because the second run's terminal will close the same response; it is not a forged finish or delivery.

### 10.2 Structure and marker safety

toOpenAIMessages remains a pure role/content/tool-result conversion. It must not peel <system_reminder> or [SAND_HIDDEN_PROMPT], drop reminder-only turns, or insert a reminder. The named strategy runs at the fixed canonical-message stage after this conversion but before chatToResponses, chatToAnthropic, or any other provider payload conversion; it appends only its own explicit canonical suffix. Existing tests in src/hop/openai-messages.test.ts:94-149 continue to assert marker preservation, and implementation tests must assert that each provider adapter sees the injected role=user message before serialization.

### 10.3 Scope, idempotence, and bounded work

- Positive person-opened gating only; subagent, hidden, routine/automation, silence-allowed, and group turns skip all three layers.
- Exact-last-message and per-epoch fingerprints make repeated HTTP retries idempotent.
- L1 has one reminder per silent streak; L2 has at most one additional run by hard policy; L3 has at most three redrives by hard policy.
- Respect client disconnects, terminal-decision watchdogs, upstream deadlines, token/cost quotas, finalNoTool suppression, and a per-conversation/epoch lease.
- Hold only the host-boundary terminal event set and required stream terminator. heldTerminalBytes is expected to be tiny; there is no whole-response capture or size-based fallback.
- Once a terminal is held, every failure path invokes the idempotent original-terminal release guard before returning. Before the request handler exits, the logical hold must be empty; no exception, cancellation, or client-close path may leave a terminal pending.
- The first response is never discarded on an L2 failure. Its already forwarded content stays in the host session; the original terminal is replayed to close that same response. No gateway-created delivery call appears in the fallback.
- Do not store full prompt/response bodies merely to explain an injection. Reuse existing redaction and body-capture settings; hashes, event references, and bounded counters are sufficient.

### 10.4 Cache, latency, and cost

All prompt additions are suffixes, keeping the large prefix eligible for provider caching. The incident's 82816/84530 cached-token ratio is the baseline to monitor. L2 intentionally spends one extra model call on every trusted person-opened turn that would otherwise end in a pure-text silent stop, regardless of earlier delivery-call history. It must preflight and reserve maxAdditionalPromptTokens, maxAdditionalCompletionTokens, and maxAdditionalCostUsd; exceeding any cap releases the original held terminal before dispatch. Logs must report estimated/actual prompt and completion tokens, reserved/actual cost, wall-clock delta, firstByteForwardedAt, and cache-hit changes. The second run must never inherit an unbounded original max_tokens setting.

The normal path is a hard non-functional boundary: all ordinary productive turns stream immediately, hold only their terminal event for a local decision, make no second call, and have no first-byte delay. Only the silent-tail cohort waits for the optional second call. Dry-run is observation-only: it forwards every event, never holds the terminal, never mutates requests, and never changes first-token latency.

### 10.5 Logging and control-page visibility

Extend the hop request metadata (not provider payload) with:

~~~text
injectionMode
injectionFamilies[]          # l1.reply-first, l1.start-ack, l1.silence, l1.early-result,
                             # l2.reply-nudge, l3.reply-nudge, l3.closing-send
identityGateResult            # pass | fail; source is authenticated host/transport context
skipReason                    # stable reason enum; absent only when no gate skipped
classificationSkippedReason   # stable reason for incomplete/non-blocking classification
injectionEpoch                # trusted host epoch only; otherwise omitted/skip
injectionFingerprint
injectionWouldApply
l2SupportedProtocol           # chat-completions | responses | anthropic | unknown
l2Eligible / l2Attempted / l2Outcome / l2AdditionalRuns
l2AddedLatencyMs
l2PromptTokensEstimated / l2CompletionTokenCap
l2CostReservedUsd / l2PromptTokensActual / l2CompletionTokensActual / l2CostActualUsd
firstByteForwardedAt / firstContentAt
currentResponseToolCallCount
terminalFinishReason / terminalHoldState
heldTerminalBytes             # terminal event/framing bytes only; not response bytes
terminalDecision              # normal-release | l2-triggered | l2-fallback-original-terminal | skipped
terminalReleaseReason
terminalReleaseAt
firstResponseHash             # incremental hash of host-boundary bytes already forwarded
l2BodyHash                    # incremental hash of second host-boundary bytes, when present
deliveryCallsEmitted[]        # gateway-visible call-emitted records
deliveryObserved[]            # trusted host delivery-observed event ids
deliveryObservedAt[]          # trusted host observedAt timestamps, paired by event id
deliveryErrorsObserved[]      # trusted host delivery-error-observed event ids
ledgerSentMessageCount / ledgerReacted   # known values or unknown
ledgerOwedAtStart / ledgerOwedAtEnd       # true/false only from explicit host state; otherwise unknown
awaitingUserSelection / completionReason # only when supplied by trusted host event
finalNoTool / l2Suppressed
~~~

Only bounded names, booleans, numbers, ids, hashes, timestamps, event sequences, and explicit host event ids are logged by default. identityGateResult is the result of the host/transport metadata gate. skipReason is a stable, cardinality-bounded enum such as no_bot_id, missing_conversation_id, missing_epoch, unknown_identity, non_person, group_chat, terminal_tool_calls, response_has_tool_calls, l2_attempt_exhausted, budget_prompt, budget_completion, budget_cost, client_closed, lease_busy, or terminal_decision_timeout. classificationSkippedReason is separate and covers parser/conversion/deadline cases such as parse_error, parser_incomplete, conversion_error, and classification_deadline; it must not be collapsed into an identity skip. heldTerminalBytes is the actual host-boundary terminal event/framing byte count and should be zero after release; it is never a full response size. firstResponseHash and l2BodyHash are incremental hashes of host-boundary bytes only, never provider-original bytes, prompt text, or secrets.

The control page should show the identity result, skip/classification reason, family, terminal decision, and outcome beside the paired custom-host/hop rows. It must distinguish normal terminal release, L2 triggered/second-success, and L2 failure with original-terminal replay. call-emitted is gateway observation; delivery-observed is host-confirmed success. When openbot-logs.json body capture is disabled, these fields must still be available as metadata; no key or full prompt is exposed. ledgerOwedAtStart/ledgerOwedAtEnd, awaitingUserSelection, and completionReason must remain unknown/omitted unless the trusted host contract supplies them; never render an inferred boolean. Add counters/events for injection.would_apply, injection.applied, injection.terminal_released, injection.l2_triggered, injection.l2_fallback_original_terminal, injection.suppressed_duplicate, injection.skipped{skipReason}, injection.classification_skipped{classificationSkippedReason}, injection.budget_exceeded, injection.unresolved, delivery.call_emitted, delivery.observed (including observedAt), and delivery.unknown.

### 10.6 Gray rollout and rollback

1. Ship with configuration absent/effective off.
2. Enable dry-run for one bot or a small allow-list and inspect eligible rate, family distribution, cache impact, response-level silent-tail classification, and possible false positives. Confirm first-byte timing is unchanged.
3. Enable enforce with L2 maxAdditionalRuns=1 for the same cohort; compare normal-release, l2-triggered, and l2-fallback-original-terminal outcomes, call-emitted versus host delivery-observed rates (when the host event contract is available), unresolved rates, and added latency for the silent-tail cohort only.
4. Expand only after the integration and box acceptance checks pass, including the terminal-release invariant.
5. Roll back by setting mode to off or disabling the affected layer. The next request stops injecting; no host restart or plan rewrite is required.

## 11. Configuration

### 11.1 New opt-in file

Use a separate file so delivery policy is not accidentally coupled to routing or logging:

- File: /home/box/sand-data/openbot-injection.json.
- Optional path override: OPENBOT_INJECTION.
- The file is read and validated on every hop request, like the existing per-request plan/map/log reads.
- Missing, invalid, or unsupported configuration fails **closed** to mode: off.
- Writes should be atomic and contain no secrets. A future UI/API save kind may be added, but a direct JSON edit is sufficient for the first rollout while custom wrap is already live.

Recommended explicit enforce shape:

~~~json
{
  "mode": "enforce",
  "layers": {
    "l1": {
      "enabled": true,
      "startOfTurnAckThreshold": 1,
      "watchingSilenceThreshold": 6,
      "earlyResultThreshold": 0
    },
    "l2": {
      "enabled": true,
      "maxAdditionalRuns": 1,
      "terminalDecisionTimeoutMs": 250,
      "timeoutMs": 15000,
      "maxAdditionalPromptTokens": 131072,
      "maxAdditionalCompletionTokens": 2048,
      "maxAdditionalCostUsd": 0.10
    },
    "l3": {
      "enabled": true,
      "maxRedrivesPerEpoch": 1,
      "ttlMs": 300000
    }
  }
}
~~~

There is deliberately no response-size setting or capture-admission field. heldTerminalBytes is a runtime observation of the tiny terminal event set, not a configurable response buffer. A defensive implementation may reject an invalidly large terminal event, but it must immediately release the original bytes and disable L2 rather than wait.

Effective defaults and validation limits:

| Field | Default | Valid range / rule |
| --- | --- | --- |
| mode | off | off, dry-run, or enforce; invalid means off. |
| layers.l1/l2/l3.enabled | true when a layer object is present | Boolean; the top-level off gate still wins. |
| l1.startOfTurnAckThreshold | 1 | Integer at least 1; compares with >, matching official §3.21. |
| l1.watchingSilenceThreshold | 6 | Integer at least 1; default matches §3.22. |
| l1.earlyResultThreshold | 0 | Integer at least 0; default matches §3.23. |
| l2.maxAdditionalRuns | 1 | Integer 0..1; implementation hard cap is 1. |
| l2.terminalDecisionTimeoutMs | 250 | Integer 1..2000; hard local deadline for the terminal hold decision. |
| l2.timeoutMs | 15000 | 1000..30000; also bounded by the existing request deadline. |
| l2.maxAdditionalPromptTokens | 131072 | Integer 8192..262144; total estimated prompt tokens for the additional run, including the complete canonical context and nudge. Over limit releases the held terminal and skips L2. |
| l2.maxAdditionalCompletionTokens | 2048 | Integer 128..16384; hard cap for the additional run's max_tokens/max_completion_tokens. |
| l2.maxAdditionalCostUsd | 0.10 | Number 0..10; reserve worst-case prompt + completion cost using configured model rates; unknown rate or over limit skips L2. |
| l3.maxRedrivesPerEpoch | 1 | Integer 0..3; implementation hard cap is 3. |
| l3.ttlMs | 300000 | 60000..900000; expired obligations are marked unresolved. |

An absent file is equivalent to { "mode": "off" }. A practical rollback file is:

~~~json
{
  "mode": "off"
}
~~~

### 11.2 Relationship with existing sand-data files

- openbot-plan.json remains the compiled route/catalog/model plan (kind, hop, agents, and catalog). It is not a place for reminder bodies or ledger state; model bindings and secrets remain unchanged.
- openbot-logs.json remains LogSettings (loggingEnabled, body-capture, retention, and record limits). It controls persistence/retention, not whether injection is enabled. Injection metadata should be recorded when logging is enabled, and dry-run telemetry must be best-effort without making chat fail when logging is disabled.
- openbot-requests.jsonl and openbot-request-bodies/ remain logs, not configuration. The new metadata belongs in request rows/events and follows existing redaction/retention rules.
- openbot-mode still decides official versus custom. The strategy applies only to the custom hop; official mode (including the official tap) is untouched.
- openbot-injection.json is hot-read per request. Editing it does not wrap/unwrap the host, change the plan, start a tunnel, or require a bounce. The control page can later expose the same fields, but must not silently turn the mode on.

## 12. Test plan

No product code is changed in this documentation PR. The implementation PR must add the following tests before enabling enforce by default for any cohort.

### 12.1 Unit tests

1. **Ledger contract and predicates:** successful text SendToUser, widget SendToUser, SendMessage, ReactToMessage, explicit delivery errors, plain text, and missing host events; assert independent call-emitted, delivery-observed, delivery-error-observed, sentMessageCount, reacted, text-ack, and unknown states. isDeliveryOwed may be true/false only when the trusted host fields are known.
2. **Tool normalization and response-level silence:** canonical names and JSON/SSE/Responses/Anthropic shapes; never count a string in assistant content as a call; count tool calls in the current response independently from earlier turn history; assert any current-response tool call makes the response non-silent and skips L2, while a current-response silent stop remains eligible whether or not an earlier delivery call occurred.
3. **Identity and boundary detection:** accept only authenticated HostRequestContext/transport metadata for botId, conversationId, epoch, flags, and chatType; reject prompt/transcript regex extraction; missing or empty botId/conversationId/epoch (when required), missing/ambiguous identity, chatType="group" even when its group-member flag is unset/false, groupFlag=true, and unknown chatType all skip; cover hidden marker, injected reminder, routine/memory row, opening row that cannot be identified safely, new trusted user epoch, and same-epoch tool continuation.
4. **L1 thresholds:** >1, >6, and >0/delivery-call presence; §3.22 precedence over §3.23; one reminder per silent streak; exact-last-message short-circuit; reset on an explicit delivery event/new trusted epoch; injection is staged before every provider payload converter.
5. **Terminal event classifier:** text, reasoning, and tool-call deltas are forwarded as they arrive; only finish-bearing terminal events and required [DONE] framing enter heldTerminalBytes; terminal finish_reason=tool_calls or a terminal tool-call event releases immediately; no whole-response capture, raw SSE collection, or first-byte delay is introduced.
6. **L2 decision:** person-opened permission plus terminal finish_reason=stop plus zero tool calls in the current response; assert both required silent-stop cases—an earlier delivery call in the same turn and no earlier delivery call—always trigger one L2 attempt. Assert that a current response containing any tool call is non-silent and does not trigger; after one L2 attempt, a still-silent stop is unresolved/finalNoTool with no third run. Cover non-stop finishes, hidden/non-person, missing epoch, budgets, leases, and client state. Delivery history and its ordering with tools must never be a skip predicate.
7. **L2 context and marker:** canonical context uses existing structured transcript/event state; prior historical tool results remain paired and ordered; the final nudge content is exactly [SAND_HIDDEN_PROMPT] concatenated with the §3.27 body (no inserted newline), then the same request adapter selected for the first run converts that canonical context for each of the three protocols. No private full-response retention is allowed.
8. **L2 bounds and release:** maxAdditionalRuns hard cap of one, terminal decision watchdog, retry timeout, prompt/output token caps, cost reservation, lease contention, client close, and process exception. Assert every held original terminal is replayed exactly once when a failure occurs after the hold, including second-run 5xx, timeout, parse/conversion failure, cancellation, budget refusal, and terminal-decision timeout; assert a first-run 5xx before any terminal propagates normally with an empty hold. heldTerminalBytes is zero after every path.
9. **Cache prefix and retention:** compare the serialized prompt prefix before the injection suffix; assert no system/history prefix mutation and no stripping of official markers. Assert first response text remains in the host session after both second-run success and failure; do not attempt recovery/deletion.
10. **Dry-run and protocol behavior:** JSON and streamed dry-run cases for all three protocols forward immediately with no terminal hold, no request mutation, no second request, and no first-token latency change. An adapter without incremental classification records classificationSkippedReason for observation only.
11. **Observability:** assert identityGateResult, distinct skipReason/classificationSkippedReason values (including no_bot_id, group_chat, terminal_tool_calls, response_has_tool_calls, l2_attempt_exhausted, and budget_*), terminalDecision, terminalReleaseReason, heldTerminalBytes, firstResponseHash, l2BodyHash, currentResponseToolCallCount, event-order fields, and trusted deliveryObservedAt are present/unknown exactly as specified. Assert that no delivery-call chronology field is required for L2.

### 12.2 Integration tests with a fake upstream

#### Protocol/encoding matrix (coverage, not a capability gate)

Run every row for each apiType (chat-completions, responses, and anthropic) and each encoding (JSON and SSE). This cross-product is test coverage, not a capability distinction: all three protocols use the same canonical L2 policy after response conversion.

| First-response case | Required assertion for every protocol/encoding pair |
| --- | --- |
| Current response contains a tool call / normal tool turn | First text/reasoning/tool deltas reach the host at their original times; only the terminal event is briefly held/released, no second request is made, no whole-response capture exists, and first-byte timing is unchanged. |
| No earlier delivery call, current response pure-text stop | First deltas are already visible; only the terminal event is held; exactly one second upstream request is issued in the same host request; the canonical context ends with [SAND_HIDDEN_PROMPT] directly followed by the exact §3.27 body. |
| Earlier delivery call in the same turn, current response pure-text stop | L2 triggers exactly as in the no-earlier-delivery case. This incident-shaped counterexample must not be rejected because a delivery call happened earlier or because earlier tools ran; no delivery chronology is inspected. |
| Current response contains any tool call (delivery or non-delivery) | The response is non-silent; release the held terminal immediately, make no second request, and preserve the real tool event. Earlier delivery history is irrelevant. |
| Terminal tool call / finish_reason=tool_calls | Release the held terminal immediately, preserve the ordinary response, and make no second request. |
| Second response succeeds | Host receives one complete legal response: the first already-forwarded text followed by second-run events including any real tool calls, then the second terminal close; no first terminal leaks and no fabricated call appears. |
| Second response fails | For a failure after the first terminal is held—5xx, timeout, network, parse/conversion failure, client close, budget refusal, or in-process exception—immediately replay the original held terminal exactly once; assert no held state remains and no third request is made. A first-run 5xx before a terminal exists propagates without inventing a terminal. |
| Same turn already remedied, second response still pure-text stop | Return the second valid response once, mark unresolved/finalNoTool, and do not start a third request or select L3 for the same epoch/tail. |
| Existing conversion contract | For Responses and Anthropic JSON, assert responsesToChat/anthropicToChat; for SSE, assert incremental use of responsesSseToChat/anthropicSseToChat mapping and [DONE]; for chat-completions, consume the existing host shape directly. |
| JSON legality | Assert the host receives one legal JSON response, never two concatenated JSON documents, with the first text and any second-run tool calls represented by the existing host shape. |
| SSE continuity | Assert the first stream's non-terminal events arrive before the second stream's non-terminal events, the second terminal/[DONE] closes the single stream, and the first terminal/[DONE] is not emitted on success. |
| Budget and permission skip | For non-person/hidden/group/subagent/routine/silence, lease contention, prompt/completion/cost budget refusal, or terminal decision timeout, release the held terminal immediately, make no second request, and keep ordinary streaming behavior. An unknown delivery ledger skips only predicates that require it (for example L3), not the L2 silent-stop gate. |

### 12.3 Reverse assertions

For every test where the current upstream response contains no tool calls—including the case where an earlier same-turn response emitted a delivery call—inspect the host response JSON/SSE and assert that the gateway did not create an assistant tool_calls item named SendToUser, SendMessage, or ReactToMessage, did not change finish_reason, and did not increment or claim delivery-observed counters without an explicit host event. The literal word SendToUser may appear in a nudge's user content; that is not a tool call and must not satisfy the reverse assertion.

For every failure-path test, assert the terminal-release invariant independently from the HTTP status: the original host-boundary terminal event is attempted immediately, exactly once, and the logical held state is cleared even when the client writer rejects a physical write after disconnect.

## 13. Acceptance criteria

### 13.1 Box reproduction

1. On the Computer, confirm the target bot is 7a1ef5de-2f61-4344-b309-3b8eafea1b83, the wrap is custom, and 127.0.0.1:9280 is the OpenBot hop. Do not patch or restart the stock host manually.
2. Back up the current openbot-injection.json (if any) and enable mode: dry-run for one bot. Confirm the control page shows wouldApply on a controlled plain-text stop turn only when an authenticated HostRequestContext supplies non-empty botId, conversationId, trusted epoch, explicit person flags, and a non-group chatType; prove no visible-prompt regex is used. Confirm every streamed delta and the first byte have the same timing as mode off and that no terminal hold is visible to the host.
3. Use deterministic fixtures for each of the three protocols and both JSON/SSE encodings to reproduce the incident response (an earlier SendToUser acknowledgement and tool work in the same turn, followed by a current response with finish_reason=stop and no tool calls) with an authenticated HostRequestContext; a trusted host ledger snapshot is useful for observation but is not an L2 eligibility prerequisite. The live model smoke test is not a substitute for the deterministic fixtures.
4. Switch only this bot to mode: enforce with L2 enabled and issue one person-opened turn for each protocol/encoding pair that otherwise ends in plain text. Observe first deltas at normal times, one terminal hold, one same-request L2 attempt, and a second response continuing the same host stream with a real delivery tool call; record this as call-emitted unless the host success event contract separately confirms delivery-observed.
5. Open the control page logs and pair the custom-host/hop rows. A current response containing a tool call must show terminalDecision=normal-release, l2AdditionalRuns=0, heldTerminalBytes returning to 0, and no first-byte delay. An incident-shaped row must show injectionFamilies=[l2.reply-nudge], terminalDecision=l2-triggered, l2AdditionalRuns=1, l2Outcome=call-emitted, firstResponseHash, l2BodyHash, currentResponseToolCallCount=0, and no delivery-history skip field. If the host emits a trusted success event, the ledger may later show delivery-observed with its deliveryObservedAt; without it, owed/delivery state must remain unknown rather than an inferred transition. The host-visible transcript must contain an actual SendToUser/SendMessage tool event, not just the nudge text.
6. Repeat with the fake upstream returning plain text twice. The log must show l2AdditionalRuns=1, valid-no-tool/retryExhausted, finalNoTool suppression of L3, no third request, no fabricated tool, and an explicit unresolved-or-unknown ledger state.
7. Exercise the complete three-protocol × (JSON/SSE) matrix: current-response tool-call/non-silent turns, silent stops with and without an earlier delivery call in the same turn, same-turn second-response silent exhaustion, terminal tool-call finish, second-run success, every failure path, and over-budget fixtures. Each protocol must use the shared classifier, its existing request/response converters, and one legal host response/stream; no protocol is skipped merely because of its type.
8. Set mode: off; the next request must have no injection metadata marked as applied and must retain the current single-run behavior.

### 13.2 Quantitative pass gates

- **Normal-turn gate:** 100% of requests whose current response contains any tool call, or whose person-opened permission gate rejects intervention, forward the first non-terminal byte without waiting for full response completion, allocate no whole-response storage, make zero second upstream requests, and release the terminal after only local millisecond-scale work.
- **Silent-tail gate:** 100% of eligible trusted person-opened responses with finish_reason=stop and zero tool calls in the current response issue exactly one bounded second attempt, regardless of whether an earlier delivery call occurred in the same turn or how earlier tools were ordered; the existing budget, deadline, lease, and one-attempt bounds still apply.
- **Attempt-cap gate:** 100% of turns that have already used their one L2 attempt and then end in another silent stop make zero additional remediation calls, mark unresolved/finalNoTool, release the held terminal, and do not select L3 for the same epoch/tail.
- **Second-success gate:** for every protocol and JSON/SSE encoding, host receives one complete legal response with first text followed by second-run tool events and the second terminal close; no first terminal leaks and no fabricated delivery appears.
- **Terminal-release gate:** for every failure after a terminal is held—including second-run 5xx, timeout, network error, parser/conversion failure, client disconnect, budget refusal, lease failure, terminal-decision timeout, and process exception—the original held terminal is attempted immediately exactly once (or the closed-writer release callback is recorded), heldTerminalBytes returns to 0, and the request cannot remain stuck; a first-run error before a terminal has no replay target and must leave the hold empty.
- **No-forgery gate:** no test creates SendToUser/SendMessage/ReactToMessage, changes finish_reason, or increments delivery-observed without upstream/host evidence.
- **Protocol/encoding matrix gate:** each of chat-completions, Responses, and Anthropic in JSON and SSE normalizes through the existing converters, applies the same finish_reason=stop plus current-response-tool-call predicate, and either performs the bounded L2 attempt or follows the immediate terminal-release path. Earlier delivery-call history is not a predicate.
- **Dry-run gate:** first streamed bytes are forwarded immediately, no terminal is held, no request is mutated, no second request is made, and first-token latency is unchanged; unavailable non-blocking classification is recorded with classificationSkippedReason.
- **Identity/group gate:** missing or untrusted identity, prompt-only identity, unknown chatType, and chatType="group" with an omitted/false isGroupMemberTurn all fail closed with distinct skipReason values.
- **Quota gate:** no L2 request is dispatched when prompt tokens, completion-token cap, or worst-case reserved cost exceeds its configured limit; the corresponding budget skip reason is logged and the held terminal is released.
- **Prefix/cache check:** no mutation of the pre-suffix serialized prefix; monitor cached-token ratio against the incident baseline.
- **Session-retention check:** first response text remains in the host session on both second success and fallback; no attempted reclamation or deletion occurs.
- **§3.29 boundary:** idle/boot-only ack obligations are reported as out of scope and are never presented as L3 coverage.
- **Rollback check:** switching off takes effect on the next request without a host bounce.
- **Repository check:** npm test completes with no failures; only docs/injection-hardening-plan.md is changed by this documentation PR.

## 14. Risks and open questions

1. **Model non-compliance:** a nudge is not a guarantee. If the model continues to emit text, the gateway must report unresolved rather than forge delivery; the original first text remains safely in the session.
2. **Terminal-release correctness:** the only catastrophic failure is a held terminal that is never released. The implementation needs an idempotent release guard, independent hard watchdog, and finally/abort tests for upstream errors, second-run errors, parser failures, client close, and process exceptions. A closed socket may reject the physical write, but the release callback and state clear must still happen synchronously.
3. **Streaming latency:** incremental conversion and terminal-only holding are required to preserve first-byte timing. Any adapter that collects raw SSE or converted content violates the plan. Measure first-byte and per-delta timing against mode off; only the silent-tail cohort may wait for L2.
4. **Provider shape drift:** finish reasons, terminal chunks, and tool-call deltas differ across chat-completions, Responses, and Anthropic. Existing bidirectional converters normalize those differences before one shared classifier; retain JSON/SSE fixtures for every adapter and treat this as an adapter correctness risk, not a reason to retain the response.
5. **Intentional extra-reminder trade-off:** Every trusted person-opened current response that ends with finish_reason=stop and no tool calls triggers L2, even when an earlier same-turn response emitted a delivery call. If the model already delivered the result and then adds a plain-text closing sentence, the user may receive one extra nudge and short confirmation. This is deliberate: one extra message is far better than one missing reply. The affected set is approximately the silent-ending user-facing cohort (4 of 170 sample turns, about 2.4%); removing the chronology suppression does not expand the impact surface, it only stops leaking people. Keep tests for both earlier-delivery and no-earlier-delivery silent stops, current-response tool calls, and one-attempt unresolved behavior.
6. **Identity metadata:** the trust root is the authenticated HostRequestContext/transport envelope defined in §9.1, not a visible prompt or regex. The implementation must wire botId, conversationId, epoch, person/source flags, and chatType/group state from that root; absent, unsigned, or ambiguous metadata fails closed. The empty-bot memory record is a known false-positive risk.
7. **Epoch extraction:** validate explicit trusted host message/epoch IDs on the box. A transcript hash may be used only for deduplication inside a trusted epoch; if no trusted epoch is available, skip L1/L2/L3 rather than create one locally.
8. **Canonical-context reconstruction:** a same-request second run needs the existing structured transcript and paired tool results, but must not retain a private full-response copy. If the host/adapter cannot supply a safe complete context, release the original terminal and skip; never fabricate a result.
9. **Session transcript trade-off:** the first response body is already delivered and will remain in the host session. This is intentional and acceptable because it preserves evidence and content if the second run fails; do not attempt to reclaim it.
10. **Quota and cost:** the second run can be expensive for a long canonical context. Enforce prompt/output/cost reservations, a hard one-call cap, an independent timeout, and an overall request deadline; unknown rates fail closed.
11. **Concurrency:** confirm the existing turn lease covers the terminal decision and second run, or add a small per-conversation lease without changing host ownership. Lease contention must release the held terminal, not wait indefinitely.
12. **Official disable semantics:** decide whether a future implementation should mirror SAND_DISABLE_USER_REPLY_REMINDER=1 when that signal is available to the hop. Until then, the separate mode/layer switches are the only OpenBot controls and default off.
13. **Log/UI compatibility:** agree on request-row schema, terminal decision names, trusted host event version, and control-page facets before implementation so normal release, L2 trigger, and original-terminal replay are distinguishable without exposing bodies or breaking old rows.
14. **Operational policy:** choose the first allow-list (bot ids, model ids, or a percentage), token/cost quota defaults, and the SLO for the silent-tail additional latency/cost before enabling enforce broadly. Keep §3.29 idle/boot recovery as a separately scoped future decision.

## 15. AGENTS.md and skill revision checklist

### AGENTS.md

**No AGENTS.md wording change is required by this proposal.** The existing constraints remain correct and must be carried into the implementation PR:

- Keep “Do not map leftover assistant text onto SendToUser.”
- Keep “Do not add a SendToUser-drop or a forced finish=stop on GenericHop.”
- Keep “Do not insert a reminder” for toOpenAIMessages.
- Keep “Named opt-in strategies are a separate union.”

If implementation reviewers decide an explicit clarification helps, the only suggested one-line addition is immediately after the structural-conversion rule:

~~~text
Any delivery reminder must be implemented as a separately named, opt-in hop strategy after structural conversion; it must never synthesize a tool call or delivery result.
~~~

That sentence is optional documentation hardening, not a prerequisite for this plan. It does not relax any existing prohibition.

### skills/openbot-config

The implementation PR changes the supported sand-data surface and therefore must update skills/openbot-config/SKILL.md and skills/openbot-config/reference.md in the same change or a follow-up PR, as required by AGENTS.md:66-93:

- Document /home/box/sand-data/openbot-injection.json, OPENBOT_INJECTION, the JSON shape, defaults, validation ranges, and fail-closed behavior.
- Document the JSON-vs-/api/save rule and that this setting is hot-read per hop request; no wrap/host bounce is needed.
- Document off, dry-run, and enforce, the per-layer switches, hard attempt limits, and rollback command/edit.
- Document the do-not list: no secrets, no leftover-text mapping, no edits to openbot-plan.json for this policy, and no reminder insertion in toOpenAIMessages.
- Document log fields/events and how to use control-page logs for acceptance.

This documentation-only PR does not edit the skill because the product setting is not implemented yet. When the setting is implemented, the parent/coordinator should dispatch the repository-prescribed skill updater rather than hand-editing the skill in the product implementation task.

## 16. Implementation handoff

The follow-up implementation PR should keep the changes scoped to the custom hop/runtime and tests. A suggested order is:

1. Add config loading/validation and named literal constants, defaulting off.
2. Add the canonical ledger/classifier with JSON/SSE/provider fixtures, including host-boundary event ordering and call/result correlation.
3. Add L1 in a post-conversion policy stage, with dry-run metadata.
4. Add an incremental host-boundary reverse-adapter path for all three protocol adapters. Forward every non-terminal delta immediately; hold only finish-bearing terminal events and the required stream terminator. At the hold point, run the local person/response-level finish-and-tool-call decision and either release immediately or issue one same-request L2 call with the exact hidden suffix. Never add whole-response capture, a size-based branch, or first-byte delay.
5. On second-run success, continue the existing host stream with the second response's real events and terminal. On every second-run failure, timeout, parse/conversion error, client close, budget refusal, or in-process exception, synchronously replay the original held terminal exactly once and clear the hold. Preserve first-response content in the host session.
6. Add L3 history-tail detection only for §3.27/§3.28, using trusted host epoch/ledger events, fingerprinting, TTL, finalNoTool suppression, and per-epoch cap; leave §3.29 idle/boot ack-redrive out of scope.
7. Extend request-log metadata/control-page display without logging prompt bodies by default; distinguish normal terminal release, L2 trigger/success, and original-terminal fallback, and keep unavailable ledger fields unknown.
8. Run unit/integration tests, the complete three-protocol × (JSON/SSE) matrix, all terminal-release failure fixtures, npm test, and then the deterministic box acceptance reproduction.
9. Update skills/openbot-config in the same or follow-up PR, and leave AGENTS.md unchanged unless reviewers choose the optional clarification above.

The success condition is not “the gateway found some text that looks like an answer.” It is: normal responses remain low-latency and unbuffered; a trusted person-opened response that ends in pure-text silence gets at most one same-request opportunity; the model makes a real delivery tool call (call-emitted); where the trusted host event contract is available, the host confirms it as delivery-observed and the ledger counts it; otherwise the gateway stays unknown/unresolved. Every terminal event is released or intentionally superseded by the completed second terminal, and the control page explains which bounded opt-in layer made the second chance possible without claiming signals it cannot observe.
