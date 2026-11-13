// Booking rules for a small salon / clinic / studio. Pure JavaScript with no
// I/O: the MCP server, the admin CLI, the tests and the browser demo all use it.
//
// The AI agent can only do what these functions allow. Every call, allowed or
// refused, is written to a hash-chained audit log.
import { sha256 } from "./sha256.js";

export const DEFAULT_CONFIG = {
  business: "Studio Lumi (demo salon)",
  slotMinutes: 15,
  minLeadMinutes: 120, // no bookings less than 2 hours ahead
  maxDaysAhead: 60,
  freeChangeHours: 24, // changes closer than this need a person to approve
  maxBookingsPerCustomerPerDay: 2,
  // 0 = Sunday … 6 = Saturday; null = closed
  hours: { 0: ["10:00", "15:00"], 1: null, 2: ["09:00", "19:00"], 3: ["09:00", "19:00"], 4: ["09:00", "19:00"], 5: ["09:00", "19:00"], 6: ["09:00", "17:00"] },
  staff: [
    { id: "arta", name: "Arta", services: ["haircut", "colour", "blowdry"] },
    { id: "bora", name: "Bora", services: ["haircut", "manicure", "blowdry"] },
  ],
  services: [
    { id: "haircut", name: "Haircut", minutes: 45, price: 1500 },
    { id: "colour", name: "Colour", minutes: 120, price: 5000 },
    { id: "blowdry", name: "Blow-dry", minutes: 30, price: 900 },
    { id: "manicure", name: "Manicure", minutes: 60, price: 1200 },
  ],
  currency: "ALL",
};

// ---------------------------------------------------------------- time helpers
// Times are local wall-clock strings ("2026-11-20", "14:30"), which is how
// customers and staff think about appointments.
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const dayOfWeek = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const stamp = (date, time) => Date.parse(`${date}T${time}:00Z`) / 60000; // minutes since epoch, local wall-clock
const nowStamp = (d) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 60000);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

export class BookingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, msg) => {
  throw new BookingError(code, msg);
};

const maskPhone = (p) => (typeof p === "string" && p.length > 6 ? p.slice(0, 4) + "•••" + p.slice(-3) : p);

// ---------------------------------------------------------------- store
export function emptyState() {
  return { nextId: 1, bookings: [], requests: [], audit: [] };
}

export function createBookingSystem({ state = emptyState(), config = DEFAULT_CONFIG, now = () => new Date(), actor = "agent" } = {}) {
  const service = (id) => config.services.find((s) => s.id === id) ?? fail("unknown_service", `No service called "${id}". Use list_services.`);
  const staffFor = (svc) => config.staff.filter((s) => s.services.includes(svc.id));
  const active = () => state.bookings.filter((b) => b.status === "confirmed");

  function audit(tool, args, outcome, detail) {
    const prev = state.audit.at(-1)?.hash ?? "genesis";
    const safeArgs = { ...args };
    if (safeArgs.customer_phone) safeArgs.customer_phone = maskPhone(safeArgs.customer_phone);
    const entry = { seq: state.audit.length + 1, at: now().toISOString(), actor, tool, args: safeArgs, outcome, detail, prev };
    entry.hash = sha256(JSON.stringify({ ...entry, hash: undefined }));
    state.audit.push(entry);
    return entry;
  }

  // Wraps every tool: validation errors and rule refusals are logged too.
  function logged(tool, fn) {
    return (args = {}) => {
      try {
        const result = fn(args);
        audit(tool, args, result?.status === "pending_approval" ? "needs_approval" : "ok", result?.summary ?? null);
        return result;
      } catch (e) {
        if (!(e instanceof BookingError)) throw e;
        audit(tool, args, "refused", `${e.code}: ${e.message}`);
        return { ok: false, error: e.code, message: e.message };
      }
    };
  }

  function checkDate(date, time) {
    if (!DATE_RE.test(date ?? "")) fail("bad_date", "Use a date like 2026-11-20.");
    if (time !== undefined && !TIME_RE.test(time ?? "")) fail("bad_time", "Use a 24-hour time like 14:30.");
  }

  function hoursFor(date) {
    const h = config.hours[dayOfWeek(date)];
    return h ? [toMin(h[0]), toMin(h[1])] : null;
  }

  function conflict(staffId, date, start, end, ignoreId) {
    return active().find((b) => b.staff === staffId && b.date === date && b.id !== ignoreId && start < toMin(b.end) && toMin(b.start) < end);
  }

  // Shared by booking and rescheduling. Throws with a reason the agent can relay.
  function validateSlot({ svc, date, time, staffId, phone, ignoreId }) {
    checkDate(date, time);
    const open = hoursFor(date) ?? fail("closed", `We're closed on that day.`);
    const start = toMin(time);
    const end = start + svc.minutes;
    if (start % config.slotMinutes) fail("bad_time", `Appointments start every ${config.slotMinutes} minutes.`);
    if (start < open[0] || end > open[1]) fail("outside_hours", `That day we're open ${toHHMM(open[0])}–${toHHMM(open[1])}, and a ${svc.name.toLowerCase()} takes ${svc.minutes} minutes.`);
    const lead = stamp(date, time) - nowStamp(now());
    if (lead < config.minLeadMinutes) fail("too_soon", `Bookings need at least ${config.minLeadMinutes / 60} hours' notice.`);
    if (lead > config.maxDaysAhead * 1440) fail("too_far", `We take bookings up to ${config.maxDaysAhead} days ahead.`);
    const candidates = staffId ? [config.staff.find((s) => s.id === staffId) ?? fail("unknown_staff", `No staff member "${staffId}".`)] : staffFor(svc);
    if (staffId && !candidates[0].services.includes(svc.id)) fail("staff_cannot", `${candidates[0].name} doesn't do ${svc.name.toLowerCase()}.`);
    const free = candidates.find((s) => !conflict(s.id, date, start, end, ignoreId));
    if (!free) fail("slot_taken", "That time is already booked. Use find_slots to see what's free.");
    const sameDay = active().filter((b) => b.phone === phone && b.date === date && b.id !== ignoreId).length;
    if (sameDay >= config.maxBookingsPerCustomerPerDay) fail("limit_reached", `A customer can hold at most ${config.maxBookingsPerCustomerPerDay} bookings per day.`);
    return { staff: free, start: toHHMM(start), end: toHHMM(end) };
  }

  function ownBooking(id, phone) {
    const b = state.bookings.find((x) => x.id === id && x.status === "confirmed");
    // Same message for "doesn't exist" and "not yours", so bookings can't be probed.
    if (!b || b.phone !== phone) fail("not_found", "No active booking with that reference for this phone number.");
    return b;
  }

  const needsApproval = (b) => stamp(b.date, b.start) - nowStamp(now()) < config.freeChangeHours * 60;

  const publicBooking = (b) => ({ id: b.id, service: b.service, staff: b.staffName, date: b.date, start: b.start, end: b.end, customer: b.name, status: b.status });

  const tools = {
    list_services: logged("list_services", () => ({
      ok: true,
      business: config.business,
      services: config.services.map((s) => ({ ...s, currency: config.currency, staff: staffFor(s).map((x) => x.name) })),
      opening_hours: Object.fromEntries(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => [d, config.hours[i] ? config.hours[i].join("–") : "closed"])),
      rules: [
        `At least ${config.minLeadMinutes / 60} hours' notice, up to ${config.maxDaysAhead} days ahead`,
        `Changes or cancellations less than ${config.freeChangeHours} hours before need staff approval`,
        `Max ${config.maxBookingsPerCustomerPerDay} bookings per customer per day`,
      ],
    })),

    find_slots: logged("find_slots", ({ service: sid, date, staff }) => {
      const svc = service(sid);
      checkDate(date);
      const open = hoursFor(date);
      if (!open) return { ok: true, date, slots: [], note: "Closed that day." };
      const slots = [];
      for (let t = open[0]; t + svc.minutes <= open[1]; t += config.slotMinutes) {
        const time = toHHMM(t);
        const lead = stamp(date, time) - nowStamp(now());
        if (lead < config.minLeadMinutes || lead > config.maxDaysAhead * 1440) continue;
        const who = (staff ? config.staff.filter((s) => s.id === staff) : staffFor(svc)).filter((s) => s.services.includes(svc.id) && !conflict(s.id, date, t, t + svc.minutes));
        if (who.length) slots.push({ time, staff: who.map((s) => s.name) });
      }
      return { ok: true, service: svc.name, date, slots, summary: `${slots.length} free slots` };
    }),

    create_booking: logged("create_booking", (a) => {
      const svc = service(a.service);
      if (!a.customer_name || String(a.customer_name).trim().length < 2) fail("missing_name", "Ask the customer for their name.");
      if (!PHONE_RE.test(a.customer_phone ?? "")) fail("bad_phone", "Phone must be in international format, e.g. +355691234567.");
      const slot = validateSlot({ svc, date: a.date, time: a.time, staffId: a.staff, phone: a.customer_phone });
      // The agent must read the details back and get a yes before anything is written.
      if (a.customer_confirmed !== true) {
        return {
          ok: true,
          status: "preview",
          message: `Please confirm with the customer: ${svc.name} with ${slot.staff.name} on ${a.date} at ${slot.start}, ${svc.price} ${config.currency}. Call again with customer_confirmed: true once they say yes.`,
          summary: "preview only, nothing booked",
        };
      }
      const b = {
        id: `BK-${String(state.nextId++).padStart(4, "0")}`,
        service: svc.name,
        serviceId: svc.id,
        staff: slot.staff.id,
        staffName: slot.staff.name,
        date: a.date,
        start: slot.start,
        end: slot.end,
        name: String(a.customer_name).trim(),
        phone: a.customer_phone,
        status: "confirmed",
        createdAt: now().toISOString(),
      };
      state.bookings.push(b);
      return { ok: true, status: "confirmed", booking: publicBooking(b), summary: `booked ${b.id}` };
    }),

    find_bookings: logged("find_bookings", ({ customer_phone }) => {
      if (!PHONE_RE.test(customer_phone ?? "")) fail("bad_phone", "Phone must be in international format.");
      const mine = active().filter((b) => b.phone === customer_phone).map(publicBooking);
      return { ok: true, bookings: mine, summary: `${mine.length} bookings` };
    }),

    reschedule_booking: logged("reschedule_booking", ({ booking_id, customer_phone, new_date, new_time }) => {
      const b = ownBooking(booking_id, customer_phone);
      const svc = service(b.serviceId);
      const slot = validateSlot({ svc, date: new_date, time: new_time, phone: customer_phone, ignoreId: b.id });
      if (needsApproval(b)) {
        const r = { id: `RQ-${String(state.requests.length + 1).padStart(3, "0")}`, type: "reschedule", booking: b.id, new_date, new_time, status: "pending", at: now().toISOString() };
        state.requests.push(r);
        return { ok: true, status: "pending_approval", request: r.id, message: "This appointment is less than 24 hours away, so a member of staff will confirm the change.", summary: `${r.id} awaiting staff` };
      }
      Object.assign(b, { date: new_date, start: slot.start, end: slot.end, staff: slot.staff.id, staffName: slot.staff.name });
      return { ok: true, status: "rescheduled", booking: publicBooking(b), summary: `moved ${b.id}` };
    }),

    cancel_booking: logged("cancel_booking", ({ booking_id, customer_phone, reason = "" }) => {
      const b = ownBooking(booking_id, customer_phone);
      if (needsApproval(b)) {
        const r = { id: `RQ-${String(state.requests.length + 1).padStart(3, "0")}`, type: "cancel", booking: b.id, reason, status: "pending", at: now().toISOString() };
        state.requests.push(r);
        return { ok: true, status: "pending_approval", request: r.id, message: "Late cancellations are confirmed by staff. They'll be in touch shortly.", summary: `${r.id} awaiting staff` };
      }
      b.status = "cancelled";
      return { ok: true, status: "cancelled", booking: publicBooking(b), summary: `cancelled ${b.id}` };
    }),
  };

  // ------------------------------------------------------------ staff-only (not exposed to the agent)
  const staffActions = {
    decide: logged("staff_decide", ({ request_id, approve }) => {
      const r = state.requests.find((x) => x.id === request_id && x.status === "pending") ?? fail("not_found", "No pending request with that id.");
      const b = state.bookings.find((x) => x.id === r.booking);
      if (approve && r.type === "cancel") b.status = "cancelled";
      if (approve && r.type === "reschedule") {
        // Re-check: the slot may have been taken while the request waited.
        const slot = validateSlot({ svc: service(b.serviceId), date: r.new_date, time: r.new_time, phone: b.phone, ignoreId: b.id });
        Object.assign(b, { date: r.new_date, start: slot.start, end: slot.end, staff: slot.staff.id, staffName: slot.staff.name });
      }
      r.status = approve ? "approved" : "rejected";
      return { ok: true, request: r, summary: `${r.id} ${r.status}` };
    }),
    listAll: () => state.bookings.map(publicBooking),
    pending: () => state.requests.filter((r) => r.status === "pending"),
  };

  return { tools, staff: staffActions, state, config };
}

/** Recomputes every hash. Returns {ok, brokenAt}. */
export function verifyAudit(entries) {
  let prev = "genesis";
  for (const e of entries) {
    const expect = sha256(JSON.stringify({ ...e, hash: undefined }));
    if (e.prev !== prev || e.hash !== expect) return { ok: false, brokenAt: e.seq };
    prev = e.hash;
  }
  return { ok: true, entries: entries.length };
}
