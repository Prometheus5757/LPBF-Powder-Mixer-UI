# RAMPS 1.4 & Arduino Mega Complete Wiring Reference

This document summarizes the complete hardware configuration, stepper driver calibration, and `AUX-2` control wiring for your Arduino Mega + RAMPS 1.4 setup.

---

## 1. Final Master Wiring & Configuration Table

| Component / Subsystem | RAMPS Header / Point | Arduino Pin | Wiring & Configuration Details |
| :--- | :--- | :--- | :--- |
| **Stepper Drivers (Pololu A4988)** | `X`, `Y`, `Z`, `E0` Sockets | Step/Dir/En | Genuine Pololu A4988 drivers with heatsinks installed (no active fan). $V_{\text{ref}}$ calibrated to **$0.45\text{ V}$** ($\approx 0.83\text{ A}$ on `R068` boards) for **17HS15-1684S-PG5** geared stepper motors. |
| **5V & GND Power Rails** | `AUX-2` (`5V` & `GND`) | `5V` / `GND` | Routed via female DuPont jumpers to a breadboard power rail to distribute `5V` and Common `GND` evenly across all controls. |
| **Potentiometer 1** | `AUX-2` | **`A5`** (`D59`) | Outer pins to breadboard `5V` (left) and `GND` (right); middle wiper pin to `A5`. |
| **Potentiometer 2** | `AUX-2` | **`A9`** (`D63`) | Outer pins to breadboard `5V` (left) and `GND` (right); middle wiper pin to `A9`. |
| **Potentiometer 3** | `AUX-2` | **`A10`** (`D64`) | Outer pins to breadboard `5V` (left) and `GND` (right); middle wiper pin to `A10`. |
| **Potentiometer 4** | `AUX-2` | **`A11`** (`D65`) | Outer pins to breadboard `5V` (left) and `GND` (right); middle wiper pin to `A11`. |
| **Push Button 1** | `AUX-2` | **`D40`** | One leg to breadboard `5V`; second leg connected to `D40` AND pulled down to breadboard `GND` via a **$10\text{ k}\Omega$ resistor**. |
| **Push Button 2** | `AUX-2` | **`D42`** | One leg to breadboard `5V`; second leg connected to `D42` AND pulled down to breadboard `GND` via a **$10\text{ k}\Omega$ resistor**. |

---

## 2. `AUX-2` Header Pinout Map

Looking at the RAMPS 1.4 board with the green power terminals positioned on the left, all of your external inputs are consolidated onto the $2 \times 5$ `AUX-2` header:

```text
      [ Left Column ]         [ Right Column ]
Row 1:      5V  ────────────►  GND (Breadboard Rails)
Row 2:   A9 (D63) [Pot 2]      A5 (D59) [Pot 1]
Row 3:  A10 (D64) [Pot 3]      D40      [Button 1]
Row 4:  A11 (D65) [Pot 4]      D42      [Button 2]
Row 5:  A12 (D66) [Spare]      D44      [Spare]
```

---

## 3. Schematic Overview (Breadboard & Control Circuit)

### Potentiometers ($\times 4$)
* **Left Pin:** Connected to Breadboard `5V` bus.
* **Middle Pin (Wiper):** Connected via female DuPont wire directly to `A5`, `A9`, `A10`, or `A11`.
* **Right Pin:** Connected to Breadboard `GND` bus.

### Push Buttons ($\times 2$, Active-High with Pull-Down)
```text
Breadboard 5V ────[ Push Button ]────┬────► RAMPS AUX-2 (D40 or D42)
                                     │
                                  [10 kΩ]
                                     │
Breadboard GND ──────────────────────┘
```
* **Unpressed State:** The $10\text{ k}\Omega$ resistor holds the digital pin at `0V` (`LOW` / `0`).
* **Pressed State:** `5V` flows through the switch to the digital pin (`HIGH` / `1`).

---

## 4. Complete Arduino Verification Sketch

Upload this sketch to the Arduino Mega to verify all four potentiometers and both push buttons simultaneously in the Serial Monitor (`115200` baud):

```cpp
// Analog Potentiometer Pins (AUX-2)
const int potPins[4] = {A5, A9, A10, A11};

// Digital Push Button Pins (AUX-2)
const int button1Pin = 40;
const int button2Pin = 42;

void setup() {
  Serial.begin(115200);

  // External 10k pull-down resistors are wired on the breadboard
  pinMode(button1Pin, INPUT);
  pinMode(button2Pin, INPUT);
}

void loop() {
  // Read and print all 4 potentiometers (0 - 1023)
  for (int i = 0; i < 4; i++) {
    int potVal = analogRead(potPins[i]);
    Serial.print("Pot ");
    Serial.print(i + 1);
    Serial.print(": ");
    Serial.print(potVal);
    Serial.print(" | ");
  }

  // Read and print both push buttons (0 = Released, 1 = Pressed)
  int btn1State = digitalRead(button1Pin);
  int btn2State = digitalRead(button2Pin);

  Serial.print("Btn 1 (D40): ");
  Serial.print(btn1State);
  Serial.print(" | Btn 2 (D42): ");
  Serial.println(btn2State);

  delay(150);
}
```

---

## 5. Pre-Power-On Safety Checklist
- [ ] **Driver Orientation:** Confirm all Pololu A4988 trimpots face **away** from the `D8–D10` green power terminal blocks.
- [ ] **Driver $V_{\text{ref}}$:** Verified at **$0.45\text{ V}$** between the potentiometer screw head and `GND`.
- [ ] **Breadboard Rails:** Confirm `5V` and `GND` are never bridged together and that any split center buses on the breadboard are jumpered across.
- [ ] **Motor Connections:** Ensure stepper motors are plugged in securely **before** applying 12V/24V main power (never connect or disconnect stepper motors while powered).