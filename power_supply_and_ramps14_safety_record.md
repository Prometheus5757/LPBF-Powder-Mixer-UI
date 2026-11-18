# Custom Power Distribution & Electronics Safety Record

This document summarizes the specifications, engineering practices, and safety configurations discussed for integrating a **Mean Well LRS-350 Power Supply** with a **Pololu RAMPS 1.4 Control Board**.

---

## 1. AC Power Entry Modules (PEM) Overview
An all-in-one AC Power Entry Module integrates a standard 3-pin power connection, a dedicated rocker switch, and a protective fuse compartment into a single component. 

### Component Comparison Table
| Component Options | Typical Pricing | Key Specs & Variations |
| :--- | :--- | :--- |
| **Chassis Mount IEC320 C14 Module** | \$4.99 | • 15A Max rating<br>• Screw-mount flange (stable)<br>• SPST On/Off rocker switch |
| **Uxcell IEC320 C14 Inlet Socket** | \$7.26 | • 10A 250V AC rating<br>• Built-in 5x20mm fuse compartment<br>• Illuminated Red SPST Switch |
| **Schurter Medical Grade PEM** | \$15.33 | • 10A 250V AC rating<br>• Snap-in front panel mount<br>• Industrial/Medical grade reliability |

### Critical Selection Details
* **Mounting Style:** Screw-mount modules are highly recommended for high mechanical stability over snap-in models when plugging/unplugging frequently.
* **Switch Type:** Unlit SPST switches require simple 2-pin series wiring. Illuminated switches require a dedicated connection to the Neutral line to power the internal lamp.
* **Fusing:** Most units accept standard 5x20mm glass or ceramic fuses. Always verify the fuse amperage matches your power supply's continuous current draw calculations.

---

## 2. Integration and Mounting Constraints
* **Native Fitment:** An AC power entry module **cannot** be mounted directly into a Mean Well LRS-350 power supply frame without an external bracket or case. The LRS-350 features a flat metal chassis terminating in an exposed 9-pin covered screw terminal block.
* **Safety Hazard:** Wiring an entry module directly to the screw terminals without a structural enclosure leaves high-voltage AC mains exposed, creating severe shock and short-circuit risks.
* **Engineering Solution:** Use a 3D-printed enclosure or end-cap bracket that mounts to the existing M3/M4 chassis threads to securely house the inlet module and cover the terminals.

---

## 3. Alternative Hardwired Configuration (Switch Strip Control)
Using a hardwired power cord directly connected to the terminals and controlled via a switched, trip-safe multi-port extension cable is a safe and effective alternative, provided the following precautions are taken:

### 3D-Printable Safety Covers
* **Clamping Cable Cover:** Utilizes a mechanical clamp to protect the mains connection and provide strain relief, ensuring a tug on the cord cannot pull wires out of the terminal block.
* **Connector Cover:** A protective barrier mounting to the side threads of the LRS-350 frame that shields all 9 pins while providing a safe exit path for AC and DC lines.

### Wiring Best Practices
1. **Prep the Cord Ends:** Strip the outer jacket back roughly 2 to 3 inches. Strip individual Hot, Neutral, and Ground lines back by 0.25 inches.
2. **Use Crimp Terminals:** Always crimp insulated **#6 fork (spade) terminals** or wire ferrules onto the splayed wire ends. Never jam loose, bare stranded wire straight into the screw terminals.
3. **Pin Assignment (US Standard Colors):**
   * **`L` (Line/Hot):** Black wire
   * **`N` (Neutral):** White wire
   * **`⏚` (Earth Ground):** Green wire (Critical for grounding the metal chassis)

---

## 4. Powering the Pololu RAMPS 1.4 Board (12V)
Flipping the multi-port extension cable switch to power the system will **not** cause damage to the RAMPS 1.4 board. Modern switching power supplies utilize soft-start circuitry to suppress initial current inrush and smoothly ramp the DC output up to 12V.

### Crucial System Checklist
* **Input Voltage Selection:** Ensure the 115V/230V physical slider switch inside the side cutout of the LRS-350 chassis is set explicitly to **115V** for standard US mains.
* **RAMPS 1.4 Dual-Terminal Wiring:** The green terminal block on the RAMPS 1.4 board features two distinct input zones. Run pairs of 12V power and ground wires to **both** inputs if a heated print bed is used:
  * *11A Terminal (Top Pair):* Powers the heated bed output (`D8`). Recommended wire gauge: **14 AWG**.
  * *5A Terminal (Bottom Pair):* Powers stepper drivers, extruder heaters, fans, and the Arduino Mega logic. Recommended wire gauge: **16 AWG or 18 AWG**.
* **DC Polarity Verification:** Double-check that positive (`+V`) lines from the LRS-350 route strictly to positive inputs, and negative (`-V` / COM) lines route to negative inputs. Reversed DC polarity will immediately destroy components or blow the onboard RAMPS protection diodes.