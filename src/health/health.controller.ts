import { Controller, Get, HttpCode, HttpStatus, Res } from "@nestjs/common";
import { Response } from "express";
import { Public } from "../auth/public.decorator";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get()
  getHealth() {
    return {
      status: "ok",
      protocol: "Refract",
      deprecated: true,
      message: "Use /health/live or /health/ready",
    };
  }

  @Public()
  @Get("live")
  @HttpCode(HttpStatus.OK)
  getLiveness() {
    return this.healthService.getLiveness();
  }

  @Public()
  @Get("ready")
  async getReadiness(@Res({ passthrough: true }) res: Response) {
    const result = await this.healthService.getReadiness();
    res.status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }

  @Get("detail")
  async getDetail() {
    return this.healthService.getDetail();
  }
}
