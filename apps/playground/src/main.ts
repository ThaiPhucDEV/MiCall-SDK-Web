import {
  MICALL_DOM_EVENT_NAMES,
  createMiCallSDK,
  type AudioDeviceSnapshot,
  type CallSnapshot,
  type MiCallBrowserSDK,
  type MiCallEventMap,
  type MiCallSDKConfig,
  type Unsubscribe,
} from '@mitek/webrtc';
import './styles.css';

const typedEventNames = Object.keys(MICALL_DOM_EVENT_NAMES) as (keyof MiCallEventMap)[];
const sensitiveKey = /authorization|credential|password|secret|token/i;

let sdk: MiCallBrowserSDK | undefined;
let currentCall: CallSnapshot | undefined;
const teardownCallbacks: (() => void)[] = [];

const configForm = element<HTMLFormElement>('#config-form');
const eventLog = element<HTMLOListElement>('#event-log');
const passwordInput = element<HTMLInputElement>('#password');
const sessionState = element<HTMLElement>('#session-state');
const transportState = element<HTMLElement>('#transport-state');
const registrationState = element<HTMLElement>('#registration-state');
const callState = element<HTMLElement>('#call-state');
const visibilityState = element<HTMLElement>('#visibility-state');
const audioState = element<HTMLElement>('#audio-state');
const destroyButton = element<HTMLButtonElement>('#destroy');
const callButton = element<HTMLButtonElement>('#call');
const answerButton = element<HTMLButtonElement>('#answer');
const rejectButton = element<HTMLButtonElement>('#reject');
const hangupButton = element<HTMLButtonElement>('#hangup');
const muteButton = element<HTMLButtonElement>('#mute');
const holdButton = element<HTMLButtonElement>('#hold');
const sendDtmfButton = element<HTMLButtonElement>('#send-dtmf');
const transferButton = element<HTMLButtonElement>('#transfer');
const unlockAudioButton = element<HTMLButtonElement>('#unlock-audio');

visibilityState.textContent = document.visibilityState;
document.addEventListener('visibilitychange', () => {
  visibilityState.textContent = document.visibilityState;
  appendLog('page', 'visibilitychange', { state: document.visibilityState });
});

configForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void createAndStart();
});
configForm.addEventListener('reset', () => queueMicrotask(() => passwordInput.focus()));
destroyButton.addEventListener('click', () => void destroySDK());
element<HTMLButtonElement>('#reset').addEventListener('click', () => {
  passwordInput.value = '';
});
element<HTMLButtonElement>('#clear-log').addEventListener('click', () =>
  eventLog.replaceChildren(),
);
callButton.addEventListener('click', () => void runAction('makeCall', makeCall));
answerButton.addEventListener(
  'click',
  () => void withCall('answerCall', (client, call) => client.answerCall(call.callId)),
);
rejectButton.addEventListener(
  'click',
  () => void withCall('rejectCall', (client, call) => client.rejectCall(call.callId)),
);
hangupButton.addEventListener(
  'click',
  () => void withCall('hangupCall', (client, call) => client.hangupCall(call.callId)),
);
muteButton.addEventListener(
  'click',
  () => void withCall('setMuted', (client, call) => client.setMuted(call.callId, !call.muted)),
);
holdButton.addEventListener(
  'click',
  () => void withCall('setHold', (client, call) => client.setHold(call.callId, !call.localHold)),
);
sendDtmfButton.addEventListener(
  'click',
  () => void withCall('sendDtmf', (client, call) => client.sendDtmf(call.callId, value('#dtmf'))),
);
transferButton.addEventListener(
  'click',
  () =>
    void withCall('blindTransfer', (client, call) =>
      client.blindTransfer(call.callId, value('#transfer-destination')),
    ),
);
unlockAudioButton.addEventListener(
  'click',
  () =>
    void runAction('unlockAudio', async () => {
      if (sdk === undefined) return;
      const result = await sdk.unlockAudio();
      audioState.textContent = result.status;
    }),
);

bindDeviceSelect('#audio-input', (client, id) => client.selectAudioInput(id));
bindDeviceSelect('#call-output', (client, id) => client.selectCallAudioOutput(id));
bindDeviceSelect('#ringtone-output', (client, id) => client.selectRingtoneOutput(id));

window.addEventListener('pagehide', () => {
  passwordInput.value = '';
});

async function createAndStart(): Promise<void> {
  if (sdk !== undefined) {
    appendLog('playground', 'warning', {
      message: 'Destroy instance hiện tại trước khi tạo instance mới.',
    });
    return;
  }
  setConfigBusy(true);
  try {
    const mode = value('#ui-mode');
    const instance = await createMiCallSDK(createConfig(mode));
    sdk = instance;
    bindSDKEvents(instance);
    sessionState.textContent = 'Đang khởi động';
    renderSnapshot();
    await instance.start();
    sessionState.textContent = mode === 'headless' ? 'Headless active' : 'Default UI active';
    appendLog('playground', 'started', { mode, capabilities: instance.getCapabilities() });
  } catch (error) {
    appendError('create/start', error);
    await destroySDK();
  } finally {
    setConfigBusy(false);
    updateControls();
  }
}

function createConfig(mode: string): MiCallSDKConfig {
  const displayName = value('#display-name');
  const ringtoneUrl = value('#ringtone-url');
  const sipInput = value('#sip-uri');
  const sipDomain = value('#sip-domain');
  const sipUri = normalizeSipUri(sipInput, sipDomain);
  const iceServers = value('#ice-servers')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
    .map((urls) => ({ urls }));
  const allowlist = value('#header-allowlist')
    .split(',')
    .map((header) => header.trim())
    .filter(Boolean);
  return {
    sip: {
      uri: sipUri,
      wssServer: value('#wss-server'),
      authorizationUsername: value('#username'),
      authorizationPassword: passwordInput.value,
      ...(displayName === '' ? {} : { displayName }),
      registerExpiresSeconds: 600,
    },
    ...(ringtoneUrl === '' ? {} : { ringtoneUrl }),
    ...(iceServers.length === 0 ? {} : { rtc: { iceServers } }),
    incomingHeaders: { allowlist },
    logging: { level: 'info', enableDiagnosticsBuffer: true },
    ui: {
      defaultCallScreen: mode !== 'headless',
      ...(mode === 'custom'
        ? {
            theme: {
              '--micall-color-primary': '#a3e635',
              '--micall-color-bg': '#11140d',
              '--micall-color-surface': '#222719',
            },
            slots: { 'brand-logo': 'MiCall · Custom Lab', footer: 'PBX staging test' },
          }
        : {}),
    },
  };
}

function normalizeSipUri(sipInput: string, domain: string): string {
  if (sipInput.startsWith('sip:') || sipInput.startsWith('sips:')) return sipInput;
  if (domain === '') {
    throw new Error('PBX domain là bắt buộc khi SIP URI chỉ chứa extension.');
  }
  return `sip:${sipInput}@${domain}`;
}

function bindSDKEvents(instance: MiCallBrowserSDK): void {
  const subscriptions: Unsubscribe[] = [];
  for (const eventName of typedEventNames) {
    subscriptions.push(
      instance.on(eventName, (payload) => {
        handleDomainEvent(eventName, payload);
        appendLog('typed', eventName, payload);
      }),
    );
    const domEventName = MICALL_DOM_EVENT_NAMES[eventName];
    const listener: EventListener = (event) => {
      appendLog('dom', domEventName, (event as CustomEvent<unknown>).detail);
    };
    instance.events.addEventListener(domEventName, listener);
    teardownCallbacks.push(() => instance.events.removeEventListener(domEventName, listener));
  }
  teardownCallbacks.push(...subscriptions);
}

function handleDomainEvent(
  eventName: keyof MiCallEventMap,
  payload: MiCallEventMap[keyof MiCallEventMap],
): void {
  if ('snapshot' in payload && isCallSnapshot(payload.snapshot)) currentCall = payload.snapshot;
  if (eventName === 'callEnded') currentCall = undefined;
  if (eventName === 'audioUnlockRequired') audioState.textContent = 'unlock required';
  if (eventName === 'mediaDevicesChanged' && 'devices' in payload) {
    renderDevices(payload.devices as readonly AudioDeviceSnapshot[]);
  }
  renderSnapshot();
}

async function makeCall(): Promise<void> {
  if (sdk === undefined) return;
  const destination = value('#destination');
  if (destination === '') throw new Error('Destination không được để trống.');
  currentCall = await sdk.makeCall(destination);
  sdk.getCallScreen()?.show();
  renderSnapshot();
}

async function withCall(
  actionName: string,
  action: (client: MiCallBrowserSDK, call: CallSnapshot) => Promise<void>,
): Promise<void> {
  await runAction(actionName, async () => {
    if (sdk === undefined || currentCall === undefined) {
      throw new Error('Không có cuộc gọi hiện tại.');
    }
    await action(sdk, currentCall);
  });
}

async function runAction(actionName: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    appendLog('action', actionName, { status: 'completed' });
  } catch (error) {
    appendError(actionName, error);
  } finally {
    renderSnapshot();
  }
}

async function destroySDK(): Promise<void> {
  const instance = sdk;
  sdk = undefined;
  currentCall = undefined;
  for (const teardown of teardownCallbacks.splice(0)) teardown();
  if (instance !== undefined) {
    try {
      await instance.destroy();
      appendLog('playground', 'destroyed', { status: 'completed' });
    } catch (error) {
      appendError('destroy', error);
    }
  }
  passwordInput.value = '';
  sessionState.textContent = 'Đã destroy';
  transportState.textContent = 'stopped';
  registrationState.textContent = 'unregistered';
  callState.textContent = 'none';
  audioState.textContent = 'locked/unknown';
  renderDevices([]);
  updateControls();
}

function renderSnapshot(): void {
  if (sdk !== undefined) {
    const snapshot = sdk.getSnapshot();
    transportState.textContent = snapshot.transportState;
    registrationState.textContent = snapshot.registrationState;
    currentCall =
      [...snapshot.calls].reverse().find((call) => call.state !== 'ended') ?? currentCall;
    callState.textContent = currentCall?.state ?? 'none';
    muteButton.textContent = currentCall?.muted === true ? 'Unmute' : 'Mute';
    holdButton.textContent = currentCall?.localHold === true ? 'Resume' : 'Hold';
  }
  updateControls();
}

function updateControls(): void {
  const ready = sdk !== undefined;
  const hasCall = currentCall !== undefined && currentCall.state !== 'ended';
  const incoming = currentCall?.state === 'incoming-ringing';
  const active = currentCall?.state === 'active';
  destroyButton.disabled = !ready;
  callButton.disabled = !ready || hasCall;
  answerButton.disabled = !incoming;
  rejectButton.disabled = !incoming;
  hangupButton.disabled = !hasCall;
  muteButton.disabled = !active;
  holdButton.disabled = !active;
  sendDtmfButton.disabled = !active;
  transferButton.disabled = !active;
  unlockAudioButton.disabled = !ready;
}

function setConfigBusy(busy: boolean): void {
  for (const control of configForm.elements) {
    if (
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLButtonElement
    ) {
      control.disabled = busy;
    }
  }
}

function renderDevices(devices: readonly AudioDeviceSnapshot[]): void {
  updateDeviceSelect(
    '#audio-input',
    devices.filter((device) => device.kind === 'audioinput'),
  );
  const outputs = devices.filter((device) => device.kind === 'audiooutput');
  updateDeviceSelect('#call-output', outputs);
  updateDeviceSelect('#ringtone-output', outputs);
}

function updateDeviceSelect(selector: string, devices: readonly AudioDeviceSnapshot[]): void {
  const select = element<HTMLSelectElement>(selector);
  select.replaceChildren(
    new Option(devices.length === 0 ? 'Chưa có thiết bị' : 'Chọn thiết bị', ''),
  );
  devices.forEach((device, index) =>
    select.add(new Option(device.label || `Audio device ${index + 1}`, device.deviceId)),
  );
  select.disabled = sdk === undefined || devices.length === 0;
}

function bindDeviceSelect(
  selector: string,
  selectDevice: (client: MiCallBrowserSDK, deviceId: string) => Promise<void>,
): void {
  element<HTMLSelectElement>(selector).addEventListener('change', (event) => {
    const deviceId = (event.currentTarget as HTMLSelectElement).value;
    if (deviceId !== '') {
      void runAction('selectDevice', async () => {
        if (sdk !== undefined) await selectDevice(sdk, deviceId);
      });
    }
  });
}

function appendLog(channel: string, name: string, payload: unknown): void {
  const item = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const label = document.createElement('strong');
  label.textContent = `${channel} · ${name}`;
  const data = document.createElement('pre');
  data.textContent = JSON.stringify(redact(payload), undefined, 2);
  item.append(time, label, data);
  eventLog.prepend(item);
  while (eventLog.childElementCount > 120) eventLog.lastElementChild?.remove();
}

function appendError(action: string, error: unknown): void {
  appendLog('error', action, {
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}

function redact(valueToRedact: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(valueToRedact)) return valueToRedact.map((item) => redact(item));
  if (typeof valueToRedact === 'object' && valueToRedact !== null) {
    return Object.fromEntries(
      Object.entries(valueToRedact).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ]),
    );
  }
  return valueToRedact;
}

function isCallSnapshot(valueToCheck: unknown): valueToCheck is CallSnapshot {
  return (
    typeof valueToCheck === 'object' &&
    valueToCheck !== null &&
    'callId' in valueToCheck &&
    'state' in valueToCheck
  );
}

function value(selector: string): string {
  return element<HTMLInputElement | HTMLSelectElement>(selector).value.trim();
}

function element<ElementType extends Element>(selector: string): ElementType {
  const match = document.querySelector<ElementType>(selector);
  if (match === null) throw new Error(`Missing playground element: ${selector}`);
  return match;
}
