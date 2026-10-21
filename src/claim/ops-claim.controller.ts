import { Controller, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { AdminApiKeyGuard, AdminOnly } from "../common/admin-auth";
import { SecurityAudit } from "../common/security-audit.interceptor";
import { ClaimService } from "./claim.service";

@ApiExcludeController()
@Controller("api/v1/ops/claims")
@UseGuards(AdminApiKeyGuard)
@AdminOnly()
export class OpsClaimController {
  constructor(private readonly claimService: ClaimService) {}

  @Post("scan")
  @SecurityAudit("claims.ops.scan")
  scan() {
    return this.claimService.processTriggered();
  }
}
