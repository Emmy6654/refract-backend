import {
  IsInt,
  IsObject,
  IsNotEmpty,
  IsString,
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

export class PreflightPolicyDto {
  @IsString()
  @IsNotEmpty()
  @IsStellarPublicKey()
  holder!: string;

  @IsInt()
  @Min(0)
  @Max(4)
  coverageType!: number;

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
