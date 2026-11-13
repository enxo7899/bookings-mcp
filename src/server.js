#!/usr/bin/env node
// MCP server exposing the booking tools to any MCP client (Claude Desktop,
// Claude Code, your own agent). Staff-only actions are deliberately not exposed.
//
//   BOOKINGS_DATA=./data/state.json TZ=Europe/Tirane node src/server.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { createBookingSystem, emptyState } from "./core.js";

export function createServer({ system, onChange = () => {} }) {
  const server = new McpServer({ name: "bookings-mcp", version: "1.0.0" });
  const reply = (result) => {
    onChange();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result.ok === false };
  };

  const date = z.string().describe("Date as YYYY-MM-DD");
  const time = z.string().describe("Local 24-hour time as HH:MM");
  const phone = z.string().describe("Customer phone in international format, e.g. +355691234567");

  server.registerTool(
    "list_services",
    { title: "List services", description: "Services, prices, staff, opening hours and booking rules. Call this first.", annotations: { readOnlyHint: true } },
    async () => reply(system.tools.list_services({}))
  );

  server.registerTool(
    "find_slots",
    {
      title: "Find free slots",
      description: "Free start times for a service on a date. Always check before offering a time.",
      inputSchema: { service: z.string().describe("Service id from list_services"), date, staff: z.string().optional().describe("Optional staff id") },
      annotations: { readOnlyHint: true },
    },
    async (a) => reply(system.tools.find_slots(a))
  );

  server.registerTool(
    "create_booking",
    {
      title: "Create booking",
      description:
        "Books an appointment. First call WITHOUT customer_confirmed to get a summary, read it to the customer, and only call again with customer_confirmed: true after they say yes.",
      inputSchema: {
        service: z.string(),
        date,
        time,
        staff: z.string().optional(),
        customer_name: z.string(),
        customer_phone: phone,
        customer_confirmed: z.boolean().optional().describe("true only after the customer explicitly agreed to the summary"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (a) => reply(system.tools.create_booking(a))
  );

  server.registerTool(
    "find_bookings",
    {
      title: "Find a customer's bookings",
      description: "Upcoming bookings for one phone number. There is no way to list other customers' bookings.",
      inputSchema: { customer_phone: phone },
      annotations: { readOnlyHint: true },
    },
    async (a) => reply(system.tools.find_bookings(a))
  );

  server.registerTool(
    "reschedule_booking",
    {
      title: "Reschedule booking",
      description: "Moves a booking. The phone must match the booking. Within 24 hours of the appointment this creates a request for staff instead.",
      inputSchema: { booking_id: z.string(), customer_phone: phone, new_date: date, new_time: time },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (a) => reply(system.tools.reschedule_booking(a))
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel booking",
      description: "Cancels a booking. The phone must match the booking. Within 24 hours of the appointment this creates a request for staff instead.",
      inputSchema: { booking_id: z.string(), customer_phone: phone, reason: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (a) => reply(system.tools.cancel_booking(a))
  );

  return server;
}

export function loadState(file) {
  return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : emptyState();
}

export function saveState(file, state) {
  if (!file) return;
  writeFileSync(file + ".tmp", JSON.stringify(state, null, 2));
  renameSync(file + ".tmp", file); // atomic, so a crash never leaves half a file
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.env.BOOKINGS_DATA ?? new URL("../data/state.json", import.meta.url).pathname;
  const system = createBookingSystem({ state: loadState(file) });
  const server = createServer({ system, onChange: () => saveState(file, system.state) });
  await server.connect(new StdioServerTransport());
  console.error(`bookings-mcp ready (data: ${file})`);
}
