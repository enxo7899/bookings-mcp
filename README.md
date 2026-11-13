# bookings-mcp: an AI booking agent that can't break the rules

An [MCP](https://modelcontextprotocol.io) server that lets an AI receptionist book, move and cancel appointments for a salon, clinic or studio, **safely**. The business rules live in code, not in the prompt, so a confused or manipulated model still can't double-book, ignore opening hours, cancel someone else's appointment or quietly rewrite history.

Works with Claude Desktop, Claude Code or any MCP-capable agent, and behind a WhatsApp or website chat.

**▶ Live demo: https://enxo7899.github.io/bookings-mcp/** (run four agent scenarios, or open the **Tool console** and try to break the rules yourself; everything runs in your browser against the real rules)

![Agent tool calls, calendar and audit log](docs/overview.png)

## Guardrails

| Risk | What stops it |
|---|---|
| Booking without the customer agreeing | `create_booking` first returns a **preview**; nothing is written until it's called again with `customer_confirmed: true` |
| Double booking | Overlap check per staff member on every create and move; `find_slots` never offers a taken time |
| Impossible times | Opening hours per weekday, closed days, 15-minute grid, service length must fit before closing |
| Last-minute and far-future bookings | Minimum 2 hours' notice, maximum 60 days ahead |
| One customer blocking the diary | At most 2 bookings per customer per day |
| Seeing or changing other people's bookings | No "list all" tool exists; find, move and cancel require the phone number the booking was made with, and "wrong phone" looks the same as "no such booking" |
| Late changes | Within 24 hours, a move or cancellation becomes a **request for staff**; the agent has no tool to approve it |
| Approving a slot that filled up meanwhile | Staff approval re-runs every check |
| Covering tracks | Every call, including refusals, goes into a **SHA-256 hash-chained audit log** with phone numbers masked; `admin verify` detects any edit |
| Bad input | Zod schemas at the MCP layer, then validation in the core with a reason the agent can pass on |

| Prompt injection gets nowhere | Late cancellation waits for staff | Editing the log is detected |
|---|---|---|
| ![](docs/prompt-injection.png) | ![](docs/late-cancel.png) | ![](docs/tampered-log.png) |

**Try to break it yourself.** The demo's tool console calls the same tools an agent would: skip the confirmation, book on a closed day, book in 30 minutes, cancel someone else's appointment. Each attempt is refused with a reason and logged.

![Tool console refusing bookings that break the rules](docs/tool-console.png)

## Tools exposed to the agent

| Tool | Annotations | Purpose |
|---|---|---|
| `list_services` | read-only | Services, prices, staff, hours and rules |
| `find_slots` | read-only | Free start times for a service and date |
| `create_booking` | write | Preview, then book after the customer confirms |
| `find_bookings` | read-only | Upcoming bookings for one phone number |
| `reschedule_booking` | destructive | Move a booking (or request it, inside 24h) |
| `cancel_booking` | destructive | Cancel a booking (or request it, inside 24h) |

Staff actions (approve, reject, list everything, verify the log) are in `scripts/admin.js` and are **never** exposed over MCP.

## Run it

```bash
npm install
npm test                      # 16 tests: rules, privacy, approvals, audit chain, and a real MCP client round-trip
npm run dev                   # demo page at http://127.0.0.1:5175 (?run=happy,inject replays scenarios, ?console opens the tool console)
npm run screenshots           # with dev running: regenerates docs/*.png, fails on console errors
TZ=Europe/Tirane npm start    # MCP server on stdio, data in data/state.json
npm run admin -- pending      # staff: see requests waiting for approval
npm run admin -- approve RQ-001
npm run admin -- verify       # check the audit log hasn't been edited
```

### Use it from Claude Desktop or Claude Code

```json
{
  "mcpServers": {
    "bookings": {
      "command": "node",
      "args": ["/path/to/bookings-mcp/src/server.js"],
      "env": { "BOOKINGS_DATA": "/path/to/bookings.json", "TZ": "Europe/Tirane" }
    }
  }
}
```

Then just ask: *"Book me a haircut on Wednesday morning, I'm Ana, +355 69 234 5678."*

## Adapt it

Services, staff, opening hours and rules are one config object (`DEFAULT_CONFIG` in `src/core.js`). Storage is a JSON file written atomically; swapping in Postgres, Supabase or Google Calendar means replacing `loadState` / `saveState`. The core has no dependencies and also runs in the browser (that's what the demo uses).

| Path | What it is |
|---|---|
| `src/core.js` | Booking rules, privacy checks, approvals, audit log |
| `src/server.js` | MCP server (stdio) with Zod schemas and tool annotations |
| `src/sha256.js` | Dependency-free SHA-256 for the audit chain |
| `scripts/admin.js` | Staff command line |
| `tests/` | Rule tests and an end-to-end MCP client test |
| `index.html` | Interactive demo |

---

Built by **[EmSoft](https://github.com/enxo7899)**: AI agents with safety guardrails, MCP servers and booking assistants. Get in touch through my Fiverr or Upwork profile.
