# KiranaOS — Retail Hardware Integration Guide

This document describes how to connect, configure, and troubleshoot common Indian retail POS hardware devices with KiranaOS.

---

## 1. Barcode Scanners (USB HID)

### Supported Hardware
- TVS Electronics (BS-L100 Plus, BSF 100)
- Honeywell (Voyager 1250g, 1450g 2D)
- Posiflex / Datalogic / Zebra
- Any USB barcode gun or omnidirectional hands-free scanner that operates in **HID Keyboard Emulation Mode**.

### Configuration
1. Connect the scanner via USB. Windows will automatically recognize it as an input device (`HID-compliant keyboard`).
2. Scan the barcode in the scanner manual labeled **"Add Carriage Return (Enter) Suffix"**.
3. In KiranaOS, open **Hardware Setup (`/settings/hardware`)**.
4. Scan any item in the diagnostics input pad. The tool will measure the interval between keystrokes. An average keystroke interval `< 30ms` confirms the hardware scanner is recognized.

---

## 2. Thermal Receipt Printers (58 mm & 80 mm)

### Supported Formats
- **58 mm (2-inch)**: Compact receipt format (32 characters per line, font size 10px). Ideal for small grocery shops and low-cost paper rolls.
- **80 mm (3-inch)**: Standard retail receipt format (48 characters per line, font size 11px). Includes detailed line items, discounts, and GST breakdowns.
- **A4 Full Sheet**: Tax invoice for bulk wholesale transactions or customer credit accounts.

### Browser Printing Setup
1. Connect your thermal printer (USB, Ethernet, or Bluetooth) and install the manufacturer driver (e.g. TVS RP3200 driver or Epson TM Series Virtual Port).
2. Set paper size to `58mm x Receipt` or `80mm x Receipt` in Windows Printer Properties.
3. In Chrome/Brave print dialog:
   - Margins: **None**
   - Headers and Footers: **Unchecked**
4. Set default paper format in KiranaOS **Store Settings → Default Receipt Print Format**.

---

## 3. Cash Drawers (RJ-11 Kick Pulse)

In retail setups, the electronic cash drawer connects via RJ-11 phone cable directly to the **DK (Drawer Kick) port** on the back of the thermal printer.

### Trigger Command
When a cash bill is completed or change is returned, the printer sends a pulse to open the drawer:
```
ESC p m t1 t2
HEX: 1B 70 00 19 FA
Decimal: 27 112 0 25 250
```
- Most printer drivers have an option under **Device Settings → Cash Drawer → Open Before Printing / Open After Printing**. Enable this in Windows printer settings for automatic opening.

---

## 4. Electronic Weighing Scales

For loose produce, grains, dals, and sugar sold by fractional weight:
- Connect the weighing scale to the POS computer via RS-232 serial cable or USB-to-Serial converter.
- Configure serial communication parameters:
  - Baud Rate: `9600`
  - Data Bits: `8`
  - Parity: `None`
  - Stop Bits: `1`
- In KiranaOS POS, items marked with `is_loose_weight = 1` allow entering fractional decimals directly (e.g. `0.75` kg or `1.25` kg).
