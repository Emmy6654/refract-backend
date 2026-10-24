import { timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

/**
 * Bearer-token guard for ops-only endpoints that reads `OPS_API_TOKEN`
 * straight from the environment.
 *
 * It is deliberately self-contained (no dependency on the typed AppConfig)
 * so feature modules can protect their ops routes without pulling in the
 * whole configuration tree. It fails closed: when `OPS_API_TOKEN` is unset
 * every request is rejected.
 */
@Injectable()
export class OpsTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configured = process.env.OPS_API_TOKEN?.trim();
    if (!configured) {
      throw new UnauthorizedException({ error: "Ops API token not configured (OPS_API_TOKEN)" });
    }

    const req = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!match || !constantTimeEquals(match[1].trim(), configured)) {
      throw new UnauthorizedException({ error: "Invalid or missing ops bearer token" });
    }
    return true;
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
