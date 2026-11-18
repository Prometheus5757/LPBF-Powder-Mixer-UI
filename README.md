# Laser Powder Bed Fusion: Powder Mixer UI and Testing Suite

Control software for the TAMU FORGE LPBF powder mixer. It has four dispensers, each driven by a geared NEMA 17 stepper, run by an Arduino Mega 2560 with a RAMPS 1.4 shield and A4988 drivers. Each dispenser takes a ratio from 0 to 100, set with a dial on the panel or in the browser UI. The red button confirms each motor in turn, and the green button starts a timed run.

Dispensing is open loop: there's no scale or flow sensor. Each motor turns at a speed proportional to its ratio, and dispensed mass comes from a calibration curve recorded in the UI.

**The browser UI includes:**
- **Dispense:** the ratio setup wizard and timed runs
- **Calibrate:** grams-per-revolution curves for each canister
- **Clean:** empties the dispensers at full speed until stopped
- **Device:** drive settings and the serial log
- **Reference:** the wiring diagram, docs and RAMPS PDF
- **Always visible:** an LCD mirror and an interactive 3D view of the machine that flies to the selected motors

It runs offline: every library is bundled, and nothing needs installing beyond Python and a Chromium browser.

---

## Set up on a fresh laptop

### 1. Install the prerequisites

| Tool | Why | Get it |
| :--- | :--- | :--- |
| **Git** | Clone the repository | https://git-scm.com/downloads |
| **Python 3.8+** | Serves the UI locally (standard library only, no packages) | https://www.python.org/downloads/. On Windows, tick **Add python.exe to PATH**. |
| **Google Chrome or Microsoft Edge** | The UI talks to the Mega over USB with Web Serial, which only Chromium browsers support | Edge ships with Windows |
| **Arduino IDE 2** | Upload the firmware to the Mega | https://www.arduino.cc/en/software |

### 2. Clone the repository

```bash
git clone https://github.com/<your-account>/LPBF-Powder-Mixer-UI.git
cd LPBF-Powder-Mixer-UI
```

The clone is about 75 MB. Most of that is the 3D model (`ui/assets/assembly.glb`) and the CAD source (`FullDesign.step`).

### 3. Upload the firmware to the Mega

1. Plug the Mega in over USB, and open `firmware/lpbf_mixer/lpbf_mixer.ino` in the Arduino IDE.
2. Choose **Tools → Board → Arduino Mega or Mega 2560**, and pick the board's port under **Tools → Port**.
3. Click **Upload**. The sketch uses only the built-in `Wire` and `EEPROM` libraries.
4. **Close the Arduino IDE** (or at least its Serial Monitor). Only one program can hold the COM port at a time.

The LCD is found automatically at I²C address 0x27 or 0x3F. Microstepping, gear ratio, run time and top speed are stored in the Mega's EEPROM. Change them in the UI on the **Device** tab.

### 4. Launch the UI

**Windows:** double-click **`start-ui.bat`**. It:
- starts a small local server in a minimized window, or reuses one already running
- waits until the server answers
- opens the UI as its own maximized Chrome or Edge window at http://localhost:8765/ui/

To get a one-click launcher, right-click `start-ui.bat`, choose **Show more options → Send to → Desktop (create shortcut)**, and pin the shortcut to the taskbar.

**macOS or Linux:** start the server, then open http://localhost:8765/ui/ in Chrome or Edge:

```bash
python3 tools/serve.py
```

### 5. Connect

Click **Connect Mega** and pick the board's port: COM*n* on Windows, `/dev/tty.usbmodem*` or `/dev/ttyACM*` elsewhere. The browser remembers it, so later launches reconnect automatically, including when the USB cable is plugged back in. The status pill should read **Mega connected · fw 0.2.0**.

No hardware? Click **Use simulator**. A virtual panel with dials and buttons stands in for the Mega, and every tab works.

### Optional: motor-only test sketch

`firmware/x_motor_test/x_motor_test.ino` checks the X motor, LCD, pots and buttons without the UI. The motor runs 10 s on, 5 s off, five times. Pot changes and button presses show on the LCD and in the Serial Monitor at 115200 baud. Re-upload `lpbf_mixer` afterwards to use the UI again.

---

## Hardware at a glance

| Item | Detail |
| :--- | :--- |
| Controller | Arduino Mega 2560 + RAMPS 1.4, 12 V on the RAMPS **5 A** input pair |
| Drivers | 4 × Pololu A4988 in X, Y, Z, E0. V<sub>ref</sub> 0.45 V ≈ 0.83 A. MS jumpers for 1/16 |
| Motors | 17HS15-1684S-PG5, NEMA 17 with a 5.18 : 1 planetary gearbox |
| Motor header order | 2B 2A 1A 1B = **B− B+ A+ A−** |
| Dials | Pots on A5, A9, A10, A11 (AUX-2), one per motor |
| Buttons | Red D40 (confirm, next, stop), green D42 (start). Active high with 10 kΩ pull-downs |
| LCD | 16×2 with a PCF8574 I²C backpack on the RAMPS I²C header (SDA D20, SCL D21) |
| Max speed | 180 rpm at the motor = 34.7 rpm at the gearbox output (the cleaning speed) |

The full wiring, including the AUX-2 pin map from the RAMPS silkscreen, is in `panel_wiring_diagram.html` and on the UI's **Reference** tab.

---

## Using the UI

### Dispense
1. **Setup.** Motor 1 is selected. Turn dial 1 or type a value, and the LCD and UI both follow. A typed value holds until the dial is turned about 3% of its travel. Then the dial takes over.
2. **Confirm.** Red confirms the motor and moves to the next. After motor 4 the system is **Ready**.
3. **Run.** Green starts a timed run. The four values are scaled into shares, and the largest runs at the top speed. Red or **Stop** ends it early.
4. **Done.** Green repeats the run, and red goes back to editing from motor 1.

### Calibrate
After a run, weigh each canister's output and enter it on the **Calibrate** tab. Each entry adds a grams-per-revolution point at that speed. Once every canister in use has a point, the UI estimates the dispensed mass and the mass-based mix. Points live in the browser. Use **Export CSV** to keep them.

### Clean
1. Detach the canister and put a tray under the outlet.
2. Tick the confirmation box.
3. Pick the dispensers, then **Start cleaning**. They spin at 180 motor rpm until you press **Stop**, the red panel button or **Stop motors** in the green bar.
4. **Clean again** if powder is still coming out.

The UI sends a heartbeat every second. If the board hears nothing for 5 s (tab closed, cable pulled), it stops cleaning by itself.

### 3D assembly view
The view flies to the selected motor, or frames and boxes several. The machine turns see-through for about a second when several motors are selected, or when a motor would be hidden behind other parts. Clicking a motor selects it.

Motor 1 (X) and Motor 2 (Y) are the front pair, left to right. Motor 3 (Z) is across from Motor 1, and Motor 4 (E0) across from Motor 2. If that's wrong, use **Motor numbering looks wrong?** under the view to swap them.

**After changing the CAD:**
1. Export the Fusion assembly as STEP to `FullDesign.step`.
2. Run `python tools/devserver.py`.
3. Open http://127.0.0.1:8766/tools/convert.html and press **Convert**. It rewrites `ui/assets/assembly.glb`.

### Reference
Shows the wiring diagram, the markdown docs in this folder, the power supply and safety record, and the RAMPS dossier PDF, read straight from the repository.

---

## Demo checklist

**Night before:**
1. Upload `lpbf_mixer` to the Mega and close the Arduino IDE.
2. Run `start-ui.bat`, then press **Ctrl+Shift+R** once to drop any cached old copy.
3. Connect once.
4. Run one Clean and one Dispense pass.

**On the day:**
1. Plug in USB.
2. Switch on 12 V, with the motors plugged in before power.
3. Double-click the launcher.
4. Check the pill shows **fw 0.2.0**.

If the hardware misbehaves, use **Disconnect**, then **Use simulator**.

---

## Repository layout

| Path | What it is |
| :--- | :--- |
| `start-ui.bat` | One-click Windows launcher |
| `firmware/lpbf_mixer/` | Main Mega firmware: dials, buttons, LCD, per-motor timer step generation, cleaning, serial protocol |
| `firmware/x_motor_test/` | Standalone motor, LCD, pot and button test sketch |
| `ui/index.html`, `ui/app.js`, `ui/styles.css` | The UI |
| `ui/device-serial.js` | Web Serial link to the Mega |
| `ui/device-sim.js` | Simulator that mirrors the firmware state machine |
| `ui/viewer3d.js` | 3D assembly view (three.js) |
| `ui/docs.js` | Reference tab |
| `ui/calibration.js` | Calibration curve storage |
| `ui/assets/` | The 3D model converted from `FullDesign.step` |
| `ui/vendor/` | Bundled libraries: three.js 0.160.0 (MIT), occt-import-js 0.0.23 (LGPL-2.1), marked 12.0.2 (MIT) |
| `tools/serve.py` | Local static server used by the launcher (no-cache, localhost only) |
| `tools/convert.html`, `tools/devserver.py` | One-time STEP → GLB converter |
| `FullDesign.step` | Fusion 360 assembly export (source of the 3D model) |
| `panel_wiring_diagram.html` | Interactive panel wiring diagram |
| `ramps_1_4_*.md`, `power_supply_and_ramps14_safety_record.md`, `RAMPS_dossier.pdf` | Hardware documentation |

## Serial protocol (115200 baud)

Commands are newline-terminated text:

| Command | Meaning |
| :--- | :--- |
| `PING` | Board replies with its greeting |
| `STATUS` | Send a status line now |
| `SET m v` | Set motor m's ratio to v |
| `SEL m` | Select motor m |
| `NEXT` | Same as the red button |
| `GO` | Same as the green button |
| `STOP` | Stop a run or cleaning |
| `RESET` | Reset the ratios |
| `CLEAN mask` | Clean the motors in the bitmask (bit 0 = X … bit 3 = E0) |
| `KA` | Heartbeat |
| `DUR s` | Run duration in seconds |
| `TOP rpm×10` | Top speed |
| `MS 1\|2\|4\|8\|16` | Microstepping |
| `GEAR ratio×100` | Gearbox ratio |
| `INV mask` | Reverse motor directions |

The board replies with one JSON object per line:

| Reply | Meaning |
| :--- | :--- |
| `hello` | Greeting, with the firmware version |
| `st` | Status, sent 5 times a second and on any change |
| `ev` | Button and cleaning events |
| `ack` | Command accepted |
| `err` | Command refused, with the reason |
