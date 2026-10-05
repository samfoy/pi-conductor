// One concurrent publisher: tries `count` admissions to `to` and prints the ids it was told were queued.
import { admitCoordination, buildCoordination } from "../../src/supervision/inbox.ts";

const [to, worker, count] = process.argv.slice(2) as [string, string, string];
const accepted: string[] = [];
for (let i = 0; i < Number(count); i++) {
  const record = buildCoordination({ from: `sender-${worker}`, to, text: `m${i}`, createdAt: 1000 + Number(worker) * 100 + i });
  try { admitCoordination(record, () => {}); accepted.push(record.id); } catch (e) { if (!/full|64/.test((e as Error).message)) throw e; }
}
process.stdout.write(JSON.stringify(accepted));
