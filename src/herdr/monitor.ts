/** Independent of stall policy: missing progress and proven process death are different facts. */
export class HerdrMonitor {
  private lastProbe: number;
  private lastScan: number;
  private busy = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: {
    now: () => number; active: () => boolean;
    probe: () => "alive" | "gone" | "unknown";
    scan: () => Promise<void>; drain: () => void; gone: () => void;
  }) { this.lastProbe = this.lastScan = options.now(); }
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.closed || this.busy) return;
    if (!this.options.active()) { this.close(); return; }
    this.busy = true;
    try {
      const now = this.options.now();
      if (now - this.lastProbe >= 5000) {
        this.lastProbe = now;
        if (this.options.probe() === "gone") {
          this.options.drain(); this.close(); this.options.gone(); return;
        }
      }
      if (now - this.lastScan >= 30000 && this.options.active()) {
        this.lastScan = now;
        await this.options.scan();
      }
    } finally { this.busy = false; }
  }
  close(): void { this.closed = true; clearInterval(this.timer); this.timer = undefined; }
}
