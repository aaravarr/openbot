# OpenBot Injection Hardening Plan

[README.md](../README.md) · [README.zh-CN.md](../README.zh-CN.md)

> Status: proposal only. This PR adds documentation; it does not change product code, the official host, or the structural message converter.

## 1. Executive summary

OpenBot can successfully receive a POST /v1/chat/completions response and still show the user nothing: plain assistant text is inner transcript content, while only a real SendToUser (or accepted delivery tool) reaches the user. The incident in §2 is exactly that case. The bottom invariant for this plan is: **for every message sent by a user, the user ultimately receives at least one touch.** Every gate and recovery rule below exists to serve that invariant without inventing delivery.

This plan adds a named, opt-in InjectionHardeningStrategy at the OpenBot hop boundary:

- **L1 — before generation:** append the official reply-first/start-of-turn/silence/early-result reminders when the reconstructed ledger reaches the official thresholds.
- **L2 — after generation:** the key patch for this incident. The upstream response is converted into host-boundary chat-completions events incrementally. Every text, reasoning, and tool-call delta is forwarded immediately. Only terminal event(s) carrying finish_reason are held. L2 then applies three gates: (1) a trusted person-opened request permission gate; (2) a silent current response, meaning finish_reason=stop and zero tool calls in that response; and (3) the debt classifier computed from the latest real user message. No touch means §3.27; touch followed by later tool calls means §3.28; touch with no later tool call is not owed and is released without a nudge. An owed silent stop gets at most one bounded second upstream run with the selected exact official suffix. Any retry failure immediately releases the original held terminal. There is no whole-response capture or response-size admission rule; provider continuation is not used.
- **L3 — between host requests (limited):** the next eligible request reuses exactly the same latest-user-message debt classifier and §3.27/§3.28 shape selector; L2 and L3 must not maintain separate definitions. §3.29 idle/boot ack-redrive is explicitly out of scope; L3 must not claim to implement it.

The strategy is deliberately outside toOpenAIMessages. That function remains a pure structural conversion. SendToUser and SendMessage count as touches; ReactToMessage also counts as a touch under the official ledger, although it does not deliver content. The strategy records a gateway-visible delivery call as **call-emitted** and records **delivery-observed** only when a trusted host success event confirms it. With no host delivery event contract, it can only treat an initiated call as a touch for classification and must not claim successful delivery. It never maps leftover text to SendToUser, never forces finish_reason, and never claims delivery from plain text or a call alone.

### Latency and blast radius

Normal turns — a current response that contains any tool call, a request rejected by the person-opened permission gate, or a response whose debt classifier says not owed — have zero extra model calls, zero response buffering, and no first-byte delay. The terminal event is released after only local classification. The same is true for hidden, group, subagent, routine, and silence-allowed turns: the permission gate skips intervention while the ordinary stream remains unchanged.

Only a trusted person-opened turn whose current response ends with finish_reason=stop, contains no tool calls, and is classified as owed can incur a second model call. Its body has already been streamed to the host, so the extra wait is confined to that silent-tail/owed cohort and does not delay the first byte of normal turns. The verified trigger population remains the four person-facing silent-ending turns in the 170-turn sample (about 2.4%); the new debt classifier subdivides those four turns and does not expand the impact surface. The not-owed class is intentional: it prevents a redundant message after a result was already touched. A known narrow limitation remains: touch → no later tool → plain-text answer is treated as not owed even though plain text itself is not delivered; the standing system prompt, L1 pre-generation reminder, and L3 next-request safety net are the mitigations.

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
4. L2 and L3 use the same latest-real-user debt classifier and shape selector defined in §§7.1 and 9.3. With a trusted host delivery-event contract, call-emitted is not delivery-observed and an attempted-but-undelivered call remains owed; without that contract, an initiated call is the touched fallback for classification while actual delivery remains unknown. Missing/ambiguous latest-user or host epoch state skips the layer rather than inventing a boundary. L1 continues to use the official stream thresholds in §6.1 and does not acquire the L2 terminal lease.
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

### 7.1 Three gates, debt classifier, and shape selection

At the host boundary, the incremental reverse adapter supplies normalized chat-completions events. The classifier keeps only bounded counters, IDs, event sequence numbers, the current-response finish/tool-call facts, and the tail observations needed to classify debt. It does not retain the response body. The total objective is the bottom invariant: **for every real user message, the user ultimately receives at least one touch.** The following three gates are the only eligibility gates, and all of them are evaluated before an L2 retry:

1. **Request permission gate (inbound):** the request is a trusted, person-opened real-user turn (requestSource="person"). The authenticated context must identify a non-group request and must not mark it hidden, subagent, routine/automation, or silence-allowed. Missing or ambiguous identity fails closed; a failed gate means no intervention at all.
2. **Silent-close gate (outbound):** the current response has a complete terminal with finish_reason="stop" and contains no tool call anywhere in that response. Any current-response tool call means that the turn is not at this exit; do not intervene and release the held terminal immediately.
3. **Debt gate:** start at the **latest real user message** for this turn/epoch, never at an earlier user message and never by carrying delivery credit across turns. Classify its tail as follows:
   - **No touch:** no SendToUser, SendMessage, or ReactToMessage touch occurred after that user message → **owed**, shape 1.
   - **Touch then tool:** a touch occurred, but a later tool call occurred after the last touch → **owed**, shape 2.
   - **Touch with no later tool:** a touch occurred and no tool call followed the last touch → **not owed**, so release without a nudge. This is the deliberate anti-duplication branch.

A touch is a SendToUser or SendMessage delivery, and ReactToMessage also counts as a touch because the official ledger counts the user as reached; ReactToMessage does not deliver content, so any tool call after it still makes the tail owed. A tool-after-touch is a normalized tool-call event (and, where the host contract supplies it, the corresponding tool-execution event) after the latest qualifying touch. The classifier always resets at the latest real user message; an acknowledgement or result from an earlier turn is not this turn's delivery.

Official delivery semantics include “attempted but not delivered” as owed. When a trusted host event contract exists, classify from host events: delivery-observed is the successful touch, an explicit delivery-error-observed does not satisfy the touch, and call-emitted is only the gateway's observation that a call was requested (it is not delivery-observed). If the host cannot provide delivery events, the gateway has no delivery truth and can only count an initiated call as a touch for this classifier; it must still record delivery as unknown and must never claim success. This host-cooperation limitation is a separately tracked risk in §14.

L2 starts only after all three gates pass and the existing non-gate guards also pass: L2 is enabled, the client sink is usable, the per-conversation/epoch lease is available, this epoch has not consumed its one attempt, budgets and deadline leave room, and canonical context can be reconstructed safely. If the debt gate says not owed, or any gate/guard fails, release every held original terminal event immediately.

### 7.2 Algorithm

~~~text
permission = personOpenedPermission(authenticatedContext)
base = canonical messages after L1/L3, before provider conversion
first = upstream(providerPayload(base, apiType))

for each event from the incremental reverse adapter:
    observe finish and current-response assistant tool calls
    record normalized touch/tool events and trusted host delivery events
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

# The debt classifier always starts at the latest real user message.
debt = classifyDebt(latestRealUserMessage, currentEpochTail,
    trustedHostDeliveryEventsOrInitiatedCallFallback)
if debt == not-owed:
    releaseHeldTerminal("debt-cleared-touch-without-later-tool")
    return
# debt is owed only in one of two shapes: no-touch or touch-then-tool.
shape = debt.shape                         # §3.27 or §3.28
if l2AdditionalRuns >= 1:
    mark unresolved/finalNoTool for this trusted epoch
    releaseHeldTerminal("l2-attempt-exhausted")
    return

acquire the L2 lease and run local budget/deadline checks
if any check fails:
    releaseHeldTerminal(budget_or_lease_reason)
    return

secondBase = reconstruct canonical context from the existing host/adapter state
nudgeBody = shape == no-touch ? EXACT_§3.27_BODY : EXACT_§3.28_BODY
secondMessages = secondBase
    + [{ role: "user", content: "[SAND_HIDDEN_PROMPT]" + nudgeBody }]
second = upstream(providerPayload(secondMessages, apiType, bounded L2 parameters))

for each event from the incremental reverse adapter for second:
    observe second-response finish/tool calls and delivery events
    if event is terminal or required framing:
        secondHeldTerminal.append(event)
        continue
    write event to host immediately

if second-run/parser/process failure:
    discard any second held terminal/framing bytes
    releaseHeldTerminal(original_first_terminal_reason)
    return

if second completes with a valid terminal:
    if second has finish_reason="stop" and zero tool calls:
        mark unresolved/finalNoTool for this trusted epoch
    release second terminal and its framing tail
    discard the first held terminal (it was intentionally superseded)
    return

# Any unexpected second-run exit is a failure path.
discard any second held terminal/framing bytes
releaseHeldTerminal(original_first_terminal_reason)
return
~~~

The second request uses the complete canonical conversation already available to the host/adapter, then appends one new tail user message whose content is exactly [SAND_HIDDEN_PROMPT] followed immediately by either the official §3.27 body (shape 1, no touch) or the official §3.28 body (shape 2, touch followed by a tool), with no inserted newline. Existing paired tool results remain paired and ordered. If a tool call or its result cannot be reconstructed safely, the gateway releases the original terminal and skips L2; it never invents a tool call, tool result, ID, or delivery count. The first response's text has already been sent to and recorded by the host. Do not try to recall, retract, or delete it.

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

The release invariant is non-negotiable: once an original terminal event is held, every exit path must either intentionally supersede it with a completed second terminal or immediately replay the original event exactly once. **Any failure during remediation—timeout, error, client disconnect, budget refusal, or watchdog—must immediately replay the held original terminal.** The implementation must use an idempotent releaseHeldTerminal guard and a finally/abort path that proves heldTerminalBytes is zero before the handler returns. If the first upstream fails before emitting any terminal event, there is no event to replay; propagate that ordinary upstream error while proving that no hold exists. Every failure after a terminal has been held must release that original event. Cover all of these paths explicitly:

- upstream 5xx/non-2xx, network error, first-run timeout, or malformed first response;
- second-run 5xx/non-2xx, network error, timeout, malformed response, reverse-conversion error, or exhausted overall deadline;
- client disconnect or response-writer abort while the second run is pending;
- prompt-token, completion-token, or cost budget refusal;
- lease contention, configuration reload, cancellation, and any in-process exception or unexpected throw;
- terminal parser timeout, incomplete terminal set, or invalid framing.

On each failure, call releaseHeldTerminal before returning or cancelling. If the socket has already closed and the bytes cannot physically be written, the release operation still runs synchronously, records the closed-writer reason, clears the hold, and leaves no pending state; a closed transport must never turn a held terminal into an indefinitely stuck request. A fake/recording writer in tests must observe the attempted original-terminal replay. There is no “held but not released” state and no size-based branch.

If the second run has already emitted some non-terminal deltas before failing, those deltas cannot be retracted. The original held terminal is still released immediately so the host can close the response normally; log the partial-continuation failure rather than hiding or rewriting it.

### 7.5 Bounds and outcome semantics

- Default and hard maximum: maxAdditionalRuns=1. A trusted turn/epoch is remedied at most once; L2 can issue at most one second upstream request for that epoch/request.
- If that one remediation still silently stops, mark unresolved/finalNoTool and do not compensate again in the same turn or select an L3 nudge for that tail. The second run uses a separate bounded timeout (default 15,000 ms), token caps, and worst-case cost reservation; it cannot extend the first request deadline.
- One in-flight L2 attempt per trusted conversation/epoch. Client close cancels the second request and invokes the original-terminal release path.
- A valid second response with a delivery call is recorded first as call-emitted; only a trusted host success event can upgrade it to delivery-observed. A valid second response without a delivery call that still ends in finish_reason="stop" is finalNoTool/unresolved and never causes a third run or an L3 redrive for that tail. A second response containing tool calls is forwarded as real model output, but the one-attempt cap still forbids another remediation run.
- A first terminal released because a gate says no intervention is outcome normal-release. A first terminal held while an owed silent stop is attempted is outcome l2-triggered; a second-run failure that replays it is outcome l2-fallback-original-terminal. The selected shape (no-touch/§3.27 or touch-then-tool/§3.28) is part of the outcome. The original terminal is not counted as a second assistant turn.
- Hashes and counters may be computed incrementally from host-boundary bytes/events. Do not retain full prompt or response bodies solely to explain an injection.

### 7.6 Latency and blast radius

The non-functional requirement is explicit: requests whose current response contains any tool call, whose person-opened permission gate rejects intervention, or whose latest-user-message debt classifier says not owed have zero extra model calls, zero whole-response buffering, and zero first-byte delay. They pay only the local millisecond-scale terminal observation and release. Non-person and other excluded turns do not enter the intervention decision.

Only trusted person-opened turns whose current response ends with finish_reason=stop, contains no tool calls, and is owed under the latest-user-message classifier can incur the extra model call and its timeout. Shape 1 (no touch) uses §3.27; shape 2 (touch followed by a tool) uses §3.28. The first text/reasoning deltas for those turns have already been delivered, so the added wait is confined to the silent-tail/owed cohort. The verified trigger population remains the four person-facing silent-ending turns in the 170-turn sample (about 2.4%); the new classifier only subdivides those four and does not expand the impact surface. The not-owed branch is specifically what prevents a redundant message after a result was already touched. The known narrow limitation—touch, no later tool, then a plain-text answer—is recorded in §14 with its system-prompt, L1, and L3 mitigations.

## 8. L3 — between-turn safety net

L3 covers the case where the gateway cannot keep a same-request L2 run alive, but it is a **next-request-only** safety net. It is not a general background scheduler.

**Explicit boundary:** L3 implements only the historical-tail forms of §3.27 and §3.28. Official §3.29 ack-redrive is **out of scope** for this proposal: it is driven by a 5-second idle/boot scheduler, persisted ack obligations, and an ackToken tied to the host agent. The hop cannot own that lifecycle or mint/validate that token from an ordinary request, so L3 must not claim equivalence to §3.29. A future host event/scheduler integration would be a separate design and acceptance plan.

### 8.1 Trigger and family selection

On the next eligible host request, at the fixed canonical-message stage (after structural conversion and before provider payload conversion), L3 must call the **same** debt classifier and shape selector as L2. The historical tail is anchored at the **latest real user message** in the trusted outstanding epoch; delivery from an earlier user message or an earlier epoch is never carried forward. The prior tail must have passed the silent-close condition (finish_reason="stop" and zero tools in that prior response), and the new request must pass the trusted person-opened permission gate. L3 is not allowed to replace this selector with the old `sentMessageCount === 0 && reacted === false` test.

- **Shape 1 — no touch:** no SendToUser, SendMessage, or ReactToMessage touch is credited after the latest real user message. This is owed; append one new canonical `role: "user"` message whose content is **`[SAND_HIDDEN_PROMPT]` immediately followed by** the exact §3.27 body; do not insert a newline.
- **Shape 2 — touch then tool:** a touch is credited, but a later tool call occurred after the last touch. This is owed; append one new canonical user message with `[SAND_HIDDEN_PROMPT]` directly concatenated to the exact §3.28 body.
- **Not owed — touch with no later tool:** a touch is credited and no tool call followed the last touch. Do not append a nudge; this branch is required to avoid a redundant message.

The same touch semantics apply in both layers: SendToUser and SendMessage are touches; ReactToMessage also counts as a touch under the official ledger even though it carries no result content, and any later tool call still makes the tail owed. With a trusted host event contract, use delivery-observed/delivery-error-observed events (call-emitted alone is not delivery-observed); without that contract, the only available fallback is to count an initiated call as touched while recording delivery as unknown. An explicit attempted-but-undelivered event remains owed. This is a host-cooperation risk, not a reason for L3 and L2 to diverge.

The selector uses normalized chat/Responses/Anthropic events, not provider-specific raw shapes. If the tail is only a memory/summary lane, botId is empty/missing, any identity flag is untrusted, the turn is hidden/routine/subagent/group, the required host epoch/latest real-user boundary is unavailable, or a newer real user message supersedes the old obligation, skip L3. A tail marked `finalNoTool=true` after an exhausted L2 valid-no-tool response is also ineligible: this same-epoch suppression prevents L3 from selecting either §3.27 or §3.28 again.

### 8.2 Placement, dedupe, and bounds

- Append one new canonical `role: "user"` tail message. The hidden content is exactly `[SAND_HIDDEN_PROMPT]` + the named template body; preserve the marker spelling and do not wrap the follow-up in an invented system role or add a marker newline.
- Never append into old assistant text or tool results. Never remove an existing reminder.
- Use an exact body check plus fingerprint(trusted conversationId, botId, host epoch, family, templateVersion) to avoid duplicate injection when the host retries an identical request. Do not invent an epoch from a transcript hash; if the host does not supply a trusted epoch, skip.
- Default maxRedrivesPerEpoch=1, hard maximum 3, and default obligation TTL 300,000 ms (5 minutes). Once the cap is reached or TTL expires, mark unresolved and wait for a new trusted real-user epoch; do not nag every request forever.
- The L3 obligation is cleared only when the shared latest-user-message classifier says not owed (touch with no later tool) or when a trusted host delivery-observed event updates that tail. A gateway-visible `call-emitted` signal is not delivery success. An explicit delivery-error-observed event remains owed; without a host event contract, an initiated call is used as the touched fallback and delivery stays unknown. Both layers must use these exact same semantics.
- A new trusted real-user epoch resets the L3 budget and the shared latest-user-message window. It does not resurrect a `finalNoTool` tail from the prior epoch; that suppression lasts for that exact epoch/tail.
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

If the host cannot provide this contract, delivery success/failure remains unknown to the gateway. For the shared debt classifier only, the gateway can use **only** a gateway-visible initiated delivery call (call-emitted) as the touched fallback, while recording delivery as unknown; it must never claim that the call was delivered. When a trusted contract is available, delivery-observed and delivery-error-observed events take precedence and an unobserved/failed attempt remains owed. Do not assert a successful delivery, owedAtStart, or owedAtEnd from a call-emitted signal or a 200 response alone.

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
  latestRealUserMessageId: string | "unknown"
  latestRealUserMessageSequence: number | "unknown"
  touchesSinceLatestUser: [{ name, id, sequence, evidence: "delivery-observed" | "call-emitted-fallback" }]
  lastTouchSequence: number | "none" | "unknown"
  toolCallsAfterLastTouch: number | "unknown"
  touchClassification: "none" | "observed" | "initiated-fallback" | "failed" | "unknown"
  debtState: "owed" | "not-owed" | "unknown"
  debtShape: "no-touch" | "touch-then-tool" | "touch-no-tool" | "unknown"
  hostDeliveryEventMode: "available" | "unavailable"
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

Tool names are compared against the canonical set {SendToUser, SendMessage, ReactToMessage} after provider normalization. deliveryCallsEmitted is a call-presence ledger; deliveryObserved is a separate host-confirmed-success ledger. Tool-call presence alone is not a successful delivery, and a provider tool result/error is not promoted to a host success/error event unless the trusted contract says so. A successful SendToUser/SendMessage widget, card, or attachment still increments sentMessageCount; it is excluded from the text-ack counter when args.type !== "text". ReactToMessage is included in touchesSinceLatestUser for the policy classifier even though it carries no result content. For §3.23, the official condition is delivery-call presence, so use textDeliveryCallsEmitted/call presence rather than requiring deliveryObserved.

For the shared L2/L3 classifier, walk the authenticated transcript from the latest real user message only. Count each qualifying SendToUser/SendMessage/ReactToMessage touch according to host-event availability, remember lastTouchSequence, and count any normalized tool call after it as toolCallsAfterLastTouch. With a trusted host event contract, only delivery-observed counts as a successful touch and delivery-error-observed remains owed; without that contract, call-emitted is the explicit initiated-touch fallback and delivery stays unknown. Earlier user messages, opening acknowledgements from earlier epochs, plain assistant text, reminder bodies, and tool descriptions never satisfy this window. For a host transcript, walk assistant tool_calls and their paired role: "tool" results to reconstruct the conversation, but do not label a delivery as observed without the host event. For a live stream, consume every converted delta and terminal event. Assign a monotonic sequence at the host boundary for event ordering, deduplication, and call/result correlation; sequence order is used only to establish “after the last touch,” not as an independent L2 eligibility predicate. Never count a string SendToUser in assistant content as a call.

### 9.2 Turn and epoch boundary

Key state only by the authenticated host/transport conversationId + non-empty botId + host-supplied epoch id. There is no local fallback epoch and no prompt/transcript-regex fallback for any of these values. A trusted host user-message id may serve as the epoch boundary only when the contract explicitly defines it that way; a locally generated transcript hash is a deduplication fingerprint, never an epoch. The shared debt window always starts at the latest real user message in that trusted epoch and never imports a touch or result from an earlier message/epoch. Define and reuse the epoch as follows:

1. An explicit trusted host turn/epoch id, or a host user-message id explicitly designated as an epoch boundary, creates the new epoch and its latest-user-message boundary.
2. If the request has a real user message but no trusted epoch id, the gateway may recognize that a boundary is ambiguous, but it must not assign an epoch; skip L1/L2/L3 rather than create one from content.
3. A repeated request containing the same trusted epoch and latest real-user tail with only additional assistant/tool rows is the same epoch; re-run the same debt classifier over that tail.
4. A hidden marker, exact policy body, memory/summary row, botId-empty routine row, visible-prompt regex match, or model-generated identity string never creates a person-opened epoch. Missing/ambiguous identity or group fields also never do so.
5. On process restart, rebuild state only from a trusted epoch/event in the transcript tail; do not persist raw user content solely for the ledger. If no safe trusted boundary/latest real-user message can be proven, skip L1/L2/L3.

Maintain a bounded in-memory state/lease map keyed by the trusted conversation, bot, and epoch with the latest-real-user boundary, touch/tool-after-touch counters, debt shape/state, host-event sequence, silent-streak id, fingerprints, terminal release state, finalNoTool flag, L2/L3 budgets, and last-seen timestamp. Rehydrate only from trusted host state; eviction must not invent an epoch or turn unknown into owed. Use an atomic per-key lease around the terminal decision and L2 so two host requests cannot both send a remediation run. The state map stores event references/counters needed to reconstruct a safe canonical tail; it is not a raw response copy.

### 9.3 Official ledger and shared debt classifier

The official ledger predicate remains available for host accounting, but it is not the complete L2/L3 policy predicate. Evaluate it only when both official fields are known:

~~~text
ledger.isDeliveryOwed =
  (ledger.sentMessageCount !== unknown && ledger.reacted !== unknown)
    ? ledger.sentMessageCount === 0 && ledger.reacted === false
    : unknown  # accounting state only; never coerce unknown
~~~

The remediation policy uses one shared classifier in both L2 and L3. It starts at the latest real user message and uses the touch/tool chronology after that boundary:

~~~text
touch =
  hostDeliveryEventMode == "available"
    ? delivery-observed events for SendToUser | SendMessage | ReactToMessage
    : call-emitted events for those tools       # initiated-touch fallback only
lastTouch = latest qualifying touch after latestRealUserMessage
toolCallsAfterLastTouch = normalized tool calls after lastTouch

debtShape =
  no qualifying touch after latestRealUserMessage
    ? "no-touch"                         # owed; use §3.27
    : toolCallsAfterLastTouch > 0
      ? "touch-then-tool"                 # owed; use §3.28
      : "touch-no-tool"                   # not owed; release

debtState = debtShape in { "no-touch", "touch-then-tool" }
  ? "owed"
  : "not-owed"
~~~

SendToUser and SendMessage are touches; ReactToMessage is also a touch under the official ledger, even though it does not deliver result content. An explicit delivery-error-observed event means the attempted touch did not arrive and therefore remains owed. When the host event contract exists, call-emitted is never promoted to delivery-observed; when no contract exists, call-emitted is the only available touched fallback and the actual delivery remains unknown. A 200 response, plain assistant answer, or earlier-turn acknowledgement never clears this latest-user-message debt. The same classifier and shape selector must be called by L2 and L3; neither layer may substitute an independent sentMessageCount/reacted test. Unit-test the official ledger, host-event uncertainty, latest-user boundary, all three shapes, current-response silent-stop gate, and terminal-release invariant independently.

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

All prompt additions are suffixes, keeping the large prefix eligible for provider caching. The incident's 82816/84530 cached-token ratio is the baseline to monitor. L2 spends one extra model call only when all three gates pass, the current response is a silent stop, and the latest-user-message classifier says owed (shape 1 §3.27 or shape 2 §3.28). The verified trigger population remains the four person-facing silent-ending turns in the 170-turn sample (about 2.4%); the new classifier subdivides those four and does not expand the impact surface. The not-owed branch is expressly retained to avoid redundant messages. L2 must preflight and reserve maxAdditionalPromptTokens, maxAdditionalCompletionTokens, and maxAdditionalCostUsd; exceeding any cap releases the original held terminal before dispatch. Logs must report estimated/actual prompt and completion tokens, reserved/actual cost, wall-clock delta, firstByteForwardedAt, and cache-hit changes. The second run must never inherit an unbounded original max_tokens setting.

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
l2NudgeShape                  # no-touch (§3.27) | touch-then-tool (§3.28) | none
l2AddedLatencyMs
l2PromptTokensEstimated / l2CompletionTokenCap
l2CostReservedUsd / l2PromptTokensActual / l2CompletionTokensActual / l2CostActualUsd
firstByteForwardedAt / firstContentAt
currentResponseToolCallCount
latestRealUserMessageId / latestRealUserMessageSequence
lastTouchSequence / toolCallsAfterLastTouch
touchClassification          # none | observed | initiated-fallback | failed | unknown
hostDeliveryEventMode        # available | unavailable
debtState / debtShape         # owed|not-owed|unknown; no-touch|touch-then-tool|touch-no-tool|unknown
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
ledgerOwedAtStart / ledgerOwedAtEnd       # official host state only; otherwise unknown
awaitingUserSelection / completionReason # only when supplied by trusted host event
finalNoTool / l2Suppressed
~~~

Only bounded names, booleans, numbers, ids, hashes, timestamps, event sequences, and explicit host event ids are logged by default. identityGateResult is the result of the host/transport metadata gate. skipReason is a stable, cardinality-bounded enum such as no_bot_id, missing_conversation_id, missing_epoch, unknown_identity, non_person, group_chat, terminal_tool_calls, response_has_tool_calls, debt_not_owed, l2_attempt_exhausted, budget_prompt, budget_completion, budget_cost, client_closed, lease_busy, or terminal_decision_timeout. classificationSkippedReason is separate and covers parser/conversion/deadline cases such as parse_error, parser_incomplete, conversion_error, and classification_deadline; it must not be collapsed into an identity skip. heldTerminalBytes is the actual host-boundary terminal event/framing byte count and should be zero after release; it is never a full response size. firstResponseHash and l2BodyHash are incremental hashes of host-boundary bytes only, never provider-original bytes, prompt text, or secrets. debtState/debtShape and l2NudgeShape must show the shared latest-user-message result, including the no-touch/§3.27, touch-then-tool/§3.28, and touch-no-tool/not-owed branches.

The control page should show the identity result, skip/classification reason, latestRealUserMessageId, touch classification, toolCallsAfterLastTouch, debt state/shape, selected §3.27/§3.28 shape, terminal decision, and outcome beside the paired custom-host/hop rows. It must distinguish normal terminal release, L2 triggered/second-success, and L2 failure with original-terminal replay. call-emitted is gateway observation; delivery-observed is host-confirmed success; the initiated-call fallback must be visibly marked as such. When openbot-logs.json body capture is disabled, these fields must still be available as metadata; no key or full prompt is exposed. ledgerOwedAtStart/ledgerOwedAtEnd, awaitingUserSelection, and completionReason remain unknown/omitted unless the trusted host contract supplies them; never render an inferred official ledger boolean. Add counters/events for injection.would_apply, injection.applied, injection.terminal_released, injection.l2_triggered, injection.l2_fallback_original_terminal, injection.suppressed_duplicate, injection.skipped{skipReason}, injection.classification_skipped{classificationSkippedReason}, injection.budget_exceeded, injection.unresolved, delivery.call_emitted, delivery.observed (including observedAt), delivery.unknown, and delivery.host_event_unavailable.

### 10.6 Gray rollout and rollback

1. Ship with configuration absent/effective off.
2. Enable dry-run for one bot or a small allow-list and inspect eligible rate, family distribution, cache impact, response-level silent-tail classification, and possible false positives. Confirm first-byte timing is unchanged.
3. Enable enforce with L2 maxAdditionalRuns=1 for the same cohort; compare normal-release, l2-triggered, and l2-fallback-original-terminal outcomes, the §3.27 versus §3.28 shape split, call-emitted versus host delivery-observed rates (when the host event contract is available), unresolved rates, and added latency for the silent-tail/owed cohort only. Confirm that touch-no-tool/not-owed rows are not retried and that this prevents redundant messages.
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

1. **Ledger and touch contract:** cover successful text SendToUser, widget/attachment SendToUser, SendMessage, ReactToMessage, explicit delivery errors, plain text, and missing host events. Assert independent call-emitted, delivery-observed, delivery-error-observed, sentMessageCount, reacted, text-ack, touch, and unknown states. SendToUser/SendMessage/ReactToMessage are touches for this plan; ReactToMessage has no content result. When a trusted host event contract exists, an attempted-but-undelivered call remains owed; when it does not, call-emitted is the initiated-touch fallback and actual delivery remains unknown.
2. **Shared latest-user debt classifier:** from each latest real user message, assert (a) no touch + silent stop => owed/shape 1/§3.27, (b) touch → tool call + silent stop => owed/shape 2/§3.28, and (c) touch → no later tool + silent stop => not owed/no remediation. Assert that earlier-turn delivery never satisfies the new boundary and that L2 and L3 invoke the same classifier and shape selector.
3. **Tool normalization and response-level silence:** canonical names and JSON/SSE/Responses/Anthropic shapes; never count a string in assistant content as a call; count tool calls in the current response independently from earlier turn history; assert any current-response tool call makes the response non-silent, skips L2, and releases its terminal, while only a current-response finish_reason=stop with zero tools reaches the debt gate.
4. **Identity and boundary detection:** accept only authenticated HostRequestContext/transport metadata for botId, conversationId, epoch, flags, and chatType; reject prompt/transcript regex extraction; missing or empty botId/conversationId/epoch (when required), missing/ambiguous identity, chatType="group" even when its group-member flag is unset/false, groupFlag=true, and unknown chatType all skip; cover hidden marker, injected reminder, routine/memory row, opening row that cannot be identified safely, latest real-user boundary, new trusted user epoch, and same-epoch tool continuation.
5. **L1 thresholds:** >1, >6, and >0/delivery-call presence; §3.22 precedence over §3.23; one reminder per silent streak; exact-last-message short-circuit; reset on an explicit delivery event/new trusted epoch; injection is staged before every provider payload converter.
6. **Terminal event classifier:** text, reasoning, and tool-call deltas are forwarded as they arrive; only finish-bearing terminal events and required [DONE] framing enter heldTerminalBytes; terminal finish_reason=tool_calls or a terminal tool-call event releases immediately; no whole-response capture, raw SSE collection, or first-byte delay is introduced.
7. **L2 decision and exact shape:** person-opened permission plus silent-close gate plus the shared debt classifier; assert no-touch silent stops use the exact §3.27 body, touch-then-tool silent stops use the exact §3.28 body, and touch-no-tool silent stops are released without a nudge. Assert a current response containing any tool call never triggers L2, and after one attempt a still-silent stop is unresolved/finalNoTool with no third run. Cover non-stop finishes, hidden/non-person, missing epoch, budgets, leases, and client state.
8. **L2 context and marker:** canonical context uses existing structured transcript/event state; prior historical tool results remain paired and ordered; the final nudge content is exactly [SAND_HIDDEN_PROMPT] concatenated with the selected official §3.27 or §3.28 body (no inserted newline), then the same request adapter selected for the first run converts that canonical context for each of the three protocols. No private full-response retention is allowed.
9. **L2 bounds and release:** maxAdditionalRuns hard cap of one, terminal decision watchdog, retry timeout, prompt/output token caps, cost reservation, lease contention, client close, and process exception. For each of the no-touch, touch-then-tool, and touch-no-tool cases, assert every failure path replays a held original terminal exactly once when applicable, including second-run 5xx, timeout, parse/conversion failure, cancellation, budget refusal, and terminal-decision timeout; assert a first-run 5xx before any terminal propagates normally with an empty hold. heldTerminalBytes is zero after every path.
10. **Cache prefix and retention:** compare the serialized prompt prefix before the injection suffix; assert no system/history prefix mutation and no stripping of official markers. Assert first response text remains in the host session after both second-run success and failure; do not attempt recovery/deletion.
11. **Dry-run and protocol behavior:** JSON and streamed dry-run cases for all three protocols forward immediately with no terminal hold, no request mutation, no second request, and no first-token latency change. An adapter without incremental classification records classificationSkippedReason for observation only.
12. **Observability:** assert identityGateResult, distinct skipReason/classificationSkippedReason values (including no_bot_id, group_chat, terminal_tool_calls, response_has_tool_calls, debt_not_owed, l2_attempt_exhausted, and budget_*), latestRealUserMessageId, touchClassification, toolCallsAfterLastTouch, debtState/debtShape, l2NudgeShape, terminalDecision, terminalReleaseReason, heldTerminalBytes, firstResponseHash, l2BodyHash, currentResponseToolCallCount, event-order fields, call-emitted versus trusted deliveryObservedAt, and host-event availability are present/unknown exactly as specified.

### 12.2 Integration tests with a fake upstream

#### Protocol/encoding matrix (coverage, not a capability gate)

Run every row for each apiType (chat-completions, responses, and anthropic) and each encoding (JSON and SSE). This cross-product is test coverage, not a capability distinction: all three protocols use the same canonical L2 policy after response conversion.

| First-response case | Required assertion for every protocol/encoding pair |
| --- | --- |
| No touch + finish_reason=stop + zero current-response tools | This is owed, shape 1: first deltas are already visible, only the terminal is held, exactly one same-request L2 run is issued, and its canonical suffix is [SAND_HIDDEN_PROMPT] directly followed by the exact §3.27 body. |
| Touch → later tool call → finish_reason=stop + zero current-response tools | This is owed, shape 2 and the incident-shaped counterexample: exactly one L2 run is issued with [SAND_HIDDEN_PROMPT] directly followed by the exact §3.28 body. It must not be suppressed because the opening touch or earlier tools existed. |
| Touch → no later tool call → finish_reason=stop + zero current-response tools | This is not owed: no second request and no nudge; release the held terminal immediately and record the not-owed shape. This branch is required to prevent a redundant message. |
| Current response contains any tool call (delivery or non-delivery) | The response is non-silent; release the held terminal immediately, make no second request, and preserve the real tool event. Earlier delivery history is irrelevant. |
| Terminal tool call / finish_reason=tool_calls | Release the held terminal immediately, preserve the ordinary response, and make no second request. |
| Second response succeeds with a real tool call | Host receives one complete legal response: the first already-forwarded text followed by second-run events including the real tool call, then the second terminal close; no first terminal leaks and no fabricated call appears. |
| Remediation response still silently stops | After the one allowed attempt, return the second valid response once, mark unresolved/finalNoTool, make no third request, and do not select L3 for the same epoch/tail. |
| Failure during any owed shape or remediation | For every shape-1/shape-2 fixture and every failure after the first terminal is held—5xx, timeout, network, parse/conversion failure, client close, budget refusal, watchdog, or in-process exception—immediately replay the original held terminal exactly once; assert no held state remains and no third request is made. A first-run 5xx before a terminal exists propagates without inventing a terminal. |
| Existing conversion contract | For Responses and Anthropic JSON, assert responsesToChat/anthropicToChat; for SSE, assert incremental use of responsesSseToChat/anthropicSseToChat mapping and [DONE]; for chat-completions, consume the existing host shape directly. The same debt classifier and shape selector are shared by all three protocols. |
| JSON legality | Assert the host receives one legal JSON response, never two concatenated JSON documents, with first text and any second-run tool calls represented by the existing host shape. |
| SSE continuity | Assert the first stream's non-terminal events arrive before the second stream's non-terminal events, the second terminal/[DONE] closes the single stream, and the first terminal/[DONE] is not emitted on success. |
| Permission, budget, lease, or watchdog skip | For non-person/hidden/group/subagent/routine/silence, lease contention, prompt/completion/cost budget refusal, or terminal decision timeout, release the held terminal immediately, make no second request, and keep ordinary streaming behavior. The same latest-user debt state is recorded; no gate failure is converted into a forged delivery. |
| Host-event uncertainty | With a trusted host contract, call-emitted without delivery-observed (or an explicit delivery-error-observed event) remains owed; without the contract, call-emitted is the initiated-touch fallback, delivery remains unknown, and the classifier does not claim success. |

### 12.3 Reverse assertions

For every test where the current upstream response contains no tool calls—including the case where an earlier same-turn response emitted a delivery call—inspect the host response JSON/SSE and assert that the gateway did not create an assistant tool_calls item named SendToUser, SendMessage, or ReactToMessage, did not change finish_reason, and did not increment or claim delivery-observed counters without an explicit host event. For a touch-no-tool tail, also assert that no nudge request was made; for no-touch and touch-then-tool tails, assert that the selected user suffix is exactly §3.27 or §3.28 respectively. The literal word SendToUser may appear in a nudge's user content; that is not a tool call and must not satisfy the reverse assertion.

For every failure-path test, assert the terminal-release invariant independently from the HTTP status: the original host-boundary terminal event is attempted immediately, exactly once, and the logical held state is cleared even when the client writer rejects a physical write after disconnect.

## 13. Acceptance criteria

### 13.1 Box reproduction

1. On the Computer, confirm the target bot is 7a1ef5de-2f61-4344-b309-3b8eafea1b83, the wrap is custom, and 127.0.0.1:9280 is the OpenBot hop. Do not patch or restart the stock host manually.
2. Back up the current openbot-injection.json (if any) and enable mode: dry-run for one bot. Confirm the control page reports wouldApply only after the trusted person-opened permission gate and silent-close gate pass and the shared latest-user debt classifier selects shape 1 or shape 2. A touch with no later tool must report not owed/wouldApply=false. The authenticated HostRequestContext must supply non-empty botId, conversationId, trusted epoch, explicit person flags, and a non-group chatType; prove no visible-prompt regex is used. Confirm every streamed delta and the first byte have the same timing as mode off and that no terminal hold is visible to the host.
3. Use deterministic fixtures for each of the three protocols and both JSON/SSE encodings covering all three latest-user tails: no touch, touch followed by a tool call (the incident response: an earlier SendToUser acknowledgement and tool work), and touch with no later tool. Each fixture ends the current response with finish_reason=stop and zero current-response tool calls, uses an authenticated HostRequestContext, and proves that delivery from an earlier real-user message is not reused. A trusted host ledger snapshot is useful for observation but does not replace the shared classifier. The live model smoke test is not a substitute for the deterministic fixtures.
4. Switch only this bot to mode: enforce with L2 enabled and issue one person-opened turn for each protocol/encoding pair in each owed shape. For no-touch, observe the exact §3.27 suffix; for touch-then-tool, observe the exact §3.28 suffix; for touch-no-tool, observe no second call and immediate terminal release. For each owed case, first deltas arrive at normal times, one terminal is held, at most one same-request L2 attempt runs, and any second response continues the same host stream with a real delivery tool call; record it as call-emitted unless the host success event contract separately confirms delivery-observed.
5. Open the control page logs and pair the custom-host/hop rows. A current response containing a tool call must show terminalDecision=normal-release, l2AdditionalRuns=0, heldTerminalBytes returning to 0, and no first-byte delay. A no-touch row must show debtShape=no-touch, l2NudgeShape=§3.27, terminalDecision=l2-triggered, l2AdditionalRuns=1, and the exact §3.27 body. An incident-shaped touch-then-tool row must show debtShape=touch-then-tool, l2NudgeShape=§3.28, terminalDecision=l2-triggered, l2AdditionalRuns=1, and the exact §3.28 body. A touch-no-tool row must show debtShape=touch-no-tool, debtState=not-owed, l2AdditionalRuns=0, and immediate terminal release. If the host emits a trusted success event, the ledger may later show delivery-observed with its deliveryObservedAt; without it, delivery remains unknown and a call-emitted fallback must not be rendered as success. Owed rows' host-visible transcript must contain an actual SendToUser/SendMessage tool event, not just the nudge text.
6. Repeat with the fake upstream returning plain text twice. The log must show l2AdditionalRuns=1, valid-no-tool/retryExhausted, finalNoTool suppression of L3, no third request, no fabricated tool, and an explicit unresolved-or-unknown ledger state.
7. Exercise the complete three-protocol × (JSON/SSE) matrix: no-touch + silent stop (§3.27), touch → tool → silent stop (§3.28), touch → no-tool → silent stop (no remediation), any current-response tool call (no remediation and terminal release), same-turn second-response silent exhaustion, terminal tool-call finish, second-run success, every failure path for each owed shape, and over-budget fixtures. Each protocol must use the shared classifier and shape selector, its existing request/response converters, and one legal host response/stream; no protocol is skipped merely because of its type.
8. Set mode: off; the next request must have no injection metadata marked as applied and must retain the current single-run behavior.

### 13.2 Quantitative pass gates

- **Bottom-invariant gate:** for every real user message, the final host outcome must contain at least one actual touch. If the host event contract is available, require delivery-observed; without it, an initiated call is only the classifier fallback and the actual invariant remains unproven/unknown. An unresolved result is failure telemetry, not proof that the invariant was met; no plain assistant text, inferred identity, or synthetic tool call may be counted as a touch.
- **Normal-turn gate:** 100% of requests whose current response contains any tool call, whose person-opened permission gate rejects intervention, or whose latest-user-message classifier says touch-no-tool/not owed, forward the first non-terminal byte without waiting for full response completion, allocate no whole-response storage, make zero second upstream requests, and release the terminal after only local millisecond-scale work.
- **Silent-tail/debt gate:** 100% of eligible trusted person-opened responses with finish_reason=stop and zero tools in the current response issue exactly one bounded second attempt when the latest-user-message classifier says owed: no-touch selects §3.27, and touch-then-tool selects §3.28. The four person-facing silent-ending turns in the verified 170-turn sample (about 2.4%) are the complete trigger cohort; this classifier only subdivides those four and does not expand the impact surface. Touch-no-tool selects neither template and makes zero additional calls, specifically avoiding a redundant message.
- **Attempt-cap gate:** 100% of turns that have already used their one L2 attempt and then end in another silent stop make zero additional remediation calls, mark unresolved/finalNoTool, release the held terminal, and do not select L3 for the same epoch/tail.
- **Second-success gate:** for every protocol and JSON/SSE encoding, host receives one complete legal response with first text followed by second-run tool events and the second terminal close; no first terminal leaks and no fabricated delivery appears.
- **Terminal-release gate:** for every failure after a terminal is held—including second-run 5xx, timeout, network error, parser/conversion failure, client disconnect, budget refusal, lease failure, terminal-decision timeout, and process exception—the original held terminal is attempted immediately exactly once (or the closed-writer release callback is recorded), heldTerminalBytes returns to 0, and the request cannot remain stuck; a first-run error before a terminal has no replay target and must leave the hold empty.
- **No-forgery gate:** no test creates SendToUser/SendMessage/ReactToMessage, changes finish_reason, or increments delivery-observed without upstream/host evidence.
- **Protocol/encoding matrix gate:** each of chat-completions, Responses, and Anthropic in JSON and SSE normalizes through the existing converters, applies the same three gates plus latest-user debt classifier, selects §3.27/§3.28 or no remediation as appropriate, and either performs the bounded L2 attempt or follows the immediate terminal-release path. Earlier delivery-call history is never reused across the latest-user boundary.
- **Dry-run gate:** first streamed bytes are forwarded immediately, no terminal is held, no request is mutated, no second request is made, and first-token latency is unchanged; unavailable non-blocking classification is recorded with classificationSkippedReason, including whether the shared debt shape could not be resolved.
- **Identity/group gate:** missing or untrusted identity, prompt-only identity, unknown chatType, and chatType="group" with an omitted/false isGroupMemberTurn all fail closed with distinct skipReason values. The inbound permission gate is mandatory for both L2 and L3.
- **Quota gate:** no L2 request is dispatched when prompt tokens, completion-token cap, or worst-case reserved cost exceeds its configured limit; the corresponding budget skip reason is logged and the held terminal is released.
- **Prefix/cache check:** no mutation of the pre-suffix serialized prefix; monitor cached-token ratio against the incident baseline.
- **Session-retention check:** first response text remains in the host session on both second success and fallback; no attempted reclamation or deletion occurs.
- **§3.29 boundary:** idle/boot-only ack obligations are reported as out of scope and are never presented as L3 coverage.
- **Rollback check:** switching off takes effect on the next request without a host bounce.
- **Repository check:** npm test completes with no failures; only docs/injection-hardening-plan.md is changed by this documentation PR.

## 14. Risks and open questions

1. **Model non-compliance:** a nudge is not a guarantee. If the model continues to emit text, the gateway must report unresolved rather than forge delivery; the original first text remains safely in the session, and unresolved does not count as satisfying the bottom invariant.
2. **Terminal-release correctness:** the only catastrophic failure is a held terminal that is never released. The implementation needs an idempotent release guard, independent hard watchdog, and finally/abort tests for upstream errors, second-run errors, parser failures, client close, and process exceptions. A closed socket may reject the physical write, but the release callback and state clear must still happen synchronously.
3. **Streaming latency:** incremental conversion and terminal-only holding are required to preserve first-byte timing. Any adapter that collects raw SSE or converted content violates the plan. Measure first-byte and per-delta timing against mode off; only the silent-tail/owed cohort may wait for L2.
4. **Provider shape drift:** finish reasons, terminal chunks, and tool-call deltas differ across chat-completions, Responses, and Anthropic. Existing bidirectional converters normalize those differences before one shared classifier; retain JSON/SSE fixtures for every adapter and treat this as an adapter correctness risk, not a reason to retain the response.
5. **Bounded extra-reminder trade-off:** an extra model call occurs only after the trusted person-opened gate, silent-close gate, and owed debt gate all pass. The verified trigger population is the four person-facing silent-ending turns in the 170-turn sample (about 2.4%); the new classifier subdivides those four and does not expand the impact surface. The touch-no-tool/not-owed branch is deliberate and prevents a redundant message. Keep tests for both owed shapes, the not-owed shape, current-response tool calls, and one-attempt unresolved behavior.
6. **Known narrow limitation:** if the model touches the user, runs no later tool, and then writes the actual answer as plain text, the classifier treats the tail as not owed and does not nudge, even though plain text is never delivered. This is an honest limitation of the chronology rule, not permission to forge delivery. Mitigations are the standing system prompt that declares plain text never delivered, the L1 reminder before generation, and the L3 next-request safety net.
7. **Host delivery-observation gap (requires host cooperation):** official semantics treat an attempted-but-undelivered call as owed, but the gateway normally sees only call-emitted and not delivery-observed. With a trusted host event contract, classify by delivery-observed/delivery-error-observed and do not promote call-emitted; without it, the only available fallback is to count the initiated call as touched while recording actual delivery as unknown. That fallback can miss a failed delivery, so delivery.host_event_unavailable must remain a separately visible risk.
8. **Identity metadata:** the trust root is the authenticated HostRequestContext/transport envelope defined in §9.1, not a visible prompt or regex. The implementation must wire botId, conversationId, epoch, person/source flags, and chatType/group state from that root; absent, unsigned, or ambiguous metadata fails closed. The empty-bot memory record is a known false-positive risk.
9. **Epoch extraction:** validate explicit trusted host message/epoch IDs on the box. A transcript hash may be used only for deduplication inside a trusted epoch; if no trusted epoch is available, skip L1/L2/L3 rather than create one locally.
10. **Canonical-context reconstruction:** a same-request second run needs the existing structured transcript and paired tool results, but must not retain a private full-response copy. If the host/adapter cannot supply a safe complete context, release the original terminal and skip; never fabricate a result.
11. **Session transcript trade-off:** the first response body is already delivered and will remain in the host session. This is intentional and acceptable because it preserves evidence and content if the second run fails; do not attempt to reclaim it.
12. **Quota and cost:** the second run can be expensive for a long canonical context. Enforce prompt/output/cost reservations, a hard one-call cap, an independent timeout, and an overall request deadline; unknown rates fail closed.
13. **Concurrency:** confirm the existing turn lease covers the terminal decision and second run, or add a small per-conversation lease without changing host ownership. Lease contention must release the held terminal, not wait indefinitely.
14. **Official disable semantics:** decide whether a future implementation should mirror SAND_DISABLE_USER_REPLY_REMINDER=1 when that signal is available to the hop. Until then, the separate mode/layer switches are the only OpenBot controls and default off.
15. **Log/UI compatibility:** agree on request-row schema, terminal decision names, trusted host event version, debt shape fields, and control-page facets before implementation so normal release, L2 shape selection, original-terminal replay, and host-event uncertainty are distinguishable without exposing bodies or breaking old rows.
16. **Operational policy:** choose the first allow-list (bot ids, model ids, or a percentage), token/cost quota defaults, and the SLO for the silent-tail/owed additional latency/cost before enabling enforce broadly. Keep §3.29 idle/boot recovery as a separately scoped future decision.

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
2. Add one canonical latest-user debt classifier with JSON/SSE/provider fixtures, including touch semantics, trusted host delivery events, call-emitted fallback, event ordering, and call/result correlation. The classifier must return no-touch/§3.27, touch-then-tool/§3.28, or touch-no-tool/not-owed from the latest real user message and be reused unchanged by L2 and L3.
3. Add L1 in a post-conversion policy stage, with dry-run metadata and the existing official templates.
4. Add an incremental host-boundary reverse-adapter path for all three protocol adapters. Forward every non-terminal delta immediately; hold only finish-bearing terminal events and the required stream terminator. At the hold point, apply the three gates (trusted person-opened permission, finish_reason=stop plus zero current-response tools, and owed latest-user debt), select the exact §3.27 or §3.28 body, and either release immediately or issue one same-request L2 call. Never add whole-response capture, a size-based branch, or first-byte delay.
5. On second-run success, continue the existing host stream with the second response's real events and terminal. If the second response still silently stops, mark unresolved/finalNoTool and make no further attempt. On every second-run failure, timeout, parse/conversion error, client close, budget refusal, watchdog, or in-process exception, synchronously replay the original held terminal exactly once and clear the hold. Preserve first-response content in the host session.
6. Add L3 history-tail detection only for the same classifier's §3.27/§3.28 owed shapes, using trusted host epoch/ledger events, latest-user boundary, fingerprinting, TTL, finalNoTool suppression, and per-epoch cap. A touch-no-tool tail must not redrive. Leave §3.29 idle/boot ack-redrive out of scope.
7. Extend request-log metadata/control-page display without logging prompt bodies by default; expose latestRealUserMessageId, touch/tool-after-touch fields, debt shape, selected template, normal release, L2 success/fallback, unresolved, and host-event uncertainty distinctly.
8. Run unit/integration tests, the complete three-protocol × (JSON/SSE) matrix for all three timing cases and every failure path, npm test, and then the deterministic box acceptance reproduction.
9. Update skills/openbot-config in the same or follow-up PR, and leave AGENTS.md unchanged unless reviewers choose the optional clarification above.

The success condition is not “the gateway found some text that looks like an answer.” It is the bottom invariant: **for every real user message, the user ultimately receives at least one touch.** In enforce mode, a trusted person-opened silent stop with no touch gets at most one §3.27 opportunity; a touch followed by a tool gets at most one §3.28 opportunity; a touch with no later tool is released without a nudge to avoid redundancy. A real model delivery call is recorded as call-emitted, and only a trusted host delivery-observed event is delivery success; when the host contract is unavailable, the initiated-call fallback remains explicitly unknown. If the model ignores the nudge, the outcome is unresolved/finalNoTool rather than forged delivery. Every held terminal is released or intentionally superseded by a completed second terminal, all retry failures replay the original exactly once, and the control page explains the selected bounded layer without claiming signals it cannot observe.
