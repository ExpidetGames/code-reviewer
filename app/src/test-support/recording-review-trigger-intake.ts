// A test double for the review trigger intake: it remembers every trigger it was given, and can be
// told to fail or to take its time. Use it wherever code under test hands triggers over.
import type { Integration, ReviewTrigger } from "../integrations/types.ts";
import type {
  ReviewTriggerIntake,
  ReviewTriggerSource,
} from "../webhooks/review-trigger-intake.ts";

export type RecordingReviewTriggerIntake = ReviewTriggerIntake & {
  /** Every trigger handed over successfully, in order. */
  readonly triggers: ReviewTrigger[];
  /** The integration that came with each trigger. */
  readonly integrations: Integration[];
  /** The delivery each trigger came from. */
  readonly sources: ReviewTriggerSource[];
  /** Every call, including the ones that failed. */
  readonly calls: number;
  /** Makes the next calls reject with this error, until `recover`. */
  failWith(error: Error): void;
  recover(): void;
  /** Makes every call wait this long before it records the trigger. */
  delay(ms: number): void;
};

export function createRecordingReviewTriggerIntake(): RecordingReviewTriggerIntake {
  const triggers: ReviewTrigger[] = [];
  const integrations: Integration[] = [];
  const sources: ReviewTriggerSource[] = [];
  let calls = 0;
  let failure: Error | undefined;
  let delayMs = 0;

  return {
    triggers,
    integrations,
    sources,
    get calls() {
      return calls;
    },
    failWith(error) {
      failure = error;
    },
    recover() {
      failure = undefined;
    },
    delay(ms) {
      delayMs = ms;
    },
    async enqueueReviewTrigger(trigger, integration, source) {
      calls++;
      if (delayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failure !== undefined) throw failure;
      triggers.push(trigger);
      integrations.push(integration);
      sources.push(source);
    },
  };
}
