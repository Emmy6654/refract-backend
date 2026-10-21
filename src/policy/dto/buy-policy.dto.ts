import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";
import { IsStellarPublicKey } from "../../common/validators/stellar-address.validator";

export class BuyPolicyDto {
  @IsString()
  @Length(56, 56)
  @IsStellarPublicKey()
  holder!: string;

  @IsInt()
  @Min(0)
  @Max(4)
  coverageType!: number;

  @IsString()
  @Matches(/^\d+$/)
  coverageAmount!: string;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @IsOptional()
  @IsObject()
  triggerParams?: Record<string, unknown>;
}

export class PreflightPolicyDto extends BuyPolicyDto {}
