import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsInt,
  Min,
  Max,
  Matches,
  Length,
  IsObject,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { IsStellarPublicKey } from "../../common/validators/stellar-address.validator";

@ValidatorConstraint({ name: "triggerParams", async: false })
class TriggerParamsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value !== "object" || Array.isArray(value)) return false;

    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 8) return false;

    return entries.every(([key, entryValue]) => {
      if (typeof key !== "string" || key.length === 0 || key.length > 64) return false;
      if (typeof entryValue === "string") return entryValue.length > 0 && entryValue.length <= 256;
      if (typeof entryValue === "number" || typeof entryValue === "boolean") return Number.isFinite(entryValue);
      return false;
    });
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a flat object of scalar values with at most 8 keys`;
  }
}

export class BuyPolicyDto {
  @IsString()
  @Length(56, 56)
  @IsStellarPublicKey()
  holder!: string;

  @IsString()
  @IsNotEmpty()
  policyId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  premium?: number;

  @IsInt()
  @Min(0)
  @Max(4)
  coverageType!: number;

  /** USDC amount in 1e7 base units, passed as a decimal string to avoid precision loss. */
  @IsString()
  @Matches(/^\d+$/)
  coverageAmount!: string;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @IsOptional()
  @IsObject()
  @ValidateIf((obj) => obj.triggerParams !== undefined)
  @Validate(TriggerParamsConstraint)
  triggerParams?: Record<string, unknown>;
}

/**
 * Request body for the read-only policy purchase preflight.
 *
 * Mirrors the fields `BuyPolicyDto` needs to evaluate every contract-enforced
 * condition (capacity, utilization, coverage bounds, duration, premium balance)
 * without building or returning an XDR.
 */
export class PreflightPolicyDto extends BuyPolicyDto {}
