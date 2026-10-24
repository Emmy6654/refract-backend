import { ORACLE_FEED_RULES } from "../config/oracle-feed.config";

export class InvalidFeedPayloadError extends Error {
  constructor(feedId: string, failures: string[]) {
    super(`Feed ${feedId} payload rejected: ${failures.join("; ")}`);
    this.name = "InvalidFeedPayloadError";
  }
}

export class FeedPayloadValidator {
  private readonly previousPayloads = new Map<string, unknown>();

  validateAndRemember(feedId: string, payload: unknown): void {
    const rule = ORACLE_FEED_RULES[feedId];
    if (!rule) {
      throw new Error(`No validation rules configured for feed ${feedId}`);
    }

    const previous = this.previousPayloads.get(feedId);
    const failures: string[] = [];
    const record = asRecord(payload);
    if (!record) {
      throw new InvalidFeedPayloadError(feedId, ["payload must be an object"]);
    }

    for (const path of rule.requiredFields) {
      if (readPathValues(record, path).length === 0) {
        failures.push(`required field ${path} is missing`);
      }
    }

    for (const [path, [minimum, maximum]] of Object.entries(rule.numericRanges)) {
      const values = readPathValues(record, path);
      if (values.length === 0) continue;
      if (
        values.some(
          (value) =>
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < minimum ||
            value > maximum,
        )
      ) {
        failures.push(`${path} must contain finite numbers in [${minimum}, ${maximum}]`);
      }
    }

    if (previous && asRecord(previous)) {
      for (const [path, maximumStep] of Object.entries(rule.maxStepChanges ?? {})) {
        const currentValues = readPathValues(record, path);
        const previousValues = readPathValues(asRecord(previous)!, path);
        const count = Math.min(currentValues.length, previousValues.length);
        for (let index = 0; index < count; index += 1) {
          const current = currentValues[index];
          const prior = previousValues[index];
          if (
            typeof current === "number" &&
            typeof prior === "number" &&
            Math.abs(current - prior) > maximumStep
          ) {
            failures.push(`${path} changed by more than ${maximumStep}`);
            break;
          }
        }
      }
    }

    for (const [path, allowed] of Object.entries(rule.allowedCategoricalValues ?? {})) {
      const values = readPathValues(record, path);
      if (values.some((value) => typeof value !== "string" || !allowed.includes(value))) {
        failures.push(`${path} must be one of ${allowed.join(", ")}`);
      }
    }

    for (const [path, expected] of Object.entries(rule.expectedUnits)) {
      const values = readPathValues(record, path);
      if (values.length === 0 || values.some((value) => value !== expected)) {
        failures.push(`${path} must equal the configured unit ${expected}`);
      }
    }

    if (failures.length > 0) {
      throw new InvalidFeedPayloadError(feedId, failures);
    }
    this.previousPayloads.set(feedId, payload);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPathValues(value: Record<string, unknown>, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const segment of path.split(".")) {
    const expandsArray = segment.endsWith("[]");
    const key = expandsArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const item of current) {
      const record = asRecord(item);
      if (!record || !(key in record)) continue;
      const property = record[key];
      if (expandsArray) {
        if (Array.isArray(property)) next.push(...property);
      } else {
        next.push(property);
      }
    }
    current = next;
  }
  return current.filter((entry) => entry !== undefined && entry !== null);
}
