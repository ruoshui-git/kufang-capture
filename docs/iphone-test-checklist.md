# Real-iPhone test checklist

These checks need the owner's iPhone. Desktop emulation is not a substitute, and none of these steps counts as passed until the owner reports a result. Record results in the tables below; also update [acceptance-matrix.md](acceptance-matrix.md) and [camera-findings.md](camera-findings.md).

**Device:** iPhone 15 Pro Max. **iOS version:** ____ **Date:** ____

Before starting:
- Use Safari, not Chrome or in-app browsers.
- Open https://capture.kufang.org.
- For the Synced tests, have the login password ready. Read it with `ssh kufang-prod sudo cat /srv/kufang-capture/credentials.txt`.

## A. Install and offline launch (spec #1)

1. In Safari, open the site and tap **Share → Add to Home Screen → Add**.
2. Launch it from the Home Screen. It should open without Safari's address bar.
3. Wait for the toast **Ready to work offline**, or wait 30 seconds.
4. Turn on **Airplane Mode**, force-close the app (swipe it up), and relaunch it from the Home Screen.

| Check | Result | Notes |
|---|---|---|
| Opens standalone (no Safari UI) | | |
| Relaunches with Airplane Mode on | | |

## B. Counting flow from the list (spec #2, #3, #11)

1. Tap **+ New** and create `Temple 2 / A04` as **Local Only**.
2. Tap **+ New Entry** 15 times. Add 1–5 photos to each with the row's **Add Photo** button. Don't type any titles.
3. Scroll back to **#0003** without opening Details. Change the quantity to `3`, the dimensions to `30 × 20 × 15 cm`, add a note and a title. Tap **More** and set the unit to `boxes`.
4. On #0003, tap **Add Photo** twice (two photos).
5. Delete one photo in #0003's Details, then tap **Undo**. Delete entry **#0005**, then tap **Undo**. Delete #0005 again and restore it from **Recently Deleted**.
6. Create a new entry. It must be **#0016**.

| Check | Result | Notes |
|---|---|---|
| No navigation happened when tapping inputs, thumbnails or Add Photo | | |
| Scroll position stayed put while editing and after the photos came back | | |
| #0003 shows the two new photos as its most recent thumbnails | | |
| Header chips show per-unit totals (e.g. "3 boxes"), never a mixed sum | | |
| Undo and Restore brought back the same numbers; #0016 came next | | |

## C. Camera comparison (spec #4, #5)

1. In **Settings**, choose **System camera**. On one entry, take 3 photos with **Add Photo**. Count the taps between consecutive photos and time the 3 photos.
2. In **Settings**, choose **Fast camera**. On another entry, take 5 photos with the shutter. Count the taps and time them.
3. Open each kind of photo in the viewer and zoom in on small label text.
4. Open **Settings → Diagnostics → Start camera test**, then **Copy report**. Paste the report into a note and send it to the developer.
5. Close the app completely, relaunch it, and use the Fast camera again. Does it ask for permission again?
6. While the Fast camera is open, have someone call you, decline the call, and return to the app. Does the camera resume, or does it offer **Tap to resume**?

| Measure | System camera | Fast camera |
|---|---|---|
| Taps between two photos of one entry | | |
| Seconds for the 3 or 5 photos | | |
| Pixel size (shown in the viewer) | | |
| Label text sharp at 100%? | | |
| Lens choices shown (exact labels) | n/a | |
| Zoom control shown? Hardware or "Digital crop"? | n/a | |
| Torch / focus controls shown? | n/a | |
| Permission prompt after relaunch? | | |
| Recovered after an incoming call? | | |

## D. Airplane-mode durability (spec #6)

1. With Airplane Mode **on**, create 3 entries and take at least **20 photos** across them. Edit the quantities and notes.
2. Force-close the app and relaunch it, still in Airplane Mode.

| Check | Result | Notes |
|---|---|---|
| All entries, fields and 20+ photos are present after the relaunch | | |

## E. Local Only vs Synced (spec #7, #8, #9, #15)

1. Export the Local Only collection while offline: **Export ZIP → Save to Files**. Open the ZIP in the Files app and look for the `photos` folder.
2. Turn Airplane Mode off. Sign in (**Settings → Sign in**). Create a **Sync to Server** collection named `Sync test`. Add 3 entries with 2 photos each.
3. Watch the status go from `… photos pending` to **Backed up**.
4. Start uploading about 10 photos, then force-close the app mid-upload. Reopen it and confirm it ends **Backed up** with no duplicate photos.
5. With Airplane Mode on, edit the same entry twice. Turn Airplane Mode off and confirm the server shows only the final values: check the entry on a desktop browser after signing in.
6. On a desktop computer, sign in and open **Server**. `Sync test` is listed and `Temple 2 / A04` is **not**. Download the ZIP.

| Check | Result | Notes |
|---|---|---|
| Offline Local Only ZIP saved to Files | | |
| Synced collection reaches Backed up | | |
| Kill mid-upload resumes without loss or duplicates | | |
| Desktop shows the synced collection only | | |

## F. Scale and clearing (spec #10, #16)

1. Optional: use **Settings → Diagnostics → Generate 300 test entries**, if present, or create a long list. Scroll quickly, and judge the smoothness and how fast thumbnails appear.
2. Archive `Temple 2 / A04`. Try **Clear from this device…**. It should stay blocked until a fresh export exists.

| Check | Result | Notes |
|---|---|---|
| 300+ entries scroll smoothly | | |
| Clear blocked before export, allowed after export plus typing the name | | |

## G. Shared items across collections (owner decision 2026-11-09)

1. **Upgrade first.** Before updating the app, note the entry count, photo count and a few entry numbers in two collections (one Local Only, one Synced). Accept the update prompt and reopen. Every number, title, quantity and photo must be unchanged; the Synced collection must still reach **Backed up** with no duplicate photos.
2. With Airplane Mode on, in a Local Only collection B open the collection menu → **Import from another collection** → pick Local Only collection A → select one entry with photos → **Import 1**. B shows the photos immediately and a blank quantity.
3. Change the title in B and confirm A shows it. Enter a different quantity in each; each keeps its own.
4. Delete the entry in A. B still has it with its photos. Undo in A brings it back with its old number.
5. Confirm that Synced collections are not offered when importing into a Local Only collection, and that switching A to Sync to Server is blocked while it shares an item with B.
6. With the import sheet open and many collections listed, rotate the phone (or open and close the keyboard in its search field), scroll the list and tap a collection near the bottom. It must respond. (Headless WebKit stops routing taps inside an open sheet after a viewport resize; the sheet now scrolls as one container, but only the device can confirm iOS behaves.)

| Check | Result | Notes |
|---|---|---|
| Existing data unchanged after the update | | |
| Import works offline and shows photos at once | | |
| Shared edits appear in both; quantities stay separate | | |
| Delete in one collection keeps the item in the other | | |
| Mode rules: other-mode collections hidden, mode switch blocked | | |
| Import sheet still responds after rotating or using the keyboard | | |
