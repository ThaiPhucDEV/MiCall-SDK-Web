import { MiCallError, type MiCallConsumerClient } from '@micall/core';
import { MiCallCallScreen } from './call-screen.js';

export const DEFAULT_CALL_SCREEN_TAG = 'micall-call-screen';

export type CallScreenTheme = Readonly<Record<`--micall-${string}`, string>>;
export type CallScreenSlotName = 'brand-logo' | 'footer';

export const defaultTokens: CallScreenTheme = Object.freeze({
  '--micall-color-primary': '#0ea5e9',
  '--micall-color-bg': '#111827',
  '--micall-color-surface': '#1f2937',
  '--micall-color-text': '#ffffff',
  '--micall-color-text-muted': '#9ca3af',
  '--micall-radius-lg': '16px',
  '--micall-radius-full': '9999px',
  '--micall-avatar-size': '96px',
  '--micall-font-family': 'system-ui, sans-serif',
  '--micall-button-accept-bg': '#22c55e',
  '--micall-button-reject-bg': '#ef4444',
  '--micall-button-neutral-bg': '#374151',
  '--micall-network-good': '#22c55e',
  '--micall-network-fair': '#f59e0b',
  '--micall-network-poor': '#ef4444',
  '--micall-z-index': '2147483000',
} as const);

export interface CreateCallScreenOptions {
  readonly client: MiCallConsumerClient;
  readonly tagName?: string;
  readonly mountTarget?: ParentNode;
  readonly theme?: CallScreenTheme;
  readonly loggingEnabled?: boolean;
}

export interface CallScreenHandle {
  readonly element: MiCallCallScreen;
  mount(target?: ParentNode): void;
  unmount(): void;
  show(): void;
  hide(): void;
  setTheme(theme: CallScreenTheme): void;
  setSlotContent(slotName: CallScreenSlotName, content: Node | string | undefined): void;
  destroy(): void;
}

const registeredTags = new Set<string>();

export function defineCallScreen(tagName: string = DEFAULT_CALL_SCREEN_TAG): CustomElementConstructor {
  if (typeof globalThis.customElements === 'undefined') {
    throw new MiCallError(
      'UI_UNAVAILABLE',
      'Custom Elements are unavailable in the current environment.',
    );
  }
  const normalizedTag = normalizeTagName(tagName);
  const existing = globalThis.customElements.get(normalizedTag);
  if (existing !== undefined) {
    if (existing === MiCallCallScreen || existing.prototype instanceof MiCallCallScreen) {
      registeredTags.add(normalizedTag);
      return existing;
    }
    throw new MiCallError(
      'UI_TAG_CONFLICT',
      `Custom element '${normalizedTag}' is already registered by another implementation.`,
    );
  }

  const constructor =
    normalizedTag === DEFAULT_CALL_SCREEN_TAG && !registeredTags.has(DEFAULT_CALL_SCREEN_TAG)
      ? MiCallCallScreen
      : class RegisteredMiCallScreen extends MiCallCallScreen {};
  globalThis.customElements.define(normalizedTag, constructor);
  registeredTags.add(normalizedTag);
  return constructor;
}

export function createCallScreen(options: CreateCallScreenOptions): CallScreenHandle {
  if (typeof globalThis.document === 'undefined') {
    throw new MiCallError(
      'UI_UNAVAILABLE',
      'Call Screen can only be created in a browser document.',
    );
  }
  const tagName = normalizeTagName(options.tagName ?? DEFAULT_CALL_SCREEN_TAG);
  defineCallScreen(tagName);
  const element = globalThis.document.createElement(tagName) as MiCallCallScreen;
  element.client = options.client;
  element.logger.enabled = options.loggingEnabled ?? true;
  element.logger.info(`Call Screen created with tag <${tagName}>.`);

  const slots = new Map<CallScreenSlotName, HTMLElement>();
  const setTheme = (theme: CallScreenTheme): void => {
    for (const [token, value] of Object.entries(theme)) {
      if (!token.startsWith('--micall-')) {
        continue;
      }
      element.style.setProperty(token, value);
    }
  };
  if (options.theme !== undefined) {
    setTheme(options.theme);
  }

  let destroyed = false;
  const handle: CallScreenHandle = {
    element,
    mount(target = options.mountTarget ?? globalThis.document.body): void {
      if (destroyed) {
        throw new MiCallError('UI_UNAVAILABLE', 'Cannot mount a destroyed Call Screen.');
      }
      if (element.parentNode === target) {
        return;
      }
      target.append(element);
    },
    unmount(): void {
      element.remove();
    },
    show(): void {
      element.show();
    },
    hide(): void {
      element.hide();
    },
    setTheme,
    setSlotContent(slotName, content): void {
      slots.get(slotName)?.remove();
      slots.delete(slotName);
      if (content === undefined) {
        return;
      }
      const node =
        typeof content === 'string' ? globalThis.document.createTextNode(content) : content;
      if (node instanceof HTMLElement) {
        node.slot = slotName;
        element.append(node);
        slots.set(slotName, node);
        return;
      }
      const wrapper = globalThis.document.createElement('span');
      wrapper.slot = slotName;
      wrapper.append(node);
      element.append(wrapper);
      slots.set(slotName, wrapper);
    },
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      slots.clear();
      element.destroy();
    },
  };
  return handle;
}

function normalizeTagName(tagName: string): string {
  const normalized = tagName.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(normalized)) {
    throw new MiCallError('INVALID_CONFIG', `Invalid custom-element tag name '${tagName}'.`);
  }
  return normalized;
}

export { MiCallCallScreen } from './call-screen.js';
export { MiCallUILogger } from './ui-logger.js';
