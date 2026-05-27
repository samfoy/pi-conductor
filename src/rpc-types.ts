/**
 * Vendored from
 *   [pi-dist] modes/rpc/rpc-types.d.ts
 * at @earendil-works/pi-coding-agent@0.74.0 (pin: package.json
 * `dependencies` → "@earendil-works/pi-coding-agent": "^0.74.0").
 *
 * We vendor (copy + trim) instead of importing pi's RPC types at
 * runtime to avoid a hard coupling on pi's internal layout. Per
 * design §4.9 (`docs/v0.12-steering-design.md`), the vendored
 * subset is the minimum surface for slices 2–4:
 *
 *   - RpcCommand
 *   - RpcResponse
 *   - RpcSessionState
 *   - RpcExtensionUIRequest
 *   - RpcExtensionUIResponse
 *
 * Plus one supporting type (`RpcSlashCommand`) that appears inside
 * `RpcResponse`'s `get_commands` `data` payload — defined in the
 * same upstream file so vendoring it together is honest, not
 * scope-creep.
 *
 * Public dependent types we rely on come from the public pi
 * packages:
 *   - AgentMessage, ThinkingLevel from `@earendil-works/pi-agent-core`
 *   - ImageContent, Model       from `@earendil-works/pi-ai`
 *
 * Private dependent types from pi's `./core/...` path
 * (`BashResult`, `CompactionResult`, `SessionStats`, `SourceInfo`)
 * are deliberately erased to `unknown`. The conductor never
 * constructs these — it only receives them inside `data:` fields
 * of `RpcResponse` variants we don't currently consume. If a
 * future slice surfaces the data, type-narrow at the use site.
 *
 * **No runtime shape probe on startup** — see design §4.9 +
 * `PRD.md:616` Q5-deferred pattern. Drift detection is the
 * human's job: when bumping `@earendil-works/pi-coding-agent` in
 * `package.json`, re-grep `[pi-dist]/modes/rpc/rpc-types.d.ts`
 * and update this file in the same commit.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";

// ── RpcCommand ────────────────────────────────────────────────────────
//
// Discriminated union over `type`. Lines emitted on the conductor's
// stdin → pi-subagent.

export type RpcCommand =
  | {
      id?: string;
      type: "prompt";
      message: string;
      images?: ImageContent[];
      streamingBehavior?: "steer" | "followUp";
    }
  | {
      id?: string;
      type: "steer";
      message: string;
      images?: ImageContent[];
    }
  | {
      id?: string;
      type: "follow_up";
      message: string;
      images?: ImageContent[];
    }
  | {
      id?: string;
      type: "abort";
    }
  | {
      id?: string;
      type: "new_session";
      parentSession?: string;
    }
  | {
      id?: string;
      type: "get_state";
    }
  | {
      id?: string;
      type: "set_model";
      provider: string;
      modelId: string;
    }
  | {
      id?: string;
      type: "cycle_model";
    }
  | {
      id?: string;
      type: "get_available_models";
    }
  | {
      id?: string;
      type: "set_thinking_level";
      level: ThinkingLevel;
    }
  | {
      id?: string;
      type: "cycle_thinking_level";
    }
  | {
      id?: string;
      type: "set_steering_mode";
      mode: "all" | "one-at-a-time";
    }
  | {
      id?: string;
      type: "set_follow_up_mode";
      mode: "all" | "one-at-a-time";
    }
  | {
      id?: string;
      type: "compact";
      customInstructions?: string;
    }
  | {
      id?: string;
      type: "set_auto_compaction";
      enabled: boolean;
    }
  | {
      id?: string;
      type: "set_auto_retry";
      enabled: boolean;
    }
  | {
      id?: string;
      type: "abort_retry";
    }
  | {
      id?: string;
      type: "bash";
      command: string;
    }
  | {
      id?: string;
      type: "abort_bash";
    }
  | {
      id?: string;
      type: "get_session_stats";
    }
  | {
      id?: string;
      type: "export_html";
      outputPath?: string;
    }
  | {
      id?: string;
      type: "switch_session";
      sessionPath: string;
    }
  | {
      id?: string;
      type: "fork";
      entryId: string;
    }
  | {
      id?: string;
      type: "clone";
    }
  | {
      id?: string;
      type: "get_fork_messages";
    }
  | {
      id?: string;
      type: "get_last_assistant_text";
    }
  | {
      id?: string;
      type: "set_session_name";
      name: string;
    }
  | {
      id?: string;
      type: "get_messages";
    }
  | {
      id?: string;
      type: "get_commands";
    };

// ── RpcSlashCommand (supporting) ──────────────────────────────────────
//
// Vendored together with `RpcSessionState` because both are nested
// inside `RpcResponse` payloads and live in the same upstream file.
// `sourceInfo` is `unknown` (private upstream type).

export interface RpcSlashCommand {
  /** Command name (without leading slash) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** What kind of command this is */
  source: "extension" | "prompt" | "skill";
  /** Source metadata for the owning resource (`SourceInfo` — erased) */
  sourceInfo: unknown;
}

// ── RpcSessionState ───────────────────────────────────────────────────

export interface RpcSessionState {
  // `Model<any>` — Model is parameterised over the API kind upstream;
  // we don't constrain TApi here.
  model?: Model<any>;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

// ── RpcResponse ───────────────────────────────────────────────────────
//
// Discriminated on `command` (success) plus a catch-all failure
// variant. `data` payloads use `unknown` for upstream-private types
// (`BashResult`, `CompactionResult`, `SessionStats`).

export type RpcResponse =
  | {
      id?: string;
      type: "response";
      command: "prompt";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "steer";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "follow_up";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "abort";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "new_session";
      success: true;
      data: { cancelled: boolean };
    }
  | {
      id?: string;
      type: "response";
      command: "get_state";
      success: true;
      data: RpcSessionState;
    }
  | {
      id?: string;
      type: "response";
      command: "set_model";
      success: true;
      data: Model<any>;
    }
  | {
      id?: string;
      type: "response";
      command: "cycle_model";
      success: true;
      data: {
        model: Model<any>;
        thinkingLevel: ThinkingLevel;
        isScoped: boolean;
      } | null;
    }
  | {
      id?: string;
      type: "response";
      command: "get_available_models";
      success: true;
      data: { models: Model<any>[] };
    }
  | {
      id?: string;
      type: "response";
      command: "set_thinking_level";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "cycle_thinking_level";
      success: true;
      data: { level: ThinkingLevel } | null;
    }
  | {
      id?: string;
      type: "response";
      command: "set_steering_mode";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "set_follow_up_mode";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "compact";
      success: true;
      // Upstream: CompactionResult — erased to unknown per vendoring
      // policy (private to pi's `./core/compaction/`).
      data: unknown;
    }
  | {
      id?: string;
      type: "response";
      command: "set_auto_compaction";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "set_auto_retry";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "abort_retry";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "bash";
      success: true;
      // Upstream: BashResult — erased to unknown per vendoring policy.
      data: unknown;
    }
  | {
      id?: string;
      type: "response";
      command: "abort_bash";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "get_session_stats";
      success: true;
      // Upstream: SessionStats — erased to unknown per vendoring policy.
      data: unknown;
    }
  | {
      id?: string;
      type: "response";
      command: "export_html";
      success: true;
      data: { path: string };
    }
  | {
      id?: string;
      type: "response";
      command: "switch_session";
      success: true;
      data: { cancelled: boolean };
    }
  | {
      id?: string;
      type: "response";
      command: "fork";
      success: true;
      data: { text: string; cancelled: boolean };
    }
  | {
      id?: string;
      type: "response";
      command: "clone";
      success: true;
      data: { cancelled: boolean };
    }
  | {
      id?: string;
      type: "response";
      command: "get_fork_messages";
      success: true;
      data: { messages: Array<{ entryId: string; text: string }> };
    }
  | {
      id?: string;
      type: "response";
      command: "get_last_assistant_text";
      success: true;
      data: { text: string | null };
    }
  | {
      id?: string;
      type: "response";
      command: "set_session_name";
      success: true;
    }
  | {
      id?: string;
      type: "response";
      command: "get_messages";
      success: true;
      data: { messages: AgentMessage[] };
    }
  | {
      id?: string;
      type: "response";
      command: "get_commands";
      success: true;
      data: { commands: RpcSlashCommand[] };
    }
  | {
      id?: string;
      type: "response";
      command: string;
      success: false;
      error: string;
    };

// ── RpcExtensionUIRequest ─────────────────────────────────────────────
//
// Emitted by the sub-agent whenever an extension calls `ctx.ui.*`
// while running under `--mode rpc`. The sub-agent is BLOCKED until
// the conductor responds.

export type RpcExtensionUIRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText: string | undefined;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    };

// ── RpcExtensionUIResponse ────────────────────────────────────────────
//
// Conductor → sub-agent reply for an `extension_ui_request`. v0.12
// always uses the `cancelled: true` shape (Risk 2 always-cancel-and-warn
// policy — see design §4.2).

export type RpcExtensionUIResponse =
  | {
      type: "extension_ui_response";
      id: string;
      value: string;
    }
  | {
      type: "extension_ui_response";
      id: string;
      confirmed: boolean;
    }
  | {
      type: "extension_ui_response";
      id: string;
      cancelled: true;
    };
