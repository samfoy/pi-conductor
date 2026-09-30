import { closeSync, constants, fstatSync, openSync, readSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "./cli.ts";

const LIMIT = 32 * 1048576;
/** One read-only cursor per invocation. No decoder.end(): a dangling line is not an event. */
export class HerdrTail {
  private offset: number;
  private partial = "";
  private decoder = new StringDecoder("utf8");
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private draining = false;
  constructor(private readonly options: { path: string; offset: number; nonce: string; line: (line: string) => void; error: (error: Error) => void }) {
    this.offset = options.offset;
  }
  start(): void {
    if (this.closed || this.timer) return;
    try {
      this.watcher = watch(dirname(this.options.path), { persistent: false }, () => this.drain());
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
    } catch { /* The poll also covers unavailable watches and late file creation. */ }
    this.timer = setInterval(() => this.drain(), 1000); this.timer.unref();
    this.drain();
  }
  drain(): void {
    if (this.closed || this.draining) return;
    this.draining = true;
    let fd: number | undefined;
    try {
      try { fd = openSync(this.options.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < this.offset) throw new Error("herdr: transcript identity/size changed");
      if (stat.size - this.offset > LIMIT) throw new Error("herdr: transcript scan limit exceeded");
      const buffer = Buffer.alloc(65536);
      while (this.offset < stat.size && !this.closed) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!count) throw new Error("herdr: transcript changed during read");
        this.offset += count;
        const lines = (this.partial + this.decoder.write(buffer.subarray(0, count))).split("\n");
        this.partial = lines.pop()!;
        if (this.partial.length > LIMIT) throw new Error("herdr: transcript line limit exceeded");
        for (const line of lines) {
          let event: unknown; try { event = JSON.parse(line); } catch { continue; }
          if (isRecord(event) && isRecord(event._c) && event._c.n === this.options.nonce) this.options.line(line);
        }
      }
    } catch (e) { this.close(); this.options.error(e as Error); }
    finally { if (fd !== undefined) closeSync(fd); this.draining = false; }
  }
  close(): void {
    this.closed = true;
    this.watcher?.close(); this.watcher = undefined;
    clearInterval(this.timer); this.timer = undefined;
    this.partial = "";
  }
}
