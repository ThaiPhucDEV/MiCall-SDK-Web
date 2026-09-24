import {
  MiCallApiClient,
  MiCallApiError,
  createMiCallConfigFromSipAccount,
  createMiCallSDK,
  type MiCallBrowserSDK,
  type Unsubscribe,
} from '@mitek/webrtc';
import './styles.css';

// Vite forwards this same-origin path to https://api-portal-02.mipbx.vn.
// Production hosts must provide an equivalent reverse proxy.
const LOGIN_API_BASE_URL = '/api-portal/api/v1/';
const HOST_STATE_LOGGING_ENABLED = true;
const REMEMBERED_EMAIL_STORAGE_KEY = 'micall.quick-start.email';
const apiClient = new MiCallApiClient({ baseUrl: LOGIN_API_BASE_URL });

const loginForm = getElement<HTMLFormElement>('login-form');
const emailInput = getElement<HTMLInputElement>('email');
const passwordInput = getElement<HTMLInputElement>('password');
const loginButton = getElement<HTMLButtonElement>('login-button');
const loginStatus = getElement<HTMLElement>('login-status');
const loginView = getElement<HTMLElement>('login-view');
const phoneView = getElement<HTMLElement>('phone-view');
const accountEmailLabel = getElement<HTMLElement>('account-email');
const extensionLabel = getElement<HTMLElement>('extension');
const transportState = getElement<HTMLElement>('transport-state');
const registrationState = getElement<HTMLElement>('registration-state');
const callState = getElement<HTMLElement>('call-state');
const pageVisibilityState = getElement<HTMLElement>('page-visibility-state');
const notificationState = getElement<HTMLElement>('notification-state');
const ringtoneState = getElement<HTMLElement>('ringtone-state');
const enableNotificationsButton = getElement<HTMLButtonElement>('enable-notifications-button');
const destinationInput = getElement<HTMLInputElement>('destination');
const callButton = getElement<HTMLButtonElement>('call-button');
const eventLog = getElement<HTMLUListElement>('event-log');

emailInput.value = readRememberedEmail();

let sdk: MiCallBrowserSDK | undefined;
let eventSubscriptions: Unsubscribe[] = [];

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void loginAndRegister();
});

callButton.addEventListener('click', () => void makeCall());
enableNotificationsButton.addEventListener('click', () => void enableIncomingCallNotifications());
getElement<HTMLButtonElement>('logout-button').addEventListener('click', () => void logout());

window.addEventListener('pagehide', () => {
  passwordInput.value = '';
});
document.addEventListener('visibilitychange', updateBrowserAttentionState);
updateBrowserAttentionState();

async function loginAndRegister(): Promise<void> {
  if (sdk !== undefined) return;

  setLoginBusy(true);
  showLoginStatus('Đang đăng nhập…');
  let newSdk: MiCallBrowserSDK | undefined;
  const email = emailInput.value.trim();

  try {
    const session = await apiClient.login({
      email,
      password: passwordInput.value,
    });
    passwordInput.value = '';
    showLoginStatus('Đăng nhập thành công. Đang đăng ký SIP…');

    const sipConfig = createMiCallConfigFromSipAccount(session.sipAccount);
    newSdk = await createMiCallSDK({
      ...sipConfig,
      incomingHeaders: {
        allowlist: [
          'X-My-Extra-Callid',
          'X-My-Extra-Id',
          'X-My-Extra-Camid',
          'X-My-Extra-Acw',
          'X-My-Extra-Info',
        ],
      },
      ui: {
        defaultCallScreen: true,
        loggingEnabled: true,
      },
    });

    sdk = newSdk;
    bindSdkEvents(newSdk);

    const registration = waitForRegistration(newSdk);
    try {
      await Promise.all([newSdk.start(), registration.promise]);
    } finally {
      registration.cancel();
    }

    rememberEmail(email);
    accountEmailLabel.textContent = email;
    extensionLabel.textContent = session.sipAccount.extension;
    loginView.hidden = true;
    phoneView.hidden = false;
    updateRuntimeState();
    addEvent('SIP đã đăng ký thành công');
  } catch (error) {
    passwordInput.value = '';
    showLoginStatus(formatError(error), 'error');
    if (newSdk !== undefined) await destroySdk(newSdk);
    sdk = undefined;
  } finally {
    setLoginBusy(false);
  }
}

function bindSdkEvents(instance: MiCallBrowserSDK): void {
  eventSubscriptions = [
    instance.on('transportStateChanged', ({ state }) => {
      transportState.textContent = state;
      updateRuntimeState();
    }),
    instance.on('registrationStateChanged', ({ previousState, state }) => {
      logSdkState('Registration', state, previousState);
      registrationState.textContent = state;
      addEvent(`Registration: ${state}`);
      updateRuntimeState();
    }),
    instance.on('incomingCall', ({ snapshot }) => {
      logSdkState('Call', snapshot.state);
      addEvent('Có cuộc gọi đến');
      updateRuntimeState();
    }),
    instance.on('callStateChanged', ({ previousState, state }) => {
      logSdkState('Call', state, previousState);
      addEvent(`Call: ${state}`);
      updateRuntimeState();
    }),
    instance.on('callEnded', ({ reason }) => {
      logHostSdkEvent(`Call ended: ${reason}`);
      addEvent(`Cuộc gọi kết thúc: ${reason}`);
      updateRuntimeState();
    }),
    instance.on('audioUnlockRequired', () => {
      ringtoneState.textContent = 'blocked';
      addEvent('Browser đang chặn chuông hoặc call audio.', 'error');
    }),
    instance.on('error', ({ code, message }) => {
      addEvent(`Lỗi SDK ${code}: ${message}`, 'error');
      updateRuntimeState();
    }),
  ];
}

async function makeCall(): Promise<void> {
  const destination = destinationInput.value.trim();
  if (sdk === undefined || destination.length === 0) {
    addEvent('Hãy nhập số máy cần gọi.', 'error');
    destinationInput.focus();
    return;
  }

  callButton.disabled = true;
  try {
    const call = await sdk.makeCall(destination);
    logSdkState('Call', call.state);
    updateRuntimeState();
  } catch (error) {
    addEvent(formatError(error), 'error');
    updateRuntimeState();
  }
}

function logSdkState(scope: 'Call' | 'Registration', state: string, previousState?: string): void {
  const transition = previousState === undefined ? state : `${previousState} -> ${state}`;
  logHostSdkEvent(`${scope} state: ${transition}`);
}

function logHostSdkEvent(message: string): void {
  if (!HOST_STATE_LOGGING_ENABLED) {
    return;
  }
  console.info(`[MiCall:Host] ${message}`);
}

async function logout(): Promise<void> {
  const activeSdk = sdk;
  sdk = undefined;
  if (activeSdk !== undefined) await destroySdk(activeSdk);

  forgetRememberedEmail();
  emailInput.value = '';
  passwordInput.value = '';
  destinationInput.value = '';
  eventLog.replaceChildren();
  accountEmailLabel.textContent = '—';
  extensionLabel.textContent = '—';
  transportState.textContent = 'stopped';
  registrationState.textContent = 'unregistered';
  callState.textContent = 'none';
  ringtoneState.textContent = 'locked/unknown';
  callButton.disabled = true;
  phoneView.hidden = true;
  loginView.hidden = false;
  showLoginStatus('Đã đăng xuất.');
  emailInput.focus();
}

function readRememberedEmail(): string {
  try {
    return globalThis.localStorage.getItem(REMEMBERED_EMAIL_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberEmail(email: string): void {
  try {
    globalThis.localStorage.setItem(REMEMBERED_EMAIL_STORAGE_KEY, email);
  } catch {
    // Login vẫn hoạt động khi browser chặn persistent storage.
  }
}

function forgetRememberedEmail(): void {
  try {
    globalThis.localStorage.removeItem(REMEMBERED_EMAIL_STORAGE_KEY);
  } catch {
    // Logout vẫn tiếp tục cleanup SDK và UI khi storage không khả dụng.
  }
}

async function enableIncomingCallNotifications(): Promise<void> {
  try {
    const notificationPermission = requestNotificationPermission();
    const audioUnlock = sdk?.unlockAudio();
    const [permission, audioResult] = await Promise.all([
      notificationPermission,
      audioUnlock ?? Promise.resolve(undefined),
    ]);

    if (audioResult !== undefined) {
      ringtoneState.textContent = audioResult.status;
      addEvent(
        audioResult.status === 'unlocked'
          ? 'Đã mở khóa chuông và call audio.'
          : `Audio unlock: ${audioResult.status}.`,
        audioResult.status === 'unlocked' ? undefined : 'error',
      );
    }
    updateBrowserAttentionState();
    if (permission !== 'unsupported') {
      addEvent(
        permission === 'granted'
          ? 'Đã bật thông báo cuộc gọi khi tab bị ẩn.'
          : 'Chưa được cấp quyền thông báo cuộc gọi.',
        permission === 'granted' ? undefined : 'error',
      );
    }
  } catch {
    updateBrowserAttentionState();
    ringtoneState.textContent = 'blocked';
    addEvent('Không thể mở khóa chuông hoặc yêu cầu quyền notification.', 'error');
  }
}

function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) {
    return Promise.resolve('unsupported');
  }
  if (Notification.permission !== 'default') {
    return Promise.resolve(Notification.permission);
  }
  return Notification.requestPermission();
}

function updateBrowserAttentionState(): void {
  pageVisibilityState.textContent = document.visibilityState;
  if (!('Notification' in window)) {
    notificationState.textContent = 'unsupported';
    // Audio unlock vẫn sử dụng được dù browser không hỗ trợ system notification.
    enableNotificationsButton.disabled = false;
    return;
  }
  notificationState.textContent = Notification.permission;
  enableNotificationsButton.disabled = false;
}

async function destroySdk(instance: MiCallBrowserSDK): Promise<void> {
  for (const unsubscribe of eventSubscriptions.splice(0)) unsubscribe();
  try {
    await instance.destroy();
  } catch {
    // The example has already returned to a safe disconnected state.
  }
}

function waitForRegistration(instance: MiCallBrowserSDK): {
  readonly promise: Promise<void>;
  cancel(): void;
} {
  let settled = false;
  const subscriptions: Unsubscribe[] = [];
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;

  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const timeout = globalThis.setTimeout(() => {
    finish(() => rejectPromise?.(new Error('SIP REGISTER quá thời gian chờ.')));
  }, 30_000);

  function finish(completion?: () => void): void {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timeout);
    for (const unsubscribe of subscriptions) unsubscribe();
    completion?.();
  }

  subscriptions.push(
    instance.on('registrationStateChanged', ({ state }) => {
      if (state === 'registered') finish(resolvePromise);
      if (state === 'failed') {
        finish(() => rejectPromise?.(new Error('Tổng đài từ chối đăng ký SIP.')));
      }
    }),
    instance.on('error', ({ code, message }) => {
      if (
        code === 'AUTHENTICATION_FAILED' ||
        code === 'REGISTRATION_FAILED' ||
        code === 'TRANSPORT_FAILED'
      ) {
        finish(() => rejectPromise?.(new Error(message)));
      }
    }),
  );

  return {
    promise,
    cancel: () => finish(),
  };
}

function updateRuntimeState(): void {
  if (sdk === undefined) return;
  const snapshot = sdk.getSnapshot();
  transportState.textContent = snapshot.transportState;
  registrationState.textContent = snapshot.registrationState;
  const activeCall = [...snapshot.calls].reverse().find((call) => call.state !== 'ended');
  if (activeCall !== undefined) {
    callState.textContent = activeCall.state;
  } else {
    const lastCall = snapshot.calls.at(-1);
    callState.textContent =
      lastCall !== undefined && lastCall.state === 'ended'
        ? `ended (${lastCall.endReason ?? 'unknown'})`
        : 'none';
  }
  callButton.disabled = snapshot.registrationState !== 'registered' || activeCall !== undefined;
}

function setLoginBusy(isBusy: boolean): void {
  emailInput.disabled = isBusy;
  passwordInput.disabled = isBusy;
  loginButton.disabled = isBusy;
  loginButton.textContent = isBusy ? 'Đang xử lý…' : 'Đăng nhập';
}

function showLoginStatus(message: string, state?: 'error'): void {
  loginStatus.textContent = message;
  if (state === undefined) delete loginStatus.dataset.state;
  else loginStatus.dataset.state = state;
}

function addEvent(message: string, state?: 'error'): void {
  const item = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const text = document.createElement('span');
  text.textContent = message;
  if (state !== undefined) item.dataset.state = state;
  item.append(time, text);
  eventLog.prepend(item);
  while (eventLog.childElementCount > 20) eventLog.lastElementChild?.remove();
}

function formatError(error: unknown): string {
  if (error instanceof MiCallApiError && error.code === 'NETWORK') {
    return 'Không kết nối được Login API. Hãy chạy example bằng lệnh pnpm example để sử dụng Vite proxy.';
  }
  if (error instanceof Error) return error.message;
  return 'Đã xảy ra lỗi không xác định.';
}

function getElement<ElementType extends Element>(id: string): ElementType {
  const match = document.getElementById(id);
  if (match === null) throw new Error(`Missing quick-start element: #${id}`);
  return match as ElementType;
}
