import { Controller, Get, HttpCode, HttpStatus, Res } from "@nestjs/common";
import { Response } from "express";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth() {
    return { status: "ok", protocol: "Refract" };
  }

  @Get("live")
  @HttpCode(HttpStatus.OK)
  getLiveness() {
    return this.healthService.getLiveness();
  }

  @Get("ready")
  async getReadiness(@Res({ passthrough: true }) response: Response) {
    const result = await this.healthService.getReadiness();
    response.status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }

  @Get("detail")
  getDetail() {
    return this.healthService.getDetail();
  }
}
