import { Injectable } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { DbService } from "../db/db.service";

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DbService,
    private readonly cache: CacheService,
  ) {}

  getLiveness(): { status: "ok" } {
    return { status: "ok" };
  }

  async getReadiness() {
    const [postgres, redis] = await Promise.all([
      Promise.resolve(this.database.isAvailable()),
      this.cache.ping(),
    ]);
    return {
      ready: postgres && redis,
      dependencies: { postgres, redis },
    };
  }

  getDetail() {
    return {
      status: "ok",
      dependencies: {
        postgres: this.database.isAvailable(),
        redis: this.cache.isConnected(),
      },
    };
  }
}
