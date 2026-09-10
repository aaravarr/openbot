# OpenBot Injection Hardening Plan

[README.md](../README.md) · [README.zh-CN.md](../README.zh-CN.md)

> Status: proposal only. This PR adds documentation; it does not change product code, the official host, or the structural message converter.

## 1. Executive summary

OpenBot can successfully receive a POST /v1/chat/completions response and still show the user nothing: plain assistant text is inner transcript content, while only a real SendToUser (or accepted delivery tool) reaches the user. The incident in §2 is exactly that case. The official Grok Bot has detection and follow-up mechanisms, but the custom wrap/hop path did not deliver those mechanisms to the gateway.

This plan adds a named, opt-in InjectionHardeningStrategy at the OpenBot hop boundary:

- **L1 — before generation:** append the official reply-first/start-of-turn/silence/early-result reminders when the reconstructed ledger reaches the official thresholds.
- **L2 — after generation:** the key patch for this incident. When a trusted person-opened upstream run ends with `finish_reason="stop"`, the first response contains **zero assistant `tool_calls` of any kind**, and the trusted host ledger says delivery is owed, append the exact §3.27 nudge and run the upstream once more in the same host request. This plan defines no provider-continuation protocol: a first response containing even a non-delivery tool call is ineligible. Return the second response when it is valid; never manufacture a tool call.
- **L3 — between host requests (limited):** if the next request's history and a trusted host ledger prove that the preceding person-opened epoch is still owed, append a §3.27 or §3.28 nudge before sending the next upstream request. §3.29 idle/boot ack-redrive is explicitly out of scope; L3 must not claim to implement it.

The strategy is deliberately outside toOpenAIMessages. That function remains a pure structural conversion. The strategy records an upstream assistant delivery call as **call-emitted**; it records **delivery-observed** only when a trusted host success event confirms delivery. It never maps leftover text to SendToUser, never forces finish_reason, and never claims delivery from plain text or a call alone.

### Goals

1. Close the proven gap without changing the official host or its reminders.
2. Preserve prompt-cache prefixes, provider protocol conversion, and the existing raw passthrough contract.
3. Bound extra calls, latency, memory, and cost.
4. Make every decision visible in request logs and reversible with a hot configuration switch.

### Non-goals

- Rewriting assistant text as a tool call.
- Dropping or replacing SendToUser calls.
- Adding a reminder inside toOpenAIMessages.
- Modifying /home/box/sand-data/host-main.cjs.pre-openbot, the stock host, or the official executor.
- Guaranteeing delivery when the model ignores a valid nudge; the gateway must remain honest in that case.

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

## 5. Design and request pipeline

### 5.1 Boundary and naming

Introduce a conceptual named strategy (implementation can choose the final module name):

~~~text
InjectionHardeningStrategy = off | dry-run | enforce
~~~

The strategy has one fixed injection stage: the custom hop runs it **after** the host transcript is converted into canonical chat messages and **before** any provider-specific payload conversion or serialization. In particular, it must run before adapters such as `chatToResponses` or `chatToAnthropic`. A provider payload is too late: appending a canonical `role: "user"` suffix there may be ignored or become an invalid provider shape. L1 and L3 mutate canonical messages at this stage; L2 builds a second canonical context at the same stage and converts each run independently.

~~~text
host request
  -> parse/route/credentials
  -> host transcript -> canonical chat messages
       (toOpenAIMessages; structural conversion only)
  -> InjectionHardeningStrategy (L1/L2/L3; opt-in)
       (L1/L3 append canonical role=user content; L2 builds full second context)
  -> provider adapter/payload conversion
       (chatToResponses / chatToAnthropic / other provider serializers)
  -> image/tool-id/protocol finalization for that provider
  -> upstream request
~~~

The strategy may append a new model-visible canonical role: "user" suffix or append to the opening user content as specified below. It must not edit old assistant text, tool results, tool IDs, system messages, or finish reasons. It must carry a local fingerprint for every insertion; that fingerprint is never sent as an invented provider field.

### 5.2 Common policy gates

All layers require every gate below:

1. Configuration mode is enforce (or dry-run for observation only).
2. The request must carry an authenticated host/transport context with explicit hidden, requestSource, isSubagent, isSilenceAllowed, routine/automation, chatType, and group-state fields. A person-opened turn requires hidden=false, requestSource="person" (or an explicitly allow-listed equivalent), isSubagent=false, isSilenceAllowed=false, routine/automation=false, and a trusted non-group chat type/flag. `chatType="group"` or any trusted group flag is always excluded, even if `isGroupMemberTurn` is omitted or false; missing or ambiguous required values fail closed and skip rather than inferring a person turn. No value may be extracted from visible prompt/transcript text with a regex.
3. botId and conversationId are required non-empty opaque values from that same trusted host/transport context. An empty or missing botId, including the 17:45:50 memory call, is unconditionally ineligible; a prompt-derived or otherwise inferred identity may not override this. The ledger key must contain trusted conversationId + botId + host-supplied epoch when the selected layer needs epoch state.
4. For predicates that use delivery or completion state, the required host ledger fields must be explicitly observed under the contract in §9.1. Unknown is not zero/false: missing or ambiguous state fails closed and skips that layer.
5. The client response has not received headers/body bytes before a possible L2 decision.
6. A per-conversation/epoch turn lease prevents two concurrent requests from injecting the same epoch.

Every layer also honors the global and per-layer enabled switch. Turning the mode to off takes effect on the next request; it never requires a host bounce.

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

L2 is the key patch for the incident and is a **bounded gateway-side analogue** of §3.27, with a strict zero-tool-call first-response guard rather than a claim of full official equivalence. This plan deliberately defines no provider-continuation protocol: L2 never retries a first response that contains any `tool_calls`, including non-delivery calls. It is a second model run, not response post-processing.

### 7.1 Eligibility

After the first upstream response is fully classified, L2 is eligible only when all conditions hold:

1. The request passed the common person-opened gate.
2. The upstream transport response is successful and every relevant choice terminates with finish_reason="stop" (for a non-stream JSON response, the choice has that value; for SSE, the terminal chunk is buffered and classified). “Successful” here describes transport/status, not delivery.
3. The normalized first response has **zero assistant `tool_calls` in every choice/chunk**—delivery and non-delivery alike. Any tool-call entry disqualifies L2, even if it is a non-delivery call or a later event suggests it failed. No provider-continuation protocol is defined here; a future relaxation must specify who executes each first-run tool, how its result is authenticated and paired back into the second request, and how duplicate/non-idempotent side effects are prevented. Until that protocol exists, this is fail-closed.
4. The current epoch has an explicit trusted ledger state `deliveryOwed=true`, meaning `sentMessageCount === 0 && reacted === false` was observed from the host contract. Lack of a tool call alone is not proof of either counter; unknown state fails closed.
5. The provider protocol is supported for same-request L2: this plan enables L2 only for chat-completions with a host-boundary response capture; Responses and Anthropic requests skip L2 (see §7.3).
6. No L2 attempt has been used for this epoch/request, the client is still connected, the remaining retry budget is positive, and the first-run context can be reconstructed completely.

A plain response body is evidence of an owed turn, not a deliverable. Do not inspect its text and do not convert it into a tool call.

### 7.2 Algorithm

~~~text
baseMessages = canonical messages after L1/L3, before provider conversion
first = upstream(providerPayload(baseMessages))
classify first without sending bytes to host
if eligible(first) and mode == enforce:
    # eligible(first) proves the normalized first response has zero tool_calls
    firstAssistant = canonicalize the selected plain assistant output
    secondMessages = baseMessages
        + firstAssistant                         # text only; no tool_calls
        + [{ role: "user",
             content: "[SAND_HIDDEN_PROMPT]" + exact §3.27 body }]
    preflight token/cost quotas and derive a bounded provider request
    second = upstream(providerPayload(secondMessages, bounded L2 parameters))
    if second is a valid response:
        return second to host
    return first from the captured host-boundary response snapshot  # failure fallback
else:
    return first unchanged
~~~

The second request is built from a **complete canonical conversation**, not from `clone(body)` plus a reminder. It keeps the original model, tools, tool definitions, stream flag, and provider options unless an explicit L2 token/cost cap below lowers the output limit. The base context already contains the prior transcript and any paired historical tool results; the selected first response is appended exactly as a plain assistant message because the zero-tool-call gate has passed. If a tool call appears in any first-response choice/chunk during classification, return the first response unchanged, set `l2Eligible=false`, and record `skipReason=first_tool_call`—do not attempt to reconstruct or replay that run. Only after the complete context is assembled does the gateway append one new canonical `role: "user"` message whose content is the official hidden form **`[SAND_HIDDEN_PROMPT]` immediately concatenated with the exact §3.27 body**; no extra newline is inserted between marker and body. This is the `hidden: true → [SAND_HIDDEN_PROMPT] prepended` semantics from the read-only official catalog. The request must not remove earlier assistant text, invent a tool_calls array or tool result, set finish_reason, or change sentMessageCount locally. The second upstream response is the only candidate returned to the host in the success path, so the host never sees both responses as two assistant turns.

For dry-run, classify only through the non-blocking tee described in §7.3 and log the same eligible/skip result when available; never send the second request or use the enforce full-response buffer. If non-blocking classification is unavailable, record `classificationSkippedReason` and continue unchanged. For off, preserve today's single request exactly.

### 7.3 Streaming, protocol scope, and host-boundary fallback

The L2 fallback snapshot is a **host-boundary artifact**, never provider-original bytes. For an L2-supported request, capture the exact bytes that the host would receive **after** provider-response normalization/conversion and host serialization, together with the host-visible status and end-to-end headers, immediately before the first byte is written. The snapshot is `{ hostBodyBytes, status, headers }`; it must not be reconstructed by parsing and re-serializing a provider body. If an adapter cannot expose this post-conversion host boundary, L2 is unsupported for that adapter and is skipped before buffering.

This plan enables same-request L2 only for the `chat-completions` protocol. Requests using `Responses` or `Anthropic` adapters skip L2 before a response buffer is allocated, with `l2Eligible=false`, `skipReason=protocol_unsupported`, no second upstream request, and ordinary pass-through of the host contract. L1/L3 canonical-message behavior may still be evaluated independently for those protocols; this L2 restriction prevents a `chatToResponses`/`chatToAnthropic` conversion from being mistaken for a host response byte contract.

For `chat-completions` JSON, classify the normalized first response while the host-boundary serializer produces the response snapshot. For `chat-completions` SSE, the adapter must expose the **converted host-visible SSE bytes/events** to the capture layer; do not capture provider SSE and later replay it as if it were host SSE. In enforce mode, hold those host-boundary bytes until the terminal event is classified, subject to `maxBufferedResponseBytes` (default 4 MiB). If parsing, conversion, the client, or the first-run deadline prevents classification while a complete host snapshot is available, replay that snapshot with its captured status/headers and log `classificationSkippedReason`; if the client is already closed, cancel and return the existing transport error.

If the host-boundary byte ceiling is reached, this is not a recoverable buffered fallback: immediately switch to host-boundary pass-through, flush the buffered host-visible prefix, pipe the remaining **converted host-visible** bytes unchanged, set `l2Suppressed=buffer_overflow` and `skipReason=buffer_overflow` for this response/epoch, and **permanently skip L2 for it**. Never send a partial first stream and then append a second stream. The pass-through/replay response uses the first host-boundary status and end-to-end headers; preserve Content-Type and Content-Encoding, and preserve Content-Length only when the unmodified host bytes and length are known. Transfer-Encoding and other hop-by-hop framing headers are proxy-owned: remove Transfer-Encoding and the Connection/Keep-Alive/TE/Upgrade family and let the server choose framing, never sending both Content-Length and Transfer-Encoding. Do not recalculate or reuse second-response headers for a first-response fallback.

If the first `chat-completions` response is eligible, send no first-response bytes to the host and run the second upstream request. On a valid second response, forward only its host-boundary bytes with its own valid status/headers and the original stream contract. On a second-run failure, replay the captured **first host-boundary** bytes, status, and headers. This preserves the host's one-response expectation at the cost of first-token latency only for eligible chat-completions L2 candidates.

Dry-run never enters the enforce full-response buffer. It tees the host-boundary stream to the host immediately and performs only incremental, best-effort classification (bounded parser state/counters, at most 64 KiB; `bufferedBytes=0`), so it does not block, mutate the request, issue a second call, or change first-token/stream latency; its overhead is O(1) CPU per chunk and at most 64 KiB of classification state. If a provider adapter cannot expose a non-blocking normalized event stream, dry-run records `classificationSkippedReason=non_blocking_adapter`, performs no buffering, and leaves L2 observation for that adapter disabled by default. The first-response hash, when available, is computed from the host-boundary bytes rather than provider-original bytes.

### 7.4 Bounds, timeout, and failure

- Default: maxAdditionalRuns=1; hard maximum 2 regardless of configuration.
- A separate L2 retry budget defaults to 15,000 ms and cannot extend the process's existing upstream deadline. Skip the second call when less than the configured budget remains.
- Before dispatch, estimate the complete second prompt (including the first assistant output, tool results, and nudge). If it exceeds maxAdditionalPromptTokens, abandon L2 and replay the first response. Set the provider's max_tokens/max_completion_tokens to no more than maxAdditionalCompletionTokens; if the adapter cannot enforce an output cap, skip L2 rather than issue an unbounded run.
- Reserve a worst-case cost for the second run from maxAdditionalCostUsd using configured model rates and the prompt/output caps. If the rate or reservation is unavailable, fail closed; actual usage/cost is recorded after the run, and any over-quota result disables further remediation for the epoch. These token and cost limits are independent of maxAdditionalRuns.
- One in-flight L2 attempt per conversation/epoch. Client close cancels the active second request.
- A non-2xx response, timeout, network error, parse/conversion error, or exhausted deadline/quota is a remediation failure: replay the first response with its captured **host-boundary** status/headers/bytes and mark the epoch unresolved. Buffer overflow follows the immediate host-boundary pass-through rule above, suppresses L2 permanently for this response/epoch, and is not retried.
- A valid second response that still has no delivery tool call is final. Do not run a third call from L2 or select an L3 nudge for this same epoch/tail; set finalNoTool=true and retryExhausted=true. The gateway still must not forge delivery. A later real user message starts a new epoch but does not resurrect this final-no-tool obligation.
- Transport retries (existing 429/5xx policy) remain separate and are included in the total deadline. They must not multiply the L2 limit.

### 7.5 Exact body and outcome observability

The request record must distinguish l2Eligible, l2Attempted, l2Outcome (call-emitted, delivery-observed, valid-no-tool, failed-first-fallback, classification-skipped), l2AdditionalRuns, l2AddedLatencyMs, token/cost reservation and actual usage, and `l2BodyHash`. **call-emitted** means the normalized second upstream response contains a delivery tool call; it does not prove that the host invoked or delivered it. **delivery-observed** is allowed only after the trusted host event contract confirms a successful delivery, and may arrive as a later ledger update. Missing host confirmation remains unknown/fail-closed, not delivered. `l2BodyHash` is a diagnostic hash of the host-boundary body selected/returned by the L2 path (never provider-original bytes, a prompt, or a secret); it is omitted when no such body exists.

## 8. L3 — between-turn safety net

L3 covers the case where the gateway cannot keep a same-request L2 run alive, but it is a **next-request-only** safety net. It is not a general background scheduler.

**Explicit boundary:** L3 implements only the historical-tail forms of §3.27 and §3.28. Official §3.29 ack-redrive is **out of scope** for this proposal: it is driven by a 5-second idle/boot scheduler, persisted ack obligations, and an ackToken tied to the host agent. The hop cannot own that lifecycle or mint/validate that token from an ordinary request, so L3 must not claim equivalence to §3.29. A future host event/scheduler integration would be a separate design and acceptance plan.

### 8.1 Trigger and family selection

On the next eligible host request, at the fixed canonical-message stage (after structural conversion and before provider payload conversion), inspect the historical tail for the immediately preceding **trusted** person-opened epoch:

- **Plain/stop owed tail:** the previous epoch ended with finish_reason="stop" and no delivery tool call emitted, and the trusted host ledger explicitly states deliveryOwed=true (`sentMessageCount === 0 && reacted === false`). Append one new canonical `role: "user"` message whose content is **`[SAND_HIDDEN_PROMPT]` immediately followed by** the exact §3.27 body; do not insert a newline. A missing ledger snapshot is unknown and skips L3. A tail with an emitted delivery call is not this no-call form; L3 may consider that separate historical failed-delivery shape only when every such call has an explicit `delivery-error-observed` event. This L3 rule does not relax L2's zero-tool-call first-response gate.
- **Ack + silent-tools tail:** select this family only when the trusted host contract supplies the official §3.28 facts: the first assistant tool-call message had a text delivery acknowledgement, later non-delivery tools ran, every later delivery call is explicitly reported as errored, the tail ended on non-delivery tools, and `awaitingUserSelection` is false/absent and `completionReason` is not `"send_to_user_end_turn"`. Append the same canonical user message with `[SAND_HIDDEN_PROMPT]` directly concatenated to the exact §3.28 body. Any missing/ambiguous fact skips; a call-emitted signal alone is insufficient.

The selector uses normalized chat/Responses/Anthropic events, not provider-specific raw shapes. If the tail is only a memory/summary lane, botId is empty/missing, any identity flag is untrusted, the turn is hidden/routine/subagent/group, the host epoch is unavailable, or a newer real user message supersedes the old obligation, skip L3. A tail marked `finalNoTool=true` by an exhausted L2 valid-no-tool response is also ineligible: this is the final-no-tool suppression rule and prevents L3 from selecting §3.27 again for the same epoch.

### 8.2 Placement, dedupe, and bounds

- Append one new canonical `role: "user"` tail message. The hidden content is exactly `[SAND_HIDDEN_PROMPT]` + the named template body; preserve the marker spelling and do not wrap the follow-up in an invented system role or add a marker newline.
- Never append into old assistant text or tool results. Never remove an existing reminder.
- Use an exact body check plus fingerprint(trusted conversationId, botId, host epoch, family, templateVersion) to avoid duplicate injection when the host retries an identical request. Do not invent an epoch from a transcript hash; if the host does not supply a trusted epoch, skip.
- Default maxRedrivesPerEpoch=1, hard maximum 3, and default obligation TTL 300,000 ms (5 minutes). Once the cap is reached or TTL expires, mark unresolved and wait for a new trusted real-user epoch; do not nag every request forever.
- Only an explicit host `delivery-observed` event (successful send-message or react-to-message) clears the obligation and fingerprint. A gateway-visible `call-emitted` signal is not success. If the host event is absent or ambiguous, keep the state unknown and fail closed rather than redrive or claim owed/cleared.
- A new trusted real-user epoch clears the old L3 budget. It does not resurrect a `finalNoTool` tail from the prior epoch; that suppression lasts for that exact epoch/tail.
- In dry-run, record the selected family and would-be suffix only through the non-blocking observation path in §7.3; never use the enforce full SSE buffer or change first-token latency. In off mode, the next request is byte-for-byte unchanged.
## 9. Ledger implementation

### 9.1 Canonical per-request observation

**Identity trust root.** The only trusted source for identity and turn gates is an authenticated host/transport context, never visible prompt or transcript text. The implementation must provide a host-generated, request-bound `HostRequestContext v1`; one concrete wire shape is a signed/encrypted metadata envelope in `x-openbot-host-context` with a matching `x-openbot-host-context-signature` (an equivalent in-process typed context is acceptable). The gateway must reject client-controlled or unsigned copies of these headers/body fields. The envelope contains:

~~~text
HostRequestContext v1 {
  requestId, conversationId, botId, epochId
  hidden, requestSource, isSubagent, isSilenceAllowed, isRoutine
  chatType, isGroupMemberTurn?, groupFlag?
  auth: { keyId, signature } | inProcessHostBinding
}
~~~

`conversationId`, `botId`, and the host-supplied `epochId` (when the selected layer needs epoch state) are non-empty opaque identifiers. `requestSource` is an explicit allow-listed value such as `person`, `subagent`, `memory`, `routine`, or `automation`; `chatType` must be an explicit trusted non-group value (for example `dm`) to enter a person gate. `chatType="group"` or `groupFlag=true` always skips, regardless of `isGroupMemberTurn`; absent/unknown/ambiguous identity or group fields skip. A value parsed from `messages[].content`, a visible prompt, a model response, a reminder body, or a regex over any of them is data only and can never establish `botId`, `conversationId`, epoch, person status, or non-group status.

The gateway can directly observe the normalized upstream response and the assistant's emitted tool calls. It normally cannot observe the official host's successful `send-message` update, successful reaction, every errored delivery call, `awaitingUserSelection`, or `completionReason`. Those signals must never be inferred from plain text, a tool-call name, an HTTP 200, or a provider `role: tool` result.

Use a versioned, request/epoch-bound host event contract for any state that the hop cannot see itself. The transport must use the authenticated `HostRequestContext v1` trust root above (or an equivalent in-process binding), never user/model content; the gateway accepts only events bound to the current request, non-empty trusted conversationId/botId, and trusted epoch. Unsigned/client-supplied event fields are unknown and fail closed. The host emits only after its own operation reaches the stated phase:

~~~text
HostDeliveryEvent v1 {
  eventId, requestId, conversationId, botId, epochId, sequence, observedAt
  kind: "delivery-observed" | "delivery-error-observed" | "turn-state"
  toolCallId, toolName, deliveryType?
  sentMessageCount?, reacted?, awaitingUserSelection?, completionReason?
}
~~~

- `delivery-observed` is a host-confirmed successful `send-message` or `react-to-message` update. Its required `observedAt` is the host operation-completion timestamp and is copied into `deliveryObservedAt`; gateway receipt time is diagnostic only and cannot replace it. The event, or an explicit corresponding field in a trusted `turn-state` snapshot, may set `sentMessageCount`/`reacted` to a known value; a `ReactToMessage` success sets `reacted=true`, while SendToUser/SendMessage success updates the count according to the official accounting. Fields not supplied by either trusted event form remain "unknown".
- `delivery-error-observed` is an explicit host error tied to a particular emitted delivery call. A missing error event does not mean the call failed.
- `turn-state` may carry a host snapshot of `sentMessageCount`, `reacted`, `awaitingUserSelection`, and `completionReason`, but each field is independently optional and unknown when absent. The event must be authenticated/paired with the request and trusted epoch; user-supplied metadata is not sufficient.
- The gateway itself records `call-emitted` whenever normalized assistant `tool_calls` contains SendToUser, SendMessage, or ReactToMessage. `call-emitted` means only that the model asked for the call; it is distinct from `delivery-observed` and never proves host execution or success.

If the host cannot provide this contract, the unavailable fields remain `unknown` and any predicate that needs them fails closed. In particular, do not assert `owedAtStart`, `owedAtEnd`, `delivered-tool`, or a successful delivery from gateway-visible calls alone.

Normalize each provider response into a small internal observation before applying the policy. This can be shared by JSON and SSE paths and by chat-completions, Responses, and Anthropic adapters:

~~~text
TurnObservation {
  finishReasons: string[]
  assistantToolCalls: [{ name, id, args, choiceIndex }]
  deliveryCallsEmitted: [{ name, id, args, choiceIndex }]
  deliveryObserved: [{ name, id, eventId, deliveryType? }]
  deliveryErrorsObserved: [{ name, id, eventId }]
  textDeliveryCallsEmitted: number
  nonDeliveryToolCalls: number
  sentMessageCount: number | "unknown"
  reacted: boolean | "unknown"
  awaitingUserSelection: boolean | "unknown"
  completionReason: string | "unknown"
  firstContentAt?: number
  parserComplete: boolean
}
~~~

Tool names are compared against the canonical set {SendToUser, SendMessage, ReactToMessage} after provider normalization. `deliveryCallsEmitted` is a call-presence ledger; `deliveryObserved` is a separate host-confirmed-success ledger. Tool-call presence alone is not a successful delivery, and a provider tool result/error is not promoted to a host success/error event unless the trusted contract says so. A successful SendToUser/SendMessage widget, card, or attachment still increments sentMessageCount; it is excluded from the text-ack counter when args.type !== "text". For §3.23, the official condition is delivery-call presence, so use `textDeliveryCallsEmitted`/call presence rather than requiring `deliveryObserved`.

For a host transcript, walk assistant tool_calls and their paired role: "tool" results to reconstruct the conversation, but do not label a delivery as observed without the host event. For a live stream, consume every tool_calls delta and the terminal result/event. Never count a string SendToUser in assistant content, a reminder body, or a tool description as a call.

### 9.2 Turn and epoch boundary

Key state only by the authenticated host/transport `conversationId` + non-empty `botId` + host-supplied epoch id. There is no local fallback epoch and no prompt/transcript-regex fallback for any of these values. A trusted host user-message id may serve as the epoch boundary only when the contract explicitly defines it that way; a locally generated transcript hash is a deduplication fingerprint, never an epoch. Define and reuse the epoch as follows:

1. An explicit trusted host turn/epoch id, or a host user-message id explicitly designated as an epoch boundary, creates the new epoch.
2. If the request has a real user message but no trusted epoch id, the gateway may recognize that a boundary is ambiguous, but it must not assign an epoch; skip L1/L2/L3 rather than create one from content.
3. A repeated request containing the same trusted epoch and real-user tail with only additional assistant/tool rows is the same epoch.
4. A hidden marker, exact policy body, memory/summary row, botId-empty routine row, visible-prompt regex match, or model-generated identity string never creates a person-opened epoch. Missing/ambiguous identity or group fields also never do so.
5. On process restart, rebuild state only from a trusted epoch/event in the transcript tail; do not persist raw user content solely for the ledger. If no safe trusted boundary can be proven, skip L1/L2/L3.

Maintain a bounded in-memory state/lease map keyed by the trusted conversation, bot, and epoch with counts, host-event sequence, silent-streak id, fingerprints, finalNoTool flag, L2/L3 budgets, and last-seen timestamp. Rehydrate only from trusted host state; eviction must not invent an epoch or turn unknown into owed. Use an atomic per-key lease around L2 so two host requests cannot both send a remediation run.

### 9.3 Alignment with isDeliveryOwed

At every policy decision, preserve the official predicate but evaluate it only when both inputs are known:

~~~text
ledger.isDeliveryOwed =
  (ledger.sentMessageCount !== unknown && ledger.reacted !== unknown)
    ? ledger.sentMessageCount === 0 && ledger.reacted === false
    : unknown  # fail closed; do not treat unknown as 0/false
~~~

Only a trusted `delivery-observed` event may clear an obligation. A `call-emitted` delivery call, a 200 response, or a plain assistant answer does not. ReactToMessage remains in the owed-clearing set exactly as official, although it is not user-visible text. SendToUser and SendMessage are the user-visible delivery set. The start-of-turn gate separately uses text delivery **call presence**; it must not be reported as successful delivery unless the host contract confirms it. These predicates and the unknown path must be unit-tested independently.
## 10. Guardrails

### 10.1 No forged delivery

The gateway must never:

- Create an assistant tool_calls entry for SendToUser, SendMessage, or ReactToMessage.
- Convert leftover assistant text into a tool call.
- Set a synthetic finish_reason="tool_calls" or force finish=stop.
- Increment sentMessageCount/reacted without an explicit trusted host event; an upstream tool call is not a success event.
- Drop an upstream delivery call or alter the official reminder strings.

A nudge is only a user-role prompt asking the model to make a real call. If the model does not call a tool, the result remains unresolved and is reported as such.

### 10.2 Structure and marker safety

toOpenAIMessages remains a pure role/content/tool-result conversion. It must not peel <system_reminder> or [SAND_HIDDEN_PROMPT], drop reminder-only turns, or insert a reminder. The named strategy runs at the fixed canonical-message stage **after** this conversion but **before** chatToResponses, chatToAnthropic, or any other provider payload conversion; it appends only its own explicit canonical suffix. Existing tests in src/hop/openai-messages.test.ts:94-149 continue to assert marker preservation, and implementation tests must assert that each provider adapter sees the injected role=user message before serialization.

### 10.3 Scope, idempotence, and bounded work

- Positive person-opened gating only; subagent, hidden, routine/automation, silence-allowed, and group turns skip all three layers.
- Exact-last-message and per-epoch fingerprints make repeated HTTP retries idempotent.
- L1 has one reminder per silent streak; L2 has at most two additional runs by hard policy; L3 has at most three redrives by hard policy.
- Respect client disconnects, upstream deadlines, response-buffer ceilings, token/cost quotas, finalNoTool suppression, and a per-conversation/epoch lease.
- The first response is never discarded on an L2 failure; for the chat-completions path it is replayed from captured **host-boundary** body bytes with its captured host-visible status/header policy (or immediate host-boundary pass-through on buffer overflow). Protocols without that capture skip L2 before buffering.
- Do not store full prompt/response bodies merely to explain an injection. Reuse existing redaction and body-capture settings; hashes and bounded counters are sufficient.

### 10.4 Cache, latency, and cost

All additions are suffixes, keeping the large prefix eligible for provider caching. The incident's 82816/84530 cached-token ratio is the baseline to monitor. L2 intentionally spends one extra model call only on a proven owed stop response, but it must preflight and reserve maxAdditionalPromptTokens, maxAdditionalCompletionTokens, and maxAdditionalCostUsd; exceeding any cap abandons L2 before dispatch. Logs must report estimated/actual prompt and completion tokens, reserved/actual cost, wall-clock delta, and cache-hit changes. Roll out with dry-run before enforce to establish eligible rate and expected spend; a second run must never inherit an unbounded original max_tokens setting. Dry-run is observation-only: it must tee and classify without blocking, mutating requests, full-buffering SSE, or changing first-token latency; when a provider cannot support that non-blocking path, classification is skipped with a reason and the adapter remains off by default.

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
bufferedBytes                 # host-boundary bytes held; 0 for dry-run tee/pass-through
firstResponseHash             # hash of first host-boundary response bytes, never provider-original bytes
l2BodyHash                    # hash of host-boundary body selected/returned by L2
deliveryCallsEmitted[]        # gateway-visible call-emitted records
deliveryObserved[]            # trusted host delivery-observed event ids
deliveryObservedAt[]          # trusted host observedAt timestamps, paired by event id
deliveryErrorsObserved[]      # trusted host delivery-error-observed event ids
ledgerSentMessageCount / ledgerReacted   # known values or unknown
ledgerOwedAtStart / ledgerOwedAtEnd     # true/false only from explicit host state; otherwise unknown
awaitingUserSelection / completionReason # only when supplied by trusted host event
finalNoTool / l2Suppressed
~~~

Only bounded names, booleans, numbers, ids, hashes, timestamps, and explicit host event ids are logged by default. `identityGateResult` is the result of the host/transport metadata gate; `skipReason` is a stable, cardinality-bounded enum such as `no_bot_id`, `missing_conversation_id`, `missing_epoch`, `unknown_identity`, `non_person`, `group_chat`, `protocol_unsupported`, `first_tool_call`, `buffer_overflow`, `budget_prompt`, `budget_completion`, `budget_cost`, `client_closed`, or `lease_busy`. `classificationSkippedReason` is separate and covers parser/conversion/deadline cases such as `parse_error`, `parser_incomplete`, `parser_overflow`, `non_blocking_adapter`, and `classification_deadline`; it must not be collapsed into an identity skip. `bufferedBytes` is the actual host-boundary byte count held for enforce classification (zero for dry-run tee and immediate pass-through). `firstResponseHash` and `l2BodyHash` are hashes of host-boundary bytes only, never provider-original bytes, prompt text, or secrets. `deliveryObservedAt` contains the trusted host event's `observedAt` timestamp, not an inferred gateway time.

The control page should show the identity result, skip/classification reason, family, and outcome beside the paired custom-host/hop rows. `deliveryCallsEmitted`/`call-emitted` is gateway observation; `deliveryObserved`/`delivery-observed` is host-confirmed success. When openbot-logs.json body capture is disabled, these fields must still be available as metadata; no key or full prompt is exposed. `ledgerOwedAtStart`/`ledgerOwedAtEnd`, `awaitingUserSelection`, and `completionReason` must remain unknown/omitted unless the trusted host contract supplies them; never render an inferred boolean. Add counters/events for `injection.would_apply`, `injection.applied`, `injection.suppressed_duplicate`, `injection.skipped{skipReason}`, `injection.classification_skipped{classificationSkippedReason}`, `injection.buffer_overflow`, `injection.budget_exceeded`, `injection.l2_fallback`, `injection.unresolved`, `delivery.call_emitted`, `delivery.observed` (including `observedAt`), and `delivery.unknown`.

### 10.6 Gray rollout and rollback

1. Ship with configuration absent/effective off.
2. Enable dry-run for one bot or a small allow-list and inspect eligible rate, family distribution, cache impact, and possible false positives.
3. Enable enforce with L2 maxAdditionalRuns=1 for the same cohort; compare call-emitted versus host delivery-observed rates (when the host event contract is available), unknown/unresolved rates, and added latency.
4. Expand only after the integration and box acceptance checks pass.
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
      "timeoutMs": 15000,
      "maxBufferedResponseBytes": 4194304,
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

Effective defaults and validation limits:

| Field | Default | Valid range / rule |
| --- | --- | --- |
| mode | off | off, dry-run, or enforce; invalid means off. |
| layers.l1/l2/l3.enabled | true when a layer object is present | Boolean; the top-level off gate still wins. |
| l1.startOfTurnAckThreshold | 1 | Integer at least 1; compares with >, matching official §3.21. |
| l1.watchingSilenceThreshold | 6 | Integer at least 1; default matches §3.22. |
| l1.earlyResultThreshold | 0 | Integer at least 0; default matches §3.23. |
| l2.maxAdditionalRuns | 1 | Integer 0..2; implementation hard cap is 2. |
| l2.timeoutMs | 15000 | 1000..30000; also bounded by the existing request deadline. |
| l2.maxBufferedResponseBytes | 4194304 | 262144..8388608; chat-completions host-boundary bytes only; on overflow immediately pass through converted host bytes and permanently suppress L2 for that response/epoch. Responses/Anthropic skip L2 before buffering. |
| l2.maxAdditionalPromptTokens | 131072 | Integer 8192..262144; total estimated prompt tokens for the additional run, including the complete first-run context and nudge. Over limit skips L2. |
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
2. **Tool normalization:** canonical names and JSON/SSE/Responses/Anthropic shapes; never count a string in assistant content as a call, and never promote a provider tool result to delivery-observed without the host event contract.
3. **Identity and boundary detection:** accept only authenticated HostRequestContext/transport metadata for botId, conversationId, epoch, flags, and chatType; reject prompt/transcript regex extraction; missing or empty botId/conversationId/epoch (when required), missing/ambiguous identity, `chatType="group"` even when its group-member flag is unset/false, groupFlag=true, and unknown chatType all skip; cover hidden marker, injected reminder, routine/memory row, opening row that cannot be identified, new trusted user epoch, and same-epoch tool continuation.
4. **L1 thresholds:** >1, >6, and >0/delivery-call presence; §3.22 precedence over §3.23; one reminder per silent streak; exact-last-message short-circuit; reset on an explicit delivery event/new trusted epoch; injection is staged before every provider payload converter.
5. **L2 decision:** only `finish_reason=stop` plus **zero first-response `tool_calls` of any kind** plus explicit trusted deliveryOwed plus the supported chat-completions protocol is eligible. A stop response containing non-delivery `tool_calls` must assert `l2Eligible=false`, `skipReason=first_tool_call`, and no L2 dispatch; also cover non-stop, delivery calls, hidden/non-person, missing epoch, unknown ledger, unsupported Responses/Anthropic, and client bytes. No provider-continuation protocol is assumed.
6. **L2 context and marker:** plain first assistant text is present in the second canonical context, while any first-response tool call prevents a second context; prior historical tool results remain paired and ordered; the final nudge content is exactly [SAND_HIDDEN_PROMPT] concatenated with the §3.27 body (no inserted newline), then the supported adapter converts that canonical context.
7. **L2 bounds and host fallback:** zero/one/two configured additional runs, hard cap, timeout, prompt/output token caps, cost reservation, client close, host-boundary buffer overflow pass-through, first-response host-boundary fallback bytes with status/headers, valid second no-tool final, finalNoTool suppression, and no third/L3 run.
8. **L3:** §3.27 versus §3.28 tail selection only with trusted host facts, unknown/fail-closed paths, direct marker concatenation, TTL, max redrives, duplicate fingerprints keyed by trusted epoch, reset on new epoch/observed delivery, final-no-tool suppression, and explicit §3.29 out-of-scope/skip behavior.
9. **Cache prefix:** compare the serialized first request prefix before the injection suffix; assert no system/history prefix mutation and no stripping of official markers.
10. **Dry-run and protocol behavior:** a streamed dry-run tees immediately with no full SSE buffer, no request mutation, and no first-token latency change; an adapter without a non-blocking classifier records `classificationSkippedReason` and remains off by default; Responses/Anthropic JSON and SSE skip L2 without a second request or buffering.
11. **Observability:** assert identityGateResult, distinct skipReason/classificationSkippedReason values (including no_bot_id, group_chat, unknown_identity, buffer_overflow/parser_overflow, and budget_*), bufferedBytes, firstResponseHash, l2BodyHash, and trusted deliveryObservedAt are present/unknown exactly as specified.

### 12.2 Integration tests with a fake upstream

- **Chat-completions JSON success:** first response is `finish_reason="stop"`, plain assistant text, and zero `tool_calls`, with a trusted host ledger snapshot `deliveryOwed=true`. Assert exactly two upstream requests in one host request; the second canonical context contains the first assistant text and ends with a user message whose content is [SAND_HIDDEN_PROMPT] directly followed by the exact §3.27 body; the host receives the second response when it contains a real delivery tool call, recorded initially as call-emitted and upgraded to delivery-observed only by a host success event.
- **A stop plus non-delivery tool call is not eligible:** first chat-completions JSON/SSE response has `finish_reason="stop"` and one non-delivery `tool_calls` entry (even if a fixture supplies a purported result). Assert exactly one upstream request, `l2Eligible=false`, `skipReason=first_tool_call`, no §3.27 second request, and no provider-continuation inference or fabricated result.
- **Second response still has no tools:** assert exactly two total upstream requests (initial + one default L2 attempt), `finalNoTool=true` suppresses L3 for that epoch/tail, no infinite loop, and the chosen final response is returned without a fabricated tool call.
- **Host-boundary fallback:** make the second chat-completions run fail or time out after the first response has been converted/serialized for the host. Assert the captured **host-boundary** body bytes are returned byte-for-byte with the captured host-visible status and end-to-end headers—not provider-original bytes; Content-Length is preserved only when valid, Transfer-Encoding is proxy-normalized, the request is marked `l2_fallback`, `firstResponseHash` hashes those host bytes, and no gateway-created delivery call appears.
- **Chat-completions SSE:** first converted host-visible SSE has terminal stop and zero tools; second SSE has a tool call. Assert no first host bytes reached the host, only the second host-boundary stream is returned with its own valid content type/status/finish mapping, and the call is not labeled delivery-observed without a host event.
- **Host-boundary SSE overflow:** make the converted host-visible first SSE exceed maxBufferedResponseBytes. Assert the gateway immediately flushes the buffered host prefix and pipes the remaining converted host bytes unchanged with first-response status/header semantics, records `bufferedBytes` and `skipReason=buffer_overflow`, permanently suppresses L2 for that response/epoch, and never emits a second upstream request.
- **Responses/Anthropic protocol matrix:** for both JSON and SSE, exercise stop/no-tool/owed fixtures through Responses and Anthropic adapters. Assert L2 is skipped before buffering (`l2Eligible=false`, `skipReason=protocol_unsupported`), no second upstream request is sent, normal host response bytes/status/headers are passed through unchanged, and no provider-original body is used as a fallback.
- **Dry-run SSE:** assert the first host-visible chunk reaches the host immediately, `bufferedBytes=0`, no second request or request mutation occurs, and first-token latency is unchanged; when the adapter cannot expose non-blocking normalized events, assert `classificationSkippedReason=non_blocking_adapter` and the adapter remains disabled by default.
- **Trusted identity and group gates:** provide missing/empty botId, prompt text that falsely resembles an identity, unsigned/client-controlled identity headers, unknown chatType, `chatType="group"` with `isGroupMemberTurn` omitted or false, and trusted groupFlag=true. Assert `identityGateResult=fail`, distinct `skipReason` values (`no_bot_id`, `unknown_identity`, `group_chat`, etc.), no L1/L2/L3 injection, and no prompt-regex fallback.
- **L1 dry-run versus enforce:** dry-run leaves the upstream body unchanged and does not full-buffer SSE but records wouldApply/classification metadata; enforce appends one exact canonical suffix before chatToResponses/chatToAnthropic conversion and does not duplicate it.
- **L3 replay:** send the next host request with an owed historical tail and a trusted epoch/ledger event; assert one pre-upstream §3.27/§3.28 nudge, no repeat after the per-epoch cap, skip when any host fact is unknown, and never claim coverage of a boot/idle-only §3.29 obligation.
- **Quota fixture:** make the complete second prompt exceed maxAdditionalPromptTokens, the bounded output exceed maxAdditionalCompletionTokens, or the worst-case cost exceed maxAdditionalCostUsd. Assert L2 is abandoned before dispatch, `skipReason` identifies `budget_prompt`, `budget_completion`, or `budget_cost`, and the first host-boundary response is replayed unchanged.
### 12.3 Reverse assertions

For every test where the upstream returns no delivery tool, inspect the host response JSON/SSE and assert that the gateway did not create an assistant tool_calls item named SendToUser, SendMessage, or ReactToMessage, did not change finish_reason, and did not increment or claim delivery-observed counters without an explicit host event. The literal word SendToUser may appear in a nudge's user content; that is not a tool call and must not satisfy the reverse assertion.

## 13. Acceptance criteria

### 13.1 Box reproduction

1. On the Computer, confirm the target bot is 7a1ef5de-2f61-4344-b309-3b8eafea1b83, the wrap is custom, and 127.0.0.1:9280 is the OpenBot hop. Do not patch or restart the stock host manually.
2. Back up the current openbot-injection.json (if any) and enable mode: dry-run for one bot. Confirm the control page shows wouldApply on a controlled plain-text stop turn only when an authenticated HostRequestContext supplies non-empty botId, conversationId, trusted epoch, explicit person flags, and a non-group chatType; prove no visible-prompt regex is used. Confirm dry-run does not full-buffer SSE or change first-token latency.
3. Use a deterministic chat-completions fixture that reproduces the incident response (finish_reason=stop, zero tool_calls) with an explicit trusted host ledger snapshot, or reproduce the same instruction on the box if the model can be controlled. The live model smoke test is not a substitute for the deterministic fixture.
4. Switch only this bot to mode: enforce with L2 enabled and issue one person-opened chat-completions turn that otherwise ends in plain text. Observe one same-request L2 attempt and a second response containing a real delivery tool call; record this as call-emitted unless the host success event contract separately confirms delivery-observed.
5. Open the control page logs and pair the custom-host/hop rows. The row must show the authenticated identity result, `injectionFamilies=[l2.reply-nudge]`, `l2AdditionalRuns=1`, `l2Outcome=call-emitted`, `firstResponseHash`, `l2BodyHash`, `bufferedBytes`, and no status != 200 requirement for success. If the host emits a trusted success event, the ledger may later show delivery-observed with its `deliveryObservedAt`; without it, owed/delivery state must remain unknown rather than an inferred owed-to-delivered transition. The host-visible transcript must contain an actual SendToUser/SendMessage tool event, not just the nudge text.
6. Repeat with the fake upstream returning plain text twice. The log must show l2AdditionalRuns=1, valid-no-tool/retryExhausted, finalNoTool suppression of L3, no third request, no fabricated tool, and an explicit unresolved-or-unknown ledger state.
7. Exercise Responses and Anthropic adapters with both JSON and SSE stop/no-tool fixtures. Each must skip L2 with `skipReason=protocol_unsupported`, no buffering or second request, and ordinary host pass-through.
8. Set mode: off; the next request must have no injection metadata marked as applied and must retain the current single-run behavior.

### 13.2 Quantitative pass gates

- Deterministic integration fixture: 100% of eligible first-stop/**zero-tool-call** chat-completions cases produce exactly one bounded remediation attempt; no case produces more than the configured hard cap. A first stop with any non-delivery `tool_calls` produces zero L2 attempts.
- Successful fixture: host sees a real delivery tool call from the upstream response; only an explicit host success event may additionally qualify it as delivery-observed and supply `deliveryObservedAt`.
- Double-failure fixture: zero fabricated delivery calls, zero third upstream requests, and finalNoTool suppresses L3 for the same epoch/tail.
- Protocol gate: Responses and Anthropic JSON/SSE requests produce no L2 buffer or second request and retain normal host response bytes/status/headers.
- Dry-run gate: first streamed bytes are forwarded immediately, `bufferedBytes=0`, no request is mutated, and first-token latency is unchanged; unavailable non-blocking classification is recorded with `classificationSkippedReason`.
- Identity/group gate: missing or untrusted identity, prompt-only identity, unknown chatType, and `chatType="group"` with an omitted/false isGroupMemberTurn all fail closed with distinct `skipReason` values.
- Live smoke: one reproduction on the same bot creates a visible injection marker; a delivery-observed claim is counted only when the trusted host event contract supplies the success event and `deliveryObservedAt`, otherwise the outcome remains call-emitted/unknown.
- Quota gate: no L2 request is dispatched when prompt tokens, completion-token cap, or worst-case reserved cost exceeds its configured limit; the corresponding budget skip reason is logged.
- Prefix/cache check: no mutation of the pre-suffix serialized prefix; monitor cached-token ratio against the incident baseline.
- §3.29 boundary: idle/boot-only ack obligations are reported as out of scope and are never presented as L3 coverage.
- Rollback check: switching off takes effect on the next request without a host bounce.

## 14. Risks and open questions

1. **Model non-compliance:** a nudge is not a guarantee. If the model continues to emit text, the gateway must report unresolved rather than forge delivery.
2. **Streaming latency/memory:** enforce-mode L2 buffering delays first-token delivery only for eligible chat-completions candidates; host-boundary overflow immediately passes through converted bytes and permanently suppresses L2 for that response/epoch. Dry-run uses a non-blocking tee with zero full-response buffering and no first-token delay; if an adapter cannot provide that path it is skipped/default-off. Confirm the memory ceiling, header/framing behavior, and acceptable limits for the largest provider response.
3. **Provider shape drift:** finish reasons and tool-call deltas differ across chat-completions, Responses, and Anthropic. Keep one canonical classifier and add fixtures for each adapter, while L2 remains explicitly unsupported for Responses/Anthropic until a host-boundary capture contract exists.
4. **Repeated tool work:** this plan intentionally refuses L2 whenever the first response contains any tool call, so it cannot repeat an unexecuted non-delivery tool as a same-request continuation. A future provider-continuation protocol must name the executor, authenticated result pairing, and idempotency/side-effect protection before relaxing the gate.
5. **Identity metadata:** the trust root is the authenticated HostRequestContext/transport envelope defined in §9.1, not a visible prompt or regex. The implementation must wire botId, conversationId, epoch, person/source flags, and chatType/group state from that root; absent, unsigned, or ambiguous metadata fails closed. The empty-bot memory record is a known false-positive risk.
6. **Epoch extraction:** validate explicit trusted host message/epoch IDs on the box. A transcript hash may be used only for deduplication inside a trusted epoch; if no trusted epoch is available, skip L1/L2/L3 rather than create one locally.
7. **Concurrency:** confirm the existing turn lease can cover the L2/L3 decision, or add a small per-conversation lease without changing host ownership.
8. **Official disable semantics:** decide whether a future implementation should mirror SAND_DISABLE_USER_REPLY_REMINDER=1 when that signal is available to the hop. Until then, the separate mode/layer switches are the only OpenBot controls and default off.
9. **Log/UI compatibility:** agree on request-row schema, trusted host event version, and control-page facets before implementation so call-emitted versus delivery-observed metadata can be added without exposing bodies or breaking old rows.
10. **Operational policy:** choose the first allow-list (bot ids, model ids, or a percentage), token/cost quota defaults, and the SLO for additional latency/cost before enabling enforce broadly. Keep §3.29 idle/boot recovery as a separately scoped future decision.

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
2. Add the canonical ledger/classifier with JSON/SSE/provider fixtures.
3. Add L1 in a post-conversion policy stage, with dry-run metadata.
4. Add L2 buffered classification and same-request bounded retry only for chat-completions first responses with zero tool_calls, including complete context, direct hidden-marker concatenation, token/cost preflight, host-boundary first-response fallback (bytes/status/headers), and converted-byte overflow pass-through; skip Responses/Anthropic and any first tool call.
5. Add L3 history-tail detection only for §3.27/§3.28, using trusted host epoch/ledger events, fingerprinting, TTL, finalNoTool suppression, and per-epoch cap; leave §3.29 idle/boot ack-redrive out of scope.
6. Extend request-log metadata/control-page display without logging prompt bodies by default; distinguish call-emitted from host delivery-observed and keep unavailable ledger fields unknown.
7. Run unit/integration tests, then the deterministic box acceptance reproduction.
8. Update skills/openbot-config in the same or follow-up PR, and leave AGENTS.md unchanged unless reviewers choose the optional clarification above.

The success condition is not “the gateway found some text that looks like an answer.” It is: the model made a real delivery tool call (`call-emitted`); where the trusted host event contract is available, the host confirms it as `delivery-observed` and the ledger counts it; otherwise the gateway stays unknown/unresolved. The control page must explain which bounded opt-in layer made the second chance possible without claiming signals it cannot observe.
