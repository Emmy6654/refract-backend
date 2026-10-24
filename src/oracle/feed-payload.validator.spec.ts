import { FeedPayloadValidator, InvalidFeedPayloadError } from "./feed-payload.validator";

describe("FeedPayloadValidator", () => {
  it("rejects missing fields, out-of-range values, and unexpected units", () => {
    const validator = new FeedPayloadValidator();

    expect(() =>
      validator.validateAndRemember("coingecko-usdc", {
        price: 4,
        unit: "EUR",
      }),
    ).toThrow(InvalidFeedPayloadError);
    expect(() =>
      validator.validateAndRemember("coingecko-usdc", {
        price: 1,
      }),
    ).toThrow(/required field unit is missing/);
  });

  it("rejects an excessive step change without updating the accepted baseline", () => {
    const validator = new FeedPayloadValidator();
    validator.validateAndRemember("coingecko-usdc", { price: 1, unit: "USD" });

    expect(() =>
      validator.validateAndRemember("coingecko-usdc", { price: 0.7, unit: "USD" }),
    ).toThrow(/changed by more than 0.2/);

    expect(() =>
      validator.validateAndRemember("coingecko-usdc", { price: 0.9, unit: "USD" }),
    ).not.toThrow();
  });

  it("rejects categorical values outside the configured set", () => {
    const validator = new FeedPayloadValidator();

    expect(() =>
      validator.validateAndRemember("aviationstack", {
        flightNumber: "RF123",
        delayMinutes: 0,
        status: "unknown",
        unit: "minutes",
      }),
    ).toThrow(/status must be one of scheduled, delayed, cancelled/);
  });

  it("validates every numeric entry in array-valued provider fields", () => {
    const validator = new FeedPayloadValidator();

    expect(() =>
      validator.validateAndRemember("defillama-aave", {
        unit: "USD",
        tvl: [{ date: 1, totalLiquidityUSD: -10 }],
      }),
    ).toThrow(/tvl\[\]\.totalLiquidityUSD/);
  });
});
