import { createMiCallSDK } from './index.js';

const IIFE_NAMESPACE_MARKER = '@mitek/webrtc';
const IIFE_VERSION = '0.0.0';

interface MiCallGlobalNamespace {
  readonly namespace: typeof IIFE_NAMESPACE_MARKER;
  readonly version: typeof IIFE_VERSION;
  readonly createMiCallSDK: typeof createMiCallSDK;
}

type MiCallGlobalScope = typeof globalThis & {
  MiCall?: unknown;
};

const scope = globalThis as MiCallGlobalScope;
const existingNamespace = scope.MiCall;

if (existingNamespace === undefined) {
  const namespace: MiCallGlobalNamespace = Object.freeze({
    namespace: IIFE_NAMESPACE_MARKER,
    version: IIFE_VERSION,
    createMiCallSDK,
  });
  Object.defineProperty(scope, 'MiCall', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: namespace,
  });
} else if (!isCompatibleNamespace(existingNamespace)) {
  throw new Error(
    '[MiCall:SDK] globalThis.MiCall already exists and is not a compatible MiCall SDK namespace.',
  );
}

function isCompatibleNamespace(value: unknown): value is MiCallGlobalNamespace {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<MiCallGlobalNamespace>;
  return (
    candidate.namespace === IIFE_NAMESPACE_MARKER &&
    candidate.version === IIFE_VERSION &&
    typeof candidate.createMiCallSDK === 'function'
  );
}
