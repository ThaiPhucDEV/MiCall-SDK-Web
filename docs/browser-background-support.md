# Browser background support

MiCall keeps the current SIP registration and active call unchanged when a page becomes hidden or the user switches tabs. When the page becomes visible again, the SDK asks the existing reconnect coordinator to verify WSS and registration state.

| Browser state                 | Incoming call expectation                                   | Active audio expectation                      |
| ----------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| Visible tab                   | Supported while WSS and REGISTER are healthy                | Supported                                     |
| Hidden desktop tab            | Best effort; browser timer/network throttling still applies | Usually maintained by WebRTC                  |
| Frozen mobile/background page | Not guaranteed                                              | OS/browser may suspend or terminate media     |
| Discarded page                | Not supported; a new page lifecycle starts                  | Existing session cannot be restored           |
| Closed browser/tab            | Not supported                                               | Call ends when browser resources are released |

The web SDK is not a push-notification service and must not promise native-app background reliability. For guaranteed incoming-call wake-up on iOS/Android, use a native application with the platform call/push mechanisms.

When the default Call Screen receives an incoming call in a hidden but still running tab, it
uses the Web Notifications API if the host has already obtained `granted` permission. The
notification deliberately omits caller identity to avoid exposing PII on a lock screen. Clicking
it asks the browser to focus the MiCall tab; browser and OS focus policy still applies. This does
not wake a frozen, discarded or closed page.

## Manual verification

1. Register an account and confirm WSS plus REGISTER are healthy.
2. Grant notification permission from a user click/tap, then switch to another desktop tab.
3. Place an incoming call and verify a generic system notification appears without caller identity.
4. Click the notification and verify the MiCall tab is focused with the incoming Call Screen open.
5. Answer or reject the call and verify the system notification closes.
6. Repeat after one registration refresh interval (600 seconds) and verify there is no duplicate WSS connection or REGISTER loop.
7. During an active call, switch tabs and verify audio remains active; simulate WSS loss and verify the WebRTC call is not ended solely by signaling loss.
8. Repeat on supported mobile browsers and record OS/browser limitations; do not treat a suspended-page success as a guarantee.
