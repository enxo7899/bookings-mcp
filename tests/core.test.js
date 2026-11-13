import { test } from "node:test";
import assert from "node:assert/strict";
import { createBookingSystem, verifyAudit } from "../src/core.js";

// Monday 16 Nov 2026, 10:00 local. Tue 17th is open 09–19, Mon is closed.
const NOW = new Date(2026, 10, 16, 10, 0);
const make = (now = NOW) => createBookingSystem({ now: () => now });
const ANA = { customer_name: "Ana Hoxha", customer_phone: "+355692345678" };
const book = (s, extra) => s.tools.create_booking({ service: "haircut", date: "2026-11-18", time: "10:00", ...ANA, customer_confirmed: true, ...extra });

test("first call only previews; nothing is booked until the customer confirms", () => {
  const s = make();
  const r = s.tools.create_booking({ service: "haircut", date: "2026-11-18", time: "10:00", ...ANA });
  assert.equal(r.status, "preview");
  assert.equal(s.state.bookings.length, 0);
  assert.equal(book(s).status, "confirmed");
  assert.equal(s.state.bookings.length, 1);
});

test("no double booking: the second haircut at 10:00 goes to the other stylist, the third is refused", () => {
  const s = make();
  assert.equal(book(s).booking.staff, "Arta");
  assert.equal(book(s, { customer_name: "Besa", customer_phone: "+355690000001" }).booking.staff, "Bora");
  const r = book(s, { customer_name: "Cela", customer_phone: "+355690000002" });
  assert.equal(r.error, "slot_taken");
});

test("overlapping but not identical times also clash", () => {
  const s = make();
  book(s, { staff: "arta", service: "colour", time: "10:00" }); // 10:00–12:00
  const r = book(s, { staff: "arta", time: "11:30", customer_phone: "+355690000003" });
  assert.equal(r.error, "slot_taken");
});

test("opening hours, closed days, notice and horizon are enforced", () => {
  const s = make();
  assert.equal(book(s, { date: "2026-11-23" }).error, "closed"); // Monday
  assert.equal(book(s, { time: "18:30" }).error, "outside_hours"); // haircut would end 19:15
  assert.equal(book(s, { date: "2026-11-17", time: "08:00" }).error, "outside_hours");
  assert.equal(book(s, { time: "10:10" }).error, "bad_time");
  assert.equal(book(s, { date: "2027-03-02" }).error, "too_far");
  const late = make(new Date(2026, 10, 18, 9, 0));
  assert.equal(book(late, { time: "10:00" }).error, "too_soon");
});

test("staff can only be booked for services they do", () => {
  assert.equal(book(make(), { service: "manicure", staff: "arta" }).error, "staff_cannot");
});

test("bad input is refused with a reason the agent can relay", () => {
  const s = make();
  assert.equal(book(s, { customer_phone: "0692345678" }).error, "bad_phone");
  assert.equal(book(s, { customer_name: "" }).error, "missing_name");
  assert.equal(book(s, { service: "tattoo" }).error, "unknown_service");
  assert.equal(book(s, { date: "18/11/2026" }).error, "bad_date");
});

test("a customer can hold at most 2 bookings per day", () => {
  const s = make();
  book(s, { time: "10:00" });
  book(s, { time: "12:00" });
  assert.equal(book(s, { time: "15:00" }).error, "limit_reached");
});

test("you can only see and change bookings for your own phone number", () => {
  const s = make();
  const id = book(s).booking.id;
  assert.equal(s.tools.find_bookings({ customer_phone: "+355690009999" }).bookings.length, 0);
  assert.equal(s.tools.cancel_booking({ booking_id: id, customer_phone: "+355690009999" }).error, "not_found");
  assert.equal(s.tools.cancel_booking({ booking_id: "BK-9999", customer_phone: ANA.customer_phone }).error, "not_found");
  assert.equal(s.state.bookings[0].status, "confirmed");
});

test("changes more than 24h ahead go through; within 24h they wait for staff", () => {
  const s = make();
  const id = book(s).booking.id;
  const moved = s.tools.reschedule_booking({ booking_id: id, customer_phone: ANA.customer_phone, new_date: "2026-11-19", new_time: "11:00" });
  assert.equal(moved.status, "rescheduled");

  const close = make(new Date(2026, 10, 18, 9, 0));
  close.state.bookings.push({ ...s.state.bookings[0], id: "BK-0100", date: "2026-11-18", start: "15:00", end: "15:45" });
  const r = close.tools.cancel_booking({ booking_id: "BK-0100", customer_phone: ANA.customer_phone });
  assert.equal(r.status, "pending_approval");
  assert.equal(close.state.bookings.find((b) => b.id === "BK-0100").status, "confirmed", "not cancelled yet");
  close.staff.decide({ request_id: r.request, approve: true });
  assert.equal(close.state.bookings.find((b) => b.id === "BK-0100").status, "cancelled");
});

test("staff approval re-checks the slot in case it was taken meanwhile", () => {
  const s = make(new Date(2026, 10, 18, 9, 0));
  s.state.bookings.push({ id: "BK-0100", service: "Haircut", serviceId: "haircut", staff: "arta", staffName: "Arta", date: "2026-11-18", start: "15:00", end: "15:45", name: "Ana", phone: ANA.customer_phone, status: "confirmed" });
  const r = s.tools.reschedule_booking({ booking_id: "BK-0100", customer_phone: ANA.customer_phone, new_date: "2026-11-19", new_time: "10:00" });
  assert.equal(r.status, "pending_approval");
  s.tools.create_booking({ service: "haircut", date: "2026-11-19", time: "10:00", customer_name: "Xhoi", customer_phone: "+355690000010", customer_confirmed: true });
  s.tools.create_booking({ service: "haircut", date: "2026-11-19", time: "10:00", customer_name: "Ylli", customer_phone: "+355690000011", customer_confirmed: true });
  const d = s.staff.decide({ request_id: r.request, approve: true });
  assert.equal(d.error, "slot_taken");
  assert.equal(s.state.bookings[0].start, "15:00");
});

test("every call, including refusals, is in a tamper-evident audit log with phones masked", () => {
  const s = make();
  s.tools.list_services();
  book(s);
  book(s, { date: "2026-11-23" });
  assert.equal(s.state.audit.length, 3);
  assert.deepEqual(s.state.audit.map((e) => e.outcome), ["ok", "ok", "refused"]);
  assert.equal(s.state.audit[1].args.customer_phone, "+355•••678");
  assert.equal(verifyAudit(s.state.audit).ok, true);
  s.state.audit[1].outcome = "refused"; // someone edits history
  assert.deepEqual(verifyAudit(s.state.audit), { ok: false, brokenAt: 2 });
});

test("find_slots never offers a taken time", () => {
  const s = make();
  book(s, { staff: "arta" });
  book(s, { staff: "bora", customer_phone: "+355690000004" });
  const { slots } = s.tools.find_slots({ service: "haircut", date: "2026-11-18" });
  assert.ok(!slots.some((x) => x.time === "10:00"));
  assert.ok(!slots.some((x) => x.time === "09:30"), "09:30 + 45 min would overlap 10:00");
  assert.ok(slots.some((x) => x.time === "10:45"));
});
