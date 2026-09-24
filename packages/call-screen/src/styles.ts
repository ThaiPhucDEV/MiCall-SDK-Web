import { css, type CSSResult } from 'lit';

export const callScreenStyles: CSSResult = css`
  :host {
    all: initial;
    --micall-color-primary: #0ea5e9;
    --micall-color-bg: #111827;
    --micall-color-surface: #1f2937;
    --micall-color-text: #ffffff;
    --micall-color-text-muted: #9ca3af;
    --micall-radius-lg: 16px;
    --micall-radius-full: 9999px;
    --micall-avatar-size: 96px;
    --micall-font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --micall-button-accept-bg: #22c55e;
    --micall-button-reject-bg: #ef4444;
    --micall-button-neutral-bg: #374151;
    --micall-network-good: #22c55e;
    --micall-network-fair: #f59e0b;
    --micall-network-poor: #ef4444;
    --micall-z-index: 2147483000;
    position: fixed;
    inset: 0;
    z-index: var(--micall-z-index);
    display: block;
    box-sizing: border-box;
    color: var(--micall-color-text);
    font-family: var(--micall-font-family);
    font-size: 14px;
    font-weight: 400;
    line-height: 1.45;
    pointer-events: none;
    isolation: isolate;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  button,
  input,
  select {
    font: inherit;
  }

  .icon {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .shell {
    position: absolute;
    right: max(20px, env(safe-area-inset-right));
    bottom: max(20px, env(safe-area-inset-bottom));
    width: min(360px, calc(100vw - 32px));
    pointer-events: auto;
  }

  .card,
  .mini {
    overflow: hidden;
    color: var(--micall-color-text);
    border: 1px solid rgb(255 255 255 / 9%);
    background:
      radial-gradient(circle at 20% 0%, rgb(14 165 233 / 15%), transparent 35%), rgb(17 24 39 / 90%);
    box-shadow:
      0 24px 48px -12px rgb(0 0 0 / 62%),
      0 8px 18px -8px rgb(0 0 0 / 65%);
    backdrop-filter: blur(18px) saturate(130%);
  }

  .card {
    border-radius: var(--micall-radius-lg);
  }

  .mini {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    align-items: center;
    min-height: 52px;
    padding: 6px 7px 6px 17px;
    border-radius: var(--micall-radius-full);
    cursor: pointer;
  }

  .mini__identity {
    min-width: 0;
  }

  .mini__name {
    overflow: hidden;
    font-size: 13px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mini__timer {
    color: var(--micall-color-text-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 50px;
    padding: 10px 12px 8px 18px;
  }

  .topbar__actions {
    display: flex;
    gap: 2px;
    align-items: center;
  }

  .network-metrics {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    min-width: 50px;
    color: var(--micall-color-text-muted);
    line-height: 1;
  }

  .network-quality {
    display: inline-flex;
    gap: 2px;
    align-items: flex-end;
    justify-content: center;
    width: 30px;
    height: 17px;
    padding: 2px 5px;
    color: var(--micall-color-text-muted);
  }

  .network-throughput {
    margin-top: 2px;
    color: var(--micall-color-text-muted);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .network-quality--good {
    color: var(--micall-network-good);
  }

  .network-quality--fair {
    color: var(--micall-network-fair);
  }

  .network-quality--poor {
    color: var(--micall-network-poor);
  }

  .network-quality__bar {
    width: 3px;
    min-height: 3px;
    border-radius: 2px 2px 0 0;
    background: currentColor;
    opacity: 0.22;
  }

  .network-quality__bar:nth-child(2) {
    height: 6px;
  }

  .network-quality__bar:nth-child(3) {
    height: 9px;
  }

  .network-quality__bar:nth-child(4) {
    height: 12px;
  }

  .network-quality__bar.is-active {
    opacity: 1;
  }

  .brand {
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
    color: var(--micall-color-text-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  .brand__mark {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--micall-color-primary);
    box-shadow: 0 0 0 4px rgb(14 165 233 / 12%);
  }

  .body {
    padding: 5px 22px 20px;
    text-align: center;
  }

  .status {
    min-height: 20px;
    margin: 0 0 14px;
    color: var(--micall-color-text-muted);
    font-size: 12px;
  }

  .identity {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: clamp(22px, 7vw, 30px);
    font-weight: 680;
    letter-spacing: -0.035em;
  }

  .remote-address {
    margin-top: 3px;
    overflow-wrap: anywhere;
    color: var(--micall-color-text-muted);
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }

  .timer {
    min-height: 23px;
    margin-top: 4px;
    color: #d1d5db;
    font-size: 15px;
    font-variant-numeric: tabular-nums;
  }

  .avatar-wrap {
    position: relative;
    display: grid;
    width: var(--micall-avatar-size);
    height: var(--micall-avatar-size);
    margin: 8px auto 20px;
    place-items: center;
  }

  .avatar {
    position: relative;
    z-index: 1;
    display: grid;
    width: 100%;
    height: 100%;
    place-items: center;
    border: 1px solid rgb(255 255 255 / 11%);
    border-radius: 50%;
    background: linear-gradient(145deg, #334155, #172033);
    box-shadow: inset 0 1px rgb(255 255 255 / 8%);
    color: #e2e8f0;
    font-size: 30px;
    font-weight: 700;
  }

  .ringing .avatar-wrap::before,
  .ringing .avatar-wrap::after {
    position: absolute;
    inset: 0;
    border: 1px solid rgb(14 165 233 / 42%);
    border-radius: 50%;
    content: '';
    animation: ripple 2.2s ease-out infinite;
  }

  .ringing .avatar-wrap::after {
    animation-delay: 1.1s;
  }

  .speaking {
    position: absolute;
    z-index: 2;
    right: 4px;
    bottom: 7px;
    width: 14px;
    height: 14px;
    border: 3px solid var(--micall-color-bg);
    border-radius: 50%;
    background: #34d399;
    animation: breathe 1.2s ease-in-out infinite;
  }

  .hold-banner,
  .notice,
  .error {
    margin: 12px 0 0;
    padding: 9px 11px;
    border-radius: 10px;
    font-size: 12px;
    text-align: left;
  }

  .notice__action {
    margin-inline-start: 8px;
    border: 0;
    border-radius: 999px;
    padding: 5px 9px;
    color: var(--micall-color-text, #ffffff);
    background: rgba(255, 255, 255, 0.14);
    cursor: pointer;
  }

  .hold-banner {
    color: #fde68a;
    background: rgb(245 158 11 / 14%);
    border: 1px solid rgb(245 158 11 / 20%);
  }

  .notice {
    color: #bae6fd;
    background: rgb(14 165 233 / 10%);
  }

  .error {
    color: #fecaca;
    background: rgb(239 68 68 / 13%);
    border: 1px solid rgb(239 68 68 / 20%);
  }

  .actions {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: center;
    margin-top: 20px;
  }

  .action {
    display: inline-grid;
    min-width: 58px;
    min-height: 58px;
    padding: 8px;
    place-items: center;
    border: 0;
    border-radius: var(--micall-radius-full);
    background: var(--micall-button-neutral-bg);
    box-shadow: inset 0 1px rgb(255 255 255 / 7%);
    color: var(--micall-color-text);
    cursor: pointer;
    transition:
      transform 150ms ease,
      background-color 150ms ease,
      opacity 150ms ease;
  }

  .action:hover {
    background: #475569;
  }

  .action:active {
    transform: scale(0.96);
  }

  .action:focus-visible,
  .icon-button:focus-visible,
  .key:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--micall-color-primary);
    outline-offset: 2px;
  }

  .action[disabled] {
    cursor: wait;
    opacity: 0.5;
  }

  .action--accept {
    background: var(--micall-button-accept-bg);
  }

  .action--danger {
    background: var(--micall-button-reject-bg);
  }

  .action--active {
    background: #c2410c;
  }

  .action-labels {
    display: flex;
    justify-content: center;
    gap: 12px;
    margin-top: 7px;
    color: var(--micall-color-text-muted);
    font-size: 10px;
  }

  .action-labels span {
    width: 58px;
  }

  .icon-button {
    display: inline-grid;
    width: 34px;
    height: 34px;
    padding: 0;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--micall-color-text-muted);
    cursor: pointer;
  }

  .icon-button:hover {
    color: var(--micall-color-text);
    background: rgb(255 255 255 / 7%);
  }

  .toolbar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-top: 20px;
  }

  .tool {
    display: grid;
    gap: 6px;
    justify-items: center;
    padding: 10px 4px;
    border: 0;
    border-radius: 12px;
    color: #e5e7eb;
    background: rgb(255 255 255 / 5%);
    cursor: pointer;
  }

  .tool[aria-pressed='true'] {
    color: #fed7aa;
    background: rgb(234 88 12 / 20%);
  }

  .tool__label {
    font-size: 10px;
  }

  .sheet,
  .device-panel {
    margin: 16px -22px -20px;
    padding: 17px 22px 20px;
    border-top: 1px solid rgb(255 255 255 / 7%);
    background: rgb(15 23 42 / 68%);
    animation: slide-up 180ms ease-out;
  }

  .dialpad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .key {
    min-height: 46px;
    border: 0;
    border-radius: 12px;
    color: var(--micall-color-text);
    background: rgb(255 255 255 / 6%);
    cursor: pointer;
  }

  .key:active {
    background: rgb(14 165 233 / 25%);
    transform: scale(0.97);
  }

  .field {
    display: grid;
    gap: 6px;
    margin-top: 11px;
    color: var(--micall-color-text-muted);
    font-size: 11px;
    text-align: left;
  }

  input,
  select {
    width: 100%;
    min-height: 40px;
    border: 1px solid rgb(255 255 255 / 10%);
    border-radius: 10px;
    color: var(--micall-color-text);
    background: #111827;
    padding: 8px 10px;
  }

  .transfer-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }

  .primary-button {
    border: 0;
    border-radius: 10px;
    padding: 0 14px;
    color: white;
    background: var(--micall-color-primary);
    cursor: pointer;
  }

  .footer {
    padding: 0 22px 16px;
    color: var(--micall-color-text-muted);
    font-size: 10px;
    text-align: center;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @keyframes ripple {
    from {
      opacity: 0.75;
      transform: scale(0.95);
    }
    to {
      opacity: 0;
      transform: scale(1.62);
    }
  }

  @keyframes breathe {
    50% {
      opacity: 0.48;
      transform: scale(0.8);
    }
  }

  @keyframes slide-up {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }

  @media (max-width: 480px) {
    .shell {
      right: 12px;
      bottom: 12px;
      width: calc(100vw - 24px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      scroll-behavior: auto;
      animation-duration: 1ms;
      animation-iteration-count: 1;
      transition-duration: 1ms;
    }
  }
`;
