# Desktop keyboard and accessibility review

The keyboard regression passed in actual headed desktop Chrome on 2026-10-17. The coordinator then manually reviewed its 54-action focus trace, the two focus screenshots, the exercised labels, and the dialog-close change. This satisfies the plan's desktop keyboard/label review within this recorded scope. It is a qualitative review of browser-generated evidence; it is not OS-native keystroke input, a screen-reader test, or a formal accessibility conformance audit. Phone environments remain untested.

The retained [trace](keyboard/trace.json) records real Tab, Shift+Tab, Enter, Space, text typing, and Escape events. The test performs no DOM focus calls. It installs the actual PFAF catalog, reads real model metadata, and confirms that no identification-pack assets are requested.

Observed and reviewed:

- Header controls, catalog installation, and size-labeled model consent are reachable by keyboard. Space toggles consent, Tab reaches the enabled download action, and Shift+Tab returns to consent. Unchecking it disables the download action.
- The file input's accessible name is Upload photo. Its enclosing control has a visible outline and a 44-pixel-or-larger target. The [upload screenshot](keyboard/upload-focus.png) clearly shows the complete gold focus border against the green button and pale background. Shift+Tab reaches Use camera, and Tab returns to upload.
- The labeled scientific/common-name search is keyboard reachable. Typing an actual scientific name yields an entry that Enter opens.
- The dialog has the plant name as its accessible name; the close control has a descriptive accessible name and a clear visible focus indicator in the [dialog screenshot](keyboard/dialog-focus.png). Hazards, source names, ratings including zero values, and missing-field wording remain legible.
- Native dialog traversal reaches its controls and container. The test permits browser chrome to receive focus, while rejecting focus on background application controls. It preserves native browser behavior instead of replacing it with a custom trap.
- Escape closes the record and restores visible focus to the same plant entry. This review reproduced and fixed a real problem: unmounting before native close lost focus to BODY. All close paths now perform native close while connected, before requesting React unmount. No scripted focus reassignment was added.

Evidence: `tests/e2e/keyboard.spec.ts` passed from the root checkout in 4.7 seconds (3.5-second test). The complete UI/asset suite is separately recorded in the desktop report. Direct native UI-control attachment was unavailable (`cgWindowNotFound`, no enabled browser surfaces), so no OS-native/manual-input claim is made. The successful keyboard event trace and subsequent coordinator inspection are the review evidence.
