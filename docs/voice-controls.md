# M2 voice controls and browser media

M2 adds production voice controls to the headless SDK. Every call action still requires an explicit
`callId`; the SDK does not depend on a global current session.

## Public actions

```ts
const capabilities = sdk.getCapabilities();

await sdk.setMuted(callId, true);
await sdk.setHold(callId, true);
await sdk.sendDtmf(callId, '12#');
await sdk.blindTransfer(callId, '2001');

await sdk.selectAudioInput(microphoneDeviceId);
await sdk.selectCallAudioOutput(headsetDeviceId);
await sdk.selectRingtoneOutput(speakerDeviceId);

// Call synchronously from a click/tap handler to satisfy browser autoplay policy.
const unlockResult = await sdk.unlockAudio();
```

`getCapabilities()` returns runtime feature information. `rtpDtmf` becomes meaningful after an
active peer connection exists. Output selection is only available when the browser implements
`HTMLMediaElement.setSinkId()`.

## Media behavior

- Nếu consumer không truyền `ringtoneUrl`, SDK dùng ringtone đóng gói tại
  `@micall/sipjs-browser/assets/ringtones/incoming-sound.mp3`. Truyền `ringtoneUrl` để override
  bằng âm thanh của host; autoplay policy vẫn yêu cầu gọi `unlockAudio()` từ click/tap.
- Khi cuộc gọi đi vào terminal state, SDK phát một lần
  `@micall/sipjs-browser/assets/ringtones/hangup.mp3` trên cùng output element với ringtone.
  Playback failure không chặn cleanup hoặc event `callEnded`.
- Trong cuộc gọi, SDK lấy WebRTC stats mỗi 3 giây và cập nhật `snapshot.networkQuality`.
  `good` tương ứng RTT tối đa 150 ms và packet loss tối đa 2%; `fair` tương ứng RTT tối đa
  300 ms và packet loss tối đa 5%; vượt một trong hai ngưỡng là `poor`. Khi chưa có đủ stats,
  giá trị là `unknown`. `snapshot.networkKilobytesPerSecond` chứa tổng tốc độ audio nhận và gửi,
  tính theo 1 KB = 1.000 bytes.
- The SDK acquires audio through the SIP.js public media stream factory and attaches remote media
  to a dedicated audio element per session.
- Microphone switching acquires the replacement first and calls `RTCRtpSender.replaceTrack()`.
  The current track remains active when acquisition or replacement fails.
- Call audio output and ringtone output are independent selections.
- A disconnected selected device falls back to the browser default and emits both
  `mediaDevicesChanged` and a recoverable `MEDIA_DEVICE_NOT_FOUND` error.
- Call end and `destroy()` stop only tracks owned by the SDK and detach SDK-created audio elements.

Device labels may be empty until microphone permission has been granted. Consumers must display a
fallback label such as `Microphone 1` instead of treating an empty label as a missing device.

## In-call behavior

- Mute changes only the outbound audio track's `enabled` flag; it does not renegotiate SIP.
- Hold/unhold sends one serialized re-INVITE. `snapshot.localHold` changes only after a 2xx response.
  Reject and 15-second timeout preserve the previous snapshot and return `HOLD_REJECTED`.
- DTMF validates `0-9`, `A-D`, `*`, `#`. RTP telephone-event is attempted first; SIP INFO with
  `application/dtmf-relay` is the fallback.
- Blind transfer emits `transferStateChanged`. SIP REFER 2xx or a successful NOTIFY marks the
  transfer complete, sends BYE and ends the call with reason `transferred`. Reject/timeout emits
  `failed`, returns `TRANSFER_REJECTED`, and keeps the active call.
- Hangup supersedes pending hold, DTMF INFO or transfer control timers and terminal cleanup is
  emitted at most once.

## Browser events

Typed events and DOM events share the same ordered source:

| Typed event                 | DOM event                            |
| --------------------------- | ------------------------------------ |
| `mediaDevicesChanged`       | `micall:media-devices-changed`       |
| `transferStateChanged`      | `micall:transfer-state-changed`      |
| `audioUnlockRequired`       | `micall:audio-unlock-required`       |
| `callNetworkMetricsChanged` | `micall:call-network-metrics-changed` |

```ts
sdk.events.addEventListener('micall:transfer-state-changed', (event) => {
  const detail = (event as CustomEvent).detail;
  console.info(detail.callId, detail.state, detail.destination);
});
```

All public event payloads and snapshots are JSON-safe and immutable. Browser/SIP runtime objects are
never exposed to the host application.
