// A flow that sends several transactions, step by step. A wallet this page holds no key for asks its
// owner to approve each one in its own app, so someone who approved one must be told that another is
// coming, and when; a key this page holds signs without asking. Each step says what it is, its place
// in the flow and whether it waits on the wallet, and the one under way says what it waits on now.
// The flows in engine.ts report this, and the page draws it.

export type StepState = 'todo' | 'current' | 'done' | 'failed' | 'skipped';

/** A step as a flow names it. */
export interface FlowStep {
  id: string;
  /** What it does, in the words the wallet is shown. */
  title: string;
  /** Whether it is a transaction the wallet signs. A step that waits for something to show signs nothing. */
  signs: boolean;
  /** Done by an earlier attempt, which this one carries on from: nothing is signed for it now. */
  earlier?: boolean;
}

/** A step as the page shows it. */
export interface StepView extends FlowStep {
  state: StepState;
  /** Its place in the flow, from 1. */
  number: number;
  /** Whether it waits on the wallet's approval: a step it signs, unless this page holds the key. */
  waitsOnWallet: boolean;
  /** For a step that waits on the wallet: which of the flow's approvals it is, from 1. */
  approval?: number;
}

export interface StepProgress {
  /** Every step, in order, as known now: one the plan did not foresee is added in its place, and one it did not need is skipped. */
  steps: StepView[];
  /** How many steps the flow takes, as known now. */
  total: number;
  /** How many of them wait on the wallet. */
  approvals: number;
  /** Whether a wallet approves each transaction. False for a key this page holds, which signs without asking. */
  walletApproves: boolean;
  /** The step under way. */
  current?: StepView;
  /** What the step under way waits on now: this page building it, the wallet's approval, or its sending. */
  waiting?: 'page' | 'wallet' | 'network';
  /** How many times the wallet has been asked during the step under way: more than once if it is asked again. */
  asked: number;
  /** The flow is through, or stopped. */
  over: boolean;
  /** Set when a step failed: what went out, and what to do next. */
  failure?: { step?: string; sent: string; next: string };
}

/** A step as a tracker keeps it, with how many transactions left the page while it ran. */
export interface TrackedStep {
  step: FlowStep;
  state: StepState;
  sent: number;
}

/**
 * What a flow says of a failed step: what went out, and what to do next. `began` is false for a
 * step that failed before it began, as a check made before its transaction is built can. Undefined
 * says nothing.
 */
export type DescribeFailure = (
  failed: TrackedStep | undefined, steps: readonly TrackedStep[], began: boolean,
) => { sent: string; next: string } | undefined;

export class StepTracker {
  private entries: TrackedStep[] = [];
  private at = -1;
  private waiting: StepProgress['waiting'];
  private asked = 0;
  private from: number;
  private failure: StepProgress['failure'];
  private over = false;

  /**
   * `sends` counts the transactions that have left the page, as the provider every step sends
   * through counts them. `order` is where a step the plan did not foresee goes among the others.
   */
  constructor(
    readonly walletApproves: boolean,
    private readonly sends: () => number,
    private readonly emit: (progress: StepProgress) => void = () => {},
    private readonly order: readonly string[] = [],
  ) {
    this.from = sends();
  }

  /** The steps the flow expects, before the first begins. */
  plan(steps: readonly FlowStep[]): void {
    this.entries = steps.map((step) => ({ step, state: step.earlier ? 'done' : 'todo', sent: 0 }));
    this.publish();
  }

  /** A step begins. The one before it is through, and a planned one before it that never began was not needed. */
  start(step: FlowStep): void {
    if (this.at >= 0 && this.entries[this.at].step.id === step.id) {
      this.waiting = 'page';
      this.publish();
      return;
    }
    this.settle('done');
    let index = this.entries.findIndex((entry) => entry.step.id === step.id && entry.state === 'todo');
    if (index < 0) {
      const rank = (id: string) => {
        const place = this.order.indexOf(id);
        return place < 0 ? this.order.length : place;
      };
      index = this.entries.findIndex((entry) => entry.state === 'todo' && rank(entry.step.id) > rank(step.id));
      if (index < 0) index = this.entries.length;
      this.entries.splice(index, 0, { step, state: 'todo', sent: 0 });
    }
    for (const entry of this.entries.slice(0, index)) if (entry.state === 'todo') entry.state = 'skipped';
    this.entries[index] = { step, state: 'current', sent: 0 };
    this.at = index;
    this.waiting = 'page';
    this.asked = 0;
    this.from = this.sends();
    this.publish();
  }

  /** The step `id` is through, if it is the one under way. */
  done(id: string): void {
    if (this.at < 0 || this.entries[this.at].step.id !== id) return;
    this.settle('done');
    this.publish();
  }

  /** The wallet is asked to approve the step under way, the first time or again. */
  asking(): void {
    if (this.at < 0) return;
    this.waiting = 'wallet';
    this.asked += 1;
    this.publish();
  }

  /** The wallet approved, and the step goes on to send. */
  answered(): void {
    if (this.at < 0) return;
    this.waiting = 'network';
    this.publish();
  }

  /** Every step is through. One planned that never began was not needed. */
  finish(): void {
    this.settle('done');
    for (const entry of this.entries) if (entry.state === 'todo') entry.state = 'skipped';
    this.over = true;
    this.publish();
  }

  /** The step under way failed, or between steps, the one about to begin. */
  fail(describe?: DescribeFailure): void {
    let failed: TrackedStep | undefined;
    const began = this.at >= 0;
    if (began) {
      failed = this.entries[this.at];
      this.settle('failed');
    } else {
      failed = this.entries.find((entry) => entry.state === 'todo');
      if (failed) {
        failed.state = 'failed';
        failed.sent = this.sends() - this.from;
      }
    }
    const words = describe?.(failed, this.entries, began);
    if (words) this.failure = { ...(failed ? { step: failed.step.id } : {}), ...words };
    this.over = true;
    this.publish();
  }

  /** The flow as it stands. */
  progress(): StepProgress {
    let approvals = 0;
    const steps = this.entries.map((entry, index): StepView => {
      const waitsOnWallet = this.walletApproves && entry.step.signs && !entry.step.earlier;
      return {
        ...entry.step,
        state: entry.state,
        number: index + 1,
        waitsOnWallet,
        ...(waitsOnWallet && entry.state !== 'skipped' ? { approval: ++approvals } : {}),
      };
    });
    return {
      steps,
      total: steps.length,
      approvals,
      walletApproves: this.walletApproves,
      ...(this.at >= 0 ? { current: steps[this.at], waiting: this.waiting } : {}),
      asked: this.asked,
      over: this.over,
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  private settle(state: StepState): void {
    if (this.at < 0) return;
    const entry = this.entries[this.at];
    entry.state = state;
    entry.sent = this.sends() - this.from;
    this.at = -1;
    this.waiting = undefined;
    this.asked = 0;
    this.from = this.sends();
  }

  private publish(): void {
    this.emit(this.progress());
  }
}
