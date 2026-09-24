import {
  LitElement,
  html,
  nothing,
  svg,
  type CSSResult,
  type PropertyValues,
  type SVGTemplateResult,
  type TemplateResult,
} from 'lit';
import { property, state } from 'lit/decorators.js';
import type {
  AudioDeviceSnapshot,
  CallNetworkQuality,
  CallSnapshot,
  MiCallConsumerClient,
  MiCallErrorEvent,
  MiCallPublicSnapshot,
  Unsubscribe,
} from '@micall/core';
import { callScreenStyles } from './styles.js';
import { MiCallUILogger } from './ui-logger.js';

const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;
const NETWORK_QUALITY_BARS = [1, 2, 3, 4] as const;
const NETWORK_QUALITY_PRESENTATION: Readonly<
  Record<CallNetworkQuality, { readonly label: string; readonly strength: number }>
> = Object.freeze({
  unknown: { label: 'Đang đo chất lượng mạng', strength: 0 },
  good: { label: 'Mạng ổn định', strength: 4 },
  fair: { label: 'Mạng trung bình', strength: 3 },
  poor: { label: 'Mạng yếu', strength: 1 },
});
const ENDED_VIEW_DURATION_MS = 3_000;
type IconName =
  | 'answer'
  | 'audio'
  | 'copy'
  | 'hangup'
  | 'hold'
  | 'keypad'
  | 'microphone'
  | 'microphone-off'
  | 'minimize'
  | 'transfer';
type MicrophonePermissionState = PermissionState | 'unknown' | 'unavailable';

export class MiCallCallScreen extends LitElement {
  public static override styles: CSSResult = callScreenStyles;

  public readonly logger: MiCallUILogger = new MiCallUILogger();

  @property({ attribute: false })
  public accessor client: MiCallConsumerClient | undefined;

  @property({ type: Boolean })
  public accessor visible = true;

  @state()
  private accessor snapshot: MiCallPublicSnapshot | undefined;

  @state()
  private accessor devices: readonly AudioDeviceSnapshot[] = Object.freeze([]);

  @state()
  private accessor selectedAudioInputId: string | undefined;

  @state()
  private accessor selectedCallAudioOutputId: string | undefined;

  @state()
  private accessor selectedRingtoneOutputId: string | undefined;

  @state()
  private accessor minimized = false;

  @state()
  private accessor dialpadOpen = false;

  @state()
  private accessor devicesOpen = false;

  @state()
  private accessor transferOpen = false;

  @state()
  private accessor transferDestination = '';

  @state()
  private accessor busy = false;

  @state()
  private accessor errorMessage: string | undefined;

  @state()
  private accessor noticeMessage: string | undefined;

  @state()
  private accessor now = Date.now();

  @state()
  private accessor microphonePermissionState: MicrophonePermissionState = 'unknown';

  readonly #subscriptions: Unsubscribe[] = [];
  #timerHandle: ReturnType<typeof globalThis.setInterval> | undefined;
  #endedHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
  #incomingCallNotification: Notification | undefined;
  #previousFocus: Element | null = null;
  #destroyed = false;
  readonly #visibilityChangeListener = (): void => {
    if (this.ownerDocument.visibilityState === 'visible') {
      this.#closeIncomingCallNotification();
      void this.#refreshMicrophonePermissionState();
    }
  };

  public override connectedCallback(): void {
    super.connectedCallback();
    this.#destroyed = false;
    this.ownerDocument.addEventListener('visibilitychange', this.#visibilityChangeListener);
    this.#bindClient();
    this.logger.info('Call Screen mounted.');
    queueMicrotask(() => this.#warnIfHostIsHidden());
  }

  public override disconnectedCallback(): void {
    this.ownerDocument.removeEventListener('visibilitychange', this.#visibilityChangeListener);
    this.#releaseBindings();
    this.#restoreFocus();
    this.logger.info('Call Screen unmounted.');
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has('client')) {
      this.#bindClient();
    }
    if (changed.has('visible') && this.visible) {
      void this.updateComplete.then(() => this.#focusDialog());
    }
  }

  public show(): void {
    if (this.#destroyed) {
      return;
    }
    this.#syncSnapshot();
    this.visible = true;
    this.minimized = false;
    this.logger.info('Call Screen shown.');
  }

  public hide(): void {
    this.visible = false;
    this.#restoreFocus();
    this.logger.info('Call Screen hidden.');
  }

  public destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#releaseBindings();
    this.logger.info('Call Screen destroyed.');
    this.remove();
  }

  protected override render(): TemplateResult | typeof nothing {
    const call = this.#currentCall();
    if (!this.visible || call === undefined) {
      return nothing;
    }
    if (this.minimized && call.state !== 'incoming-ringing') {
      return this.#renderMini(call);
    }
    return html`
      <div class="shell">
        <section
          class="card ${this.#isRinging(call) ? 'ringing' : ''}"
          role="dialog"
          aria-modal="false"
          aria-labelledby="micall-call-title"
          tabindex="-1"
          @keydown=${this.#handleDialogKeydown}
        >
          ${this.#renderTopbar(call)}
          <div class="body">
            ${this.#renderIdentity(call)} ${this.#renderStateNotice(call)}
            ${this.#renderPrimaryView(call)}
          </div>
          <div class="footer"><slot name="footer"></slot></div>
        </section>
      </div>
    `;
  }

  #renderMini(call: CallSnapshot): TemplateResult {
    return html`
      <div class="shell">
        <section
          class="mini"
          role="button"
          tabindex="0"
          aria-label="Mở rộng màn hình cuộc gọi"
          @click=${this.#expand}
          @keydown=${this.#handleMiniKeydown}
        >
          <div class="mini__identity">
            <div class="mini__name">${call.remoteIdentity}</div>
            <div class="mini__timer">${this.#formatDuration(call)}</div>
          </div>
          ${this.#renderNetworkQuality(call)}
          <button
            class="icon-button"
            type="button"
            aria-label=${call.muted ? 'Bật microphone' : 'Tắt microphone'}
            @click=${(event: Event) => {
              event.stopPropagation();
              void this.#setMuted(call, !call.muted);
            }}
          >
            ${this.#icon(call.muted ? 'microphone-off' : 'microphone')}
          </button>
          <button
            class="action action--danger"
            type="button"
            aria-label="Gác máy"
            @click=${(event: Event) => {
              event.stopPropagation();
              void this.#hangup(call);
            }}
          >
            ${this.#icon('hangup')}
          </button>
        </section>
      </div>
    `;
  }

  #renderTopbar(call: CallSnapshot): TemplateResult {
    const canMinimize = call.state === 'active' || call.state === 'establishing';
    return html`
      <div class="topbar">
        <div class="brand">
          <span class="brand__mark"></span><slot name="brand-logo">MiCall</slot>
        </div>
        <div class="topbar__actions">
          ${this.#renderNetworkQuality(call)}
          ${
            call.state === 'active'
              ? html`<button
                  class="icon-button"
                  type="button"
                  aria-label="Chọn thiết bị âm thanh"
                  aria-expanded=${this.devicesOpen}
                  @click=${() => {
                    this.devicesOpen = !this.devicesOpen;
                    this.dialpadOpen = false;
                    this.transferOpen = false;
                  }}
                >
                  ${this.#icon('audio')}
                </button>`
              : nothing
          }
          ${
            canMinimize
              ? html`<button
                  class="icon-button"
                  type="button"
                  aria-label="Thu nhỏ màn hình cuộc gọi"
                  @click=${() => {
                    this.minimized = true;
                  }}
                >
                  ${this.#icon('minimize')}
                </button>`
              : nothing
          }
        </div>
      </div>
    `;
  }

  #renderNetworkQuality(call: CallSnapshot): TemplateResult {
    const quality = call.networkQuality ?? 'unknown';
    const presentation = NETWORK_QUALITY_PRESENTATION[quality];
    const throughput = this.#formatNetworkThroughput(call.networkKilobytesPerSecond);
    return html`
      <span
        class="network-metrics"
        role="img"
        aria-label="${presentation.label}, lưu lượng ${throughput}"
        title="${presentation.label} · ${throughput}"
      >
        <span class="network-quality network-quality--${quality}" aria-hidden="true">
          ${NETWORK_QUALITY_BARS.map(
            (level) => html`<span
              class="network-quality__bar ${level <= presentation.strength ? 'is-active' : ''}"
            ></span>`,
          )}
        </span>
        <span class="network-throughput" aria-hidden="true">${throughput}</span>
      </span>
    `;
  }

  #formatNetworkThroughput(kilobytesPerSecond: number | undefined): string {
    if (kilobytesPerSecond === undefined) {
      return '-- KB/s';
    }
    const value =
      kilobytesPerSecond < 10
        ? kilobytesPerSecond.toFixed(1)
        : String(Math.round(kilobytesPerSecond));
    return `${value} KB/s`;
  }

  #renderIdentity(call: CallSnapshot): TemplateResult {
    const secondaryIdentity = this.#secondaryIdentity(call);
    return html`
      <div class="avatar-wrap">
        <div class="avatar" aria-hidden="true">${this.#initials(call.remoteIdentity)}</div>
        ${
          call.state === 'active' && !call.muted
            ? html`<span class="speaking" title="Microphone đang hoạt động"></span>`
            : nothing
        }
      </div>
      <h2 class="identity" id="micall-call-title">${call.remoteIdentity}</h2>
      ${secondaryIdentity === undefined
        ? nothing
        : html`<div class="remote-address">${secondaryIdentity}</div>`}
      <div class="timer">${call.state === 'active' ? this.#formatDuration(call) : ''}</div>
      <button
        class="icon-button"
        type="button"
        aria-label="Sao chép số điện thoại"
        @click=${() => void this.#copyIdentity(call)}
      >
        ${this.#icon('copy')}
      </button>
      <p class="status" aria-live="polite">${this.#statusLabel(call)}</p>
    `;
  }

  #renderStateNotice(call: CallSnapshot): TemplateResult | typeof nothing {
    return html`
      ${
        this.snapshot?.transportState === 'reconnecting'
          ? html`<div class="notice" role="status">Đang khôi phục kết nối tổng đài…</div>`
          : nothing
      }
      ${
        call.localHold || call.remoteHold
          ? html`<div class="hold-banner" role="status">Đang giữ máy (Call on Hold)</div>`
          : nothing
      }
      ${
        call.state === 'incoming-ringing' &&
        this.microphonePermissionState === 'denied' &&
        this.errorMessage === undefined
          ? html`<div class="error" role="alert">
              Microphone đang bị chặn. Hãy bật quyền Microphone trong Site Settings rồi bấm Nghe
              lại.
            </div>`
          : call.state === 'incoming-ringing' && this.microphonePermissionState === 'prompt'
            ? html`<div class="notice" role="status">
                Bấm Nghe để cấp quyền Microphone cho cuộc gọi.
              </div>`
            : nothing
      }
      ${
        this.noticeMessage === undefined
          ? nothing
          : html`<div class="notice" role="status">
              <span>${this.noticeMessage}</span>
              ${
                this.noticeMessage.includes('Unlock Audio')
                  ? html`<button
                      class="notice__action"
                      type="button"
                      @click=${() => void this.#unlockAudio()}
                    >
                      Unlock Audio
                    </button>`
                  : nothing
              }
            </div>`
      }
      ${
        this.errorMessage === undefined
          ? nothing
          : html`<div class="error" role="alert">${this.errorMessage}</div>`
      }
    `;
  }

  #renderPrimaryView(call: CallSnapshot): TemplateResult {
    if (call.state === 'incoming-ringing') {
      return this.#renderIncoming(call);
    }
    if (
      call.state === 'outgoing-dialing' ||
      call.state === 'outgoing-ringing' ||
      call.state === 'early-media' ||
      call.state === 'establishing'
    ) {
      return this.#renderOutgoing(call);
    }
    if (call.state === 'active') {
      return this.#renderActive(call);
    }
    return this.#renderEnded(call);
  }

  #renderIncoming(call: CallSnapshot): TemplateResult {
    return html`
      <div class="actions">
        <button
          class="action action--accept"
          type="button"
          aria-label="Nghe cuộc gọi"
          ?disabled=${this.busy}
          @click=${() => void this.#answerIncomingCall(call)}
        >
          ${this.#icon('answer')}
        </button>
        <button
          class="action action--danger"
          type="button"
          aria-label="Từ chối cuộc gọi"
          ?disabled=${this.busy}
          @click=${() => void this.#runAction(() => this.client?.rejectCall(call.callId))}
        >
          ${this.#icon('hangup')}
        </button>
      </div>
      <div class="action-labels"><span>Nghe</span><span>Từ chối</span></div>
    `;
  }

  #renderOutgoing(call: CallSnapshot): TemplateResult {
    return html`
      <div class="actions">
        <button
          class="action action--danger"
          type="button"
          aria-label="Hủy cuộc gọi"
          ?disabled=${this.busy}
          @click=${() => void this.#hangup(call)}
        >
          ${this.#icon('hangup')}
        </button>
      </div>
      <div class="action-labels"><span>Hủy</span></div>
    `;
  }

  #renderActive(call: CallSnapshot): TemplateResult {
    return html`
      <div class="toolbar" aria-label="Điều khiển cuộc gọi">
        <button
          class="tool"
          type="button"
          aria-pressed=${call.muted}
          @click=${() => void this.#setMuted(call, !call.muted)}
        >
          <span>${this.#icon(call.muted ? 'microphone-off' : 'microphone')}</span
          ><span class="tool__label">Mute</span>
        </button>
        <button
          class="tool"
          type="button"
          aria-pressed=${call.localHold}
          @click=${() => void this.#runAction(() => this.client?.setHold(call.callId, !call.localHold))}
        >
          <span>${this.#icon('hold')}</span><span class="tool__label">Hold</span>
        </button>
        <button
          class="tool"
          type="button"
          aria-pressed=${this.dialpadOpen}
          @click=${() => {
            this.dialpadOpen = !this.dialpadOpen;
            this.devicesOpen = false;
            this.transferOpen = false;
          }}
        >
          <span>${this.#icon('keypad')}</span><span class="tool__label">Bàn phím</span>
        </button>
        <button
          class="tool"
          type="button"
          aria-pressed=${this.transferOpen}
          @click=${() => {
            this.transferOpen = !this.transferOpen;
            this.devicesOpen = false;
            this.dialpadOpen = false;
          }}
        >
          <span>${this.#icon('transfer')}</span><span class="tool__label">Chuyển</span>
        </button>
      </div>
      <div class="actions">
        <button
          class="action action--danger"
          type="button"
          aria-label="Gác máy"
          @click=${() => void this.#hangup(call)}
        >
          ${this.#icon('hangup')}
        </button>
      </div>
      ${this.dialpadOpen ? this.#renderDialpad(call) : nothing}
      ${this.transferOpen ? this.#renderTransfer(call) : nothing}
      ${this.devicesOpen ? this.#renderDevices() : nothing}
    `;
  }

  #renderDialpad(call: CallSnapshot): TemplateResult {
    return html`
      <div class="sheet" aria-label="Bàn phím DTMF">
        <div class="dialpad">
          ${DTMF_KEYS.map(
            (tone) =>
              html`<button
                class="key"
                type="button"
                aria-label="Gửi DTMF ${tone}"
                @click=${() => void this.#runAction(() => this.client?.sendDtmf(call.callId, tone))}
              >
                ${tone}
              </button>`,
          )}
        </div>
      </div>
    `;
  }

  #renderTransfer(call: CallSnapshot): TemplateResult {
    return html`
      <form class="sheet" @submit=${(event: SubmitEvent) => void this.#submitTransfer(event, call)}>
        <label class="field">
          Số máy cần chuyển
          <span class="transfer-row">
            <input
              inputmode="tel"
              autocomplete="off"
              maxlength="128"
              .value=${this.transferDestination}
              @input=${(event: Event) => {
                this.transferDestination = (event.currentTarget as HTMLInputElement).value;
              }}
            />
            <button class="primary-button" type="submit" ?disabled=${this.busy}>Chuyển</button>
          </span>
        </label>
      </form>
    `;
  }

  #renderDevices(): TemplateResult {
    const inputs = this.devices.filter((device) => device.kind === 'audioinput');
    const outputs = this.devices.filter((device) => device.kind === 'audiooutput');
    return html`
      <div class="device-panel">
        ${this.#renderDeviceSelect('Microphone', inputs, this.selectedAudioInputId, (id) =>
          this.client?.selectAudioInput(id),
        )}
        ${this.#renderDeviceSelect('Loa đàm thoại', outputs, this.selectedCallAudioOutputId, (id) =>
          this.client?.selectCallAudioOutput(id),
        )}
        ${this.#renderDeviceSelect('Loa chuông', outputs, this.selectedRingtoneOutputId, (id) =>
          this.client?.selectRingtoneOutput(id),
        )}
      </div>
    `;
  }

  #renderDeviceSelect(
    label: string,
    devices: readonly AudioDeviceSnapshot[],
    selectedDeviceId: string | undefined,
    select: (deviceId: string) => Promise<void> | undefined,
  ): TemplateResult {
    return html`
      <label class="field">
        ${label}
        <select
          ?disabled=${devices.length === 0}
          .value=${selectedDeviceId ?? ''}
          @change=${(event: Event) =>
            void this.#runAction(() => select((event.currentTarget as HTMLSelectElement).value))}
        >
          <option value="">
            ${devices.length === 0 ? 'Không tìm thấy thiết bị' : 'Chọn thiết bị'}
          </option>
          ${devices.map(
            (device, index) =>
              html`<option value=${device.deviceId}>
                ${device.label || `${label} ${index + 1}`}
              </option>`,
          )}
        </select>
      </label>
    `;
  }

  #renderEnded(call: CallSnapshot): TemplateResult {
    return html`
      <div class="notice" role="status">Cuộc gọi đã kết thúc · ${this.#endReasonLabel(call)}</div>
      <div class="actions">
        <button class="primary-button" type="button" @click=${() => this.hide()}>Đóng</button>
      </div>
    `;
  }

  #bindClient(): void {
    this.#releaseBindings();
    if (!this.isConnected || this.client === undefined || this.#destroyed) {
      return;
    }
    const client = this.client;
    this.snapshot = client.getSnapshot();
    this.#subscriptions.push(
      client.on('transportStateChanged', () => this.#syncSnapshot()),
      client.on('registrationStateChanged', () => this.#syncSnapshot()),
      client.on('incomingCall', (event) => {
        if (this.#endedHandle !== undefined) {
          globalThis.clearTimeout(this.#endedHandle);
          this.#endedHandle = undefined;
        }
        this.errorMessage = undefined;
        this.show();
        void this.#refreshMicrophonePermissionState();
        this.#showIncomingCallNotification(event.callId);
        void this.updateComplete.then(() => this.#focusDialog());
      }),
      client.on('callStateChanged', (event) => {
        this.#closeIncomingCallNotification();
        if (event.state !== 'ended') {
          if (this.#endedHandle !== undefined) {
            globalThis.clearTimeout(this.#endedHandle);
            this.#endedHandle = undefined;
          }
          this.visible = true;
        }
        this.#syncSnapshot();
      }),
      client.on('callEnded', () => {
        this.#closeIncomingCallNotification();
        this.#syncSnapshot();
        this.#scheduleEndedDismissal();
      }),
      client.on('mediaDevicesChanged', (event) => {
        this.devices = event.devices;
        this.selectedAudioInputId = event.selectedAudioInputId;
        this.selectedCallAudioOutputId = event.selectedCallAudioOutputId;
        this.selectedRingtoneOutputId = event.selectedRingtoneOutputId;
      }),
      client.on('audioUnlockRequired', () => {
        this.noticeMessage = 'Trình duyệt đang chặn âm thanh. Hãy bấm Unlock Audio.';
      }),
      client.on('transferStateChanged', (event) => {
        this.noticeMessage =
          event.state === 'initiating'
            ? `Đang chuyển cuộc gọi tới ${event.destination}…`
            : event.state === 'completed'
              ? 'Chuyển cuộc gọi thành công.'
              : 'Không thể chuyển cuộc gọi. Cuộc gọi hiện tại vẫn được giữ.';
      }),
      client.on('callNetworkMetricsChanged', () => this.#syncSnapshot()),
      client.on('error', (event) => this.#showError(event)),
    );
    this.#updateTimer();
  }

  #releaseBindings(): void {
    for (const unsubscribe of this.#subscriptions.splice(0)) {
      unsubscribe();
    }
    if (this.#timerHandle !== undefined) {
      globalThis.clearInterval(this.#timerHandle);
      this.#timerHandle = undefined;
    }
    if (this.#endedHandle !== undefined) {
      globalThis.clearTimeout(this.#endedHandle);
      this.#endedHandle = undefined;
    }
    this.#closeIncomingCallNotification();
  }

  #showIncomingCallNotification(callId: string): void {
    const view = this.ownerDocument.defaultView;
    const NotificationConstructor = view?.Notification;
    if (this.ownerDocument.visibilityState === 'visible') {
      return;
    }
    if (NotificationConstructor === undefined) {
      this.logger.warn('System notification is unavailable in this browser.');
      return;
    }
    if (NotificationConstructor.permission !== 'granted') {
      this.logger.warn(
        `System notification skipped because permission is ${NotificationConstructor.permission}.`,
      );
      return;
    }

    this.#closeIncomingCallNotification();
    try {
      const notification = new NotificationConstructor('Cuộc gọi đến', {
        body: 'Mở tab MiCall để xem và trả lời cuộc gọi.',
        tag: `micall-incoming-call-${callId}`,
        requireInteraction: true,
      });
      this.logger.info('Incoming-call system notification shown.');
      notification.onclick = () => {
        notification.close();
        view.focus();
        this.show();
      };
      notification.onclose = () => {
        if (this.#incomingCallNotification === notification) {
          this.#incomingCallNotification = undefined;
        }
      };
      this.#incomingCallNotification = notification;
    } catch (error) {
      this.logger.warn(
        `System notification could not be shown (${getErrorName(error)}).`,
      );
    }
  }

  #closeIncomingCallNotification(): void {
    this.#incomingCallNotification?.close();
    this.#incomingCallNotification = undefined;
  }

  #syncSnapshot(): void {
    if (this.client === undefined || this.#destroyed) {
      return;
    }
    this.snapshot = this.client.getSnapshot();
    this.#updateTimer();
  }

  #updateTimer(): void {
    if (this.#timerHandle !== undefined) {
      globalThis.clearInterval(this.#timerHandle);
      this.#timerHandle = undefined;
    }
    if (this.#currentCall()?.state !== 'active') {
      return;
    }
    this.now = Date.now();
    this.#timerHandle = globalThis.setInterval(() => {
      this.now = Date.now();
    }, 1_000);
  }

  #scheduleEndedDismissal(): void {
    if (this.#endedHandle !== undefined) {
      globalThis.clearTimeout(this.#endedHandle);
    }
    this.#endedHandle = globalThis.setTimeout(() => {
      this.hide();
      this.#endedHandle = undefined;
    }, ENDED_VIEW_DURATION_MS);
  }

  #currentCall(): CallSnapshot | undefined {
    const calls = this.snapshot?.calls ?? [];
    return [...calls].reverse().find((call) => call.state !== 'ended') ?? calls.at(-1);
  }

  async #runAction(action: () => Promise<unknown> | undefined): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.errorMessage = undefined;
    try {
      await action();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Thao tác không thành công.';
    } finally {
      this.busy = false;
    }
  }

  async #setMuted(call: CallSnapshot, muted: boolean): Promise<void> {
    await this.#runAction(() => this.client?.setMuted(call.callId, muted));
  }

  async #answerIncomingCall(call: CallSnapshot): Promise<void> {
    await this.#runAction(async () => {
      await this.#ensureMicrophoneAccess();
      await this.client?.answerCall(call.callId);
    });
  }

  async #ensureMicrophoneAccess(): Promise<void> {
    const mediaDevices = this.ownerDocument.defaultView?.navigator.mediaDevices;
    if (mediaDevices === undefined) {
      this.microphonePermissionState = 'unavailable';
      throw new Error('Trình duyệt không hỗ trợ truy cập Microphone.');
    }

    let permissionStream: MediaStream;
    try {
      permissionStream = await mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (error) {
      await this.#refreshMicrophonePermissionState();
      if (isMicrophonePermissionDenied(error)) {
        throw new Error(
          'Microphone đang bị chặn. Hãy bật quyền Microphone trong Site Settings rồi bấm Nghe lại.',
        );
      }
      throw new Error('Không thể truy cập Microphone. Hãy kiểm tra thiết bị và thử lại.');
    }

    for (const track of permissionStream.getTracks()) {
      track.stop();
    }
    this.microphonePermissionState = 'granted';
  }

  async #refreshMicrophonePermissionState(): Promise<void> {
    const permissions = this.ownerDocument.defaultView?.navigator.permissions;
    if (permissions === undefined) {
      this.microphonePermissionState = 'unknown';
      return;
    }
    try {
      const status = await permissions.query({ name: 'microphone' as PermissionName });
      this.microphonePermissionState = status.state;
    } catch {
      this.microphonePermissionState = 'unknown';
    }
  }

  async #hangup(call: CallSnapshot): Promise<void> {
    await this.#runAction(() => this.client?.hangupCall(call.callId));
  }

  async #submitTransfer(event: SubmitEvent, call: CallSnapshot): Promise<void> {
    event.preventDefault();
    const destination = this.transferDestination.trim();
    if (destination.length === 0) {
      this.errorMessage = 'Vui lòng nhập số máy cần chuyển.';
      return;
    }
    await this.#runAction(() => this.client?.blindTransfer(call.callId, destination));
  }

  async #copyIdentity(call: CallSnapshot): Promise<void> {
    if (typeof globalThis.navigator?.clipboard?.writeText !== 'function') {
      this.errorMessage = 'Trình duyệt không hỗ trợ sao chép nhanh.';
      return;
    }
    try {
      await globalThis.navigator.clipboard.writeText(
        call.remoteAddress?.trim() || call.remoteIdentity,
      );
      this.noticeMessage = 'Đã sao chép số điện thoại.';
    } catch {
      this.errorMessage = 'Không thể sao chép số điện thoại.';
    }
  }

  async #unlockAudio(): Promise<void> {
    await this.#runAction(async () => {
      const result = await this.client?.unlockAudio();
      if (result?.status === 'unlocked') {
        this.noticeMessage = 'Âm thanh đã được mở khóa.';
      } else if (result?.status === 'not-configured') {
        this.noticeMessage = 'Chưa có âm thanh cần mở khóa.';
      } else {
        this.noticeMessage = 'Trình duyệt vẫn đang chặn âm thanh.';
      }
    });
  }

  #showError(event: MiCallErrorEvent): void {
    this.errorMessage = event.message;
  }

  #expand(): void {
    this.minimized = false;
  }

  #handleMiniKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.#expand();
    }
  }

  #handleDialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.minimized = true;
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = this.#focusableElements();
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && this.shadowRoot?.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && this.shadowRoot?.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  #focusableElements(): HTMLElement[] {
    return [
      ...(this.shadowRoot?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, select, [tabindex="0"]',
      ) ?? []),
    ];
  }

  #focusDialog(): void {
    const dialog = this.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog === null || dialog === undefined) {
      return;
    }
    this.#previousFocus ??= this.ownerDocument.activeElement;
    dialog.focus();
  }

  #restoreFocus(): void {
    if (this.#previousFocus instanceof HTMLElement && this.#previousFocus.isConnected) {
      this.#previousFocus.focus();
    }
    this.#previousFocus = null;
  }

  #warnIfHostIsHidden(): void {
    if (!this.isConnected || typeof globalThis.getComputedStyle !== 'function') {
      return;
    }
    const style = globalThis.getComputedStyle(this);
    const bounds = this.getBoundingClientRect();
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      bounds.width === 0 ||
      bounds.height === 0
    ) {
      this.logger.warn(
        'Host styles are hiding <micall-call-screen>. Check display, visibility and mount target layout.',
      );
    }
  }

  #isRinging(call: CallSnapshot): boolean {
    return call.state === 'incoming-ringing' || call.state === 'outgoing-ringing';
  }

  #statusLabel(call: CallSnapshot): string {
    const labels: Readonly<Record<CallSnapshot['state'], string>> = {
      'incoming-ringing': 'Cuộc gọi đến',
      'outgoing-dialing': 'Đang quay số…',
      'outgoing-ringing': 'Đang đổ chuông…',
      'early-media': 'Đang kết nối âm thanh…',
      establishing: 'Đang thiết lập cuộc gọi…',
      active: call.muted ? 'Đang tắt microphone' : 'Đang kết nối',
      terminating: 'Đang kết thúc…',
      ended: 'Đã kết thúc',
    };
    return labels[call.state];
  }

  #endReasonLabel(call: CallSnapshot): string {
    const labels: Readonly<Record<NonNullable<CallSnapshot['endReason']>, string>> = {
      'local-hangup': 'Bạn đã gác máy',
      'remote-hangup': 'Đối phương đã gác máy',
      'local-cancel': 'Đã hủy cuộc gọi',
      'remote-cancel': 'Người gọi đã hủy',
      rejected: 'Đã từ chối',
      busy: 'Máy bận',
      declined: 'Cuộc gọi bị từ chối',
      'no-answer': 'Không có người trả lời',
      failed: 'Cuộc gọi thất bại',
      transferred: 'Đã chuyển máy',
    };
    return call.endReason === undefined ? 'Không xác định' : labels[call.endReason];
  }

  #formatDuration(call: CallSnapshot): string {
    const startedAt = call.connectedAt ?? call.createdAt;
    const endedAt = call.endedAt ?? this.now;
    const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  #initials(identity: string): string {
    const normalized = identity.trim();
    if (normalized.length === 0) {
      return '?';
    }
    return normalized.slice(0, 2).toUpperCase();
  }

  #secondaryIdentity(call: CallSnapshot): string | undefined {
    const remoteAddress = call.remoteAddress?.trim();
    if (remoteAddress === undefined || remoteAddress.length === 0) {
      return undefined;
    }
    return remoteAddress.localeCompare(call.remoteIdentity.trim(), undefined, {
      sensitivity: 'accent',
    }) === 0
      ? undefined
      : remoteAddress;
  }

  #icon(name: IconName): TemplateResult {
    const paths: Readonly<Record<IconName, SVGTemplateResult>> = {
      answer: svg`<path
        d="M7.2 3.6 9.5 8 7.7 9.8c1.4 2.7 3.8 5.1 6.5 6.5l1.8-1.8 4.4 2.3v2.7c0 .8-.6 1.5-1.5 1.5C10.1 21 3 13.9 3 5.1c0-.9.7-1.5 1.5-1.5h2.7Z"
      />`,
      audio: svg`<path d="M4 14v-4a8 8 0 0 1 16 0v4" /><path
          d="M4 14v3a2 2 0 0 0 2 2h2v-7H6a2 2 0 0 0-2 2Zm16 0v3a2 2 0 0 1-2 2h-2v-7h2a2 2 0 0 1 2 2Z"
        />`,
      copy: svg`<rect x="9" y="9" width="11" height="11" rx="2" /><path
          d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"
        />`,
      hangup: svg`<path d="M5.2 14.8a11 11 0 0 1 13.6 0l1.5-3A15 15 0 0 0 3.7 11.8l1.5 3Z" /><path
          d="m8 14-1 5m9-5 1 5"
        />`,
      hold: svg`<path d="M8 5v14M16 5v14" />`,
      keypad: svg`<circle cx="7" cy="6" r="1" /><circle cx="12" cy="6" r="1" /><circle
          cx="17"
          cy="6"
          r="1"
        /><circle cx="7" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle
          cx="17"
          cy="12"
          r="1"
        /><circle cx="7" cy="18" r="1" /><circle cx="12" cy="18" r="1" /><circle
          cx="17"
          cy="18"
          r="1"
        />`,
      microphone: svg`<rect x="9" y="3" width="6" height="12" rx="3" /><path
          d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"
        />`,
      'microphone-off': svg`<path
        d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9V6a3 3 0 0 0-5.8-1M5 11a7 7 0 0 0 11.7 5.2M19 11a7 7 0 0 1-.5 2.6M12 18v3m-4 0h8M3 3l18 18"
      />`,
      minimize: svg`<path d="M6 12h12" />`,
      transfer: svg`<path d="M5 17 17 5m-7 0h7v7M5 7v12h12" />`,
    };
    return html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
  }
}

function isMicrophonePermissionDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }
  return error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError';
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
