# Capture8K

<img src="extension/icons/capture8k-mark.svg" width="88" align="right" alt="Capture8K icon">

Save the visible part of a web page as a 4K or 8K PNG. Capture8K preserves the page’s proportions and checks the result before saving. It can also send the screenshot to your Premiere Pro project.

**[Download Capture8K](https://github.com/Coraubanne/Capture8K/releases/latest)** · [Version history](CHANGELOG.md) · [Français](README.md)

Apple Silicon · macOS 13+ · Chrome 125+ or Firefox 125+

## Install

1. Download `Capture8K-complet-v…zip` from the latest release and extract it. GitHub’s **Code → Download ZIP** option downloads the project source.
2. In Terminal, change to the extracted **Capture8K complet** folder and run `./install-macos.sh`. The script installs the macOS app and copies the extensions to `~/Documents/Capture8K`.
3. Follow the steps for your browser.

   | Browser | Setup |
   | --- | --- |
   | Google Chrome | Open `chrome://extensions`, enable **Developer mode** and choose **Load unpacked** to load `~/Documents/Capture8K/Chrome`. Copy the extension ID shown by Chrome, then run `./install-macos.sh CHROME_EXTENSION_ID` from the installer folder. |
   | Firefox | Open `about:debugging#/runtime/this-firefox` and choose **Load Temporary Add-on** to load `~/Documents/Capture8K/Firefox/manifest.json`. Load it again after quitting and reopening Firefox. |

## Take a screenshot

Open a page, select **4K** or **8K** in the extension and click **Capture**. The `⌘⇧8` shortcut uses your current setting. Open the gear menu to choose the output folder, interface language and completion sound.

The PNG’s long edge is **3,840 px for 4K** or **7,680 px for 8K**. Capture8K renders the visible area again in the browser engine while preserving its proportions. Embedded images retain the detail available in their sources.

Capture processing runs on your Mac. The companion checks the dimensions and compares reference frames before writing the PNG.

## Send a screenshot to Premiere Pro

Open a saved project in **Premiere Pro 25.6 or later**, then open **Window → UXP Plug-ins → Creator Bridge**. Select **Premiere Pro** as the Capture8K destination. Capture8K saves the PNG in the `Captures Capture8K` folder next to the project. Creator Bridge receives the request to import it into the Project panel. [Creator Bridge](https://github.com/Coraubanne/CreatorBridge)

## Updates

Open **Settings → Check for updates** in the extension. The companion verifies the SHA-256 checksum before replacing the app and extension files. In Firefox, reload the temporary add-on to use the updated files. When Premiere Pro is selected as the destination, Capture8K also checks Creator Bridge separately.

## Project and support

- [Report an issue](https://github.com/Coraubanne/Capture8K/issues) · [GitHub Actions tests](https://github.com/Coraubanne/Capture8K/actions/workflows/test.yml)
- Source code is available to view on GitHub. All rights reserved.

<details>
<summary>Architecture and tests</summary>

Chrome sources are in `extension/` and Firefox sources in `extension-firefox/`. The Objective-C macOS companion and native messaging host are in `macos/`. The Creator Bridge panel is referenced by the `vendor/CreatorBridge` submodule.

Chrome uses `chrome.debugger` and `Page.captureScreenshot`. The macOS agent can restart Chrome in its capture mode to preserve the viewport height. Firefox uses `tabs.captureVisibleTab` with Gecko’s scale factor.

The test suite runs on macOS with the Xcode command line tools and Node.js.

```sh
git submodule update --init
./macos/build.sh
node --test tests/test-background.mjs macos/Tests/test-native-host.mjs
```

</details>
