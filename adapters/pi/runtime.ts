/**
 * pear's session logic, with no pi imports.
 *
 * The pi extension is a thin wiring layer over this; porting pear to another
 * harness means re-implementing that layer, not this file. Everything here is
 * synchronous and injectable so the whole state machine is testable without a
 * host.
 *
 * Three rules drive the design:
 *
 * 1. **A hook must never wait for a human.** Blocking decisions are computed
 *    synchronously and returned. Waiting happens inside a pear tool, which is
 *    allowed to take as long as the human needs.
 * 2. **Nothing is ever aborted.** The v1 implementation called pi's
 *    `ctx.abort()` when blocking, which killed the agent run so the model never
 *    saw the explanation. Blocks are ordinary tool results here.
 * 3. **No card answer parks the agent.** Every answer produces a resolution
 *    immediately. "Walk me through a file" is a resolution too — it hands the
 *    agent an instruction and relies on it calling back, rather than holding the
 *    tool open while the human reads.
 */

import { createCheckpoint, type Checkpoint, type FileState } from "../../core/checkpoint.ts";
import { loadTier, type LoadTier, type Mode } from "../../core/config.ts";
import { estimateChange } from "../../core/load.ts";
import {
  BLOCK_HUMAN_DRIVER,
  BLOCK_PAUSED,
  BLOCK_SCOPING,
  BLOCK_STOPPED,
  RESULT_ALREADY_PENDING,
  RESULT_ASK_DISMISSED,
  RESULT_CHECKPOINT_NO_PLAN,
  RESULT_CHECKPOINT_NOT_DRIVING,
  RESULT_CONTINUE,
  RESULT_DISMISSED,
  RESULT_MODE_OFF,
  RESULT_OFF,
  RESULT_PLAN_ALREADY_APPROVED,
  RESULT_PLAN_APPROVED,
  RESULT_PLAN_DISMISSED,
  RESULT_PLAN_KEEP_EXPLORING,
  RESULT_STOP,
  blockExplaining,
  blockOverBudget,
  formatPlan,
  nagDue,
  nagSoft,
  resultAnswer,
  resultExplain,
  resultPlanRevise,
  resultSteering,
  statusLine,
  type PlanSpec,
} from "../../core/prompts.ts";

/**
 * Scoping is read-only and building is not. The phase is also what decides
 * which persona is injected and which tools are in phase.
 */
export type Phase = "scoping" | "building";

/**
 * Who is holding the keyboard. Orthogonal to `phase`: both drivers scope the
 * same way, and only the building phase differs between them.
 *
 * `driver` is derived from the mode rather than stored separately, except that
 * `/pear-swap` can flip it mid-session without touching what is on disk.
 */
export type Driver = "agent" | "human";

export type BlockDecision = { block: true; reason: string } | undefined;

/** What the human chose at a checkpoint, or why there was no choice. */
export type CheckpointAnswer =
  | { kind: "continue" }
  | { kind: "explain"; file: string }
  | { kind: "steer"; text: string }
  | { kind: "stop" }
  | { kind: "dismissed" }
  | { kind: "mode-off" };

export type PlanAnswer =
  | { kind: "approve" }
  | { kind: "revise"; text: string }
  | { kind: "explore" }
  | { kind: "dismissed" }
  | { kind: "mode-off" };

export type AskAnswer =
  | { kind: "answer"; text: string }
  | { kind: "dismissed" }
  | { kind: "mode-off" };

/**
 * Every teardown path resolves a card the same way, whichever kind is open.
 * Both members are present in all three answer unions, so teardown never has to
 * know what it is cancelling.
 */
export type TeardownAnswer = { kind: "dismissed" } | { kind: "mode-off" };

export type Resolution = {
  /** Text handed back to the model as the tool result. */
  text: string;
  /** Ask the host to end the agent loop after this tool batch. */
  terminate: boolean;
};

/**
 * A card awaiting the human. One at a time, whatever its kind.
 *
 * The owning tool races `promise` against its own UI, then calls `settle` with
 * whichever answer won. Both are idempotent, so the tool never has to work out
 * whether it or a teardown path got there first.
 */
export type Pending<A> = {
  promise: Promise<A>;
  /** Release the slot and resolve with a real answer from the card. */
  settle: (answer: A) => void;
};

export type CardKind = "ask" | "plan" | "checkpoint";

type PendingSlot = {
  kind: CardKind;
  /** Resolve the open card with a teardown answer, whatever its kind. */
  teardown: (answer: TeardownAnswer) => void;
};

/** `{ pending }` when a card should be shown, `{ immediate }` when it should not. */
export type CardStart<A> = { pending: Pending<A> } | { immediate: Resolution };

export type SettledReport = {
  /** Review load left unacknowledged at the run boundary. */
  points: number;
  /** The file the human asked to be walked through, if that never happened. */
  awaitingExplanation: string | null;
};

export type RuntimeDeps = {
  mode: Mode;
  reviewBudget: number;
  /** Whether a fresh session starts in scoping. */
  planPhase: boolean;
  /** Capture current file state; returns null when git is unavailable. */
  captureFiles: () => FileState | null;
  now?: () => number;
};

export type PearRuntime = {
  readonly mode: Mode;
  readonly driver: Driver;
  readonly phase: Phase;
  /** True while pear has asked the human to explain and is waiting. */
  readonly quizzing: boolean;
  /** True once the human has replied to the outstanding quiz. */
  readonly quizAnswered: boolean;
  readonly plan: PlanSpec | null;
  /** How many plan proposals have been shown this scoping round. */
  readonly planDrafts: number;
  readonly stopped: boolean;
  readonly paused: boolean;
  readonly explaining: string | null;
  readonly reviewBudget: number;
  readonly checkpoint: Checkpoint;
  isCardPending: () => boolean;
  tier: () => LoadTier;

  setMode: (mode: Mode) => void;
  setBudget: (points: number) => void;
  /** Hand the keyboard over, keeping the plan and the session. */
  swap: () => Driver;
  /**
   * Human-driver's load comes from git rather than tool inputs, so the host
   * pushes measurements in. Keeps this module free of subprocesses.
   */
  setWorkingTreeLoad: (points: number) => void;
  /** Enter the quizzing state; the next human message carries the diff. */
  beginQuiz: () => void;
  /**
   * The human replied to the quiz. A quiz spans *two* agent runs — the one pear
   * starts to ask the question, and the one their answer starts — so the first
   * run settling must not end it.
   */
  onQuizReply: () => void;
  /** The human answered (or declined). The agent has seen the diff either way. */
  endQuiz: () => void;
  /** Adopt a plan recovered from session history, without re-approving it. */
  restorePlan: (plan: PlanSpec) => void;
  /** Return to scoping. The last approved plan is kept for reference. */
  replan: () => void;
  /** The approved plan as the model and `/pear-plan` see it. */
  planText: () => string | null;

  onMutatingToolCall: (
    toolName: string,
    callId: string,
    input: Record<string, unknown>,
  ) => BlockDecision;
  /**
   * Settle a tool call. Returns a note to append to the model-visible result,
   * or undefined when there is nothing to say.
   */
  onToolResult: (callId: string, isError: boolean) => string | undefined;
  /** Terminal run boundary: sweep orphans and clear run-scoped state. */
  onAgentSettled: () => SettledReport;
  /** Genuine user input (not extension-injected) clears every hold. */
  onUserInput: () => void;

  beginAsk: () => CardStart<AskAnswer>;
  beginPlan: () => CardStart<PlanAnswer>;
  beginCheckpoint: () => CardStart<CheckpointAnswer>;
  /** Resolve whatever card is open. Idempotent; later calls no-op. */
  resolvePending: (answer: TeardownAnswer) => void;

  applyAskAnswer: (answer: AskAnswer) => Resolution;
  applyPlanAnswer: (answer: PlanAnswer, plan: PlanSpec) => Resolution;
  applyCheckpointAnswer: (answer: CheckpointAnswer) => Resolution;

  statusText: () => string;
  filesSinceBaseline: () => { files: string[]; verified: boolean };
};

export function createRuntime(deps: RuntimeDeps): PearRuntime {
  const now = deps.now ?? (() => Date.now());
  let mode: Mode = deps.mode;
  let budget = deps.reviewBudget;
  let phase: Phase = deps.planPhase ? "scoping" : "building";
  let plan: PlanSpec | null = null;
  /** Seeded from the mode; `swap()` moves it without touching the mode. */
  let driver: Driver = deps.mode === "human-driver" ? "human" : "agent";
  let quizzing = false;
  let quizAnswered = false;
  /** How many plan proposals have been shown this scoping round. */
  let planDrafts = 0;
  /** Human-driver's load, pushed in by the host from git. */
  let treeLoad = 0;

  /** Latched by "stop"; cleared only by real user input. */
  let stopped = false;
  /** Set when the human walked away from a card; cleared at the run boundary. */
  let paused = false;
  /** Set while the human is being walked through a file. */
  let explaining: string | null = null;

  let pending: PendingSlot | null = null;

  const checkpoint = createCheckpoint(deps.captureFiles() ?? new Map());

  /** Re-baseline to the current tree. Called whenever the human acknowledges. */
  const rebaseline = (): void => {
    checkpoint.reset(deps.captureFiles() ?? new Map());
  };

  /**
   * Review load, from whichever source is authoritative for the current driver.
   * The agent's comes from priced tool inputs; the human's from git, because
   * their edits arrive through no tool call at all.
   */
  const points = (): number =>
    driver === "human" ? treeLoad : checkpoint.snapshot().points;
  const tier = (): LoadTier => loadTier(points(), budget);

  const resolvePending = (answer: TeardownAnswer): void => {
    pending?.teardown(answer);
  };

  /** Shared body of the three `begin*` calls. */
  function open<A>(kind: CardKind, blocked: Resolution | undefined): CardStart<A> {
    if (mode === "off") {
      return { immediate: { text: RESULT_OFF, terminate: false } };
    }
    if (blocked !== undefined) return { immediate: blocked };
    if (pending !== null) {
      // Reject rather than queue: a second card would race the first for the
      // same answer, and the model should wait for the answer it asked for.
      return { immediate: { text: RESULT_ALREADY_PENDING, terminate: false } };
    }

    let resolve!: (answer: A) => void;
    const promise = new Promise<A>((res) => {
      resolve = res;
    });

    const settle = (answer: A): void => {
      // Compare identity rather than null-ness: a slot opened by a *later* card
      // must not be closed by a straggler from an earlier one.
      if (pending !== slot) return;
      pending = null;
      resolve(answer);
    };

    const slot: PendingSlot = {
      kind,
      // Both teardown answers are members of every answer union, so this is
      // sound for all three card kinds. The generic cannot express "A always
      // includes TeardownAnswer", which is why the cast is here and not at the
      // call sites.
      teardown: (answer) => settle(answer as unknown as A),
    };
    pending = slot;

    return { pending: { promise, settle } };
  }

  return {
    get mode() {
      return mode;
    },
    get driver() {
      return driver;
    },
    get phase() {
      return phase;
    },
    get quizzing() {
      return quizzing;
    },
    get quizAnswered() {
      return quizAnswered;
    },
    get plan() {
      return plan;
    },
    get planDrafts() {
      return planDrafts;
    },
    get stopped() {
      return stopped;
    },
    get paused() {
      return paused;
    },
    get explaining() {
      return explaining;
    },
    get reviewBudget() {
      return budget;
    },
    get checkpoint() {
      return checkpoint;
    },
    isCardPending: () => pending !== null,
    tier,

    setMode(next) {
      if (next === mode) return;
      mode = next;
      driver = next === "human-driver" ? "human" : "agent";
      stopped = false;
      paused = false;
      explaining = null;
      quizzing = false;
      quizAnswered = false;
      treeLoad = 0;
      planDrafts = 0;
      phase = deps.planPhase ? "scoping" : "building";
      plan = null;
      // An open card belongs to the mode that opened it.
      resolvePending({ kind: "mode-off" });
      checkpoint.reset(next === "agent-driver" ? (deps.captureFiles() ?? new Map()) : new Map());
    },

    setBudget(next) {
      budget = next;
    },

    swap() {
      driver = driver === "agent" ? "human" : "agent";
      // A swap is a clean handover: whatever the previous driver was part-way
      // through is not the new one's to answer for. Same teardown as setMode,
      // minus the plan, which is the whole point of swapping rather than
      // restarting.
      stopped = false;
      paused = false;
      explaining = null;
      quizzing = false;
      quizAnswered = false;
      treeLoad = 0;
      resolvePending({ kind: "mode-off" });
      rebaseline();
      return driver;
    },

    setWorkingTreeLoad(next) {
      treeLoad = next;
    },

    beginQuiz() {
      quizzing = true;
      quizAnswered = false;
    },

    onQuizReply() {
      if (quizzing) quizAnswered = true;
    },

    endQuiz() {
      // Acknowledgement inverts here: in agent-driver the human acknowledges by
      // answering a card, but in human-driver the *agent* is the navigator, so
      // what matters is that it saw the diff. It did, even if the human replied
      // "not now" — so this clears regardless of what they said.
      quizzing = false;
      quizAnswered = false;
      treeLoad = 0;
      rebaseline();
    },

    restorePlan(next) {
      plan = next;
      planDrafts = 0;
      phase = "building";
      treeLoad = 0;
      rebaseline();
    },

    replan() {
      phase = "scoping";
      stopped = false;
      paused = false;
      explaining = null;
      quizzing = false;
      quizAnswered = false;
      treeLoad = 0;
      planDrafts = 0;
      rebaseline();
    },

    planText() {
      return plan === null ? null : formatPlan(plan);
    },

    onMutatingToolCall(toolName, callId, input) {
      if (mode === "off") return undefined;

      // `estimateChange` is the single source of truth for "does this mutate":
      // read-only bash and every non-mutating tool price as undefined.
      const cost = estimateChange(toolName, input);
      if (cost === undefined) return undefined;

      // Nothing may be changed before a plan is approved. edit/write are also
      // removed from the tool set in scoping; this is the backstop, and the only
      // thing standing between a mutating bash command and the working tree.
      if (phase === "scoping") return { block: true, reason: BLOCK_SCOPING };

      // The agent never edits while the human drives. Same backstop reasoning,
      // and it is what makes change attribution unnecessary: anything that
      // appears in the working tree is the human's by construction.
      if (driver === "human") return { block: true, reason: BLOCK_HUMAN_DRIVER };

      // The human's explicit decisions outrank the budget: they are about this
      // moment, whereas the budget is an accounting threshold.
      if (stopped) return { block: true, reason: BLOCK_STOPPED };
      if (paused) return { block: true, reason: BLOCK_PAUSED };
      if (explaining !== null) return { block: true, reason: blockExplaining(explaining) };

      // Admit-first: the tier is computed from the load accrued *before* this
      // call, so a single oversized change always executes and the block lands
      // on the next one. Blocking on this call's own estimate would force a
      // checkpoint with nothing yet to review.
      const before = points();
      if (loadTier(before, budget) === "blocked") {
        return { block: true, reason: blockOverBudget(before, budget) };
      }

      checkpoint.admit(callId, toolName, cost, now());
      return undefined;
    },

    onToolResult(callId, isError) {
      const outcome = checkpoint.settle(callId, !isError);
      // Only admitted mutating calls are nagged. A failed call changed nothing,
      // so its load was released and there is nothing new to report.
      if (outcome !== "confirmed") return undefined;
      // A card already open, or an active hold, says everything the nag would.
      if (pending !== null || stopped || paused || explaining !== null) return undefined;

      const total = points();
      switch (loadTier(total, budget)) {
        case "quiet":
          return undefined;
        case "soft":
          return nagSoft(total, budget);
        default:
          // "due" and "blocked" get the same firm note; the difference between
          // them is that the next call is refused outright.
          return nagDue(total, budget);
      }
    },

    onAgentSettled() {
      checkpoint.sweepStale();
      // `paused` is a backstop for the run that was torn down, so it expires
      // with that run. `stopped` and `explaining` are the human's standing
      // instructions and survive until they say otherwise.
      paused = false;
      return { points: points(), awaitingExplanation: explaining };
    },

    onUserInput() {
      stopped = false;
      paused = false;
      explaining = null;
      // `quizzing` is deliberately NOT cleared here: the input hook needs it
      // still set so it can attach the diff to this very message. `endQuiz`
      // clears it once the turn settles.
    },

    beginAsk() {
      // Asking is always in phase: it is how the agent gets unstuck, so gating
      // it would be a way to wedge the loop.
      return open<AskAnswer>("ask", undefined);
    },

    beginPlan() {
      const start = open<PlanAnswer>(
        "plan",
        phase === "building"
          ? { text: RESULT_PLAN_ALREADY_APPROVED, terminate: false }
          : undefined,
      );
      // A proposal is only a proposal if a card is actually going to be shown.
      if ("pending" in start) planDrafts += 1;
      return start;
    },

    beginCheckpoint() {
      // Checking in is the driver's job. When the human is driving there is
      // nothing for the agent to report, so this is out of phase rather than
      // merely unnecessary.
      const blocked =
        phase === "scoping"
          ? { text: RESULT_CHECKPOINT_NO_PLAN, terminate: false }
          : driver === "human"
            ? { text: RESULT_CHECKPOINT_NOT_DRIVING, terminate: false }
            : undefined;
      const start = open<CheckpointAnswer>("checkpoint", blocked);
      // Re-showing the card is what ends the walkthrough, so edits are no
      // longer held once the human is looking at their options again.
      if ("pending" in start) explaining = null;
      return start;
    },

    resolvePending,

    applyAskAnswer(answer) {
      switch (answer.kind) {
        case "answer":
          return { text: resultAnswer(answer.text), terminate: false };
        case "dismissed":
          paused = true;
          return { text: RESULT_ASK_DISMISSED, terminate: true };
        case "mode-off":
          return { text: RESULT_MODE_OFF, terminate: false };
      }
    },

    applyPlanAnswer(answer, proposed) {
      switch (answer.kind) {
        case "approve":
          plan = proposed;
          phase = "building";
          planDrafts = 0;
          // Anything changed while scoping (there should be nothing) is not the
          // agent's to answer for, so the build window starts clean.
          rebaseline();
          return { text: RESULT_PLAN_APPROVED, terminate: false };
        case "revise":
          return { text: resultPlanRevise(answer.text), terminate: false };
        case "explore":
          return { text: RESULT_PLAN_KEEP_EXPLORING, terminate: false };
        case "dismissed":
          paused = true;
          return { text: RESULT_PLAN_DISMISSED, terminate: true };
        case "mode-off":
          return { text: RESULT_MODE_OFF, terminate: false };
      }
    },

    applyCheckpointAnswer(answer) {
      switch (answer.kind) {
        case "continue":
          rebaseline();
          return { text: RESULT_CONTINUE, terminate: false };

        case "explain":
          // Deliberately no rebaseline: the human has not accepted anything
          // yet, so the same change set must still be there when they come
          // back to answer.
          explaining = answer.file;
          return { text: resultExplain(answer.file), terminate: false };

        case "steer":
          // They saw the change set before typing this, so it counts as
          // acknowledged. Their corrections become the next window's delta.
          rebaseline();
          return { text: resultSteering(answer.text), terminate: false };

        case "stop":
          rebaseline();
          stopped = true;
          // `terminate` ends the agent loop at the host level; the latch is the
          // guarantee if the host declines (e.g. a mixed tool batch).
          return { text: RESULT_STOP, terminate: true };

        case "dismissed":
          // No rebaseline and no latch. The turn ends, but the human has not
          // said stop — anything they type next just carries on.
          paused = true;
          return { text: RESULT_DISMISSED, terminate: true };

        case "mode-off":
          return { text: RESULT_MODE_OFF, terminate: false };
      }
    },

    statusText() {
      if (mode === "off") return statusLine(mode, phase, 0, budget);
      const flags: string[] = [];
      if (stopped) flags.push("stopped");
      if (quizzing) flags.push("awaiting your explanation");
      if (explaining !== null) flags.push(`reviewing ${explaining}`);
      else if (paused) flags.push("paused");
      if (pending !== null) flags.push("awaiting you");
      if (phase === "scoping" && planDrafts > 0) flags.push(`draft ${planDrafts}`);
      return statusLine(mode, phase, points(), budget, flags.length ? flags.join(", ") : undefined);
    },

    filesSinceBaseline() {
      const current = deps.captureFiles();
      if (current === null) return { files: [], verified: false };
      return { files: checkpoint.filesSinceBaseline(current), verified: true };
    },
  };
}
