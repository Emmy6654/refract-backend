import {
  IsInt,
  IsObject,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { IsStellarPublicKey } from "../../common/validators/stellar-address.validator";

@ValidatorConstraint({ name: "isFlatTriggerParams", async: false })
class IsFlatTriggerParamsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= 8 && entries.every(
      ([key, field]) =>
        key.length > 0 &&
        key.length <= 64 &&
        (typeof field === "string" || typeof field === "number" || typeof field === "boolean") &&
        (typeof field !== "string" || field.length <= 256)
    );
  }

  defaultMessage(): string {
    return "triggerParams must be a flat object containing at most 8 scalar values";
  }
}

export class BuyPolicyDto {
  @IsString()
  @IsNotEmpty()
  @IsStellarPublicKey()
  holder!: string;

  @IsInt()
  @Min(0)
  @Max(4)
  coverageType!: number;

  /** Coverage in 1e7 USDC base units, represented as a decimal string. */
  @IsString()
  @Matches(/^\d+$/)
  @MaxLength(38)
  coverageAmount!: string;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @Validate(IsFlatTriggerParamsConstraint)
  triggerParams?: Record<string, unknown>;
}

/**
 * Request body for the read-only policy purchase preflight.
 *
 * Mirrors the fields `BuyPolicyDto` needs to evaluate every contract-enforced
 * condition (capacity, utilization, coverage bounds, duration, premium balance)
 * without building or returning an XDR.
 */
export class PreflightPolicyDto {
  @IsString()
  @IsNotEmpty()
  @IsStellarPublicKey()
  @Length(56, 56)
  holder!: string;

  @IsInt()
  @Min(0)
  @Max(4)
  coverageType!: number;

  /** USDC amount in 1e7 base units, passed as a decimal string to avoid precision loss. */
  @IsString()
  @Matches(/^\d+$/)
  @MaxLength(38)
  coverageAmount!: string;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @Validate(IsFlatTriggerParamsConstraint)
  triggerParams?: Record<string, unknown>;
}
