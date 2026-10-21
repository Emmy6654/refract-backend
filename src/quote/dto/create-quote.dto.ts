import { IsEnum, IsInt, IsNumber, IsOptional, Min } from "class-validator";
import { IsWithinCoverageLimits } from "../../common/validators/coverage-limits.validator";
import { CoverageTypeName } from "../coverage-type";

export class CreateQuoteDto {
  @IsEnum(CoverageTypeName)
  @IsWithinCoverageLimits()
  coverageType!: CoverageTypeName;

  @IsNumber()
  @Min(0)
  coverageAmount!: number;

  @IsInt()
  @Min(1)
  durationDays!: number;

  @IsOptional()
  @IsNumber()
  triggerThreshold?: number;
}
