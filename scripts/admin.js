#!/usr/bin/env node
// Staff command line. These actions are never available to the AI agent.
//
//   node scripts/admin.js bookings
//   node scripts/admin.js pending
//   node scripts/admin.js approve RQ-001
//   node scripts/admin.js reject RQ-001
//   node scripts/admin.js audit            # print the log
//   node scripts/admin.js verify           # check the hash chain
import { createBookingSystem, verifyAudit } from "../src/core.js";
import { loadState, saveState } from "../src/server.js";

const file = process.env.BOOKINGS_DATA ?? new URL("../data/state.json", import.meta.url).pathname;
const system = createBookingSystem({ state: loadState(file), actor: `staff:${process.env.USER ?? "admin"}` });
const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case "bookings":
    console.table(system.staff.listAll());
    break;
  case "pending":
    console.table(system.staff.pending());
    break;
  case "approve":
  case "reject":
    console.log(system.staff.decide({ request_id: arg, approve: cmd === "approve" }));
    saveState(file, system.state);
    break;
  case "audit":
    for (const e of system.state.audit) console.log(`${e.seq}\t${e.at}\t${e.actor}\t${e.tool}\t${e.outcome}\t${e.detail ?? ""}`);
    break;
  case "verify": {
    const r = verifyAudit(system.state.audit);
    console.log(r.ok ? `Audit log intact (${r.entries} entries)` : `Audit log altered at entry ${r.brokenAt}`);
    process.exitCode = r.ok ? 0 : 1;
    break;
  }
  default:
    console.log("Commands: bookings | pending | approve <id> | reject <id> | audit | verify");
}
