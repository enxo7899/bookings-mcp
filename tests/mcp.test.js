// End-to-end: a real MCP client talks to the server over an in-memory transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { createBookingSystem } from "../src/core.js";

async function connect() {
  const system = createBookingSystem({ now: () => new Date(2026, 10, 16, 10, 0) });
  const server = createServer({ system });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...JSON.parse(r.content[0].text), isError: r.isError };
  };
  return { client, call, system };
}

test("exposes exactly the customer-facing tools, never staff actions", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["cancel_booking", "create_booking", "find_bookings", "find_slots", "list_services", "reschedule_booking"]);
  assert.equal(tools.find((t) => t.name === "cancel_booking").annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "find_slots").annotations.readOnlyHint, true);
});

test("a full conversation: look up, preview, confirm, find, cancel", async () => {
  const { call, system } = await connect();
  assert.equal((await call("list_services")).services.length, 4);
  const slots = await call("find_slots", { service: "manicure", date: "2026-11-18" });
  assert.equal(slots.slots[0].staff[0], "Bora");
  const args = { service: "manicure", date: "2026-11-18", time: slots.slots[0].time, customer_name: "Marco", customer_phone: "+393471122334" };
  assert.equal((await call("create_booking", args)).status, "preview");
  const booked = await call("create_booking", { ...args, customer_confirmed: true });
  assert.equal(booked.status, "confirmed");
  assert.equal((await call("find_bookings", { customer_phone: "+393471122334" })).bookings.length, 1);
  assert.equal((await call("cancel_booking", { booking_id: booked.booking.id, customer_phone: "+393471122334" })).status, "cancelled");
  assert.equal(system.state.audit.length, 6);
});

test("refusals come back as tool errors with a reason", async () => {
  const { call } = await connect();
  const r = await call("create_booking", { service: "haircut", date: "2026-11-23", time: "10:00", customer_name: "Ana", customer_phone: "+355692345678", customer_confirmed: true });
  assert.equal(r.isError, true);
  assert.equal(r.error, "closed");
});

test("schema validation rejects missing arguments before any rule runs", async () => {
  const { client } = await connect();
  const r = await client.callTool({ name: "cancel_booking", arguments: { booking_id: "BK-0001" } });
  assert.equal(r.isError, true);
});
