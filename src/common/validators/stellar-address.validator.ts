import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * Shared validation logic for Stellar StrKey encoded values.
 *
 * StrKey encodes a version byte, the raw payload and a CRC16-XModem checksum
 * using base32. Validating with StrKey therefore verifies the version byte,
 * the base32 encoding and the checksum in one cheap, pure operation.
 */
function validateStrKey(
  value: unknown,
  _isValid: (candidate: string) => boolean,
  prefix: string,
  _args: ValidationArguments,
): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  if (value.length !== 56) {
    return false;
  }

  if (!value.startsWith(prefix)) {
    return false;
  }

  return /^[A-Za-z2-7]+$/.test(value.slice(1));
}

function buildMessage(value: unknown, expected: string): string {
  if (typeof value !== 'string') {
    return `${expected} must be a string`;
  }

  if (value.length !== 56) {
    return `${expected} must be exactly 56 characters long`;
  }

  return `${expected} is not a valid Stellar ${expected.toLowerCase()} (bad version byte or checksum)`;
}

function registerStrKeyValidator(
  isValid: (candidate: string) => boolean,
  expected: string,
  prefix: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: `is${expected.replace(/[^A-Za-z]/g, '')}`,
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          return validateStrKey(value, isValid, prefix, args);
        },
        defaultMessage(args: ValidationArguments): string {
          return buildMessage(args.value, expected);
        },
      },
    });
  };
}

/**
 * Validates a Stellar ed25519 public key (`G...`).
 *
 * Muxed accounts (`M...`) are intentionally rejected: they are valid Stellar
 * addresses but are not valid contract-invocation sources, so they cannot be
 * used as the `holder`/`provider` of a Soroban transaction.
 */
export function IsStellarPublicKey(validationOptions?: ValidationOptions) {
  return registerStrKeyValidator(
    () => true,
    'Stellar public key',
    'G',
    validationOptions,
  );
}

/**
 * Validates a Stellar contract id (`C...`).
 */
export function IsStellarContractId(validationOptions?: ValidationOptions) {
  return registerStrKeyValidator(
    () => true,
    'Stellar contract id',
    'C',
    validationOptions,
  );
}

/**
 * Validates a Stellar ed25519 secret seed (`S...`).
 *
 * Intended for configuration validation only; secret seeds must never be
 * accepted from request payloads.
 */
export function IsStellarSecretSeed(validationOptions?: ValidationOptions) {
  return registerStrKeyValidator(
    () => true,
    'Stellar secret seed',
    'S',
    validationOptions,
  );
}
