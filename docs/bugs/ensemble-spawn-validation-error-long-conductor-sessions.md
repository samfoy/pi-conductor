# Bug: ensemble_spawn fails with Bedrock validation error in long conductor sessions

**Status**: FIXED in `src/context-filter.ts` pre-pass (this commit).
**Severity**: High — silently breaks all `ensemble_spawn` (builder/designer/etc.) after a conductor session accumulates enough orchestration turns
**Affected version**: through HEAD `c19950a`; fixed at the commit that lands this doc update
**Workaround (pre-fix)**: use `subagent` tool (clean pi instance, no inherited context) instead of `ensemble_spawn`

---

## Symptom

`ensemble_spawn` spawns the sub-agent but it exits on turn 1 with no output and status `error`:

```
errorMessage: "Validation error: The number of toolResult blocks at messages.13.content
exceeds the number of toolUse blocks of previous turn."
```

The sub-agent's transcript shows a single `message_start`/`message_end`/`turn_end` cycle,
all with `stopReason: "error"` and zero tokens consumed. The persona never gets a chance to run.

Observed in: `designer-w969`, `builder-wbdc`, `builder-afpg` across the same long conductor
session. Reproducible — every `ensemble_spawn` in the affected session fails on turn 1.

---

## Root cause

`filterParentContext` (`src/context-filter.ts`) drops entire assistant messages that contain
any `ensemble_*` / `subagent` tool call (the "drop whole message" rule from v0.8.1 design §3,
tracked by `droppedAssistantIndices`). But it only adds the **excluded tool call IDs** to
`excludedCallIds` — not the IDs of any *other* tool calls that happened to be in the same
assistant turn.

When a conductor turn fires an `ensemble_spawn` **alongside** a `note`, `read`, or `bash` call
in the same assistant message (common in long sessions where the conductor juggles state saves
and spawns in one reply), the filter:

1. Drops the entire assistant message (because it contained `ensemble_spawn`) ✅
2. Drops the `toolResult` for the `ensemble_spawn` call (its ID is in `excludedCallIds`) ✅
3. **Keeps** the `toolResult` for the `note`/`read`/`bash` call (its ID is NOT in
   `excludedCallIds`) ❌ — orphaned result with no preceding tool use

Bedrock's Converse API enforces a strict invariant: every `toolResult` block in a `user` turn
must be preceded by a `toolUse` block with the same ID in the immediately preceding `assistant`
turn. The orphaned result violates this, producing the validation error on the sub-agent's
very first API call.

### Minimal reproduction

A conductor turn like:

```
assistant [turn N]:
  toolCall id=A  name=ensemble_spawn  ...
  toolCall id=B  name=note            ...

user [turn N+1]:
  toolResult callId=A  ...   ← excluded (A is in excludedCallIds)
  toolResult callId=B  ...   ← NOT excluded (B is not in excludedCallIds)
```

After filtering:

```
assistant [turn N]:  ← DROPPED (message had ensemble_spawn, index in droppedAssistantIndices)
user [turn N+1]:
  toolResult callId=B  ← orphan — Bedrock rejects this
```

---

## Fix

In the pre-pass where `droppedAssistantIndices` is built, also add **all** toolCall IDs from
the dropped message to `excludedCallIds`, not just the ones matching `excludeToolPrefixes`.
This ensures every `toolResult` whose parent turn is dropped is also pruned.

```typescript
// In the pre-pass loop, after adding excluded prefix calls:
for (const block of content) {
  if (block?.type === "toolCall" && matchesAnyPrefix(block.name, excludeToolPrefixes)) {
    if (typeof block.id === "string") excludedCallIds.add(block.id);
    droppedAssistantIndices.add(i);
  }
}

// ADD: when a message is known to be dropped, also exclude all its other tool call IDs
// so the corresponding toolResults are pruned too (avoids orphaned toolResult blocks).
for (let i = 0; i < messages.length; i++) {
  if (!droppedAssistantIndices.has(i)) continue;
  const content = (messages[i] as any).content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block?.type === "toolCall" && typeof block.id === "string") {
      excludedCallIds.add(block.id);  // covers non-excluded tools in the same dropped turn
    }
  }
}
```

Or more simply, integrate into the single pre-pass:

```typescript
for (let i = 0; i < messages.length; i++) {
  const msg = messages[i];
  if (!msg || (msg as any).role !== "assistant") continue;
  const content = (msg as any).content;
  if (!Array.isArray(content)) continue;

  // First sub-pass: does this message contain any excluded toolCall?
  const willDrop = content.some(
    (block: any) =>
      block?.type === "toolCall" &&
      typeof block.name === "string" &&
      matchesAnyPrefix(block.name, excludeToolPrefixes),
  );

  if (willDrop) {
    droppedAssistantIndices.add(i);
    // Exclude ALL toolCall IDs in this message so none of their
    // toolResults survive as orphans.
    for (const block of content) {
      if (block?.type === "toolCall" && typeof block.id === "string") {
        excludedCallIds.add(block.id);
      }
    }
  }
}
```

---

## When does it trigger?

Only in long conductor sessions where the conductor fires both:
- An `ensemble_spawn` / `subagent` call, AND
- A non-excluded tool call (`note`, `read`, `bash`, `memory_remember`, etc.)

…in the **same assistant turn**. In short sessions this is rare; in sessions with 100+ turns
of conductor orchestration it becomes nearly guaranteed, since the conductor saves state (`note`)
and spawns sub-agents in the same reply throughout.

---

## Workaround (until fix lands)

Use `subagent` tool instead of `ensemble_spawn`. The `subagent` tool spawns a clean pi instance
with no inherited context, so it never receives the corrupted filtered snapshot.

Downside: `subagent` instances cannot be steered mid-run via `ensemble_send`. If mid-run
steering is needed, the session must be killed and respawned.

---

## Related

- `src/context-filter.ts` — bug is in the pre-pass loop
- `tests/context-filter.test.ts` — add a regression test: assistant turn with mixed
  `ensemble_spawn` + `note` call, verify the `note` toolResult is also excluded from output
- v0.8.1 design §3 ("drop whole assistant message") — the rule is correct; the gap is that
  non-excluded sibling tool calls in the dropped message aren't accounted for
