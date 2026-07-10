const functions = require('@google-cloud/functions-framework');
const { BigQuery } = require('@google-cloud/bigquery');
const { Firestore } = require('@google-cloud/firestore');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const { randomUUID } = require('crypto');

const bigquery = new BigQuery();
const DATASET = 'zeffy_finance';

// The admin portal / Manage Events / portalUsers all live in a different GCP
// project than BigQuery. This Cloud Function's own service account needs the
// "Cloud Datastore User" (or equivalent Firestore write) role granted on
// the hccgc-a7a54 project specifically — a separate one-time IAM grant from
// the Calendar-sharing step, since it's a different project entirely.
const EVENTS_PROJECT_ID = 'hccgc-a7a54';
const EVENTS_COLLECTION = 'events';
const REQUIRED_APP_KEY = 'bookings-finance';
const eventsFirestore = new Firestore({ projectId: EVENTS_PROJECT_ID });

if (!admin.apps.length) {
  admin.initializeApp({ projectId: EVENTS_PROJECT_ID });
}

class AuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Verifies the Firebase ID token sent as "Authorization: Bearer <token>" and
// confirms the signed-in user actually has bookings-finance access, the same
// way the front-end gate already checks (portalUsers.allowedApps or isAdmin).
// This is what makes actor attribution in the audit log trustworthy — the
// email comes from a cryptographically verified token, never from anything
// the client's request body claims.
async function requireAuthorizedUser(req) {
  const authHeader = req.get('Authorization') || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) throw new AuthError('Missing sign-in token — please sign in again.', 401);

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (err) {
    throw new AuthError('Sign-in expired — please refresh and sign in again.', 401);
  }

  const email = (decoded.email || '').toLowerCase();
  if (!email.endsWith('@hccgc.org')) throw new AuthError('Access denied.', 403);

  const snap = await eventsFirestore.collection('portalUsers').doc(email).get();
  const data = snap.exists ? snap.data() : {};
  const allowed = data.isAdmin || (Array.isArray(data.allowedApps) && data.allowedApps.includes(REQUIRED_APP_KEY));
  if (!allowed) throw new AuthError("You don't have access to Facility Booking.", 403);

  return { email };
}

function to12Hour(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return hour12 + ':' + String(m).padStart(2, '0') + ' ' + period;
}

// Creates one draft entry in Manage Events (type: 'event') from the FIRST
// occurrence only — even for a recurring internal booking, this creates a
// single listing rather than one per date, since a 30-day daily series
// shouldn't produce 30 separate public event entries. The admin can edit or
// unpublish it directly in Manage Events afterward, same as any other event.
async function createEventListing({ name, description, firstOccurrence, createdByName, createdByEmail }) {
  const eventData = {
    type: 'event',
    name: name,
    description: description || 'Details to follow — HCCGC facility booking.',
    date: firstOccurrence.date,
    fromTime: to12Hour(firstOccurrence.startTime),
    toTime: to12Hour(firstOccurrence.endTime),
    category: '',
    cost: 'Free',
    rsvpUrl: '',
    createdByName: createdByName || '',
    createdByEmail: createdByEmail || '',
    createdAt: Firestore.FieldValue.serverTimestamp()
  };
  const docRef = await eventsFirestore.collection(EVENTS_COLLECTION).add(eventData);
  return docRef.id;
}

// TODO: lock this down to your actual site origin once deployed.
const ALLOWED_ORIGIN = 'https://hccgc.org';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function getActiveRooms() {
  const [rows] = await bigquery.query(`SELECT room_id, name, rate_per_hour, calendar_id FROM \`${DATASET}.rooms\` WHERE active = TRUE ORDER BY name`);
  return rows;
}

async function getDiscountRules() {
  const [rows] = await bigquery.query(`SELECT * FROM \`${DATASET}.discount_rules\` LIMIT 1`);
  return rows[0];
}

// Every mutating action gets one row here — this is the single place to see
// "who did what, when" across the whole module, rather than hunting through
// per-table created_by/updated_by columns. actorEmail always comes from the
// verified signed-in user (see requireAuthorizedUser), never from client
// free-text, so it can't be spoofed by typing someone else's name.
async function logAudit({ action, entityType, entityId, actorEmail, details }) {
  try {
    await bigquery.query({
      query: `INSERT INTO \`${DATASET}.audit_log\` (log_id, action, entity_type, entity_id, actor_email, details, created_at)
              VALUES (@logId, @action, @entityType, @entityId, @actorEmail, @details, CURRENT_TIMESTAMP())`,
      params: {
        logId: randomUUID(), action, entityType, entityId: String(entityId),
        actorEmail: actorEmail || 'unknown', details: details ? JSON.stringify(details) : null
      }
    });
  } catch (err) {
    // Audit logging failure shouldn't block the actual action — log server-side and move on.
    console.error('Audit log write failed:', err.message);
  }
}

// Standard automatic discounts only: weekday, extended-hours, nonprofit.
// There is deliberately no automatic whole-facility/bundle discount — that's
// applied manually, case by case, via manualAdjustmentType/Value on the
// booking itself, same mechanism as any other discretionary discount.
function computeOccurrencePricing(rooms, roomsMap, hours, dateStr, isNonprofit, rules) {
  const rateSum = rooms.reduce((sum, name) => sum + (roomsMap[name] ? Number(roomsMap[name].rate_per_hour) : 0), 0);
  const baseTotal = Math.round(rateSum * hours * 100) / 100;

  const day = new Date(dateStr + 'T00:00:00').getDay();
  const isWeekday = day >= 1 && day <= 5;

  let mult = 1;
  const applied = [];
  if (isWeekday) { mult *= Number(rules.weekday_multiplier); applied.push('weekday'); }
  if (hours >= Number(rules.extended_hours_threshold)) { mult *= Number(rules.extended_hours_multiplier); applied.push('extended_hours'); }
  if (isNonprofit) { mult *= Number(rules.nonprofit_multiplier); applied.push('nonprofit'); }
  mult = Math.round(mult * 10000) / 10000;

  const subtotal = Math.round(baseTotal * mult * 100) / 100;
  return { baseTotal, mult, subtotal, applied };
}

function applyManualAdjustment(subtotal, type, value) {
  if (type === 'percent' && value) return Math.round(subtotal * (1 - Number(value) / 100) * 100) / 100;
  if (type === 'flat' && value) return Math.round((subtotal - Number(value)) * 100) / 100;
  return subtotal;
}

function occurrenceHours(occ) {
  const start = new Date(`${occ.date}T${occ.startTime}:00`);
  const end = new Date(`${occ.date}T${occ.endTime}:00`);
  return Math.round(((end - start) / 3600000) * 100) / 100;
}

// ---- Google Calendar sync ----
// One-time setup required: share each of the 4 room resource calendars with
// this Cloud Function's runtime service account (shown in the deploy output,
// or set explicitly with --service-account), granting "Make changes to
// events." A sync failure for one room doesn't block the booking — it comes
// back in the response's calendarSyncErrors so the caller can flag it, since
// a calendar hiccup shouldn't lose a real, paid booking.
let calendarClientPromise = null;
async function getCalendarClient() {
  if (!calendarClientPromise) {
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/calendar'] });
    calendarClientPromise = auth.getClient().then(authClient => google.calendar({ version: 'v3', auth: authClient }));
  }
  return calendarClientPromise;
}

// Creates one plain (non-recurring) event per room for a single occurrence.
// Occurrences can have different times from each other, so each gets its own
// event rather than relying on a single RRULE-based series.
async function syncOccurrenceToCalendar({ rooms, roomsMap, occ, renterName, seriesLabel }) {
  const calendar = await getCalendarClient();
  const eventIds = [];
  const syncErrors = [];
  const startIso = new Date(`${occ.date}T${occ.startTime}:00`).toISOString();
  const endIso = new Date(`${occ.date}T${occ.endTime}:00`).toISOString();

  for (const roomName of rooms) {
    const calendarId = roomsMap[roomName] && roomsMap[roomName].calendar_id;
    if (!calendarId) { syncErrors.push(roomName + ': no calendar configured'); continue; }
    const event = {
      summary: roomName + ' — ' + renterName + (seriesLabel ? ' (' + seriesLabel + ')' : ''),
      description: 'HCCGC facility booking' + (seriesLabel ? ' — part of a ' + seriesLabel + ' series' : ''),
      start: { dateTime: startIso },
      end: { dateTime: endIso }
    };
    try {
      const { data } = await calendar.events.insert({ calendarId, resource: event });
      eventIds.push(data.id);
    } catch (err) {
      console.error('Calendar sync failed for ' + roomName + ' on ' + occ.date + ':', err.message);
      syncErrors.push(roomName + ' (' + occ.date + '): ' + err.message);
    }
  }
  return { eventIds, syncErrors };
}

// GET /rooms
async function listRooms(req, res) {
  res.json(await getActiveRooms());
}

// GET /discount-rules
async function getDiscountRulesHandler(req, res) {
  res.json(await getDiscountRules());
}

// GET /bookings
async function listBookings(req, res) {
  const [rows] = await bigquery.query(
    `SELECT booking_id, rooms, renter_name, renter_email, organization_name, hccgc_representative_name, event_date, hours, final_total,
            payment_status, payment_method, is_internal, manual_adjustment_type, manual_adjustment_reason,
            recurring_series_id, recurrence_summary
     FROM \`${DATASET}.bookings\`
     ORDER BY created_at DESC
     LIMIT 300`
  );
  res.json(rows);
}

// POST /bookings
// Body always carries an explicit `occurrences` array: [{ date, startTime, endTime }, ...].
// A one-off booking is just a one-item array — this keeps a single code path
// for both cases and lets each occurrence in a recurring series have its own
// time (needed now that daily/variable-time series are supported).
async function createBooking(req, res, actor) {
  const b = req.body || {};
  const isInternal = !!b.isInternal;
  const errors = [];
  if (!Array.isArray(b.rooms) || b.rooms.length === 0) errors.push('Select at least one room.');
  if (!b.renterName) errors.push(isInternal ? 'Program/event name is required.' : 'Contact name is required.');
  if (isInternal && !b.hccgcRepresentativeName) errors.push('HCCGC representative name is required for internal bookings.');
  if (!isInternal && b.manualAdjustmentType && !b.manualAdjustmentReason) errors.push('A reason is required for a discretionary discount.');
  if (!Array.isArray(b.occurrences) || b.occurrences.length === 0) errors.push('At least one date/time is required.');
  else {
    b.occurrences.forEach((occ, i) => {
      if (!occ.date || !occ.startTime || !occ.endTime) errors.push(`Occurrence ${i + 1} is missing a date or time.`);
      else if (occurrenceHours(occ) <= 0) errors.push(`Occurrence ${i + 1}: end time must be after start time.`);
    });
  }
  if (errors.length) return res.status(400).json({ errors });

  const roomsList = await getActiveRooms();
  const roomsMap = {};
  roomsList.forEach(r => { roomsMap[r.name] = r; });
  const unknownRooms = b.rooms.filter(r => !roomsMap[r]);
  if (unknownRooms.length) return res.status(400).json({ errors: [`Unknown or inactive room(s): ${unknownRooms.join(', ')}`] });

  // Conflict check — one query per occurrence, since each can have its own time.
  // Nothing gets created if ANY occurrence conflicts (all-or-nothing for the series).
  const conflictMessages = [];
  for (const occ of b.occurrences) {
    const [conflicts] = await bigquery.query({
      query: `SELECT booking_id, renter_name FROM \`${DATASET}.bookings\`
              WHERE event_date = @date AND payment_status != 'cancelled'
                AND start_time < @endTime AND end_time > @startTime
                AND EXISTS (SELECT 1 FROM UNNEST(rooms) rm WHERE rm IN UNNEST(@rooms))`,
      params: { date: occ.date, startTime: `${occ.date} ${occ.startTime}:00`, endTime: `${occ.date} ${occ.endTime}:00`, rooms: b.rooms },
      types: { rooms: ['STRING'] }
    });
    if (conflicts.length) conflictMessages.push(`${occ.date} ${occ.startTime}-${occ.endTime} conflicts with an existing booking (${conflicts[0].renter_name})`);
  }
  if (conflictMessages.length) return res.status(409).json({ errors: conflictMessages });

  const rules = await getDiscountRules();
  const isSeries = b.occurrences.length > 1;
  const seriesId = isSeries ? randomUUID() : null;
  const recurrenceSummary = isSeries ? `${b.occurrences.length} occurrences` : null;

  // Link this booking to a known contact: use the selected renterId as-is,
  // or — if the person entering the booking asked to save a new contact —
  // create the renter record now and link to that instead. Neither applies
  // to internal HCCGC bookings, which have no customer at all.
  let renterId = null;
  if (!isInternal) {
    if (b.renterId) {
      renterId = b.renterId;
    } else if (b.saveAsNewRenter) {
      renterId = await createRenterRecord({
        contactName: b.renterName, email: b.renterEmail, phone: b.renterPhone,
        address: b.renterAddress, organizationName: b.organizationName, actorEmail: actor.email
      });
      await logAudit({ action: 'renter_added', entityType: 'renter', entityId: renterId, actorEmail: actor.email, details: { contactName: b.renterName, savedDuringBooking: true } });
    }
  }

  const createdBookingIds = [];
  const allSyncErrors = [];
  let totalFinal = 0;

  for (const occ of b.occurrences) {
    const hours = occurrenceHours(occ);
    let baseTotal = 0, mult = 1, subtotal = 0, finalTotal = 0;
    if (!isInternal) {
      const priced = computeOccurrencePricing(b.rooms, roomsMap, hours, occ.date, !!b.isNonprofit, rules);
      baseTotal = priced.baseTotal; mult = priced.mult; subtotal = priced.subtotal;
      finalTotal = applyManualAdjustment(subtotal, b.manualAdjustmentType, b.manualAdjustmentValue);
    }
    totalFinal += finalTotal;

    const { eventIds, syncErrors } = await syncOccurrenceToCalendar({
      rooms: b.rooms, roomsMap, occ, renterName: b.renterName, seriesLabel: isSeries ? recurrenceSummary : null
    });
    allSyncErrors.push(...syncErrors);

    const bookingId = 'HCC-' + randomUUID().slice(0, 8);
    createdBookingIds.push(bookingId);

    await bigquery.query({
      query: `INSERT INTO \`${DATASET}.bookings\`
        (booking_id, rooms, renter_id, renter_name, renter_email, renter_phone, renter_address, organization_name, hccgc_representative_name,
         event_date, start_time, end_time, hours, is_nonprofit, is_internal,
         base_total, standard_discount_multiplier, subtotal_after_standard_discount,
         manual_adjustment_type, manual_adjustment_value, manual_adjustment_reason, manual_adjustment_by,
         final_total, payment_status, payment_method, calendar_event_ids, recurring_series_id, recurrence_summary,
         notes, created_by, created_at)
        VALUES (@bookingId, @rooms, @renterId, @renterName, @renterEmail, @renterPhone, @renterAddress, @organizationName, @hccgcRepName,
         @eventDate, @startTime, @endTime, @hours, @isNonprofit, @isInternal,
         @baseTotal, @mult, @subtotal, @adjType, @adjValue, @adjReason, @adjBy,
         @finalTotal, @paymentStatus, NULL, @eventIds, @seriesId, @recurrenceSummary,
         @notes, @enteredBy, CURRENT_TIMESTAMP())`,
      params: {
        bookingId, rooms: b.rooms, renterId, renterName: b.renterName, renterEmail: b.renterEmail || null,
        renterPhone: b.renterPhone || null, renterAddress: b.renterAddress || null, organizationName: b.organizationName || null,
        hccgcRepName: b.hccgcRepresentativeName || null,
        eventDate: occ.date, startTime: `${occ.date} ${occ.startTime}:00`, endTime: `${occ.date} ${occ.endTime}:00`,
        hours, isNonprofit: !isInternal && !!b.isNonprofit, isInternal,
        baseTotal, mult, subtotal,
        adjType: (!isInternal && b.manualAdjustmentType) || null, adjValue: (!isInternal && b.manualAdjustmentValue) || null,
        adjReason: (!isInternal && b.manualAdjustmentReason) || null, adjBy: (!isInternal && b.manualAdjustmentType) ? actor.email : null,
        finalTotal, paymentStatus: isInternal ? 'n/a' : 'pending',
        eventIds, seriesId, recurrenceSummary, notes: b.notes || null, enteredBy: actor.email
      },
      types: { rooms: ['STRING'], eventIds: ['STRING'] }
    });
  }

  let eventListingCreated = false;
  let eventListingError;
  if (isInternal && b.publishAsEvent) {
    try {
      await createEventListing({
        name: b.renterName,
        description: b.notes,
        firstOccurrence: b.occurrences[0],
        createdByName: b.hccgcRepresentativeName,
        createdByEmail: actor.email
      });
      eventListingCreated = true;
    } catch (err) {
      console.error('Manage Events listing failed:', err.message);
      eventListingError = err.message;
    }
  }

  await logAudit({
    action: isInternal ? 'internal_booking_created' : 'booking_created',
    entityType: 'booking',
    entityId: createdBookingIds[0],
    actorEmail: actor.email,
    details: { bookingIds: createdBookingIds, rooms: b.rooms, renterName: b.renterName, occurrenceCount: b.occurrences.length, totalAcrossAllOccurrences: Math.round(totalFinal * 100) / 100 }
  });

  res.json({
    bookingIds: createdBookingIds,
    occurrenceCount: b.occurrences.length,
    totalAcrossAllOccurrences: Math.round(totalFinal * 100) / 100,
    isInternal,
    eventListingCreated: eventListingCreated || undefined,
    eventListingError,
    calendarSyncErrors: allSyncErrors.length ? allSyncErrors : undefined
  });
}

// POST /bookings/:id/mark-paid
async function markBookingPaid(req, res, bookingId, actor) {
  const method = (req.body || {}).paymentMethod;
  if (!['zelle', 'cash', 'check'].includes(method)) {
    return res.status(400).json({ errors: ['paymentMethod must be zelle, cash, or check.'] });
  }
  await bigquery.query({
    query: `UPDATE \`${DATASET}.bookings\` SET payment_status = 'paid', payment_method = @method, paid_by = @actorEmail, updated_at = CURRENT_TIMESTAMP()
            WHERE booking_id = @bookingId`,
    params: { method, bookingId, actorEmail: actor.email }
  });
  await logAudit({ action: 'booking_marked_paid', entityType: 'booking', entityId: bookingId, actorEmail: actor.email, details: { paymentMethod: method } });
  res.json({ bookingId, paymentStatus: 'paid', paymentMethod: method });
}

// POST /rooms
async function addRoom(req, res, actor) {
  const b = req.body || {};
  if (!b.name || !b.ratePerHour) return res.status(400).json({ errors: ['Room name and rate are required.'] });
  const roomId = randomUUID();
  await bigquery.query({
    query: `INSERT INTO \`${DATASET}.rooms\` (room_id, name, rate_per_hour, calendar_id, active) VALUES (@roomId, @name, @rate, @calendarId, TRUE)`,
    params: { roomId, name: b.name, rate: b.ratePerHour, calendarId: b.calendarId || null }
  });
  await logAudit({ action: 'room_added', entityType: 'room', entityId: b.name, actorEmail: actor.email, details: { ratePerHour: b.ratePerHour } });
  res.json({ roomId, name: b.name, ratePerHour: b.ratePerHour });
}

// PATCH /rooms/:name
async function updateRoom(req, res, roomName, actor) {
  const b = req.body || {};
  if (b.ratePerHour !== undefined) {
    await bigquery.query({ query: `UPDATE \`${DATASET}.rooms\` SET rate_per_hour = @rate WHERE name = @name`, params: { rate: b.ratePerHour, name: roomName } });
    await logAudit({ action: 'room_rate_updated', entityType: 'room', entityId: roomName, actorEmail: actor.email, details: { newRatePerHour: b.ratePerHour } });
  }
  if (b.active === false) {
    await bigquery.query({ query: `UPDATE \`${DATASET}.rooms\` SET active = FALSE WHERE name = @name`, params: { name: roomName } });
    await logAudit({ action: 'room_retired', entityType: 'room', entityId: roomName, actorEmail: actor.email });
  }
  res.json({ name: roomName, updated: true });
}

// PATCH /discount-rules — weekday/nonprofit/extended-hours only now.
// Bundle discount fields still exist in the table for now but are no longer
// read anywhere in pricing; whole-facility discounts are manual (see
// createBooking's manualAdjustmentType/Value).
async function updateDiscountRules(req, res, actor) {
  const b = req.body || {};
  await bigquery.query({
    query: `UPDATE \`${DATASET}.discount_rules\`
            SET weekday_multiplier = @weekday, nonprofit_multiplier = @nonprofit,
                extended_hours_multiplier = @extMult, extended_hours_threshold = @extThresh,
                updated_at = CURRENT_TIMESTAMP()
            WHERE rule_id = (SELECT rule_id FROM \`${DATASET}.discount_rules\` LIMIT 1)`,
    params: {
      weekday: b.weekdayMultiplier, nonprofit: b.nonprofitMultiplier,
      extMult: b.extendedHoursMultiplier, extThresh: b.extendedHoursThreshold
    }
  });
  await logAudit({ action: 'discount_rules_updated', entityType: 'discount_rules', entityId: 'global', actorEmail: actor.email, details: b });
  res.json({ updated: true });
}

// GET /renters
async function listRenters(req, res) {
  const [rows] = await bigquery.query(`SELECT renter_id, contact_name, email, phone, address, organization_name, notes
                                        FROM \`${DATASET}.renters\` ORDER BY contact_name`);
  res.json(rows);
}

// POST /renters — used both by the Add A Renter page and, internally, by
// createBooking when someone opts to save a new contact for next time.
async function createRenterRecord({ contactName, email, phone, address, organizationName, notes, actorEmail }) {
  const renterId = randomUUID();
  await bigquery.query({
    query: `INSERT INTO \`${DATASET}.renters\`
      (renter_id, contact_name, email, phone, address, organization_name, notes, created_by, created_at, updated_at)
      VALUES (@renterId, @contactName, @email, @phone, @address, @organizationName, @notes, @actorEmail, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
    params: { renterId, contactName, email: email || null, phone: phone || null, address: address || null, organizationName: organizationName || null, notes: notes || null, actorEmail }
  });
  return renterId;
}

async function addRenter(req, res, actor) {
  const b = req.body || {};
  if (!b.contactName) return res.status(400).json({ errors: ['Contact name is required.'] });
  const renterId = await createRenterRecord({
    contactName: b.contactName, email: b.email, phone: b.phone, address: b.address,
    organizationName: b.organizationName, notes: b.notes, actorEmail: actor.email
  });
  await logAudit({ action: 'renter_added', entityType: 'renter', entityId: renterId, actorEmail: actor.email, details: { contactName: b.contactName } });
  res.json({ renterId, contactName: b.contactName });
}

// GET /initiatives
async function listInitiatives(req, res) {
  const [rows] = await bigquery.query(`SELECT initiative_id, name, type FROM \`${DATASET}.initiatives\` WHERE active = TRUE ORDER BY name`);
  res.json(rows);
}

// GET /audit-log — who did what, when, across the whole module
async function listAuditLog(req, res) {
  const [rows] = await bigquery.query(`SELECT log_id, action, entity_type, entity_id, actor_email, details, created_at
                                        FROM \`${DATASET}.audit_log\` ORDER BY created_at DESC LIMIT 300`);
  res.json(rows);
}

// POST /transactions
async function logTransaction(req, res, actor) {
  const b = req.body || {};
  if (!b.date || !b.amount || !b.type || !b.initiativeName || !b.source) {
    return res.status(400).json({ errors: ['Date, amount, type, initiative, and source are all required.'] });
  }
  const transactionId = randomUUID();
  await bigquery.query({
    query: `INSERT INTO \`${DATASET}.transactions\`
      (transaction_id, date, amount, type, initiative_id, source, description, entered_by, reconciled, created_at)
      SELECT @transactionId, @date, @amount, @type, initiative_id, @source, @description, @enteredBy, FALSE, CURRENT_TIMESTAMP()
      FROM \`${DATASET}.initiatives\` WHERE name = @initiativeName`,
    params: {
      transactionId, date: b.date, amount: b.amount, type: b.type, source: b.source,
      description: b.description || null, enteredBy: actor.email, initiativeName: b.initiativeName
    }
  });
  await logAudit({ action: 'transaction_logged', entityType: 'transaction', entityId: transactionId, actorEmail: actor.email, details: { amount: b.amount, type: b.type, initiativeName: b.initiativeName, source: b.source } });
  res.json({ transactionId });
}

functions.http('api', async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  try {
    const actor = await requireAuthorizedUser(req);

    const path = req.path.replace(/\/+$/, '') || '/';
    const markPaidMatch = path.match(/^\/bookings\/([^/]+)\/mark-paid$/);
    const roomPatchMatch = path.match(/^\/rooms\/([^/]+)$/);

    if (path === '/rooms' && req.method === 'GET') return await listRooms(req, res);
    if (path === '/rooms' && req.method === 'POST') return await addRoom(req, res, actor);
    if (roomPatchMatch && req.method === 'PATCH') return await updateRoom(req, res, decodeURIComponent(roomPatchMatch[1]), actor);
    if (path === '/renters' && req.method === 'GET') return await listRenters(req, res);
    if (path === '/renters' && req.method === 'POST') return await addRenter(req, res, actor);
    if (path === '/discount-rules' && req.method === 'GET') return await getDiscountRulesHandler(req, res);
    if (path === '/discount-rules' && req.method === 'PATCH') return await updateDiscountRules(req, res, actor);
    if (path === '/bookings' && req.method === 'GET') return await listBookings(req, res);
    if (path === '/bookings' && req.method === 'POST') return await createBooking(req, res, actor);
    if (markPaidMatch && req.method === 'POST') return await markBookingPaid(req, res, decodeURIComponent(markPaidMatch[1]), actor);
    if (path === '/initiatives' && req.method === 'GET') return await listInitiatives(req, res);
    if (path === '/transactions' && req.method === 'POST') return await logTransaction(req, res, actor);
    if (path === '/audit-log' && req.method === 'GET') return await listAuditLog(req, res);

    res.status(404).json({ error: 'Not found: ' + req.method + ' ' + path });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
