import { OracleScheduler } from "./oracle.scheduler";

describe("OracleScheduler", () => {
  it("registers the refresh cron job on startup", async () => {
    const refreshPrices = jest.fn().mockResolvedValue(undefined);
    const registry = {
      addCronJob: jest.fn(),
      doesExist: jest.fn().mockReturnValue(false),
      deleteCronJob: jest.fn(),
    };
    const protocolParameters = {
      getNumber: jest.fn().mockResolvedValue(30),
    };

    const scheduler = new OracleScheduler(
      { refreshPrices } as any,
      registry as any,
      protocolParameters as any,
    );

    await scheduler.onModuleInit();

    expect(protocolParameters.getNumber).toHaveBeenCalled();
    expect(registry.addCronJob).toHaveBeenCalledWith("oracle-refresh", expect.any(Object));
  });
});
