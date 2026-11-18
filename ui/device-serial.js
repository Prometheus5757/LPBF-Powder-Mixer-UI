// USB link to the Mega through the Web Serial API (Chrome or Edge, served from localhost).

const VENDORS = { 0x2341: 'Arduino', 0x2a03: 'Arduino', 0x1a86: 'CH340', 0x0403: 'FTDI', 0x10c4: 'CP210x' };

export class SerialLink {
  static supported() { return 'serial' in navigator; }

  constructor() {
    this.kind = 'serial';
    this.label = 'USB serial';
    this.lineHandlers = [];
    this.closeHandlers = [];
    this.encoder = new TextEncoder();
  }

  onLine(fn) { this.lineHandlers.push(fn); }
  onClose(fn) { this.closeHandlers.push(fn); }

  /** ports this site was already allowed to use (Chrome remembers them between launches) */
  static async knownPorts() {
    try { return await navigator.serial.getPorts(); } catch { return []; }
  }

  /** @param {SerialPort} [port] a remembered port; without one the browser asks the user to pick */
  async connect(port) {
    this.port = port || await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    const info = this.port.getInfo();
    const vendor = VENDORS[info.usbVendorId];
    this.label = vendor ? `${vendor} USB serial` : 'USB serial';
    this.writer = this.port.writable.getWriter();
    this.readLoop();
  }

  async readLoop() {
    const decoder = new TextDecoderStream();
    this.piped = this.port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line) this.lineHandlers.forEach(fn => fn(line));
        }
      }
    } catch { /* port lost */ }
    finally {
      try { this.reader.releaseLock(); } catch { /* ignore */ }
      if (!this.closing) this.closeHandlers.forEach(fn => fn());
    }
  }

  async send(line) {
    if (!this.writer) return;
    await this.writer.write(this.encoder.encode(line + '\n'));
  }

  async disconnect() {
    this.closing = true;
    try { await this.reader?.cancel(); await this.piped; } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.port?.close(); } catch { /* ignore */ }
    this.closeHandlers.forEach(fn => fn());
  }
}
