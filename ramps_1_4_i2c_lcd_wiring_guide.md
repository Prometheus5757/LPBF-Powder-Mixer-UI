# RAMPS 1.4 to 16x2 I2C LCD Wiring Guide

This reference covers connecting a 16x2 LCD with an I2C backpack to a RAMPS 1.4 shield mounted on an Arduino Mega, utilizing the onboard 5V rail powered via the RAMPS D1 diode.

## Pinout Table

Locate the **4-pin I2C header** on the RAMPS 1.4 shield (situated near the reset button and endstop pins) and connect the pins as follows:

| LCD I2C Backpack Pin | RAMPS 1.4 I2C Header | Arduino Mega Pin | Function |
| :--- | :--- | :--- | :--- |
| **GND** | **GND** (`-`) | GND | Ground / Negative power rail |
| **VCC** | **5V** (`+`) | 5V | Positive 5V power supply |
| **SDA** | **SDA** | Pin 20 (D20) | I2C Serial Data line |
| **SCL** | **SCL** | Pin 21 (D21) | I2C Serial Clock line |

## Safety & Troubleshooting Notes

* **Input Voltage Limits:** The Arduino Mega's onboard 5V voltage regulator (AMS1117) handles the 20–40 mA draw of a 16x2 LCD backlight safely when powered by a **12V** supply. Do not use this setup with a **24V** supply unless the D1 diode is removed and an external 5V regulator is used, as the Mega's regulator will overheat.
* **Polarity:** Double-check that **VCC** and **GND** are not reversed before powering on, as reversing them will short the 5V rail.
* **Contrast Adjustment:** If the backlight turns on but no characters appear, use a small Phillips screwdriver to turn the blue potentiometer on the back of the I2C backpack until the text becomes visible.