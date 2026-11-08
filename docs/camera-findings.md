# Camera routes and browser findings

Kufang Capture offers two capture routes. **System camera** uses a hidden image file input with
`accept="image/*"` and `capture="environment"`. The browser opens its native capture flow when it
supports that hint. The returned `File` is saved as-is, with no resize or re-encoding. Add from Photos
uses the same input without `capture` and allows multiple files. The system camera route can reopen
the iOS capture UI for every photo.

**Fast camera** keeps a `getUserMedia` stream open in a full-screen sheet. The shutter uses
`ImageCapture.takePhoto()` when available; otherwise it encodes the current video frame as JPEG at
quality 0.92 and the track's reported resolution. Each result is stored as `camera_frame`. This is a
video-derived camera frame and may be lower resolution or less sharp than a native iPhone still.
Shots are queued independently while earlier IndexedDB writes finish. The saved count advances only
after the repository confirms each write.

## What Diagnostics measures

Diagnostics requests camera permission only after **Start camera test** is pressed. It reports the
user agent, standalone display mode, secure-context status, media device support, each enumerated
device's kind and browser-provided label, a shortened hash of `groupId`, active track settings,
capabilities and constraints, and the preview's actual video resolution. It records whether
`ImageCapture` and `getPhotoCapabilities()` are available, and captures one test frame to report its
route, pixel dimensions, MIME type and byte size. It also notes that the file input has the capture
attribute, and includes storage usage, quota and persistent-storage status. Device labels and
capabilities are exactly what the browser exposes. The report is built and copied locally; the app
does not send it to a server.

## WebKit and PWA limits

- A web app has no direct AVFoundation lens switch. A lens picker appears only when the browser
  enumerates multiple back-facing video devices; the options retain their exact browser-provided
  labels. Many browser/device combinations expose only one back camera.
- Native tap-to-focus is unavailable unless the active track exposes `pointsOfInterest` and accepts
  the corresponding constraint. Focus mode and distance controls are also conditional on reported
  capabilities.
- Hardware zoom is shown only when `getCapabilities()` exposes `zoom` and the track accepts an
  advanced zoom constraint. When absent, a pinch changes the digital crop used to make the captured
  image. The app labels that action **Digital crop**; it is not optical or hardware zoom.
- The fast route is limited to the stream resolution the browser grants. Even when `ImageCapture`
  exists, its output and controls are browser-dependent. It does not promise the native Camera app's
  full still-photo resolution, image processing, focus behavior, or quality.
- The `capture` attribute is a browser hint. Its presence does not guarantee a particular picker UI
  or that a Home Screen PWA will reopen the native camera in a specific way.

## Real-device test procedure

Run this on the owner's iPhone with the installed Home Screen PWA and a well-lit, detailed label.
Do not treat desktop emulation or a fake camera as evidence for these device-specific observations.

1. In Settings, select **System camera**. Create or open an entry, take a photo of the label, return
   to the entry, and take a second photo of the same label.
2. Record the taps between shots, each photo's stored pixel dimensions, and whether small label text
   is sharply readable at full-size view.
3. Repeat with **Fast camera**. Note whether the stream remains open between shots and record the
   same tap, dimension and sharpness observations.
4. Open Diagnostics, press **Start camera test**, then copy the report. Preserve the report alongside
   the observations; it contains browser-exposed settings and the dimensions/bytes for its separate
   test frame.
5. Close and relaunch the installed PWA. Check whether camera permission persists. Start Fast camera,
   interrupt it with a call or another camera-using app, return to Kufang Capture, and record whether
   the preview resumes and can take another photo.

## Owner's iPhone results

No real-device results have been recorded here. Fill this table from the procedure above.

| Route         | Taps between two photos | Photo dimensions | Label sharpness | Permission after relaunch | Resumed after call |
| ------------- | ----------------------: | ---------------- | --------------- | ------------------------- | ------------------ |
| System camera |                         |                  |                 |                           |                    |
| Fast camera   |                         |                  |                 |                           |                    |

| Diagnostics report date | iPhone / iOS | Browser / PWA mode | Enumerated cameras and controls | Test frame dimensions / bytes |
| ----------------------- | ------------ | ------------------ | ------------------------------- | ----------------------------- |
|                         |              |                    |                                 |                               |
