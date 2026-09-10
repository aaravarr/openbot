# OpenBot Injection Hardening Plan

[README.md](../README.md) · [README.zh-CN.md](../README.zh-CN.md)

> Status: proposal only. This PR adds documentation; it does not change product code, the official host, or the structural message converter.

## 1. Executive summary

OpenBot can successfully receive a POST /v1/chat/completions response and still show the user nothing: plain assistant text is inner transcript content, while only a real SendToUser (or accepted delivery tool) reaches the user. The incident in §2 is exactly that case. The official Grok Bot has detection and follow-up mechanisms, but the custom wrap/hop path did not deliver those mechanisms to the gateway.

This plan adds a named, opt-in InjectionHardeningStrategy at the OpenBot hop boundary:

- **L1 — before generation:** append the official reply-first/start-of-turn/silence/early-result reminders when the reconstructed ledger reaches the official thresholds.
- **L2 — after generation:** the key patch for this incident. When a person-opened upstream run stops with no delivery tool call and delivery is owed, append the exact §3.27 nudge and run the upstream once more in the same host request. Return the second response when it is valid; never manufacture a tool call.
- **L3 — between host requests:** if the next request's history proves that the preceding person-opened epoch is still owed, append a §3.27 or §3.28 nudge before sending the next upstream request.

The strategy is deliberately outside toOpenAIMessages. That function remains a pure structural conversion. The strategy never maps leftover text to SendToUser, never forces finish_reason, and never claims delivery without observing a real tool invocation/result.

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
| Until 17:48:33.367 | — | No next real turn for 2 minutes 47 seconds. |
| Whole window | — | Requests with status != 200: **0**; there was no failed-request retry. |

The evidence establishes that official delivery remediation equivalent to ensureUserReply did not reach the gateway after the incident run, and the gateway performed no remediation of its own. The 17:45:50 call must not be counted as a response attempt merely because it followed the incident.

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

OpenBot must maintain the same semantic split:

- sentMessageCount: only successful, observed send-message delivery events.
- reacted: only a successful, observed ReactToMessage result.
- deliveryToolCalls: all observed assistant calls named SendToUser, SendMessage, or ReactToMessage, whether their result later succeeds or fails.
- Plain assistant text is never a delivery event.

### 3.2 Seven injectors and order

A person-opened turn is hidden !== true && isGroupMemberTurn !== true (official reminders, §4). The order is:

~~~text
opening assembly / first upstream run
  -> §3.14 reply-first (once, in the opening user message)

next stream(s) in the same turn
  -> §3.21 start-of-turn text acknowledgement (non-delivery calls > 1)
  -> §3.22 watching silence (toolCallsSinceLastSend > 6)
       else §3.23 early result (calls > 0, delivery already happened)

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

The three phases matter for this proposal: §3.14 is generation-time assembly; §3.21–§3.23 are stream-time middleware; §3.27–§3.29 are post-turn/recovery work. The custom hop can implement equivalents only at its own boundary; it cannot assume the official executor is present.

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

The custom-host/hop pair produced a successful upstream response with finish_reason=stop and no tool calls, then returned it. There was no second hop request carrying the §3.27 body, and no gateway event indicating an attempted nudge. The subsequent botId-empty memory extraction is a different lane. This is consistent with either (or both) of the following:

- **Middleware not installed:** the custom executor/wrap path did not include the official StartOfTurnAck/SendMessage reminder middleware, so §3.21–§3.23 never ran.
- **ensureUserReply not triggered:** the custom path did not call the official post-run hidden runner.run, or it was gated out because the custom wrapper did not expose the official person-opened/epoch/result state.

**Assessment:** middleware omission is high confidence because the custom path is an OpenAI hop and the observed request had no stream-time reminder. Missing or unreachable ensureUserReply is high confidence because the authoritative timeline shows no follow-up hop request after the silent 200 response. The exact internal reason (not installed versus not triggered by a wrapper gate) remains medium confidence until the box's wrapped executor composition is instrumented. The memory call must not be used as evidence that delivery remediation happened.

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

The strategy is evaluated only by the custom hop after the host transcript has been structurally converted and before the first upstream write:

~~~text
host request
  -> parse/route/credentials
  -> toOpenAIMessages (structural conversion only)
  -> existing image/tool-id/protocol preparation
  -> InjectionHardeningStrategy (L1/L2/L3; opt-in)
  -> upstream request
~~~

The strategy may append a new model-visible role: "user" suffix or append to the opening user content as specified below. It must not edit old assistant text, tool results, tool IDs, system messages, or finish reasons. It must carry a local fingerprint for every insertion; that fingerprint is never sent as an invented provider field.

### 5.2 Common policy gates

All layers require every gate below:

1. Configuration mode is enforce (or dry-run for observation only).
2. The request is positively identified as a person-opened turn: not hidden, not a subagent, not isSilenceAllowed, not a routine/automation wake, and not a group-member turn. If metadata is unavailable, fail closed and skip rather than guessing.
3. The conversation/bot identity is stable enough to key the ledger. A request with an empty bot id, such as the 17:45:50 memory call, is not eligible for L2/L3 unless a trusted conversation identity independently proves it is person-opened.
4. The client response has not received headers/body bytes before a possible L2 decision.
5. A per-conversation turn lease prevents two concurrent requests from injecting the same epoch.

Every layer also honors the global and per-layer enabled switch. Turning the mode to off takes effect on the next request; it never requires a host bounce.

## 6. L1 — pre-generation injection

L1 mirrors §3.14 and §3.21–§3.23. It runs after OpenBot has assembled the outbound message array and before sending it upstream. It is not part of the conversion function.

### 6.1 Trigger and placement table

| Family | Eligibility | Placement | Bound and reset |
| --- | --- | --- | --- |
| §3.14 reply-first | First eligible opening request of a new person-opened epoch; appendReplyReminder equivalent is true; no hidden/wake/subagent/group. | Append the exact <system_reminder>…</system_reminder> after the real user text in the opening user row. If the opening row cannot be identified safely, append a new user row instead of changing an unrelated row. | Once per assembled opening message. Skip if the exact body is already present; reset only on a new epoch. |
| §3.21 start-of-turn ack | No text SendToUser/SendMessage since the epoch boundary and non-delivery tool calls since the last delivery > startOfTurnAckThreshold (default 1, therefore >1). | Append the exact full §3.21 block as one new role: "user" message at the tail. | At most once per silent streak; exact-last-message short-circuit. Reset on a real delivery call/result, a new user/system boundary, or a new epoch. |
| §3.22 watching silence | toolCallsSinceLastSend > watchingSilenceThreshold (default 6). It wins over §3.23. | Append the exact full §3.22 block as one new tail user message. | At most once per silent streak; exact-last-message short-circuit. |
| §3.23 early result | Else branch of §3.22: toolCallsSinceLastSend > earlyResultThreshold (default 0), a successful delivery tool call already occurred in this epoch, and no reminder fired in this silent streak. | Append the exact full §3.23 block as one new tail user message. | At most once per silent streak; exact-last-message short-circuit. |

A request gets no more than one L1 reminder selection: evaluate §3.22 first, then §3.23, with §3.21 as the start-of-turn acknowledgement gate. The detector ignores prior injected reminder messages when walking the ledger, but the exact text still participates in duplicate detection. Existing official reminder strings remain untouched.

### 6.2 Cache-safe suffix rule

Append reminders at the end of the assembled prompt. Do not prepend to the system prompt or rewrite the transcript prefix. For §3.14, appending to the existing opening user row means the user text and all cached history stay byte-for-byte unchanged before the suffix. For §3.21–§3.23, adding a final user row likewise preserves the prefix. This matters for the incident's cachedTokens=82816 of promptTokens=84530.

### 6.3 Dry-run behavior

In dry-run, L1 computes the same family, body, position, and fingerprint, but does not append it. It records wouldInject=true, threshold values, and a body hash. It must never alter the upstream request or delivery ledger. This is the first rollout mode.

## 7. L2 — post-generation same-request remediation

L2 is the key patch for the incident and is the gateway-side equivalent of §3.27. It is deliberately a second model run, not response post-processing.

### 7.1 Eligibility

After the first upstream response is fully classified, L2 is eligible only when all conditions hold:

1. The request passed the common person-opened gate.
2. The upstream response is successful and every relevant choice terminates with finish_reason="stop" (for a non-stream JSON response, the choice has that value; for SSE, the terminal chunk is buffered and classified).
3. The response contains **no** assistant delivery tool call in any choice/chunk: no SendToUser, SendMessage, or ReactToMessage call. A failed delivery call therefore does not enter this specific no-call gate; it remains visible in the ledger for diagnostics.
4. The current epoch is deliveryOwed: sentMessageCount === 0 && reacted === false.
5. No L2 attempt has been used for this epoch/request, the client is still connected, and the remaining retry budget is positive.

A plain response body is evidence of an owed turn, not a deliverable. Do not inspect its text and do not convert it into a tool call.

### 7.2 Algorithm

~~~text
first = upstream(body)
classify first without sending bytes to host
if eligible(first) and mode == enforce:
    secondBody = clone(body)
    append role=user:
      [SAND_HIDDEN_PROMPT]\\n + exact §3.27 body
    second = upstream(secondBody)       # same host request, bounded
    if second is a valid response:
        return second to host
    return first byte-for-byte to host  # remediation failure fallback
else:
    return first unchanged
~~~

The second body keeps the same model, tools, tool definitions, provider parameters, stream flag, and conversation history. It appends only the official hidden marker plus the exact §3.27 text. It must not remove the first assistant text, invent a tool_calls array, set finish_reason, or change sentMessageCount locally. The second upstream response is the only candidate returned to the host in the success path, so the host never sees both responses as two assistant turns.

For dry-run, classify and log the same eligibility but never send the second request. For off, preserve today's single request exactly.

### 7.3 Streaming handling

A streamed first response must be buffered until its terminal chunk is available, because forwarding its headers or text would make a same-request second response impossible. The buffer has a configured hard ceiling (maxBufferedResponseBytes, default 4 MiB). If the ceiling, parser, client disconnect, or first-run deadline prevents classification, return the first response unchanged (or the existing transport error) and log classificationSkipped; never partially forward the first stream and then append a second stream.

If the first stream is eligible, send no first-stream bytes to the host. Run the second upstream request. If it succeeds, forward only the second stream using the original content type/stream contract. If it fails, forward the buffered first stream with its original headers. This preserves the host's one-response expectation at the cost of first-token latency only for L2 candidates.

### 7.4 Bounds, timeout, and failure

- Default: maxAdditionalRuns=1; hard maximum 2 regardless of configuration.
- A separate L2 retry budget defaults to 15,000 ms and cannot extend the process's existing upstream deadline. Skip the second call when less than the configured budget remains.
- One in-flight L2 attempt per conversation/epoch. Client close cancels the active second request.
- A non-2xx response, timeout, network error, parse/conversion error, buffer overflow, or exhausted budget is a remediation failure: return the first response unchanged and mark the epoch unresolved.
- A valid second response that still has no delivery tool call is final. Do not run a third call from L2. Record retryExhausted=true; the gateway still must not forge delivery.
- Transport retries (existing 429/5xx policy) remain separate and are included in the total deadline. They must not multiply the L2 limit.

### 7.5 Exact body and outcome observability

The request record must distinguish l2Eligible, l2Attempted, l2Outcome (delivered-tool, valid-no-tool, failed-first-fallback, classification-skipped), l2AdditionalRuns, l2AddedLatencyMs, and l2BodyHash. The body hash is a diagnostic fingerprint; it is not a provider message and must not contain secrets or full prompt text.

## 8. L3 — between-turn safety net

L3 covers the case where the gateway cannot observe an official post-run boundary or the original caller does not keep the custom hop alive long enough for L2.

### 8.1 Trigger and family selection

On the next eligible host request, before upstream dispatch and after structural conversion, inspect the historical tail for the immediately preceding person-opened epoch:

- **Plain/stop owed tail:** the previous epoch ended with finish_reason="stop", no delivery tool call, and sentMessageCount === 0 && reacted === false. Append [SAND_HIDDEN_PROMPT]\\n plus the exact §3.27 body.
- **Ack + silent-tools tail:** the previous epoch's first assistant tool-call message had a text delivery acknowledgement, later non-delivery tools ran, the turn ended without a successful follow-up SendToUser, and no completion predicate explicitly ended the turn. Append [SAND_HIDDEN_PROMPT]\\n plus the exact §3.28 body.

The selector uses normalized chat/responses/Anthropic events, not provider-specific raw shapes. If the tail is only a memory/summary lane, has an empty/untrusted bot identity, is hidden/routine/subagent/group, or has a newer real user message that supersedes the old obligation, skip L3.

### 8.2 Placement, dedupe, and bounds

- Append one new role: "user" tail message. The marker is the official [SAND_HIDDEN_PROMPT] marker; preserve its spelling and do not wrap the hidden follow-up in an extra invented system role.
- Never append into old assistant text or tool results. Never remove an existing reminder.
- Use an exact body check plus fingerprint(conversationKey, epoch, family, templateVersion) to avoid duplicate injection when the host retries an identical request.
- Default maxRedrivesPerEpoch=1, hard maximum 3, and default obligation TTL 300,000 ms (5 minutes). Once the cap is reached or TTL expires, mark unresolved and wait for a new real user epoch; do not nag every request forever.
- A real delivery (sentMessageCount > 0 or reacted=true) clears the obligation and the fingerprint. A new user/system epoch clears the old L3 budget. A valid but no-tool response does not create a new L3 loop.
- In dry-run, record the selected family and would-be suffix only. In off mode, the next request is byte-for-byte unchanged.

## 9. Ledger implementation

### 9.1 Canonical per-request observation

Normalize each provider response into a small internal observation before applying the policy. This can be shared by JSON and SSE paths and by chat-completions, Responses, and Anthropic adapters:

~~~text
TurnObservation {
  finishReasons: string[]
  assistantToolCalls: [{ name, id, args, choiceIndex }]
  successfulDeliveryCalls: number
  failedDeliveryCalls: number
  successfulReaction: boolean
  textDeliveryCalls: number
  nonDeliveryToolCalls: number
  firstContentAt?: number
  parserComplete: boolean
}
~~~

Tool names are compared against the canonical set {SendToUser, SendMessage, ReactToMessage} after provider normalization. Tool-call presence alone is not a successful delivery: a matching tool result/event must be observed, and an error result does not increment sentMessageCount or reacted. A successful SendToUser/SendMessage widget, card, or attachment still increments sentMessageCount; it is only excluded from the text-ack counter when args.type !== "text".

For a host transcript, walk assistant tool_calls and their paired role: "tool" results. For a live stream, consume every tool_calls delta and the terminal result/event. Never count a string SendToUser in assistant content, a reminder body, or a tool description as a call.

### 9.2 Turn and epoch boundary

Key state by a trusted conversationId + botId pair (with a stable fallback only when the host supplies one). Define an epoch as follows, in order of evidence:

1. An explicit host user-message id or turn/epoch id creates a new epoch.
2. Otherwise, a new real user message appended after the prior observed tail creates one. Hash the normalized role/content plus the preceding transcript boundary; a policy reminder row does not qualify.
3. A repeated request containing the same real-user tail and only additional assistant/tool rows is the same epoch.
4. A hidden marker, exact policy body, memory/summary row, or botId-empty routine row never creates a person-opened epoch.
5. On process restart, rebuild from the transcript tail; do not persist raw user content solely for the ledger. If no safe boundary can be proven, skip L1/L2/L3 rather than guess.

Maintain a bounded in-memory state/lease map (for example, an LRU keyed by conversation and bot) with the epoch id, counts, silent-streak id, fingerprints, L2/L3 budgets, and last-seen timestamp. Evicting state is safe: history reclassification may restore an owed obligation, but per-epoch caps and exact-tail fingerprints prevent an unbounded loop. Use an atomic per-key lease around L2 so two host requests cannot both send a remediation run.

### 9.3 Alignment with isDeliveryOwed

At every policy decision:

~~~text
ledger.isDeliveryOwed =
  ledger.sentMessageCount === 0 && ledger.reacted === false
~~~

ReactToMessage is included in the owed-clearing set exactly as official, although it is not user-visible text. SendToUser and SendMessage are the user-visible delivery set. The start-of-turn gate separately requires a successful text call. These three predicates must be unit-tested independently.

## 10. Guardrails

### 10.1 No forged delivery

The gateway must never:

- Create an assistant tool_calls entry for SendToUser, SendMessage, or ReactToMessage.
- Convert leftover assistant text into a tool call.
- Set a synthetic finish_reason="tool_calls" or force finish=stop.
- Increment sentMessageCount/reacted without an observed host/upstream event.
- Drop an upstream delivery call or alter the official reminder strings.

A nudge is only a user-role prompt asking the model to make a real call. If the model does not call a tool, the result remains unresolved and is reported as such.

### 10.2 Structure and marker safety

toOpenAIMessages remains a pure role/content/tool-result conversion. It must not peel <system_reminder> or [SAND_HIDDEN_PROMPT], drop reminder-only turns, or insert a reminder. The named strategy runs after conversion and appends only its own explicit suffix. Existing tests in src/hop/openai-messages.test.ts:94-149 continue to assert marker preservation.

### 10.3 Scope, idempotence, and bounded work

- Positive person-opened gating only; subagent, hidden, routine/automation, silence-allowed, and group turns skip all three layers.
- Exact-last-message and per-epoch fingerprints make repeated HTTP retries idempotent.
- L1 has one reminder per silent streak; L2 has at most two additional runs by hard policy; L3 has at most three redrives by hard policy.
- Respect client disconnects, upstream deadlines, response-buffer ceilings, and a per-conversation lease.
- The first response is never discarded on an L2 failure; it is returned unchanged.
- Do not store full prompt/response bodies merely to explain an injection. Reuse existing redaction and body-capture settings; hashes and bounded counters are sufficient.

### 10.4 Cache, latency, and cost

All additions are suffixes, keeping the large prefix eligible for provider caching. The incident's 82816/84530 cached-token ratio is the baseline to monitor. L2 intentionally spends one extra model call only on a proven owed stop response; L1/L3 add a small suffix or one next-request call. Logs must report added prompt tokens, added completion tokens, wall-clock delta, and cache-hit changes. Roll out with dry-run before enforce to establish the rate of eligible turns and the expected spend.

### 10.5 Logging and control-page visibility

Extend the hop request metadata (not provider payload) with:

~~~text
injectionMode
injectionFamilies[]          # l1.reply-first, l1.start-ack, l1.silence, l1.early-result,
                             # l2.reply-nudge, l3.reply-nudge, l3.closing-send
injectionEpoch
injectionFingerprint
injectionWouldApply
l2Eligible / l2Attempted / l2Outcome / l2AdditionalRuns
l2AddedLatencyMs
ledgerSentMessageCount / ledgerReacted / ledgerDeliveryToolCalls
ledgerOwedAtStart / ledgerOwedAtEnd
~~~

Only bounded names, booleans, numbers, ids, and hashes are logged by default. The control page should show the family and outcome beside the paired custom-host/hop rows. When openbot-logs.json body capture is disabled, these fields must still be available as metadata; no key or full prompt is exposed. Add counters/events for injection.would_apply, injection.applied, injection.suppressed_duplicate, injection.l2_fallback, injection.unresolved, and delivery.owed.

### 10.6 Gray rollout and rollback

1. Ship with configuration absent/effective off.
2. Enable dry-run for one bot or a small allow-list and inspect eligible rate, family distribution, cache impact, and possible false positives.
3. Enable enforce with L2 maxAdditionalRuns=1 for the same cohort; compare owed-to-delivered conversion and added latency.
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
      "maxBufferedResponseBytes": 4194304
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
| l2.maxBufferedResponseBytes | 4194304 | 262144..8388608; overflow skips remediation. |
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

1. **Ledger predicates:** successful text SendToUser, widget SendToUser, SendMessage, ReactToMessage, failed calls, and plain text; assert independent sentMessageCount, reacted, deliveryToolCalls, and text-ack results.
2. **Tool normalization:** canonical names and JSON/SSE/Responses/Anthropic shapes; never count a string in assistant content as a call.
3. **Boundary detection:** new user message/epoch, same-epoch tool continuation, hidden marker, injected reminder, routine/memory row, missing bot id, and ambiguous metadata (must skip).
4. **L1 thresholds:** >1, >6, and >0/prior delivery; §3.22 precedence over §3.23; one reminder per silent streak; exact-last-message short-circuit; reset on delivery/new epoch.
5. **L2 decision:** finish_reason=stop + no delivery tool calls + owed is eligible; tool call, non-stop finish, reaction, send-message, hidden, and non-person turns are not.
6. **L2 bounds:** zero/one/two configured additional runs, hard cap, timeout, buffer overflow, client close, first-response fallback, valid second no-tool final, and no third run.
7. **L3:** §3.27 versus §3.28 tail selection, TTL, max redrives, duplicate fingerprints, reset on delivery/new epoch, and memory-summary exclusion.
8. **Cache prefix:** compare serialized first request prefix before the injection suffix; assert no system/history prefix mutation and no stripping of official markers.
9. **Config:** missing/corrupt/off/dry-run/enforce, range clamping/rejection, per-layer switches, hot reload, and atomic writes.

### 12.2 Integration tests with a fake upstream

- First upstream response: JSON finish_reason="stop", plain assistant text, no tool_calls. Assert the gateway sends exactly two upstream requests in one host request; the second body ends with [SAND_HIDDEN_PROMPT] plus the exact §3.27 body; the host receives the second response when it contains a real delivery tool call.
- Second upstream response still has finish_reason="stop" and no tools. Assert exactly two total upstream requests (initial + one default L2 attempt), no infinite loop, and the chosen final response is returned without a fabricated tool call.
- Second upstream fails or times out. Assert the first raw response is returned byte-for-byte, the request is marked l2_fallback, and the response contains no gateway-created delivery call.
- Stream variant: first SSE is buffered and has terminal stop with no tool; second SSE has a tool call. Assert no first bytes reached the host, only the second stream is returned, and the content type/finish mapping stays valid.
- L1 dry-run versus enforce: dry-run leaves the upstream body unchanged but records wouldApply; enforce appends one exact suffix and does not duplicate it.
- L3 replay: send the next host request with an owed historical tail; assert one pre-upstream nudge and no repeat on an identical request after the per-epoch cap.

### 12.3 Reverse assertions

For every test where the upstream returns no delivery tool, inspect the host response JSON/SSE and assert that the gateway did not create an assistant tool_calls item named SendToUser, SendMessage, or ReactToMessage, did not change finish_reason, and did not increment delivery counters. The literal word SendToUser may appear in a nudge's user content; that is not a tool call and must not satisfy the reverse assertion.

## 13. Acceptance criteria

### 13.1 Box reproduction

1. On the Computer, confirm the target bot is 7a1ef5de-2f61-4344-b309-3b8eafea1b83, the wrap is custom, and 127.0.0.1:9280 is the OpenBot hop. Do not patch or restart the stock host manually.
2. Back up the current openbot-injection.json (if any) and enable mode: dry-run for one bot. Confirm the control page shows wouldApply on a controlled plain-text stop turn.
3. Use a deterministic fake/upstream fixture that reproduces the incident response (finish_reason=stop, no tool calls), or reproduce the same instruction on the box if the model can be controlled. The live model smoke test is not a substitute for the deterministic fixture.
4. Switch only this bot to mode: enforce with L2 enabled and issue one person-opened turn that otherwise ends in plain text. Observe one same-request L2 attempt and a second response containing a **real** delivery tool call.
5. Open the control page logs and pair the custom-host/hop rows. The row must show an injection marker/family (l2.reply-nudge), l2AdditionalRuns=1, the owed-to-delivered ledger transition, and no status != 200 requirement for success. The host-visible transcript must contain an actual SendToUser/SendMessage tool event, not just the nudge text.
6. Repeat with the fake upstream returning plain text twice. The log must show l2AdditionalRuns=1, valid-no-tool/retryExhausted, no third request, no fabricated tool, and an explicit unresolved owed metric.
7. Set mode: off; the next request must have no injection metadata marked as applied and must retain the current single-run behavior.

### 13.2 Quantitative pass gates

- Deterministic integration fixture: 100% of eligible first-stop/no-tool cases produce exactly one bounded remediation attempt; no case produces more than the configured hard cap.
- Successful fixture: host sees a real delivery tool call from the upstream response.
- Double-failure fixture: zero fabricated delivery calls and zero third upstream requests.
- Live smoke: one reproduction on the same bot creates a delivery event and a visible injection marker in the control page.
- Prefix/cache check: no mutation of the pre-suffix serialized prefix; monitor cached-token ratio against the incident baseline.
- Rollback check: switching off takes effect on the next request without a host bounce.

## 14. Risks and open questions

1. **Model non-compliance:** a nudge is not a guarantee. If the model continues to emit text, the gateway must report unresolved rather than forge delivery.
2. **Streaming latency/memory:** L2 buffering delays first-token delivery for eligible candidates and needs a strict size/deadline ceiling. Confirm acceptable limits for the largest provider response.
3. **Provider shape drift:** finish reasons and tool-call deltas differ across chat-completions, Responses, and Anthropic. Keep one canonical classifier and add fixtures for each adapter.
4. **Repeated tool work:** the first run may have executed non-delivery tools before stopping. The second run receives the full transcript and could repeat a non-idempotent tool. Confirm whether the host/upstream can mark completed tool calls or whether L2 should be restricted to a safe tool policy; do not solve this by suppressing delivery calls.
5. **Identity metadata:** confirm where custom-host requests expose botId, conversationId, hidden, requestSource, and group/silence flags. Unknown identity must fail closed; the empty-bot memory record is a known false-positive risk.
6. **Epoch extraction:** validate explicit host message/epoch IDs on the box. If only transcript hashes are available, test burst messages, retries, and compaction carefully.
7. **Concurrency:** confirm the existing turn lease can cover the L2/L3 decision, or add a small per-conversation lease without changing host ownership.
8. **Official disable semantics:** decide whether a future implementation should mirror SAND_DISABLE_USER_REPLY_REMINDER=1 when that signal is available to the hop. Until then, the separate mode/layer switches are the only OpenBot controls and default off.
9. **Log/UI compatibility:** agree on request-row schema and control-page facets before implementation so metadata can be added without exposing bodies or breaking old rows.
10. **Operational policy:** choose the first allow-list (bot ids, model ids, or a percentage) and the SLO for additional latency/cost before enabling enforce broadly.

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
4. Add L2 buffered classification and same-request bounded retry, including first-response fallback.
5. Add L3 history-tail detection, fingerprinting, TTL, and per-epoch cap.
6. Extend request-log metadata/control-page display without logging prompt bodies by default.
7. Run unit/integration tests, then the deterministic box acceptance reproduction.
8. Update skills/openbot-config in the same or follow-up PR, and leave AGENTS.md unchanged unless reviewers choose the optional clarification above.

The success condition is not “the gateway found some text that looks like an answer.” It is: the model made a real delivery tool call, the host observed it, the ledger counted it, and the control page can explain which bounded opt-in layer made the second chance possible.
