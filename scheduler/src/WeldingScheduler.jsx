import React, { useState, useEffect, useCallback, useMemo, useRef, useContext, createContext } from 'react';
import {
  Plus, X, Settings2, Calendar, Users, Wrench, Check, AlertTriangle,
  Monitor, ChevronLeft, ChevronRight, ChevronDown, Trash2, Pencil, Pin, PinOff,
  Loader2, ClipboardList, LayoutGrid, CircleCheck, DollarSign, Clock, CalendarOff,
  Upload, FileWarning, UserCheck, ZoomIn, ZoomOut, Target, Lock, FlaskConical,
  Download, FileClock, Copy, FilePlus
} from 'lucide-react';
import {
  parseXlsx, autoMap, analyse, buildSchedulerJobs, FIELDS,
  DEFAULT_INCLUDE, DEFAULT_EXCLUDE, DEFAULT_COMBOS,
} from './wipImport';
import { startLiveSync } from './liveSync.js';

import {
  SHIFT_DEFS, SHIFT_ORDER, DAY_KEYS, DAY_COLS, ABSENCE_KINDS,
  defaultWeeklyRoster, absenceKindLabel, normalizeStaff,
  isoDate, addDays, generateCalendarDays, isWeekendDate, isOnLeave,
  getStaffDayInfo, fmtDay, fmtDate, fmtDateRange,
  runScheduler, whyUnscheduled, primaryStaffOf, tagOk, findStaffConflictJobs, effectiveDueDate,
} from './scheduler.js';
import {
  buildOverrideRecord, appendOverride, summariseOverrides, equipmentFlow,
  affinityFindings, dedupeFindings, weightEvidence, overrideDateRange,
} from './overrides.js';

/* ============================================================
   DATA MODEL REFERENCE (for future Business Central integration)
   ------------------------------------------------------------
   This section documents how each record maps to Business
   Central concepts, so a future sync layer has a clear,
   stable contract to build against. Field names below are kept
   deliberately close to their BC counterparts.

   JOB  (this app)              →  BUSINESS CENTRAL (Projects/Jobs module)
   ---------------------------------------------------------------
   id                           →  internal key only (see bcJobNo / bcJobTaskNo for the BC-side key)
   name                         →  Job Task Description
   process                      →  no direct BC equivalent (shop-floor routing detail)
   quantity / hoursTotal        →  Job Planning Line quantity / quantity (hours)
   readyDate                    →  no direct BC equivalent (internal scheduling gate)
   dueDate                      →  Job Task Line "Ending Date" (target completion date)
   departmentDueDate            →  no BC equivalent — optional, internal-only. When the client/
                                    end-of-month date in dueDate isn't actually when THIS department
                                    has to finish (there's scope after us — machining, assembly,
                                    etc.), this is the earlier date we're really working to. Wins
                                    over dueDate for scheduling order whenever it's set.
   percentComplete              →  informational status field — NOT the same as BC's calculated
                                    WIP % (BC derives WIP from actual vs. budgeted cost/sales
                                    ledger entries). Push this to a custom/status field, not the
                                    WIP calculation itself, unless real cost postings back it up.
   totalValue                   →  Job / Job Task "Contract (Total Price)" — value to the company
   departmentValue              →  no standard BC field — candidate for a custom field on the
                                    Job Task Line (this department's share of the contract value)
   status / completedDate       →  Job "Status" (Open/Completed) and its status-change date
   preferredEquipmentId         →  no BC equivalent — internal-only. A soft scheduling nudge
                                    (unlike a pin, or job.staffId): the scheduler tries this
                                    machine first when auto-placing the job and falls back to
                                    whichever compatible machine finishes soonest if it can't be
                                    honoured, flagging the assignment for review either way.
   lockedEquipmentId            →  no BC equivalent — internal-only. A hard restriction, same
                                    strength as job.staffId but for the machine instead of the
                                    operator: the scheduler waits for this machine rather than
                                    using another, but still auto-picks the day and the operator
                                    — unlike a pin (assignment.pinned), which fixes both of those
                                    too.
   bcJobNo                      →  Job No. (the BC key to link back to) — optional, blank until linked
   bcJobTaskNo                  →  Job Task No. — optional, blank until linked
   isRework / reworkOfJobId     →  no BC equivalent — internal-only. A rework job is an ordinary
                                    job in every other respect (scheduled, staffed, completed the
                                    same way) created via "Mark for rework" on a completed job;
                                    reworkOfJobId links back to that original, whose own record is
                                    never touched. See "Rework" in scheduler/CLAUDE.md.
   updatedAt                    →  used to drive delta/incremental sync (only push what changed)

   EQUIPMENT / STAFF (this app) →  BUSINESS CENTRAL (Resources module)
   ---------------------------------------------------------------
   name / processes             →  Resource Name / Resource Skills (no exact BC equivalent, informational)
   bcResourceNo                  →  Resource No. — optional, blank until linked

   None of this wires up automatically today — these fields exist so that
   when a middleware/sync service is built later, it has clean, named
   fields to read from and write to rather than needing a data migration.
   ============================================================ */

/* ============================================================
   CONSTANTS & SEED DATA
   ============================================================ */

// (Per-resource daily capacity is now derived per shift from each employee's roster — see SHIFT_DEFS.)
const HORIZON_DAYS = 150; // calendar days to look ahead when scheduling
// Calendar days of *history* the timeline keeps behind today. The grid used to
// begin at today, so finished and part-finished work dropped off the left edge
// the moment its dates passed and there was no way to look back at what the
// department actually ran. Nothing is ever auto-scheduled into these days —
// see runScheduler's `earliestIdx`.
const HISTORY_DAYS = 90;

const DEFAULT_PROCESSES = [
  'Robotic MIG Welding',
  'Robotic TIG Welding',
  'Thermal Spray - HVOF',
  'Thermal Spray - Plasma Spray',
  'Thermal Spray - Arc Spray',
];

const EQUIP_TYPES = ['Welding Robot', 'Thermal Spray Robot'];

function seedEquipment() {
  return [
    { id: 'eq_1', name: 'Weld Robot 1', type: 'Welding Robot', tags: ['1T Positioner'], processes: ['Robotic MIG Welding', 'Robotic TIG Welding'], unavailableDates: [], bcResourceNo: '' },
    { id: 'eq_2', name: 'Weld Robot 2', type: 'Welding Robot', tags: ['5T Positioner'], processes: ['Robotic MIG Welding', 'Robotic TIG Welding'], unavailableDates: [], bcResourceNo: '' },
    { id: 'eq_3', name: 'Weld Robot 3', type: 'Welding Robot', tags: ['1T Positioner'], processes: ['Robotic MIG Welding'], unavailableDates: [], bcResourceNo: '' },
    { id: 'eq_4', name: 'Weld Robot 4', type: 'Welding Robot', tags: ['5T Positioner'], processes: ['Robotic MIG Welding', 'Robotic TIG Welding'], unavailableDates: [], bcResourceNo: '' },
    { id: 'eq_5', name: 'Thermal Spray Cell 1', type: 'Thermal Spray Robot', processes: ['Thermal Spray - HVOF', 'Thermal Spray - Plasma Spray'], unavailableDates: [], bcResourceNo: '' },
    { id: 'eq_6', name: 'Thermal Spray Cell 2', type: 'Thermal Spray Robot', processes: ['Thermal Spray - HVOF', 'Thermal Spray - Arc Spray'], unavailableDates: [], bcResourceNo: '' },
  ];
}

function seedStaff() {
  const today = isoDate(new Date());
  return [
    { id: 'st_1', name: 'Alex', processes: ['Robotic MIG Welding', 'Robotic TIG Welding'], weeklyRoster: defaultWeeklyRoster('day'), leavePeriods: [], bcResourceNo: '' },
    { id: 'st_2', name: 'Jordan', processes: ['Robotic MIG Welding'], weeklyRoster: defaultWeeklyRoster('day'), leavePeriods: [], bcResourceNo: '' },
    { id: 'st_3', name: 'Sam', processes: ['Robotic TIG Welding', 'Thermal Spray - HVOF'], weeklyRoster: defaultWeeklyRoster('day'), leavePeriods: [{ id: uid('lv'), startDate: addDays(today, 9), endDate: addDays(today, 13), reason: 'Annual leave' }], bcResourceNo: '' },
    { id: 'st_4', name: 'Casey', processes: ['Thermal Spray - HVOF', 'Thermal Spray - Plasma Spray', 'Thermal Spray - Arc Spray'], weeklyRoster: defaultWeeklyRoster('day'), leavePeriods: [], bcResourceNo: '' },
    { id: 'st_5', name: 'Morgan', processes: ['Robotic MIG Welding', 'Thermal Spray - Arc Spray'], weeklyRoster: defaultWeeklyRoster('afternoon'), leavePeriods: [], bcResourceNo: '' },
    { id: 'st_6', name: 'Taylor', processes: [...DEFAULT_PROCESSES], weeklyRoster: defaultWeeklyRoster('day'), leavePeriods: [], bcResourceNo: '' },
    { id: 'st_7', name: 'Riley', processes: ['Robotic TIG Welding', 'Thermal Spray - Plasma Spray'], weeklyRoster: defaultWeeklyRoster('afternoon'), leavePeriods: [], bcResourceNo: '' },
  ];
}

function seedTemplates() {
  return [
    { id: 'tp_1', name: 'Bracket Weld - Standard', category: 'Brackets & Frames', tags: [], process: 'Robotic MIG Welding', hoursPerUnit: 0.5, totalValuePerUnit: 120, departmentValuePerUnit: 45 },
    { id: 'tp_2', name: 'Chassis Frame Weld', category: 'Brackets & Frames', tags: ['5T Positioner'], process: 'Robotic TIG Welding', hoursPerUnit: 2, totalValuePerUnit: 850, departmentValuePerUnit: 310 },
    { id: 'tp_3', name: 'Hydraulic Shaft HVOF Coating', category: 'Shafts & Rollers', tags: [], process: 'Thermal Spray - HVOF', hoursPerUnit: 1.5, totalValuePerUnit: 640, departmentValuePerUnit: 210 },
    { id: 'tp_4', name: 'Turbine Blade Plasma Coat', category: 'Turbine Components', tags: [], process: 'Thermal Spray - Plasma Spray', hoursPerUnit: 3, totalValuePerUnit: 2100, departmentValuePerUnit: 780 },
    { id: 'tp_5', name: 'Wear Plate Arc Spray', category: 'Wear Plates', tags: [], process: 'Thermal Spray - Arc Spray', hoursPerUnit: 1, totalValuePerUnit: 300, departmentValuePerUnit: 95 },
  ];
}

function seedJobs() {
  const today = new Date();
  const due = (n) => addDays(isoDate(today), n);
  return [
    mkJob({ name: 'Bracket Weld - Standard', process: 'Robotic MIG Welding', quantity: 40, hoursPerUnit: 0.5, dueDate: due(10), readyDate: due(-2), templateId: 'tp_1', totalValue: 4800, departmentValue: 1800, percentComplete: 25 }),
    mkJob({ name: 'Chassis Frame Weld', process: 'Robotic TIG Welding', quantity: 6, hoursPerUnit: 2, dueDate: due(14), readyDate: due(1), templateId: 'tp_2', totalValue: 5100, departmentValue: 1860, percentComplete: 0 }),
    mkJob({ name: 'Hydraulic Shaft HVOF Coating', process: 'Thermal Spray - HVOF', quantity: 12, hoursPerUnit: 1.5, dueDate: due(7), readyDate: due(-5), templateId: 'tp_3', totalValue: 7680, departmentValue: 2520, percentComplete: 60 }),
    mkJob({ name: 'Turbine Blade Plasma Coat', process: 'Thermal Spray - Plasma Spray', quantity: 4, hoursPerUnit: 3, dueDate: due(20), readyDate: due(6), templateId: 'tp_4', totalValue: 8400, departmentValue: 3120, percentComplete: 0 }),
  ];
}

function mkJob({ name, process, quantity, hoursPerUnit, dueDate, departmentDueDate = null, readyDate = null, templateId = null, notes = '', totalValue = 0, departmentValue = 0, percentComplete = 0, needsFurtherProcessing = false }) {
  return {
    id: uid('job'),
    name,
    process,
    quantity,
    hoursTotal: Math.round(quantity * hoursPerUnit * 100) / 100,
    dueDate,
    // null = the client/target due date in dueDate is also when this
    // department has to be done. Set only when there's scope after us and
    // our own deadline is genuinely earlier — see the data-model comment.
    departmentDueDate,
    readyDate: readyDate || isoDate(new Date()),
    templateId,
    notes,
    totalValue: Number(totalValue) || 0,
    departmentValue: Number(departmentValue) || 0,
    percentComplete: Number(percentComplete) || 0,
    // Work still has a downstream scope after this department (machining,
    // manual finishing, …). Such a job has to clear our cell earlier than one
    // with the same due date that ships straight from here, so it wins the
    // due-date tiebreak in runScheduler.
    needsFurtherProcessing: !!needsFurtherProcessing,
    status: 'active',
    completedDate: null,
    // null = not part of a batch — see createBatch/leaveBatch and
    // groupBatches in scheduler.js.
    batchId: null,
    batchOrder: null,
    tags: [],
    procedureId: '',
    bcJobNo: '',
    bcJobTaskNo: '',
    // null = the scheduler picks whoever is free and signed off on the
    // process; a staff id here is a manual assignment it must honour.
    staffId: null,
    updatedAt: new Date().toISOString(),
    assignment: null,
  };
}

/* ============================================================
   COSTING MODEL — cost centres (shared capital) + procedures
   (full per-hour cost breakdown), ported from the thermal-spray
   cost calculator. A procedure's total $/hr costs a job:
   cost = procedure $/hr × hours (actual once complete, else est).
   ============================================================ */

function seedCostCentres() {
  return [
    { id: 'cc_hvof_gas', name: 'HVOF (gas-fuel)', interestRate: 10, annualHours: 3800, assets: [
      { name: 'HVOF gun system', capital: 180000, salvage: 15000, life: 20000 },
      { name: 'Robot cell', capital: 220000, salvage: 20000, life: 40000 },
      { name: 'Dust extraction', capital: 45000, salvage: 0, life: 30000 },
    ] },
    { id: 'cc_hvof_kero', name: 'HVOF (kerosene)', interestRate: 10, annualHours: 3800, assets: [
      { name: 'HVOF gun system', capital: 195000, salvage: 15000, life: 20000 },
      { name: 'Robot cell', capital: 220000, salvage: 20000, life: 40000 },
      { name: 'Dust extraction', capital: 45000, salvage: 0, life: 30000 },
    ] },
    { id: 'cc_plasma', name: 'Atmospheric plasma', interestRate: 10, annualHours: 3800, assets: [
      { name: 'Plasma gun + power supply', capital: 150000, salvage: 12000, life: 25000 },
      { name: 'Robot cell', capital: 220000, salvage: 20000, life: 40000 },
      { name: 'Dust extraction', capital: 45000, salvage: 0, life: 30000 },
    ] },
  ];
}

function seedProcedures() {
  const note = 'Placeholder from cost calculator — edit or re-import with your real values.';
  return [
    { id: 'proc_wccocr', name: 'WC-CoCr 86/10/4 — hydraulic rod', process: 'Thermal Spray - HVOF', costCentreId: 'cc_hvof_gas', substrate: '17-4PH stainless', notes: note,
      materialMode: 'powder', powder: { material: 'WC-CoCr 86/10/4', pricePerKg: 82, gPerMin: 83.33 },
      gases: [
        { name: 'Hydrogen (fuel)', role: 'primary', unit: 'm³', pricePerUnit: 8.5, lPerMin: 750 },
        { name: 'Oxygen', role: 'secondary', unit: 'm³', pricePerUnit: 2.2, lPerMin: 300 },
        { name: 'Nitrogen', role: 'carrier', unit: 'm³', pricePerUnit: 1.1, lPerMin: 50 },
      ],
      electricity: { kw: 85, tariff: 0.28 },
      spares: [{ name: 'Nozzle', cost: 1250, life: 300 }, { name: 'Powder feeder wheel', cost: 340, life: 800 }, { name: 'O-ring / seal kit', cost: 65, life: 500 }],
      maintenance: [{ name: 'Annual OEM service', cost: 12000, interval: 2000 }, { name: 'Robot calibration', cost: 1800, interval: 1000 }],
      consumables: [{ name: 'Masking tape', costPerHour: 4.5 }, { name: 'Blasting grit', costPerHour: 6 }, { name: 'PPE / filters', costPerHour: 2.2 }],
      labour: [{ name: 'Spray technician', rate: 55, count: 1 }, { name: 'Cell supervisor', rate: 72, count: 0.3 }],
      qa: [{ name: 'Metallurgical coupon', costPerHour: 18 }, { name: 'CMM inspection', costPerHour: 9 }, { name: 'Documentation / cert', costPerHour: 6 }],
    },
    { id: 'proc_cr3c2', name: 'Cr₃C₂-NiCr — turbine shroud', process: 'Thermal Spray - HVOF', costCentreId: 'cc_hvof_kero', substrate: 'Inconel 718', notes: note,
      materialMode: 'powder', powder: { material: 'Cr₃C₂-NiCr (WOKA 7202)', pricePerKg: 95, gPerMin: 75 },
      gases: [
        { name: 'Kerosene (fuel)', role: 'primary', unit: 'L', pricePerUnit: 1.6, lPerMin: 0.37 },
        { name: 'Oxygen', role: 'secondary', unit: 'm³', pricePerUnit: 2.2, lPerMin: 916.67 },
        { name: 'Nitrogen', role: 'carrier', unit: 'm³', pricePerUnit: 1.1, lPerMin: 50 },
      ],
      electricity: { kw: 90, tariff: 0.28 },
      spares: [{ name: 'Combustion nozzle', cost: 1650, life: 250 }, { name: 'Spark plug', cost: 120, life: 400 }, { name: 'Powder feeder wheel', cost: 340, life: 800 }],
      maintenance: [{ name: 'Annual OEM service', cost: 12000, interval: 2000 }],
      consumables: [{ name: 'Masking', costPerHour: 5 }, { name: 'Blasting grit', costPerHour: 6.5 }, { name: 'PPE / filters', costPerHour: 2.2 }],
      labour: [{ name: 'Spray technician', rate: 55, count: 1 }, { name: 'Cell supervisor', rate: 72, count: 0.3 }],
      qa: [{ name: 'Metallurgical coupon', costPerHour: 22 }, { name: 'CMM inspection', costPerHour: 9 }, { name: 'Documentation / cert', costPerHour: 6 }],
    },
    { id: 'proc_nicraly', name: 'NiCrAlY bond coat — APS', process: 'Thermal Spray - Plasma Spray', costCentreId: 'cc_plasma', substrate: 'Various', notes: note,
      materialMode: 'powder', powder: { material: 'NiCrAlY', pricePerKg: 120, gPerMin: 63.33 },
      gases: [
        { name: 'Argon', role: 'primary', unit: 'm³', pricePerUnit: 3.8, lPerMin: 60 },
        { name: 'Hydrogen', role: 'secondary', unit: 'm³', pricePerUnit: 8.5, lPerMin: 15 },
        { name: 'Argon', role: 'carrier', unit: 'm³', pricePerUnit: 3.8, lPerMin: 8.33 },
      ],
      electricity: { kw: 110, tariff: 0.28 },
      spares: [{ name: 'Electrode (cathode)', cost: 480, life: 250 }, { name: 'Anode / nozzle', cost: 520, life: 250 }, { name: 'O-ring kit', cost: 65, life: 500 }],
      maintenance: [{ name: 'Annual OEM service', cost: 10000, interval: 2000 }, { name: 'Robot calibration', cost: 1800, interval: 1000 }],
      consumables: [{ name: 'Masking', costPerHour: 4 }, { name: 'Blasting grit', costPerHour: 6 }, { name: 'PPE / filters', costPerHour: 2.2 }],
      labour: [{ name: 'Spray technician', rate: 55, count: 1 }, { name: 'Cell supervisor', rate: 72, count: 0.3 }],
      qa: [{ name: 'Metallurgical coupon', costPerHour: 18 }, { name: 'Bond strength test (amortised)', costPerHour: 12 }, { name: 'Documentation / cert', costPerHour: 6 }],
    },
  ];
}

const fmtMoney = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Gas flow → units/hr. Priced per m³ with flow L/min → m³/hr = L/min × 0.06;
// priced per litre of liquid (unit 'L', e.g. kerosene) → L/hr = L/min × 60.
function gasUnitsHr(g) {
  return String((g && g.unit) || '').trim().toUpperCase() === 'L' ? (Number(g.lPerMin) || 0) * 60 : (Number(g.lPerMin) || 0) * 0.06;
}
// Cost centre → $/hr: straight-line depreciation + interest on average capital.
function costCentrePerHr(cc) {
  if (!cc) return 0;
  const hrs = Number(cc.annualHours) || 0;
  return (cc.assets || []).reduce((s, r) => {
    const dep = Number(r.life) > 0 ? ((Number(r.capital) || 0) - (Number(r.salvage) || 0)) / Number(r.life) : 0;
    const interest = hrs > 0 ? ((Number(cc.interestRate) || 0) / 100) * ((Number(r.capital) || 0) + (Number(r.salvage) || 0)) / 2 / hrs : 0;
    return s + dep + interest;
  }, 0);
}
// g/cm³ — turns a wire's diameter + feed speed into a consumption rate
// (see wireConsumptionGPerMin) without asking the user to know or enter a
// density themselves. A per-material lookup, not a field on the procedure,
// so two procedures using the same wire type can't silently disagree about
// its density, and it stays in sync everywhere at once if a figure needs
// correcting. Extend this as more wire types are needed — ProcedureEditor's
// wire-type select is generated straight from its keys.
const WIRE_DENSITIES = {
  'Carbon Steel': 7.85,
  'Stainless Steel': 8.00,
  'Nickel Alloy': 8.19,
  'Titanium': 4.51,
};
// Wire feedstock's consumption rate isn't a field the user enters directly
// the way powder's g/min is (the cost calculator already reports that one
// straight from the spray gun's settings) — it's derived from the wire
// itself: cross-sectional area (mm², from diameter) × feed speed (m/min) ×
// density (g/cm³) gives grams/min directly, with no extra unit-juggling
// factor needed — the mm→m and cm³→mm³ conversions cancel each other out
// exactly (standard welding-engineering deposition-rate formula). Returns 0
// for an unrecognised/blank wire type rather than guessing a density.
function wireConsumptionGPerMin(wire) {
  const density = WIRE_DENSITIES[wire?.type] || 0;
  const diameterMm = Number(wire?.diameterMm) || 0;
  const feedSpeedMPerMin = Number(wire?.feedSpeedMPerMin) || 0;
  const areaMm2 = Math.PI * (diameterMm / 2) ** 2;
  return areaMm2 * density * feedSpeedMPerMin;
}
// Procedure → per-category and total $/hr.
function procedureParts(p, costCentres) {
  if (!p) return { material: 0, gas: 0, electricity: 0, spares: 0, maintenance: 0, consumables: 0, depreciation: 0, labour: 0, qa: 0, total: 0 };
  const pw = p.powder || {}, el = p.electricity || {};
  const cc = (costCentres || []).find((c) => c.id === p.costCentreId);
  const t = {};
  // `materialMode` — 'wire' or 'powder' (default) — is a manual per-procedure
  // choice, not inferred from `process`: Thermal Spray - Arc Spray is
  // wire-fed while HVOF/Plasma are powder-fed, so process alone can't tell
  // the two apart. Switching modes in ProcedureEditor doesn't clear the
  // other mode's fields, so `p.powder`/`p.wire` can both be present at once
  // — only the active mode's ever contributes to cost. Same *0.06 g/min→kg/hr
  // conversion either way (see wireConsumptionGPerMin's comment for wire's
  // own g/min derivation).
  t.material = p.materialMode === 'wire'
    ? (Number(p.wire?.pricePerKg) || 0) * (wireConsumptionGPerMin(p.wire) * 0.06)
    : (Number(pw.pricePerKg) || 0) * ((Number(pw.gPerMin) || 0) * 0.06);
  t.gas = (p.gases || []).reduce((s, g) => s + (Number(g.pricePerUnit) || 0) * gasUnitsHr(g), 0);
  t.electricity = (Number(el.kw) || 0) * (Number(el.tariff) || 0);
  t.spares = (p.spares || []).reduce((s, r) => s + (Number(r.life) > 0 ? (Number(r.cost) || 0) / Number(r.life) : 0), 0);
  t.maintenance = (p.maintenance || []).reduce((s, r) => s + (Number(r.interval) > 0 ? (Number(r.cost) || 0) / Number(r.interval) : 0), 0);
  t.consumables = (p.consumables || []).reduce((s, r) => s + (Number(r.costPerHour) || 0), 0);
  t.depreciation = costCentrePerHr(cc);
  t.labour = (p.labour || []).reduce((s, r) => s + (Number(r.rate) || 0) * (Number(r.count) || 0), 0);
  t.qa = (p.qa || []).reduce((s, r) => s + (Number(r.costPerHour) || 0), 0);
  t.total = t.material + t.gas + t.electricity + t.spares + t.maintenance + t.consumables + t.depreciation + t.labour + t.qa;
  return t;
}
const procedureCost = (p, costCentres) => procedureParts(p, costCentres).total;
// Hours used to cost a job: actual once complete, otherwise the estimate.
const jobHoursForCost = (j) => (j && j.status === 'complete' && Number(j.actualHours) > 0 ? Number(j.actualHours) : Number((j && j.hoursTotal) || 0));
// `job.completedDate` is when someone clicked "Mark complete" in the app —
// not necessarily when the job actually finished. A job physically done on
// a Friday but not marked complete until the following Wednesday reads as
// finishing on Wednesday, which pulls it into whichever reporting period
// Wednesday falls in rather than the one it was really done in — reported
// from testing against Value Reports' "Completed" basis specifically.
//
// The job's own schedule already says when it was PLANNED to finish
// (`assignment.days`, the day-by-day plan the scheduler committed to), and
// `actualHours` vs `hoursTotal` says how wrong that plan turned out to be.
// Combining them gives a real estimate of when it actually wrapped up:
//  - Finished in actualHours <= the scheduled total: walk the ORIGINAL
//    day-by-day plan cumulatively and stop at the day the actual total is
//    reached — the exact same "trim from the start" the scheduler itself
//    already does to free up capacity when a job finishes early (see the
//    "complete.forEach" replay in scheduler.js's runScheduler). That logic
//    only ever adjusts capacity bookkeeping, never the job's own stored
//    `assignment`, so nothing already gives this date directly — it has to
//    be recomputed the same way here.
//  - Took actualHours > the scheduled total (ran over): there's no extra
//    scheduled days to walk into, so extrapolate forward from the last
//    scheduled day using the plan's own average hours/calendar-day.
// Falls back to `job.completedDate` whenever there's nothing to compute
// from — no assignment (e.g. a split job, whose own `assignment` is always
// null — see "Splitting a job"), no day-by-day plan, or no actualHours yet
// — so an old or schedule-less record degrades to today's existing
// behaviour rather than showing no date at all.
function effectiveCompletionDate(job) {
  if (!job || job.status !== 'complete') return job?.completedDate || null;
  const plan = job.assignment?.days;
  const actual = Number(job.actualHours);
  if (!plan || !plan.length || !(actual > 0)) return job.completedDate || null;

  const sorted = [...plan].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totalScheduled = sorted.reduce((s, e) => s + (Number(e.hours) || 0), 0);
  const uniqueDays = [...new Set(sorted.map((e) => e.date))];
  const lastDay = uniqueDays[uniqueDays.length - 1];

  if (actual <= totalScheduled) {
    let used = 0;
    for (const entry of sorted) {
      used += Number(entry.hours) || 0;
      if (used >= actual - 0.001) return entry.date;
    }
    return lastDay;
  }
  // Ran over — push the date forward from the plan's own daily pace.
  // uniqueDays.length is never 0 here (plan.length was checked above).
  const avgPerDay = totalScheduled / uniqueDays.length;
  if (!(avgPerDay > 0)) return job.completedDate || lastDay;
  const extraDays = Math.ceil((actual - totalScheduled) / avgPerDay - 0.001);
  return addDays(lastDay, extraDays);
}
// A job's SCHEDULED hours aren't all productive process time — some of
// every job/task is setup and breakdown, which doesn't consume materials,
// gas or machine time the way procedureCost's $/hr rate assumes, just a
// person's time. `costSettings.efficiency` (%, default 75) is the assumed
// productive share; the rest is priced at `costSettings.avgLabourRate`
// alone — deliberately one global average, not a per-person rate (see
// "Costing: efficiency and average labour cost" in scheduler/CLAUDE.md for
// why: individual pay rates are HR data, not something this app holds).
//
// Because cost is linear in hours, "efficiency% at the full rate + the
// rest at the labour rate" collapses to one blended $/hr — correct for ANY
// hours figure it's multiplied by, not just a job's total. That's what
// lets jobCost() (whole-item totals) and hourlyRate() (report rows, which
// can be a single day's partial hours) share this one function instead of
// each needing their own two-bucket split.
function effectiveHourlyRate(procedure, costCentres, costSettings) {
  const full = procedureCost(procedure, costCentres);
  const eff = Math.max(0, Math.min(100, Number(costSettings?.efficiency ?? 75))) / 100;
  const labour = Number(costSettings?.avgLabourRate) || 0;
  return full * eff + labour * (1 - eff);
}
function jobCost(j, procedures, costCentres, costSettings) {
  if (!j || !j.procedureId) return null;
  const p = (procedures || []).find((x) => x.id === j.procedureId);
  if (!p) return null;
  return effectiveHourlyRate(p, costCentres, costSettings) * jobHoursForCost(j);
}
// Map a cost-calculator spec's process string onto one of the scheduler's processes.
function mapImportProcess(str, schedProcesses) {
  const s = String(str || '').toLowerCase();
  if (!schedProcesses || !schedProcesses.length) return '';
  const hit = schedProcesses.find((pr) => s.includes(String(pr).toLowerCase()));
  if (hit) return hit;
  if (s.includes('hvof')) return schedProcesses.find((pr) => /hvof/i.test(pr)) || '';
  if (s.includes('plasma') || s.includes('aps')) return schedProcesses.find((pr) => /plasma/i.test(pr)) || '';
  if (s.includes('arc')) return schedProcesses.find((pr) => /arc/i.test(pr)) || '';
  return '';
}
// Parse the cost calculator's "Export specs" JSON ({format,version,processes,specs}).
function parseCostingImport(data, schedProcesses) {
  const rawSpecs = Array.isArray(data) ? data : (data && Array.isArray(data.specs) ? data.specs : null);
  if (!rawSpecs) return null;
  const rawProcs = (data && Array.isArray(data.processes)) ? data.processes : [];
  const costCentres = rawProcs.map((p) => ({
    id: p.id || uid('cc'), name: p.name || '', interestRate: Number(p.interestRate) || 0, annualHours: Number(p.annualHours) || 0,
    assets: (Array.isArray(p.assets) ? p.assets : (Array.isArray(p.depreciation) ? p.depreciation : [])).map((r) => ({ name: r.name || '', capital: Number(r.capital) || 0, salvage: Number(r.salvage) || 0, life: Number(r.life) || 0 })),
  }));
  const procedures = rawSpecs.map((s) => ({
    id: s.id || uid('proc'), name: s.name || '', process: mapImportProcess(s.process || s.name, schedProcesses), costCentreId: s.processId || s.costCentreId || '', substrate: s.substrate || '', notes: s.notes || '',
    // The external cost calculator this format comes from only ever exported
    // powder specs, so an import with no materialMode/wire at all defaults
    // to powder — same fallback ProcedureEditor and procedureParts use for
    // any older stored procedure missing these fields. Passed through as-is
    // (rather than dropped) in case a future export does include wire data.
    materialMode: s.materialMode === 'wire' ? 'wire' : 'powder',
    powder: s.powder || { material: '', pricePerKg: 0, gPerMin: 0 },
    wire: s.wire || { type: '', diameterMm: 0, feedSpeedMPerMin: 0, pricePerKg: 0 },
    gases: Array.isArray(s.gases) ? s.gases : [], electricity: s.electricity || { kw: 0, tariff: 0 },
    spares: Array.isArray(s.spares) ? s.spares : [], maintenance: Array.isArray(s.maintenance) ? s.maintenance : [], consumables: Array.isArray(s.consumables) ? s.consumables : [],
    labour: Array.isArray(s.labour) ? s.labour : [], qa: Array.isArray(s.qa) ? s.qa : [],
  }));
  return { costCentres, procedures };
}

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}


// How much of the schedule the Schedule view shows at once — from a detailed
// day-to-day window up to a broad multi-month view of the whole workload.
const RANGE_PRESETS = [
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
  { days: 60, label: '2 months' },
];


/* ============================================================
   STORAGE HELPERS
   ============================================================ */

async function loadKey(key, fallback) {
  try {
    const res = await window.storage.get(key, true);
    if (res && res.value) return JSON.parse(res.value);
    return fallback;
  } catch (e) {
    return fallback;
  }
}
async function saveKey(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), true);
  } catch (e) {
    console.error('storage save failed', key, e);
  }
}

/* ============================================================
   SMALL UI PRIMITIVES
   ============================================================ */

function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium text-slate-400 mb-1 tracking-wide uppercase">{label}</span>
      {children}
    </label>
  );
}
// A named, collapsible group of fields — for a modal with enough sections
// that showing all of them expanded at once is mostly scrolling past ones
// you're not touching right now. `defaultOpen` should reflect whether the
// section already holds something worth seeing at a glance (e.g. an
// optional section a user already filled in) rather than always defaulting
// one way.
function Section({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    // bg-slate-800/50, not bg-slate-900/40 — every other boxed panel in this
    // file uses /50 or /60 opacity on slate-800, which index.css remaps for
    // the light theme; /40 on slate-900 isn't one of the mapped variants, so
    // it fell through to raw Tailwind dark-slate and rendered as a washed-out
    // grey box with low-contrast text once opened (#43).
    <div className="border border-slate-800 rounded-lg mb-3 bg-slate-800/50">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">{title}</span>
        <ChevronDown size={14} className={`text-slate-500 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-3 pb-3 pt-1 border-t border-slate-800">{children}</div>}
    </div>
  );
}
// A plain `<button onClick={fn}>` written directly inside a component that
// itself renders `<Modal>` (JobModal, StaffModal, ...) can't report itself
// dirty via `useContext(DirtyContext)` at that component's own top level —
// Modal's Provider wraps whatever *children* that component passes down to
// Modal, so the Provider is a descendant of the call, not an ancestor, and
// useContext can't see it from there (this bit both JobModal's "100% to
// department" button and StaffModal's colour swatches). Wrapping the button
// in its own real child component sidesteps this: instantiated as one of
// those children, its own useContext call resolves against the Provider
// correctly, exactly like TagEditor/MultiCheck already do.
function DirtyButton({ onClick, className, style, title, children }) {
  const markDirty = useContext(DirtyContext);
  return (
    <button type="button" className={className} style={style} title={title} onClick={() => { markDirty(); onClick(); }}>
      {children}
    </button>
  );
}
const inputCls = "w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/60 focus:border-amber-500/60";
const btnPrimary = "inline-flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-sm px-3 py-2 rounded-md transition-colors";
const btnGhost = "inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm px-3 py-2 rounded-md transition-colors border border-slate-700";
const btnDanger = "inline-flex items-center gap-1.5 bg-red-950 hover:bg-red-900 text-red-300 text-sm px-3 py-2 rounded-md transition-colors border border-red-900";
const smallInput = "w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-amber-500/60";

// `size`: 'md' (default) for a simple form, 'lg' (= the old `wide` prop, kept
// for existing callers) for a data table with a few columns, 'xl' for the
// import modal's dense multi-column review table, which was still cramped —
// truncated descriptions, cut-off customer names — even at 'lg' (1024px).
const MODAL_WIDTH = { md: 'max-w-md', lg: 'max-w-5xl', xl: 'max-w-[1400px]' };

// Lets a form control that isn't a plain native input — MultiCheck's toggle
// buttons, the chip editors' Add/× buttons — report a change up to the
// enclosing Modal without every modal-content component needing its own
// wiring. Defaults to a no-op so these components still work stand-alone
// (there have never been any, but nothing requires there never to be).
const DirtyContext = createContext(() => {});

// Reference-counted body-scroll lock, shared by every mounted Modal —
// see the usage below for why a plain per-instance capture/restore of
// document.body.style.overflow doesn't work once modals can nest (a
// confirm-delete dialog opened from inside JobModal/TaskModal/etc. while
// the first one is still open, which happens throughout this file).
// Module-level, not a ref or context: it has to be shared across
// completely independent Modal instances that know nothing of each other.
let openModalCount = 0;
function lockBodyScroll() {
  openModalCount += 1;
  if (openModalCount === 1) document.body.style.overflow = 'hidden';
  return () => {
    openModalCount = Math.max(0, openModalCount - 1);
    if (openModalCount === 0) document.body.style.overflow = '';
  };
}

function Modal({ title, onClose, children, wide, size }) {
  // A backdrop click closes the modal, but "click" fires on the nearest common
  // ancestor of mousedown and mouseup — so selecting text inside the modal and
  // releasing the mouse outside it counted as a backdrop click and threw away
  // whatever had been typed. Only close when the gesture both started and
  // ended on the backdrop itself.
  const downOnBackdrop = useRef(false);
  // Whether anything inside this modal has actually changed. A ref, not
  // state: it's read once at close time, and turning it into state would
  // re-render the whole modal (and everything under it) on every keystroke.
  const dirtyRef = useRef(false);
  const markDirty = useCallback(() => { dirtyRef.current = true; }, []);
  const [confirming, setConfirming] = useState(false);

  // A backdrop click or the header ✕ used to call onClose directly, so
  // clicking outside a modal — including by mistake, a target that was
  // wider than it looked — discarded whatever had been typed with no
  // warning (#19). Now it only closes immediately if nothing changed;
  // otherwise it asks. The explicit "Cancel" button each modal's content
  // provides is left alone — clicking Cancel is already the deliberate,
  // unambiguous choice to discard, not an accidental dismissal.
  const requestClose = () => { if (dirtyRef.current) setConfirming(true); else onClose(); };

  // A modal's own content can scroll (max-h-[85vh] overflow-y-auto below),
  // but the page behind it must not — otherwise scrolling to the bottom of a
  // long form, or scrolling over the backdrop itself, keeps going and moves
  // the schedule underneath (#25). Locking body scroll for the modal's
  // lifetime handles the backdrop and keyboard/touch cases; the dialog's own
  // `overscroll-contain` (below) stops wheel scroll from "chaining" to the
  // body once the dialog hits its own top/bottom edge.
  //
  // Goes through the shared counter (lockBodyScroll), not a plain
  // capture-and-restore of document.body.style.overflow here — this modal
  // is very often not the only one mounted (a Delete button inside
  // JobModal/TaskModal/BackfillTaskModal/ProjectModal opens the
  // confirm-delete Modal while the first one is still open, and there are
  // several similar confirm/conflict dialogs elsewhere in this file), and
  // whichever nested Modal's cleanup happened to run last used to stomp
  // body.overflow back to whatever ITS OWN mount-time snapshot was, not
  // necessarily the empty string — that's exactly what made Job Backlog/
  // Costing/Patterns intermittently stop scrolling: page scroll got left
  // locked at 'hidden' after every modal involved had actually closed. The
  // Schedule view's timeline kept scrolling through all of this regardless,
  // since its grid has its own independent `overflow-auto` container (see
  // "Schedule view rendering" below) and was never relying on body scroll.
  useEffect(() => lockBodyScroll(), []);

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        const closed = downOnBackdrop.current && e.target === e.currentTarget;
        downOnBackdrop.current = false;
        if (closed) requestClose();
      }}
    >
      <div
        className={`relative bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full ${MODAL_WIDTH[size || (wide ? 'lg' : 'md')]} max-h-[85vh] overflow-y-auto overscroll-contain`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 sticky top-0 bg-slate-900">
          <h3 className="font-semibold text-slate-100 text-base">{title}</h3>
          <button onClick={requestClose} className="text-slate-500 hover:text-slate-200"><X size={18} /></button>
        </div>
        {/* onChange bubbles from any native input/select/textarea a modal's
            content renders, so this catches typing, checkboxes, selects and
            range sliders in one place with zero changes to any of the ~10
            modal-content components. Button-driven state (MultiCheck's
            toggles, the chip editors' Add/×) doesn't fire a DOM change event,
            so those call markDirty() via DirtyContext explicitly instead. */}
        <div className="p-5" onChange={markDirty}>
          <DirtyContext.Provider value={markDirty}>{children}</DirtyContext.Provider>
        </div>

        {confirming && (
          <div
            className="absolute inset-0 z-20 bg-slate-950/90 flex items-center justify-center rounded-lg p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-slate-900 border border-amber-700/60 rounded-lg p-5 max-w-sm shadow-xl">
              <p className="text-sm text-slate-200 font-medium mb-1.5">Discard unsaved changes?</p>
              <p className="text-xs text-slate-400 mb-4">Closing now will lose what you've entered here.</p>
              <div className="flex justify-end gap-2">
                <button className={btnGhost} onClick={() => setConfirming(false)}>Keep editing</button>
                <button className={btnDanger} onClick={onClose}>Discard changes</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// `showOrphans` renders selected values that are no longer offered as options,
// so they can be unticked. Only for lists whose options are a stable set the
// value is meant to stay inside (the process editors): a resource that kept a
// deleted process showed the capability everywhere with no control to clear
// it. Leave it off where options are filtered dynamically — in TemplateModal
// the equipment list narrows to the chosen process, and an id outside it is
// ordinary filtering, not stale data.
function MultiCheck({ options, value, onChange, getLabel = (x) => x, getId = (x) => x, showOrphans = false }) {
  // Toggling one of these buttons doesn't fire a native DOM change event, so
  // Modal's blanket onChange listener never sees it — report it explicitly.
  const markDirty = useContext(DirtyContext);
  const optionIds = options.map(getId);
  const orphans = showOrphans ? value.filter((v) => !optionIds.includes(v)) : [];
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const id = getId(opt);
        const active = value.includes(id);
        return (
          <button
            type="button"
            key={id}
            onClick={() => { markDirty(); onChange(active ? value.filter((v) => v !== id) : [...value, id]); }}
            className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
              active ? 'bg-amber-500/20 border-amber-500 text-amber-300' : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}
          >
            {getLabel(opt)}
          </button>
        );
      })}
      {orphans.map((id) => (
        <button
          type="button"
          key={id}
          onClick={() => { markDirty(); onChange(value.filter((v) => v !== id)); }}
          title="No longer available — click to remove"
          className="text-xs px-2.5 py-1.5 rounded-full border transition-colors bg-red-950/40 border-red-900 text-red-300 line-through"
        >
          {id}
        </button>
      ))}
    </div>
  );
}

const EQUIP_COLOR = {
  'Welding Robot': { border: 'border-l-sky-500', dot: 'bg-sky-500', text: 'text-sky-400' },
  'Thermal Spray Robot': { border: 'border-l-orange-500', dot: 'bg-orange-500', text: 'text-orange-400' },
};

/* ============================================================
   MAIN APP
   ============================================================ */

/* ============================================================
   COSTING VIEW — cost centres + procedures with $/hr breakdown
   ============================================================ */

// Shown before ProcedureEditor/CostCentreEditor ever open, in front of both
// "New procedure" and "New cost centre" — some pieces of equipment/
// procedures are close enough to an existing one that retyping every field
// by hand is wasted effort. `onCreateBlank` mirrors the old direct
// behaviour (skip straight to an empty editor); `children` is the picker
// for "Create from existing" — a flat list for cost centres, a grouped one
// for procedures (see CostingView) — rendered only once that option is
// chosen, not built up front, since it's plain JSX from the caller either
// way. Deliberately generic over both record types rather than two
// near-identical modals: the choice itself (blank vs. copy) and the
// back-and-forth between the two states is exactly the same regardless of
// what's being created.
function CreateChoiceModal({ title, onClose, onCreateBlank, children }) {
  const [showExisting, setShowExisting] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      {!showExisting ? (
        <div className="space-y-2">
          <button
            type="button"
            className="w-full text-left border border-slate-800 bg-slate-900 hover:border-slate-600 rounded-lg p-3 flex items-start gap-3"
            onClick={onCreateBlank}
          >
            <FilePlus size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-slate-100 text-sm">Create new</div>
              <div className="text-xs text-slate-500 mt-0.5">Start from a blank form.</div>
            </div>
          </button>
          <button
            type="button"
            className="w-full text-left border border-slate-800 bg-slate-900 hover:border-slate-600 rounded-lg p-3 flex items-start gap-3"
            onClick={() => setShowExisting(true)}
          >
            <Copy size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-slate-100 text-sm">Create from existing</div>
              <div className="text-xs text-slate-500 mt-0.5">Copy an existing one's data as a starting point, then adjust what's different.</div>
            </div>
          </button>
        </div>
      ) : (
        <div>
          <button type="button" className="text-xs text-amber-400 hover:underline mb-3" onClick={() => setShowExisting(false)}>‹ Back</button>
          {children}
        </div>
      )}
    </Modal>
  );
}

// CreateChoiceModal's "Create from existing" content for cost centres —
// a flat list, since there are only ever expected to be a handful of these
// (unlike procedures below, which get grouped).
function CostCentreCopyPicker({ costCentres, onPick }) {
  if (!costCentres?.length) return <p className="text-xs text-slate-600">No cost centres yet to copy from.</p>;
  return (
    <div className="space-y-1 max-h-[50vh] overflow-y-auto">
      {costCentres.map((c) => (
        <button
          key={c.id} type="button"
          className="w-full text-left text-sm text-slate-300 hover:text-amber-300 hover:bg-slate-800/60 px-2.5 py-1.5 rounded flex items-center justify-between gap-2"
          onClick={() => onPick(c)}
        >
          <span className="truncate">{c.name || '(unnamed)'}</span>
          <span className="text-[11px] text-slate-500 font-mono shrink-0">{fmtMoney(costCentrePerHr(c))} /hr</span>
        </button>
      ))}
    </div>
  );
}

// CreateChoiceModal's "Create from existing" content for procedures —
// grouped by process, each a collapsed-by-default Section, mirroring
// CostingView's own listing further down (same "one really long page"
// problem, just inside a modal instead of the tab itself).
function ProcedureCopyPicker({ procedures, costCentres, onPick }) {
  const byProcess = {};
  (procedures || []).forEach((p) => {
    const key = p.process || '(no process assigned)';
    (byProcess[key] = byProcess[key] || []).push(p);
  });
  const groups = Object.keys(byProcess).sort();
  if (!groups.length) return <p className="text-xs text-slate-600">No procedures yet to copy from.</p>;
  return (
    <div className="max-h-[55vh] overflow-y-auto">
      {groups.map((gk) => (
        <Section key={gk} title={`${gk} (${byProcess[gk].length})`} defaultOpen={false}>
          <div className="space-y-1">
            {byProcess[gk].map((p) => (
              <button
                key={p.id} type="button"
                className="w-full text-left text-sm text-slate-300 hover:text-amber-300 hover:bg-slate-800/60 px-2.5 py-1.5 rounded flex items-center justify-between gap-2"
                onClick={() => onPick(p)}
              >
                <span className="truncate">{p.name || '(unnamed)'}</span>
                <span className="text-[11px] text-slate-500 font-mono shrink-0">{fmtMoney(procedureCost(p, costCentres))} /hr</span>
              </button>
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

// `seedFrom` — an existing cost centre to copy data from, offered via
// CreateChoiceModal — only ever applies when `centre` itself is absent
// (i.e. genuinely creating new, not editing one that already exists): it
// prefills `d`, but `isNew` still derives from `centre` alone, so the
// result reads and behaves as a brand new, unsaved record (title, no
// Delete button, a fresh id) rather than as an edit of the source.
function CostCentreEditor({ centre, seedFrom, onClose, onSave, onDelete }) {
  const isNew = !centre;
  const [d, setD] = useState(() => {
    if (centre) return JSON.parse(JSON.stringify(centre));
    if (seedFrom) return { ...JSON.parse(JSON.stringify(seedFrom)), id: uid('cc'), name: `${seedFrom.name || 'Untitled cost centre'} (copy)` };
    return { id: uid('cc'), name: '', interestRate: 10, annualHours: 3800, assets: [{ name: '', capital: 0, salvage: 0, life: 0 }] };
  });
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const setAsset = (i, k, v, text) => setD((x) => { const a = x.assets.slice(); a[i] = { ...a[i], [k]: text ? v : (Number(v) || 0) }; return { ...x, assets: a }; });
  const addAsset = () => setD((x) => ({ ...x, assets: [...x.assets, { name: '', capital: 0, salvage: 0, life: 0 }] }));
  const delAsset = (i) => setD((x) => ({ ...x, assets: x.assets.filter((_, j) => j !== i) }));
  const grid = 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 20px';
  return (
    <Modal title={isNew ? 'New cost centre' : 'Edit cost centre'} onClose={onClose} wide>
      <Field label="Name"><input className={inputCls} value={d.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Interest rate (%)"><input type="number" step="any" className={inputCls} value={d.interestRate} onChange={(e) => set({ interestRate: Number(e.target.value) || 0 })} /></Field>
        <Field label="Annual operating hours"><input type="number" step="any" className={inputCls} value={d.annualHours} onChange={(e) => set({ annualHours: Number(e.target.value) || 0 })} /></Field>
      </div>
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Capital assets</span>
          <span className="text-[11px] text-amber-300 font-mono">{fmtMoney(costCentrePerHr(d))} /hr dep+interest</span>
        </div>
        <div className="grid gap-1 mb-1" style={{ gridTemplateColumns: grid }}>
          <span className="text-[10px] text-slate-500 uppercase">Asset</span><span className="text-[10px] text-slate-500 uppercase">Capital</span><span className="text-[10px] text-slate-500 uppercase">Salvage</span><span className="text-[10px] text-slate-500 uppercase">Life hr</span><span />
        </div>
        {d.assets.map((r, i) => (
          <div key={i} className="grid gap-1 mb-1 items-center" style={{ gridTemplateColumns: grid }}>
            <input className={smallInput} value={r.name} placeholder="Asset" onChange={(e) => setAsset(i, 'name', e.target.value, true)} />
            <input className={smallInput} type="number" step="any" value={r.capital} onChange={(e) => setAsset(i, 'capital', e.target.value)} />
            <input className={smallInput} type="number" step="any" value={r.salvage} onChange={(e) => setAsset(i, 'salvage', e.target.value)} />
            <input className={smallInput} type="number" step="any" value={r.life} onChange={(e) => setAsset(i, 'life', e.target.value)} />
            <button type="button" className="text-slate-500 hover:text-red-400" onClick={() => delAsset(i)}>×</button>
          </div>
        ))}
        <button type="button" className="text-[11px] text-amber-400 hover:underline mt-0.5" onClick={addAsset}>+ Add asset</button>
      </div>
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800 mt-2">
        {isNew ? <span /> : <button className={btnDanger} onClick={() => onDelete(d.id)}>Delete</button>}
        <div className="flex gap-2">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} onClick={() => onSave({ ...d, name: (d.name || '').trim() || 'Untitled cost centre' })}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

// `seedFrom` — same idea as CostCentreEditor's: an existing procedure to
// copy from, only ever consulted when `procedure` itself is absent, so
// `isNew`/title/Delete-visibility all still derive from `procedure` alone
// and the result is a genuinely new record (fresh id), not an edit of the
// source.
function ProcedureEditor({ procedure, seedFrom, processes, costCentres, onClose, onSave, onDelete }) {
  const isNew = !procedure;
  const [d, setD] = useState(() => {
    // `materialMode`/`wire` post-date this shape — a procedure saved before
    // they existed (or one that's only ever used powder) has no `wire`
    // object at all, so the wire fields would crash reading `d.wire.type`
    // etc. without this. Defaulting `materialMode` to 'powder' here (not
    // just at the procedureParts()/cost layer) keeps every read in this
    // component working off the same "undefined means powder" convention.
    const source = procedure || seedFrom;
    const base = source ? JSON.parse(JSON.stringify(source)) : {
      id: uid('proc'), name: '', process: processes[0] || '', costCentreId: (costCentres[0] && costCentres[0].id) || '', substrate: '', notes: '',
      gases: [], electricity: { kw: 0, tariff: 0.28 }, spares: [], maintenance: [], consumables: [], labour: [], qa: [],
    };
    if (!procedure && seedFrom) {
      base.id = uid('proc');
      base.name = `${seedFrom.name || 'Untitled procedure'} (copy)`;
    }
    if (!base.materialMode) base.materialMode = 'powder';
    if (!base.powder) base.powder = { material: '', pricePerKg: 0, gPerMin: 0 };
    if (!base.wire) base.wire = { type: '', diameterMm: 0, feedSpeedMPerMin: 0, pricePerKg: 0 };
    return base;
  });
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const setArr = (k, i, f, v, text) => setD((x) => { const a = x[k].slice(); a[i] = { ...a[i], [f]: text ? v : (Number(v) || 0) }; return { ...x, [k]: a }; });
  const addRow = (k, tpl) => setD((x) => ({ ...x, [k]: [...x[k], JSON.parse(JSON.stringify(tpl))] }));
  const delRow = (k, i) => setD((x) => ({ ...x, [k]: x[k].filter((_, j) => j !== i) }));
  const setPw = (f, v, text) => setD((x) => ({ ...x, powder: { ...x.powder, [f]: text ? v : (Number(v) || 0) } }));
  // Wire type is a select (text) — everything else is a number, same split
  // as setPw. Switching materialMode deliberately never resets `x.wire` or
  // `x.powder` — see the materialMode comment on procedureParts.
  const setWire = (f, v, text) => setD((x) => ({ ...x, wire: { ...x.wire, [f]: text ? v : (Number(v) || 0) } }));
  const setEl = (f, v) => setD((x) => ({ ...x, electricity: { ...x.electricity, [f]: Number(v) || 0 } }));
  const parts = procedureParts(d, costCentres);
  // Plain function (not a nested component) so inputs keep focus across renders.
  const sec = (k, legend, grid, cols, tpl, subKey) => (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{legend}</span>
        <span className="text-[11px] text-slate-500 font-mono">{fmtMoney(parts[subKey])} /hr</span>
      </div>
      {/* A placeholder alone used to be the only label a column had — fine
          while a field is empty, but every numeric column here defaults to a
          real 0, which hides its placeholder from the moment the row exists.
          A proper header row above the grid stays visible regardless (#61). */}
      <div className="grid gap-1.5 mb-1" style={{ gridTemplateColumns: grid }}>
        {cols.map((c) => <span key={c.k} className="text-[10px] text-slate-500 uppercase truncate">{c.label}</span>)}
        <span />
      </div>
      {d[k].map((r, i) => (
        <div key={i} className="grid gap-1.5 mb-1 items-center" style={{ gridTemplateColumns: grid }}>
          {cols.map((c) => (c.sel
            ? <select key={c.k} className={smallInput} value={r[c.k]} onChange={(e) => setArr(k, i, c.k, e.target.value, true)}>{c.opts.map((o) => <option key={o} value={o}>{o}</option>)}</select>
            : <input key={c.k} className={smallInput} type={c.text ? 'text' : 'number'} step={c.text ? undefined : 'any'} placeholder={c.ph} value={r[c.k]} onChange={(e) => setArr(k, i, c.k, e.target.value, !!c.text)} />
          ))}
          <button type="button" className="text-slate-500 hover:text-red-400 shrink-0" onClick={() => delRow(k, i)}>×</button>
        </div>
      ))}
      <button type="button" className="text-[11px] text-amber-400 hover:underline" onClick={() => addRow(k, tpl)}>+ Add {legend.toLowerCase()}</button>
    </div>
  );
  return (
    <Modal title={isNew ? 'New procedure' : 'Edit procedure'} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Procedure name"><input className={inputCls} value={d.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Substrate (optional)"><input className={inputCls} value={d.substrate} onChange={(e) => set({ substrate: e.target.value })} /></Field>
        <Field label="Process"><select className={inputCls} value={d.process} onChange={(e) => set({ process: e.target.value })}>{processes.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
        <Field label="Cost centre"><select className={inputCls} value={d.costCentreId} onChange={(e) => set({ costCentreId: e.target.value })}><option value="">— none —</option>{costCentres.map((c) => <option key={c.id} value={c.id}>{c.name || '(unnamed)'}</option>)}</select></Field>
      </div>
      <div className="flex items-center justify-between rounded-md bg-slate-800/60 border border-slate-700 px-3 py-2 my-3">
        <span className="text-xs text-slate-400 uppercase tracking-wide">Total hourly operating cost</span>
        <span className="text-lg font-bold font-mono text-amber-300">{fmtMoney(parts.total)} /hr</span>
      </div>
      {/* Not every process feeds the same way — Thermal Spray HVOF/Plasma
          use powder, Robotic MIG/TIG welding uses wire, and Thermal Spray -
          Arc Spray is ALSO wire-fed despite being a spray process, so
          `process` alone can't tell powder and wire apart. A manual choice
          instead of an inferred one, same reasoning as materialMode's
          comment on procedureParts. */}
      <div className="mb-3">
        <span className="block text-xs font-medium text-slate-400 mb-1 tracking-wide uppercase">Feedstock</span>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm text-slate-300 cursor-pointer">
            <input
              type="radio" name="materialMode" className="accent-amber-500"
              checked={d.materialMode !== 'wire'}
              onChange={() => set({ materialMode: 'powder' })}
            />
            Powder
          </label>
          <label className="flex items-center gap-1.5 text-sm text-slate-300 cursor-pointer">
            <input
              type="radio" name="materialMode" className="accent-amber-500"
              checked={d.materialMode === 'wire'}
              onChange={() => set({ materialMode: 'wire' })}
            />
            Wire
          </label>
        </div>
      </div>
      {d.materialMode === 'wire' ? (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1"><span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Wire</span><span className="text-[11px] text-slate-500 font-mono">{fmtMoney(parts.material)} /hr</span></div>
          <div className="grid gap-1.5 mb-1" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,.8fr) minmax(0,.8fr) minmax(0,.8fr)' }}>
            <span className="text-[10px] text-slate-500 uppercase">Wire type</span>
            <span className="text-[10px] text-slate-500 uppercase">Diameter mm</span>
            <span className="text-[10px] text-slate-500 uppercase">Feed m/min</span>
            <span className="text-[10px] text-slate-500 uppercase">$/kg</span>
          </div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,.8fr) minmax(0,.8fr) minmax(0,.8fr)' }}>
            <select className={smallInput} value={d.wire.type} onChange={(e) => setWire('type', e.target.value, true)}>
              <option value="">— select —</option>
              {Object.keys(WIRE_DENSITIES).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className={smallInput} type="number" step="any" placeholder="mm" value={d.wire.diameterMm} onChange={(e) => setWire('diameterMm', e.target.value)} />
            <input className={smallInput} type="number" step="any" placeholder="m/min" value={d.wire.feedSpeedMPerMin} onChange={(e) => setWire('feedSpeedMPerMin', e.target.value)} />
            <input className={smallInput} type="number" step="any" placeholder="$/kg" value={d.wire.pricePerKg} onChange={(e) => setWire('pricePerKg', e.target.value)} />
          </div>
          {/* Density comes from WIRE_DENSITIES, not a field here — this line
              is the only place it's ever shown, so the consumption figure
              driving the $/hr above isn't a black box. */}
          {d.wire.type ? (
            <p className="text-[11px] text-slate-500 mt-1">
              {WIRE_DENSITIES[d.wire.type]} g/cm³ · ≈ {(wireConsumptionGPerMin(d.wire) * 0.06).toFixed(2)} kg/hr consumption
            </p>
          ) : (
            <p className="text-[11px] text-amber-400/80 mt-1">Pick a wire type to calculate consumption and cost.</p>
          )}
        </div>
      ) : (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1"><span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Powder</span><span className="text-[11px] text-slate-500 font-mono">{fmtMoney(parts.material)} /hr</span></div>
          <div className="grid gap-1.5 mb-1" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr)' }}>
            <span className="text-[10px] text-slate-500 uppercase">Material</span>
            <span className="text-[10px] text-slate-500 uppercase">$/kg</span>
            <span className="text-[10px] text-slate-500 uppercase">g/min</span>
          </div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr)' }}>
            <input className={smallInput} placeholder="Material" value={d.powder.material} onChange={(e) => setPw('material', e.target.value, true)} />
            <input className={smallInput} type="number" step="any" placeholder="$/kg" value={d.powder.pricePerKg} onChange={(e) => setPw('pricePerKg', e.target.value)} />
            <input className={smallInput} type="number" step="any" placeholder="g/min" value={d.powder.gPerMin} onChange={(e) => setPw('gPerMin', e.target.value)} />
          </div>
        </div>
      )}
      {sec('gases', 'Process gas', 'minmax(0,1.4fr) 104px minmax(0,.9fr) minmax(0,.9fr) 60px 16px', [{ k: 'name', text: true, ph: 'Gas', label: 'Gas' }, { k: 'role', sel: true, opts: ['primary', 'secondary', 'carrier'], label: 'Role' }, { k: 'pricePerUnit', ph: '$/unit', label: '$/unit' }, { k: 'lPerMin', ph: 'L/min', label: 'L/min' }, { k: 'unit', text: true, ph: 'm³', label: 'Unit' }], { name: '', role: 'primary', unit: 'm³', pricePerUnit: 0, lPerMin: 0 }, 'gas')}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1"><span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Electricity</span><span className="text-[11px] text-slate-500 font-mono">{fmtMoney(parts.electricity)} /hr</span></div>
        <div className="grid gap-1.5 mb-1" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
          <span className="text-[10px] text-slate-500 uppercase">kW</span>
          <span className="text-[10px] text-slate-500 uppercase">$/kWh</span>
        </div>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
          <input className={smallInput} type="number" step="any" placeholder="kW" value={d.electricity.kw} onChange={(e) => setEl('kw', e.target.value)} />
          <input className={smallInput} type="number" step="any" placeholder="$/kWh" value={d.electricity.tariff} onChange={(e) => setEl('tariff', e.target.value)} />
        </div>
      </div>
      {sec('spares', 'Spares', 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) 16px', [{ k: 'name', text: true, ph: 'Part', label: 'Part' }, { k: 'cost', ph: 'Cost $', label: 'Cost $' }, { k: 'life', ph: 'Life hr', label: 'Life hr' }], { name: '', cost: 0, life: 0 }, 'spares')}
      {sec('maintenance', 'Maintenance', 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) 16px', [{ k: 'name', text: true, ph: 'Item', label: 'Item' }, { k: 'cost', ph: 'Cost $', label: 'Cost $' }, { k: 'interval', ph: 'Interval hr', label: 'Interval hr' }], { name: '', cost: 0, interval: 0 }, 'maintenance')}
      {sec('consumables', 'Consumables', 'minmax(0,2fr) minmax(0,1fr) 16px', [{ k: 'name', text: true, ph: 'Item', label: 'Item' }, { k: 'costPerHour', ph: '$/hr', label: '$/hr' }], { name: '', costPerHour: 0 }, 'consumables')}
      {sec('labour', 'Labour', 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) 16px', [{ k: 'name', text: true, ph: 'Role', label: 'Role' }, { k: 'rate', ph: '$/hr', label: '$/hr' }, { k: 'count', ph: 'FTE', label: 'FTE' }], { name: '', rate: 0, count: 1 }, 'labour')}
      {sec('qa', 'QA', 'minmax(0,2fr) minmax(0,1fr) 16px', [{ k: 'name', text: true, ph: 'Activity', label: 'Activity' }, { k: 'costPerHour', ph: '$/hr', label: '$/hr' }], { name: '', costPerHour: 0 }, 'qa')}
      <Field label="Notes (optional)"><input className={inputCls} value={d.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800 mt-2">
        {isNew ? <span /> : <button className={btnDanger} onClick={() => onDelete(d.id)}>Delete</button>}
        <div className="flex gap-2">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} onClick={() => onSave({ ...d, name: (d.name || '').trim() || 'Untitled procedure' })}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

function ActualHoursModal({ job, logged = 0, onCancel, onConfirm, kind = 'job' }) {
  // Prefer what was logged day by day over anything recalled now: that's the
  // whole point of the daily log. Fall back to a stored actual, then estimate.
  const [hours, setHours] = useState(String(logged > 0 ? logged : (job.actualHours ?? job.hoursTotal ?? '')));
  return (
    <Modal title={`${kind === 'task' ? 'Task' : 'Job'} complete — record actual hours`} onClose={onCancel}>
      <p className="text-sm text-slate-300 mb-3"><span className="font-semibold text-slate-100">{job.name}</span> is being marked complete.</p>
      <Field label={`Actual hours taken — estimated ${job.hoursTotal}h${job.quantity > 1 ? ` for ${job.quantity} units` : ''}`}>
        <input type="number" min={0} step={0.25} className={inputCls} value={hours} onChange={(e) => setHours(e.target.value)} autoFocus />
      </Field>
      {logged > 0 && (
        <p className="text-xs text-emerald-400 -mt-2 mb-3">
          Pre-filled from {logged}h logged daily against this {kind}. Adjust if the log missed something.
        </p>
      )}
      <p className="text-xs text-slate-500 mb-3">
        {kind === 'task'
          ? 'Saved to the task history — see the R&D tab for hours and cost.'
          : job.templateId
          ? "Saved to the job history — the template's hours-per-unit becomes the average of actual hours across its completed jobs."
          : 'Saved to the job history. This job has no template, so no hours-per-unit figure is updated.'}
      </p>
      <div className="flex items-center justify-end gap-2">
        <button className={btnGhost} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} onClick={() => onConfirm(Math.max(0, Number(hours) || 0) || job.hoursTotal)}>Save &amp; complete</button>
      </div>
    </Modal>
  );
}

/* ============================================================
   REWORK
   Collects just enough to schedule the rework as its own job — see
   createRework() for how this becomes a full job record, and "Rework"
   in scheduler/CLAUDE.md for why it's a linked record rather than
   reopening the original. ============================================ */
function ReworkModal({ job, onCancel, onConfirm }) {
  const [hoursTotal, setHoursTotal] = useState(job.hoursTotal || '');
  const [readyDate, setReadyDate] = useState('');
  const [dueDate, setDueDate] = useState(addDays(isoDate(new Date()), 14));
  const [reason, setReason] = useState('');
  const canCreate = Number(hoursTotal) > 0;
  return (
    <Modal title="Mark for rework" onClose={onCancel}>
      <p className="text-sm text-slate-300 mb-3">
        Creates a new job, linked back to <span className="font-semibold text-slate-100">{job.name}</span> — its
        own record, completion date and actual hours stay exactly as they are. The rework gets its own hours,
        its own schedule, and its own cost.
      </p>
      <Field label="What needs reworking (optional)">
        <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Estimated hours — original was ${job.hoursTotal}h`}>
          <input type="number" min={0} step={0.25} className={inputCls} value={hoursTotal} onChange={(e) => setHoursTotal(e.target.value)} />
        </Field>
        <Field label="Due date">
          <input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Ready for processing">
        <input type="date" className={inputCls} value={readyDate} onChange={(e) => setReadyDate(e.target.value)} />
      </Field>
      <p className="text-xs text-slate-500 -mt-2 mb-3">
        {readyDate
          ? 'The rework will be scheduled like any other job once this date arrives.'
          : "Leave blank until the part is actually back and ready — same rule as any other job, it just won't be auto-scheduled until then."}
      </p>
      {job.procedureId
        ? <p className="text-xs text-slate-500 mb-3">This job has a procedure assigned, so the rework's cost will be calculated from it automatically — see the Quality tab.</p>
        : <p className="text-xs text-slate-500 mb-3">This job has no procedure assigned, so the Quality tab will show hours logged but no cost for this rework.</p>}
      <div className="flex items-center justify-end gap-2">
        <button className={btnGhost} onClick={onCancel}>Cancel</button>
        <button
          className={btnPrimary} disabled={!canCreate}
          onClick={() => onConfirm({ hoursTotal, readyDate, dueDate, reason })}
        >
          <Wrench size={14} /> Create rework job
        </button>
      </div>
    </Modal>
  );
}

/* ============================================================
   DAILY HOURS LOG
   Records what was actually worked, day by day, instead of asking
   someone to reconstruct a total weeks later at completion time.
   Opens on a date, lists the jobs the schedule expected that day
   (so the common case is confirming numbers, not hunting for jobs),
   and lets any other active job be added for when reality differed.

   A row for a job/task with a paired training partner (secondStaffId)
   gets a second, independent hours field — see the "Two-person jobs" note
   on separately-logged hours in scheduler/CLAUDE.md for why: a trainee
   riding along for the whole block doesn't mean they necessarily worked
   the whole block, and the R&D/Quality reports need each person's own
   figure to attribute hours and cost correctly, not one blended total.
   Who the second person IS isn't editable here — that's the pairing set
   on the job/task itself (JobModal/TaskModal); this only ever asks how
   many of the primary's hours they were actually part of.
   ============================================================ */

function TimeLogModal({ date, jobs, staff, entries, onClose, onSave }) {
  const [day, setDay] = useState(date);
  const [rows, setRows] = useState([]);
  const [addId, setAddId] = useState('');

  const activeJobs = useMemo(() => jobs.filter((j) => j.status !== 'complete'), [jobs]);

  // Jobs the plan put on this day, plus any that already have an entry for it.
  useEffect(() => {
    const existing = entries.filter((e) => e.date === day);
    const plannedIds = new Set();
    activeJobs.forEach((j) => {
      const units = Array.isArray(j.parts) && j.parts.length ? j.parts : [j];
      units.forEach((u) => {
        if ((u.assignment?.days || []).some((d) => d.date === day)) plannedIds.add(j.id);
      });
    });
    existing.forEach((e) => plannedIds.add(e.jobId));

    setRows([...plannedIds].map((jobId) => {
      const job = activeJobs.find((j) => j.id === jobId);
      // A split job's pairing lives per-part, not on the job as a whole
      // (see "Two-person jobs" in scheduler/CLAUDE.md), so there's no
      // single secondStaffId to attribute a row's second entry to here —
      // this deliberately falls back to the single-entry behaviour below
      // for a split job, same as one with no pairing at all.
      const secondStaffId = job && !Array.isArray(job.parts) ? job.secondStaffId : null;
      // The primary's entry is "whichever one isn't the paired second
      // person's", not just the first match — with a pairing active there
      // can be two entries for this job on this date, and picking blindly
      // would sometimes hand the trainee's own hours back as if they were
      // the primary's.
      const e = secondStaffId
        ? existing.find((x) => x.jobId === jobId && x.staffId !== secondStaffId)
        : existing.find((x) => x.jobId === jobId);
      const e2 = secondStaffId ? existing.find((x) => x.jobId === jobId && x.staffId === secondStaffId) : null;
      const units = job && Array.isArray(job.parts) && job.parts.length ? job.parts : job ? [job] : [];
      const planned = units.reduce((s, u) =>
        s + (u.assignment?.days || []).filter((d) => d.date === day).reduce((t, d) => t + (d.hours || 0), 0), 0);
      return {
        jobId,
        name: job ? job.name : '(deleted job)',
        planned: Math.round(planned * 10) / 10,
        hours: e ? String(e.hours) : '',
        staffId: e ? (e.staffId || '') : '',
        note: e ? (e.note || '') : '',
        id: e ? e.id : uid('tl'),
        secondStaffId,
        secondHours: e2 ? String(e2.hours) : '',
        secondId: e2 ? e2.id : uid('tl'),
      };
    }).sort((a, b) => b.planned - a.planned || a.name.localeCompare(b.name)));
  }, [day, entries, activeJobs]);

  const setRow = (jobId, patch) => setRows((rs) => rs.map((r) => (r.jobId === jobId ? { ...r, ...patch } : r)));
  const total = Math.round(rows.reduce((s, r) => s + (Number(r.hours) || 0) + (Number(r.secondHours) || 0), 0) * 100) / 100;
  const addable = activeJobs.filter((j) => !rows.some((r) => r.jobId === j.id));

  return (
    <Modal title="Daily hours log" onClose={onClose} wide>
      <div className="flex items-end gap-3 flex-wrap mb-3">
        <Field label="Date">
          <input type="date" className={inputCls} value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <p className="text-xs text-slate-500 pb-3 flex-1 min-w-[220px]">
          Jobs the schedule expected on this day are listed for you. Leave a row blank if nothing was done on it.
        </p>
      </div>

      <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900 overflow-x-auto max-h-[42vh] overflow-y-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="sticky top-0 bg-slate-900 z-10">
            <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 font-medium">Job</th>
              <th className="px-3 py-2 font-medium">Planned</th>
              <th className="px-3 py-2 font-medium">Hours worked</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500 text-xs">
                Nothing was scheduled on this day. Add a job below if work happened anyway.
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.jobId} className="border-b border-slate-800/60">
                <td className="px-3 py-2 text-slate-200 max-w-[260px] truncate" title={r.name}>{r.name}</td>
                <td className="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">{r.planned ? `${r.planned}h` : '—'}</td>
                <td className="px-3 py-2">
                  <input
                    type="number" min={0} step={0.25}
                    className="w-20 bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-100"
                    value={r.hours}
                    placeholder="0"
                    onChange={(e) => setRow(r.jobId, { hours: e.target.value })}
                  />
                  {/* The training partner's own hours, independent of the
                      primary's — see the modal's header comment. Not shown
                      at all unless the job/task actually has one paired. */}
                  {r.secondStaffId && (
                    <input
                      type="number" min={0} step={0.25}
                      className="w-20 mt-1 bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-100"
                      value={r.secondHours}
                      placeholder="0"
                      title={`${staff.find((s) => s.id === r.secondStaffId)?.name || 'Training partner'}'s hours`}
                      onChange={(e) => setRow(r.jobId, { secondHours: e.target.value })}
                    />
                  )}
                </td>
                <td className="px-3 py-2">
                  <select
                    className="w-[130px] bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-200"
                    value={r.staffId}
                    onChange={(e) => setRow(r.jobId, { staffId: e.target.value })}
                  >
                    <option value="">—</option>
                    {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {/* Who the second person is comes from the job/task's own
                      pairing (JobModal/TaskModal), not editable here — this
                      is purely a label lining up with their hours field
                      above. */}
                  {r.secondStaffId && (
                    <div className="w-[130px] mt-1 text-[11px] text-slate-400 truncate" title={`${staff.find((s) => s.id === r.secondStaffId)?.name || 'Training partner'} (training)`}>
                      {staff.find((s) => s.id === r.secondStaffId)?.name || 'Training partner'} <span className="text-slate-600">(training)</span>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    className="w-full min-w-[140px] bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-200"
                    value={r.note}
                    placeholder="optional"
                    onChange={(e) => setRow(r.jobId, { note: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addable.length > 0 && (
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span className="text-xs text-slate-400">Also worked on:</span>
          <select
            className={`${inputCls} py-1.5 flex-1 min-w-[200px]`}
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
          >
            <option value="">Choose a job…</option>
            {addable.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <button
            type="button"
            className={btnGhost}
            disabled={!addId}
            onClick={() => {
              const j = activeJobs.find((x) => x.id === addId);
              if (!j) return;
              const secondStaffId = !Array.isArray(j.parts) ? j.secondStaffId : null;
              setRows((rs) => [...rs, {
                jobId: j.id, name: j.name, planned: 0, hours: '', staffId: '', note: '', id: uid('tl'),
                secondStaffId, secondHours: '', secondId: uid('tl'),
              }]);
              setAddId('');
            }}
          ><Plus size={14} /> Add</button>
        </div>
      )}

      <div className="flex items-center justify-between pt-4 mt-3 border-t border-slate-800">
        <span className="text-xs text-slate-500">{total}h logged for {fmtDate(day)}</span>
        <div className="flex gap-2">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button
            className={btnPrimary}
            onClick={() => {
              const built = [];
              rows.forEach((r) => {
                built.push({ id: r.id, jobId: r.jobId, date: day, hours: Number(r.hours) || 0, staffId: r.staffId || null, note: (r.note || '').trim() });
                // The second entry rides on the same note and date, its own
                // id/staffId/hours — saveTimeLog (main component) filters
                // out anything that ends up at 0h, same as the primary.
                if (r.secondStaffId) {
                  built.push({ id: r.secondId, jobId: r.jobId, date: day, hours: Number(r.secondHours) || 0, staffId: r.secondStaffId, note: (r.note || '').trim() });
                }
              });
              onSave(day, built);
            }}
          ><Check size={14} /> Save log</button>
        </div>
      </div>
    </Modal>
  );
}

function CostingView({
  procedures, costCentres, costSettings, onSaveCostSettings, processes, readOnly, onImport, onNewProcedure, onEditProcedure, onNewCentre, onEditCentre,
  equipment, onAddEquip, onEditEquip, onDeleteEquip,
}) {
  const efficiency = costSettings?.efficiency ?? 75;
  const avgLabourRate = costSettings?.avgLabourRate ?? 0;
  const setEfficiency = (v) => onSaveCostSettings({ ...costSettings, efficiency: v });
  const setAvgLabourRate = (v) => onSaveCostSettings({ ...costSettings, avgLabourRate: v });
  const fileRef = useRef(null);
  const byProcess = {};
  (procedures || []).forEach((p) => {
    const key = p.process || '(no process assigned)';
    (byProcess[key] = byProcess[key] || []).push(p);
  });
  const groups = Object.keys(byProcess).sort();
  return (
    <div>
      {/* Equipment used to have its own "Equipment & Staff" tab. Moved here
          (#20) — it has no data-model link to cost centres or procedures
          (equipment carries no $ fields), this is purely giving it a home now
          that Staff absorbed the other half of that old tab. */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2"><Wrench size={17} /> Equipment</h2>
        {!readOnly && <button className={btnPrimary} onClick={onAddEquip}><Plus size={15} /> Add</button>}
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
        {(equipment || []).map((e) => {
          const color = EQUIP_COLOR[e.type] || EQUIP_COLOR['Welding Robot'];
          return (
            <div key={e.id} className={`border border-slate-800 bg-slate-900 rounded-lg p-3 border-l-[3px] ${color.border}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-slate-100 text-sm">{e.name}</h3>
                  <p className={`text-[11px] ${color.text}`}>{e.type}</p>
                </div>
                {!readOnly && (
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => onEditEquip(e)} className="p-1 rounded hover:bg-slate-700 text-slate-400"><Pencil size={13} /></button>
                    <button onClick={() => onDeleteEquip(e)} className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"><Trash2 size={13} /></button>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {e.processes.map((p) => <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{p}</span>)}
              </div>
              {e.unavailableDates?.length > 0 && <p className="text-[10px] text-slate-600 mt-2">{e.unavailableDates.length} day(s) marked unavailable</p>}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold text-slate-100">Costing</h2>
          <p className="text-xs text-slate-500 mt-0.5">Hourly operating cost per procedure, built from your cost calculator. A template's procedure sets the $/hr used to cost its jobs.</p>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <button className={btnPrimary} onClick={onNewProcedure}><Plus size={15} /> New procedure</button>
            <button className={btnGhost} onClick={onNewCentre}><Plus size={14} /> New cost centre</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files && e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { try { onImport(JSON.parse(rd.result)); } catch (x) { onImport(null); } }; rd.readAsText(f); e.target.value = ''; }}
            />
            <button className={btnGhost} onClick={() => fileRef.current && fileRef.current.click()}><Upload size={15} /> Import from cost calculator</button>
          </div>
        )}
      </div>

      {/* A job's SCHEDULED hours aren't all productive process time — some
          of every job/task is setup and breakdown, which doesn't burn
          materials, gas or machine time the way a procedure's own $/hr
          assumes, just a person's time. This blends that into every cost
          figure the app shows (jobCost/hourlyRate — see
          effectiveHourlyRate): `efficiency`% of the scheduled hours at the
          procedure's own rate, the rest at this one average labour rate.
          Deliberately ONE global average, not a rate per staff member —
          individual pay is HR data and has no business living here. */}
      <div className="border border-slate-800 bg-slate-900 rounded-lg p-4 mb-6">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Setup/breakdown time</h3>
        <p className="text-xs text-slate-500 mb-3">
          Not every scheduled hour is spent running the process — some is setup and pack-down. {Math.round(efficiency)}% of a
          job's hours are costed at its procedure's own rate; the rest at the average labour cost below, since materials, gas
          and machine time aren't being consumed while a job is being set up or broken down.
        </p>
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <Field label="Efficiency (%)">
            <input
              type="number" min={0} max={100} step={1} className={inputCls} disabled={readOnly}
              value={efficiency} onChange={(e) => setEfficiency(e.target.value)}
            />
          </Field>
          <Field label="Average labour cost ($/hr)">
            <input
              type="number" min={0} step={0.5} className={inputCls} disabled={readOnly}
              value={avgLabourRate} onChange={(e) => setAvgLabourRate(e.target.value)}
            />
          </Field>
        </div>
      </div>

      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Cost centres (shared capital)</h3>
      {(costCentres || []).length === 0 && <p className="text-xs text-slate-600 mb-4">No cost centres yet.</p>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        {(costCentres || []).map((c) => (
          <div
            key={c.id}
            className={`border border-slate-800 bg-slate-900 rounded-lg p-3 ${!readOnly ? 'cursor-pointer hover:border-slate-600' : ''}`}
            onClick={() => !readOnly && onEditCentre(c)}
          >
            <div className="font-semibold text-slate-100 text-sm">{c.name || '(unnamed)'}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{c.interestRate}% interest · {(Number(c.annualHours) || 0).toLocaleString()} hr/yr</div>
            <div className="text-amber-300 font-mono text-sm mt-1">{fmtMoney(costCentrePerHr(c))} /hr dep+interest</div>
            <div className="mt-2 space-y-0.5">
              {(c.assets || []).map((r, i) => (
                <div key={i} className="text-[11px] text-slate-400 flex justify-between gap-2">
                  <span className="truncate">{r.name || '—'}</span>
                  <span className="font-mono shrink-0">${(Number(r.capital) || 0).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Procedures</h3>
      {groups.length === 0 && <p className="text-xs text-slate-600">No procedures yet — import from your cost calculator.</p>}
      {/* Collapsed by default, same reasoning as ProcedureCopyPicker's
          grouping (the "Create from existing" picker, above) — this page is
          a handful of procedures per process today, but the whole point of
          grouping by process is that it won't stay that way. A dozen
          processes each with several procedures, all expanded, is exactly
          the "one really long page" this replaces. */}
      {groups.map((gk) => (
        <Section key={gk} title={`${gk} (${byProcess[gk].length})`} defaultOpen={false}>
          <div className="grid lg:grid-cols-2 gap-3">
            {byProcess[gk].map((p) => {
              const parts = procedureParts(p, costCentres);
              const cc = (costCentres || []).find((c) => c.id === p.costCentreId);
              const rows = [
                [p.materialMode === 'wire' ? 'Wire' : 'Powder', parts.material], ['Process gas', parts.gas], ['Electricity', parts.electricity],
                ['Spares', parts.spares], ['Maintenance', parts.maintenance], ['Consumables', parts.consumables],
                ['Depreciation + interest', parts.depreciation], ['Labour', parts.labour], ['QA', parts.qa],
              ];
              return (
                <div
                  key={p.id}
                  className={`border border-slate-800 bg-slate-900 rounded-lg p-4 ${!readOnly ? 'cursor-pointer hover:border-slate-600' : ''}`}
                  onClick={() => !readOnly && onEditProcedure(p)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-100 text-sm truncate">{p.name || '(unnamed)'}</div>
                      <div className="text-[11px] text-slate-500">{cc ? cc.name : 'no cost centre'}{p.substrate ? ` · ${p.substrate}` : ''}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-amber-300 font-mono text-lg font-semibold">{fmtMoney(parts.total)}</div>
                      <div className="text-[10px] text-slate-500">per hour</div>
                    </div>
                  </div>
                  <div className="mt-2 space-y-0.5">
                    {rows.map(([label, val], i) => (
                      <div key={i} className={`text-[11px] flex justify-between gap-2 ${val > 0 ? 'text-slate-400' : 'text-slate-600'}`}>
                        <span>{label}</span>
                        <span className="font-mono">{fmtMoney(val)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      ))}
    </div>
  );
}

export default function WeldingScheduler() {
  const [loaded, setLoaded] = useState(false);
  const [equipment, setEquipment] = useState([]);
  const [staff, setStaff] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [processes, setProcesses] = useState(DEFAULT_PROCESSES);
  const [jobs, setJobs] = useState([]);
  const [costCentres, setCostCentres] = useState([]);
  const [procedures, setProcedures] = useState([]);
  // Scheduled hours aren't 100% productive process time — some of every job/
  // task is setup and breakdown, which doesn't burn materials/gas/machine
  // time the way a procedure's own $/hr rate assumes, just a person's time.
  // `efficiency` (%) is the assumed productive share; the rest is costed at
  // `avgLabourRate` alone. Deliberately ONE global average rate, not
  // per-person — individual pay rates are HR data, not something this app
  // should hold. See effectiveHourlyRate and "Costing: efficiency and
  // average labour cost" in scheduler/CLAUDE.md.
  const [costSettings, setCostSettings] = useState({ avgLabourRate: 0, efficiency: 75 });
  const [categories, setCategories] = useState([]);
  // Daily record of hours actually worked per job. Recalling a total at the
  // point of completion is guesswork; this is entered day by day while it's
  // still fresh, and the completion dialog then totals it rather than asking.
  const [timeLog, setTimeLog] = useState([]);
  const [timeLogDate, setTimeLogDate] = useState(null); // ISO date, or null when closed
  // Rows the last WIP import didn't claim, kept so a job whose scope later
  // grows into our work can be pulled in without re-running the whole import.
  // See PARKED_KEY for what is and isn't stored.
  const [parked, setParked] = useState([]);
  const [parkedOpen, setParkedOpen] = useState(false);
  // Where the user has overruled the scheduler — see OVERRIDES_KEY and
  // src/overrides.js. Recorded only; nothing reads it back into placement.
  const [overrides, setOverrides] = useState([]);

  // R&D projects (tracking-only — see ProjectsView) and the non-job tasks
  // that can align to one. Tasks share the scheduling engine with jobs (see
  // taskToJobUnit/splitTaskUnits and "R&D projects and tasks" in
  // scheduler/CLAUDE.md) so they consume the exact same equipment/staff
  // capacity a job would, but they're never mixed into the `jobs` array
  // itself — Job Backlog, Reports, batching, WIP import etc. all stay
  // exactly as they were, seeing only real jobs.
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);

  const [tab, setTab] = useState('schedule');
  const [readOnly, setReadOnly] = useState(false);
  const [displayMode, setDisplayMode] = useState(false);

  const [editingJob, setEditingJob] = useState(null); // job object or 'new' or null
  const [importOpen, setImportOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [editingEquipment, setEditingEquipment] = useState(null);
  const [editingStaff, setEditingStaff] = useState(null);
  const [editingProcedure, setEditingProcedure] = useState(null); // procedure object or 'new' or null
  const [editingCentre, setEditingCentre] = useState(null);       // cost-centre object or 'new' or null
  // "New procedure"/"New cost centre" open one of these first (CreateChoiceModal)
  // instead of editingProcedure/editingCentre directly — Create new still
  // lands on the same blank editor as before; Create from existing sets the
  // matching *Seed state below and THEN opens the same 'new' editor, which
  // prefills from the seed without treating it as an edit of the source
  // (see ProcedureEditor/CostCentreEditor's seedFrom prop).
  const [procedureChoiceOpen, setProcedureChoiceOpen] = useState(false);
  const [costCentreChoiceOpen, setCostCentreChoiceOpen] = useState(false);
  const [procedureSeed, setProcedureSeed] = useState(null);
  const [costCentreSeed, setCostCentreSeed] = useState(null);
  const [editingTask, setEditingTask] = useState(null);           // task object or 'new' or null
  const [editingProject, setEditingProject] = useState(null);     // project object or 'new' or null
  // A task backfilled via "Log past work" (BackfillTaskModal) — a task
  // object (routed here instead of editingTask when it's already complete
  // with no assignment, i.e. was never scheduled), 'new', or null.
  const [backfillTask, setBackfillTask] = useState(null);
  const [pendingComplete, setPendingComplete] = useState(null);   // job awaiting actual-hours entry
  // Set only when "Mark complete" was clicked FROM INSIDE JobModal (not the
  // Backlog row's own inline toggle, which has no modal to return to) — see
  // completeWithHours/the pendingComplete ActualHoursModal below for why.
  const [reopenJobAfterComplete, setReopenJobAfterComplete] = useState(false);
  const [pendingTaskComplete, setPendingTaskComplete] = useState(null); // task awaiting actual-hours entry
  const [confirmDelete, setConfirmDelete] = useState(null); // {type, id, name}
  const [parallelConflict, setParallelConflict] = useState(null); // {job, candidates}
  const [manualAssignConflict, setManualAssignConflict] = useState(null); // {job, person, blockers}
  const [equipmentLockConflict, setEquipmentLockConflict] = useState(null); // {job, machine, blockers}
  const [confirmClearPatterns, setConfirmClearPatterns] = useState(false);
  // The COMPLETED job "Mark for rework" was clicked on — holds it open only
  // long enough to collect the rework's own scheduling info (see
  // ReworkModal). Not the rework job itself, which doesn't exist until
  // createRework builds it.
  const [reworkOf, setReworkOf] = useState(null);

  const [dragJobId, setDragJobId] = useState(null);
  // A task drag is tracked separately from a job drag rather than sharing
  // dragJobId — jobs and tasks are different arrays with different drop
  // handlers (handleDrop vs handleTaskDrop below), and keeping them apart
  // means neither path needs to know the other's id-space exists. They
  // share `dropHint` (only one drag ever happens at a time) and the same
  // day-cell drop target, which just checks which one is set.
  const [dragTaskId, setDragTaskId] = useState(null);
  const [dropHint, setDropHint] = useState(null); // {equipId, date}
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  function showToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  const todayIso = useMemo(() => isoDate(new Date()), []);
  // The timeline spans HISTORY_DAYS behind today as well as the forward
  // horizon, so past work stays there to be paged back to. `todayIdx` is
  // today's position in it — the floor for auto-scheduling, and where the
  // view opens.
  const workingDays = useMemo(
    () => generateCalendarDays(addDays(todayIso, -HISTORY_DAYS), HISTORY_DAYS + HORIZON_DAYS),
    [todayIso]
  );
  const todayIdx = useMemo(() => Math.max(0, workingDays.indexOf(todayIso)), [workingDays, todayIso]);

  // The scheduler's own reasoning from the most recent run: for every
  // auto-placed job, which machines could have taken it, what each measured,
  // and which won. Pure observation — asking for it moves nothing (see the
  // trace/weights split in scheduler.js), and the app is still on the default
  // placement path.
  //
  // A ref, not state: nothing renders from it, and an override handler has to
  // read it SYNCHRONOUSLY mid-event, before its own recompute replaces it.
  // That ordering is the whole trick — once a dragged job is pinned it stops
  // generating candidates, so the only run that knows what the automatic
  // choice would have been is the one that already happened.
  const lastTraceRef = useRef([]);
  // The tasksResult half of the most recent recompute — nothing renders from
  // this either. Task mutations need to know synchronously, in the same
  // event, whether the task they just placed came back conflicted (for a
  // toast) — by the time `tasks` state itself has updated, the event that
  // needs the answer has already finished.
  const lastTasksResultRef = useRef([]);

  // EVERY runScheduler call in this component goes through here. An earlier
  // version traced only inside `recompute`, which silently missed the initial
  // load and reloadFromStore — so on a freshly opened page the ref was empty
  // and the very first correction of a session, the one most worth having,
  // recorded nothing at all.
  const runSchedulerTraced = useCallback((jobsList, eqList, stList) => {
    const trace = [];
    const result = runScheduler(jobsList, eqList, stList, workingDays, todayIdx, { trace });
    lastTraceRef.current = trace;
    return result;
  }, [workingDays, todayIdx]);

  const [rangeStart, setRangeStart] = useState(HISTORY_DAYS); // index into workingDays; opens on today
  const [rangeLength, setRangeLength] = useState(30); // days shown at once — see RANGE_PRESETS
  // Lives here, not in ScheduleView itself, for the same reason rangeStart/
  // rangeLength do (#50): ScheduleView unmounts when you switch tabs, so
  // state local to it resets every time you come back. Still not saved to
  // storage — a viewing preference for the session, not schedule data.
  // 60% (ZOOM_MIN in ScheduleView) is the default, not 100% — a fully-booked
  // shop reads better zoomed out from the start, with room to zoom in either
  // direction from there rather than only ever being able to zoom further out.
  const [zoom, setZoom] = useState(0.6);
  const visibleDays = useMemo(
    () => workingDays.slice(rangeStart, rangeStart + rangeLength),
    [workingDays, rangeStart, rangeLength]
  );

  // ---------- initial load ----------
  useEffect(() => {
    (async () => {
      const [eq, st, tp, pr, jb, cc, pc, pk, ct, tl, ov, pj, tk, cs] = await Promise.all([
        loadKey('wf_equipment', null),
        loadKey('wf_staff', null),
        loadKey('wf_templates', null),
        loadKey('wf_processes', null),
        loadKey('wf_jobs', null),
        loadKey('wf_costcentres', null),
        loadKey('wf_procedures', null),
        loadKey(PARKED_KEY, null),
        loadKey('wf_categories', null),
        loadKey(TIMELOG_KEY, null),
        loadKey(OVERRIDES_KEY, null),
        loadKey(PROJECTS_KEY, null),
        loadKey(TASKS_KEY, null),
        loadKey(COST_SETTINGS_KEY, null),
      ]);
      if (pk) setParked(pk);
      if (tl) setTimeLog(tl);
      if (ov) setOverrides(ov);
      const finalEq = eq || seedEquipment();
      const finalSt = (st || seedStaff()).map(normalizeStaff);
      const finalTp = tp || seedTemplates();
      const finalPr = pr || DEFAULT_PROCESSES;
      const finalJb = jb || seedJobs();
      const finalCc = cc || seedCostCentres();
      const finalPc = pc || seedProcedures();
      const finalPj = pj || [];
      const finalTk = tk || [];
      const finalCs = cs || { avgLabourRate: 0, efficiency: 75 };

      setEquipment(finalEq);
      setStaff(finalSt);
      setTemplates(finalTp);
      setProcesses(finalPr);
      setCostCentres(finalCc);
      setProcedures(finalPc);
      setProjects(finalPj);
      setCostSettings(finalCs);
      // Categories used to be free text typed per template. Seed the managed
      // list from whatever the existing templates already use, so nothing an
      // existing user set up disappears the first time they load this.
      const finalCt = ct || [...new Set(finalTp.map((t) => t.category).filter(Boolean))].sort();
      setCategories(finalCt);

      const merged = runSchedulerTraced([...finalJb, ...finalTk.map(taskToJobUnit)], finalEq, finalSt);
      const { jobsResult: scheduled, tasksResult: scheduledTasks } = splitTaskUnits(merged, finalTk);
      setJobs(scheduled);
      setTasks(scheduledTasks);

      if (!eq) saveKey('wf_equipment', finalEq);
      saveKey('wf_staff', finalSt);
      if (!tp) saveKey('wf_templates', finalTp);
      if (!pr) saveKey('wf_processes', finalPr);
      saveKey('wf_jobs', scheduled);
      saveKey(TASKS_KEY, scheduledTasks);
      if (!cc) saveKey('wf_costcentres', finalCc);
      if (!pc) saveKey('wf_procedures', finalPc);
      if (!ct) saveKey('wf_categories', finalCt);
      if (!pj) saveKey(PROJECTS_KEY, finalPj);
      if (!cs) saveKey(COST_SETTINGS_KEY, finalCs);

      setLoaded(true);
    })();
  }, []);

  // ---------- live sync with other people (shared deployment only) ----------
  // Latest values, for reloadFromStore to fall back on without making itself
  // depend on (and be rebuilt by) every state change.
  const latest = useRef({ equipment, staff, jobs, tasks });
  latest.current = { equipment, staff, jobs, tasks };

  // Re-read everything someone else may have changed. Deliberately does NOT
  // write anything back: a save would bump the server's version and every
  // other screen would see *that* as a change, and so on around the loop.
  const reloadFromStore = useCallback(async () => {
    const [eq, st, tp, pr, jb, cc, pc, pk, ct, tl, ov, pj, tk, cs] = await Promise.all([
      loadKey('wf_equipment', null),
      loadKey('wf_staff', null),
      loadKey('wf_templates', null),
      loadKey('wf_processes', null),
      loadKey('wf_jobs', null),
      loadKey('wf_costcentres', null),
      loadKey('wf_procedures', null),
      loadKey(PARKED_KEY, null),
      loadKey('wf_categories', null),
      loadKey(TIMELOG_KEY, null),
      loadKey(OVERRIDES_KEY, null),
      loadKey(PROJECTS_KEY, null),
      loadKey(TASKS_KEY, null),
      loadKey(COST_SETTINGS_KEY, null),
    ]);
    if (ct) setCategories(ct);
    if (tl) setTimeLog(tl);
    if (ov) setOverrides(ov);
    if (pj) setProjects(pj);
    if (cs) setCostSettings(cs);
    const nextEq = eq || latest.current.equipment;
    const nextSt = st ? st.map(normalizeStaff) : latest.current.staff;
    if (eq) setEquipment(nextEq);
    if (st) setStaff(nextSt);
    if (tp) setTemplates(tp);
    if (pr) setProcesses(pr);
    if (cc) setCostCentres(cc);
    if (pc) setProcedures(pc);
    // Either side recomputing has to carry the other along, same reason as
    // `recompute` above — they share one capacity pool. Only actually
    // reruns the engine when something that affects placement came back
    // (a job, a task, equipment or staff), not on every poll.
    if (jb || tk) {
      const nextJb = jb || latest.current.jobs;
      const nextTk = tk || latest.current.tasks;
      const merged = runSchedulerTraced([...nextJb, ...nextTk.map(taskToJobUnit)], nextEq, nextSt);
      const { jobsResult, tasksResult } = splitTaskUnits(merged, nextTk);
      setJobs(jobsResult);
      setTasks(tasksResult);
    }
    if (pk) setParked(pk);
  }, [runSchedulerTraced]);

  const [remoteChange, setRemoteChange] = useState(false);
  useEffect(() => startLiveSync(() => setRemoteChange(true)), []);

  // Hold the update back until the user isn't in the middle of something —
  // an open dialog holds its own copy of a record, and a drag in progress
  // would jump under the cursor. It applies as soon as they're done.
  const busyEditing = !!(
    editingJob || importOpen || editingTemplate || editingEquipment || editingStaff
    || editingProcedure || editingCentre || procedureChoiceOpen || costCentreChoiceOpen
    || pendingComplete || confirmDelete || dragJobId
    || timeLogDate || parallelConflict || manualAssignConflict || equipmentLockConflict
    || confirmClearPatterns || reworkOf || editingTask || editingProject || pendingTaskComplete || dragTaskId
    || backfillTask
  );
  useEffect(() => {
    if (!remoteChange || !loaded || busyEditing) return;
    setRemoteChange(false);
    reloadFromStore();
  }, [remoteChange, loaded, busyEditing, reloadFromStore]);

  // Tasks ride along on every job recompute (see taskToJobUnit/
  // splitTaskUnits) because they draw on the exact same equipment/staff
  // capacity a job does — an equipment edit, a staff roster change, or just
  // another job landing on the same day all have to be able to bump a task,
  // and vice versa. `tasksList` defaults to current state for the vastly
  // more common case (a job-only change, tasks untouched); task mutations
  // pass their own just-built list explicitly, the same reason job mutations
  // below always pass a freshly-built jobsList rather than relying on the
  // `jobs` state closure being caught up yet.
  const recompute = useCallback((jobsList, eqList, stList, tasksList = tasks) => {
    const merged = runSchedulerTraced([...jobsList, ...tasksList.map(taskToJobUnit)], eqList, stList);
    const { jobsResult, tasksResult } = splitTaskUnits(merged, tasksList);
    lastTasksResultRef.current = tasksResult;
    setJobs(jobsResult);
    saveKey('wf_jobs', jobsResult);
    setTasks(tasksResult);
    saveKey(TASKS_KEY, tasksResult);
    return jobsResult;
  }, [runSchedulerTraced, tasks]);

  // Records that the user placed a job somewhere other than where the
  // scheduler had put it. Called BEFORE the recompute that applies the
  // override, so `lastTraceRef` still holds the run in which this job was
  // auto-placed. Returns nothing and affects nothing — if any part of this
  // fails the placement still goes ahead exactly as it would have.
  const recordOverride = useCallback((job, userChoice, source) => {
    try {
      const traceEntry = lastTraceRef.current.find((t) => t.jobId === job.id);
      const record = buildOverrideRecord({
        job,
        traceEntry,
        userChoice,
        source,
        at: new Date().toISOString(),
        id: uid('ovr'),
      });
      if (!record) return; // agreement, or the job wasn't auto-placed to begin with
      setOverrides((prev) => {
        const next = appendOverride(prev, record);
        saveKey(OVERRIDES_KEY, next);
        return next;
      });
    } catch {
      // Capture is strictly a side observation. It must never be able to take
      // down a placement the user just asked for.
    }
  }, []);

  // A manual placement (drag-drop or the job modal's Equipment field) that
  // lands a job on an operator someone else already has used to just leave
  // it silently overbooked — an unassigned placeholder block with a
  // conflict flag buried in the "Overbooked" list (#30). Called right after
  // recompute() for the specific job just placed (never for jobs that
  // happened to already be conflicted before this action — that would fire
  // this dialog on unrelated recomputes like an equipment edit), this looks
  // for what it's actually contending with and, if found, offers a way out:
  // tag one of the two as parallel-processing-capable instead of leaving it
  // overbooked.
  // Who a conflicted job is actually contending with, for the dialog's
  // wording — the conflicted job's own day-plan has no staffId (that's what
  // conflict means), so read it off whichever candidate is holding the
  // overlapping date(s) instead.
  function namesHoldingOperator(conflictedJob, candidates) {
    const dates = new Set((conflictedJob.assignment.days || []).map((d) => d.date));
    const staffIds = new Set();
    candidates.forEach((c) => {
      const dayLists = c.parts ? c.parts.map((p) => p.assignment?.days || []) : [c.assignment?.days || []];
      dayLists.forEach((ds) => ds.forEach((d) => { if (dates.has(d.date) && d.staffId) staffIds.add(d.staffId); }));
    });
    return [...staffIds].map((id) => staff.find((s) => s.id === id)?.name).filter(Boolean);
  }
  function checkParallelConflict(result, jobId) {
    const justPlaced = result.find((j) => j.id === jobId);
    if (!justPlaced) return;
    // A freshly pinned job outranks whatever was already sitting on that
    // slot (same "most recent decision wins" priority a drag gets — see
    // runScheduler's pinned-sort), so it's just as likely the job we placed
    // actually WON and it's some OTHER, previously-fine job that got bumped
    // into conflict as a side effect. Check every currently-conflicted
    // pinned job for whether our action is what it's now contending with,
    // before assuming the job we just touched is the one that lost.
    const conflicted = result.filter((j) => j.id !== jobId && j.assignment?.pinned && j.assignment?.conflict);
    for (const c of conflicted) {
      const candidates = findStaffConflictJobs(c, result, staff);
      if (candidates.some((cand) => cand.id === jobId)) {
        setParallelConflict({ job: c, candidates, staffNames: namesHoldingOperator(c, candidates) });
        return;
      }
    }
    if (justPlaced.assignment?.pinned && justPlaced.assignment?.conflict) {
      const candidates = findStaffConflictJobs(justPlaced, result, staff);
      if (candidates.length) {
        setParallelConflict({ job: justPlaced, candidates, staffNames: namesHoldingOperator(justPlaced, candidates) });
      }
    }
  }
  // Grants (or the dialog could equally target the other job) the tag that
  // lets this job's operator be shared with whatever it's contending with —
  // it stays on the job from here on, not just for this one pairing (#30).
  function allowParallelProcessing(jobId) {
    const target = jobs.find((j) => j.id === jobId);
    const updated = jobs.map((j) => (j.id === jobId ? { ...j, parallelProcessing: true, updatedAt: new Date().toISOString() } : j));
    recompute(updated, equipment, staff);
    setParallelConflict(null);
    showToast(`Parallel processing allowed on ${target?.name || 'the job'} — it can now share an operator with other work.`);
  }

  // A manual staff assignment (#46) is a hard restriction the scheduler
  // honours by waiting for that person (see eligibleStaffIds) — but a PINNED
  // job already using them for the days this one needs isn't "waiting for",
  // it's a standing claim runScheduler settles before the manual job even
  // gets a turn (pinned jobs place first). Left alone, the manually-assigned
  // job just lands in "Needs scheduling" with a reason naming them, and
  // there's no way forward short of hunting down whatever's got them and
  // unpinning it by hand. This finds it for you.
  function findManualAssignBlockers(job, jobsList) {
    if (!job.staffId || job.assignment) return [];
    const from = job.readyDate;
    const blockers = new Map();
    jobsList.forEach((j) => {
      if (j.id === job.id || j.status === 'complete') return;
      const units = Array.isArray(j.parts) ? j.parts : [j];
      const holdsThem = units.some((u) =>
        u.assignment?.pinned && (u.assignment.days || []).some((d) => d.staffId === job.staffId && d.date >= from));
      if (holdsThem) blockers.set(j.id, j);
    });
    return [...blockers.values()];
  }
  function checkManualAssignConflict(result, jobId) {
    const justPlaced = result.find((j) => j.id === jobId);
    if (!justPlaced || !justPlaced.staffId || justPlaced.assignment) return;
    const person = staff.find((s) => s.id === justPlaced.staffId);
    if (!person) return;
    const blockers = findManualAssignBlockers(justPlaced, result);
    if (blockers.length) setManualAssignConflict({ job: justPlaced, person, blockers });
  }
  // Unpinning doesn't hand the person over directly — it just frees the
  // blocker to be re-placed like any other unpinned job, so the manually-
  // assigned job gets first call on them (manual assignments place before
  // automatic ones — see runScheduler) while the freed job finds itself
  // another slot, another operator, or another day. Re-checks afterwards in
  // case more than one blocker was in the way.
  function unpinForManualAssign(targetJobId, blockerIds) {
    const targets = new Set(blockerIds);
    const updated = jobs.map((j) => {
      if (!targets.has(j.id)) return j;
      const stamp = { updatedAt: new Date().toISOString() };
      if (Array.isArray(j.parts)) {
        return { ...j, ...stamp, parts: j.parts.map((p) => ({ ...p, assignment: p.assignment ? { ...p.assignment, pinned: false } : null })) };
      }
      return { ...j, ...stamp, assignment: j.assignment ? { ...j.assignment, pinned: false } : null };
    });
    const result = recompute(updated, equipment, staff);
    setManualAssignConflict(null);
    checkManualAssignConflict(result, targetJobId);
    showToast(`Unpinned ${blockerIds.length} job${blockerIds.length === 1 ? '' : 's'} so it can be rescheduled.`);
  }

  // The equipment equivalent of the manual-assignment blocker above: a hard
  // equipment lock (job.lockedEquipmentId, see scheduler.js's
  // eligibleEquipment) is a standing request to wait for one specific
  // machine, same shape of restriction job.staffId is for a person — and hits
  // the exact same wall when a PINNED job is already sitting on that machine
  // for the days this one needs. Left alone the locked job just lands in
  // "Needs scheduling" naming the machine; this finds what's holding it.
  function findEquipmentLockBlockers(job, jobsList) {
    if (!job.lockedEquipmentId || job.assignment) return [];
    const from = job.readyDate;
    const blockers = new Map();
    jobsList.forEach((j) => {
      if (j.id === job.id || j.status === 'complete') return;
      const units = Array.isArray(j.parts) ? j.parts : [j];
      const holdsIt = units.some((u) =>
        u.assignment?.pinned && u.assignment.equipmentId === job.lockedEquipmentId
        && (u.assignment.days || []).some((d) => d.date >= from));
      if (holdsIt) blockers.set(j.id, j);
    });
    return [...blockers.values()];
  }
  function checkEquipmentLockConflict(result, jobId) {
    const justPlaced = result.find((j) => j.id === jobId);
    if (!justPlaced || !justPlaced.lockedEquipmentId || justPlaced.assignment) return;
    const machine = equipment.find((e) => e.id === justPlaced.lockedEquipmentId);
    if (!machine) return;
    const blockers = findEquipmentLockBlockers(justPlaced, result);
    if (blockers.length) setEquipmentLockConflict({ job: justPlaced, machine, blockers });
  }
  // Same reasoning as unpinForManualAssign: unpinning doesn't hand the
  // machine over directly, it just frees the blocker to be re-placed like any
  // other unpinned job — a locked job already places before automatic ones
  // (see runScheduler), so it gets first call on the machine once it's free.
  function unpinForEquipmentLock(targetJobId, blockerIds) {
    const targets = new Set(blockerIds);
    const updated = jobs.map((j) => {
      if (!targets.has(j.id)) return j;
      const stamp = { updatedAt: new Date().toISOString() };
      if (Array.isArray(j.parts)) {
        return { ...j, ...stamp, parts: j.parts.map((p) => ({ ...p, assignment: p.assignment ? { ...p.assignment, pinned: false } : null })) };
      }
      return { ...j, ...stamp, assignment: j.assignment ? { ...j.assignment, pinned: false } : null };
    });
    const result = recompute(updated, equipment, staff);
    setEquipmentLockConflict(null);
    checkEquipmentLockConflict(result, targetJobId);
    showToast(`Unpinned ${blockerIds.length} job${blockerIds.length === 1 ? '' : 's'} so it can be rescheduled.`);
  }

  // Throws the correction history away. Worth having rather than letting it
  // silently accumulate forever: after a roster change, a new machine, or a
  // shift in what the department takes on, the old corrections describe a
  // department that no longer exists, and averaging them in would defend a
  // way of working nobody follows any more. Deliberately all-or-nothing —
  // letting individual records be deleted would invite curating the history
  // into agreeing with whatever you already believed.
  function clearOverrideHistory() {
    setOverrides([]);
    saveKey(OVERRIDES_KEY, []);
    setConfirmClearPatterns(false);
    showToast('Correction history cleared.');
  }

  // ---------- job actions ----------
  function addOrUpdateJob(jobData, isNew) {
    const stamped = { ...jobData, updatedAt: new Date().toISOString() };
    let newJobs;
    if (isNew) {
      newJobs = [...jobs, stamped];
    } else {
      newJobs = jobs.map((j) => (j.id === stamped.id ? stamped : j));
    }
    // Two different corrections can come out of this modal, and only for a job
    // that already existed — a brand-new job was never auto-placed, so there
    // is no automatic choice to have disagreed with.
    //   - a fresh PIN via the Equipment + Planned start date fields
    //   - a fresh LOCK via Locked equipment
    // Both say "not where you put it". They're recorded under separate
    // sources because they aren't equally strong evidence: a pin is about this
    // job on this day, a lock is a standing statement about where the work
    // belongs. Compared against the PREVIOUS stored job so merely opening and
    // saving the modal — which changes neither field — records nothing.
    if (!isNew) {
      const prev = jobs.find((j) => j.id === stamped.id);
      const a = stamped.assignment;
      const newlyPinned = a?.pinned && a.equipmentId
        && !(prev?.assignment?.pinned && prev.assignment.equipmentId === a.equipmentId
             && prev.assignment.startDate === a.startDate);
      if (newlyPinned) {
        recordOverride(stamped, { equipmentId: a.equipmentId, startDate: a.startDate }, 'modal-pin');
      } else if (stamped.lockedEquipmentId && stamped.lockedEquipmentId !== prev?.lockedEquipmentId) {
        // A lock names a machine but no day — the scheduler still picks that,
        // so there is no timing disagreement to record, only an equipment one.
        recordOverride(stamped, { equipmentId: stamped.lockedEquipmentId, startDate: prev?.assignment?.startDate || null }, 'lock');
      }
    }
    const result = recompute(newJobs, equipment, staff);
    checkParallelConflict(result, stamped.id);
    checkManualAssignConflict(result, stamped.id);
    checkEquipmentLockConflict(result, stamped.id);
    setEditingJob(null);
  }
  function importJobs(newJobs, consumedParkIds) {
    const now = new Date().toISOString();
    const stamped = newJobs.map((j) => ({ ...j, id: uid('job'), updatedAt: now, assignment: null }));
    recompute([...jobs, ...stamped], equipment, staff);
    // A parked row that has now been brought in stops being parked.
    if (consumedParkIds && consumedParkIds.size) {
      const rest = parked.filter((p) => !consumedParkIds.has(p.parkId));
      setParked(rest);
      saveKey(PARKED_KEY, rest);
    }
    setImportOpen(false);
    setParkedOpen(false);
    showToast(`Imported ${stamped.length} job${stamped.length === 1 ? '' : 's'} from WIP export.`);
  }

  // Called when an .xlsx import is committed: whatever that export offered and
  // we didn't take is kept for review. Job-shaped only — see PARKED_KEY.
  function parkUnmatched(list) {
    setParked(list);
    saveKey(PARKED_KEY, list);
  }
  function deleteJob(id) {
    recompute(jobs.filter((j) => j.id !== id), equipment, staff);
    setConfirmDelete(null);
    setEditingJob(null);
  }
  // Recompute a template's hours-per-unit as the average of actual-hours-per-unit
  // across its completed jobs recorded in wf_actuals.
  function reaverageTemplate(templateId, actualsArr) {
    if (!templateId) return;
    const rs = actualsArr.filter((r) => r.templateId === templateId && r.quantity > 0 && r.actualHours > 0);
    if (!rs.length) return;
    const avg = Math.round((rs.reduce((s, r) => s + r.actualHours / r.quantity, 0) / rs.length) * 100) / 100;
    setTemplates((ts) => {
      const next = ts.map((t) => (t.id === templateId ? { ...t, hoursPerUnit: avg } : t));
      saveKey('wf_templates', next);
      return next;
    });
  }
  function toggleComplete(job) {
    if (job.status !== 'complete') {
      // Marking complete → capture actual hours first (see ActualHoursModal).
      setPendingComplete(job);
      return;
    }
    // Un-completing → revert directly and drop its history record.
    const updated = { ...job, status: 'active', completedDate: null, updatedAt: new Date().toISOString() };
    recompute(jobs.map((j) => (j.id === job.id ? updated : j)), equipment, staff);
    (async () => {
      const arr = await loadKey('wf_actuals', []);
      const next = arr.filter((r) => r.jobId !== job.id);
      if (next.length !== arr.length) { await saveKey('wf_actuals', next); reaverageTemplate(job.templateId, next); }
    })();
  }
  function completeWithHours(hours) {
    const job = pendingComplete;
    if (!job) return;
    const cd = isoDate(new Date());
    const updated = { ...job, status: 'complete', completedDate: cd, percentComplete: 100, actualHours: hours, updatedAt: new Date().toISOString() };
    const jobsResult = recompute(jobs.map((j) => (j.id === job.id ? updated : j)), equipment, staff);
    setPendingComplete(null);
    (async () => {
      const arr = (await loadKey('wf_actuals', [])).filter((r) => r.jobId !== job.id);
      arr.push({ jobId: job.id, templateId: job.templateId || null, name: job.name, process: job.process, quantity: job.quantity || 1, estHours: job.hoursTotal, actualHours: hours, completedDate: cd });
      await saveKey('wf_actuals', arr);
      reaverageTemplate(job.templateId, arr);
    })();
    showToast(`${job.name} marked complete — ${hours}h recorded.`);
    // "Mark complete" inside JobModal has to close it first (#25/#28 —
    // ActualHoursModal is a separate dialog, and this file never nests two
    // fully independent top-level modals under one editingX state), which
    // used to just strand the user back at the Backlog with no modal open
    // at all — "Mark for rework" (only offered on a completed job) was
    // real and correct the moment they reopened it by hand, but nothing
    // told them to. Reopening on the freshly-completed job here — same
    // close-then-reopen-on-a-tick pattern `onOpenRelatedJob` already uses
    // to jump JobModal between related jobs — puts them right back where
    // they were, now showing the button, instead of requiring a manual
    // trip back through the Backlog. `jobsResult` (recompute's return
    // value), not `updated`, since the scheduler pass may have touched
    // this job's `assignment` on the way through (e.g. the completed-job
    // replay logic — see "Completing a job doesn't change the schedule…"
    // in scheduler/CLAUDE.md) and a stale `assignment` would be visible for
    // one render before the next state update caught up.
    if (reopenJobAfterComplete) {
      setReopenJobAfterComplete(false);
      const fresh = jobsResult.find((j) => j.id === job.id) || updated;
      setTimeout(() => setEditingJob(fresh), 0);
    }
  }
  // A rework is a genuinely NEW, linked job (see "Rework" in
  // scheduler/CLAUDE.md), not the original reopened. Its own record and
  // history — completedDate, actualHours, its wf_actuals entry — stay
  // exactly as they were; nothing here touches `original`. The new job
  // schedules, gets staffed, logs hours and completes exactly like any other
  // job, which is what lets everywhere else in the app (TimeLogModal,
  // ActualHoursModal, the Schedule view, ReportsView) handle it with no
  // special-casing at all — the only things that treat it differently are a
  // Backlog badge and the Quality tab's own filter on `isRework`.
  function createRework(original, { hoursTotal, readyDate, dueDate, reason }) {
    const rework = {
      id: uid('job'),
      name: `${original.name} — Rework`,
      process: original.process,
      quantity: 1,
      hoursTotal: Math.max(0, Math.round((Number(hoursTotal) || 0) * 100) / 100),
      // Blank unless the user actually set it (#59) — the rework being
      // created right now doesn't make the part any more physically ready
      // than a brand new job would be.
      readyDate: readyDate || '',
      dueDate,
      departmentDueDate: null,
      templateId: null,
      notes: reason || '',
      totalValue: 0,
      departmentValue: 0,
      percentComplete: 0,
      needsFurtherProcessing: false,
      parallelProcessing: false,
      status: 'active',
      completedDate: null,
      batchId: null,
      batchOrder: null,
      // Same kind of work as the original, so the same capability
      // requirements, procedure (for the cost calc below) and preferred
      // machine apply — but never a hard lock inherited from it; the
      // original's staffId/lockedEquipmentId were about ITS placement, not a
      // standing claim on a job that doesn't exist yet.
      tags: original.tags || [],
      procedureId: original.procedureId || '',
      staffId: null,
      secondStaffId: null,
      preferredEquipmentId: original.preferredEquipmentId || null,
      lockedEquipmentId: null,
      // Kept for traceability back to the same BC job even though this
      // department's record of it is a new, separate line.
      bcJobNo: original.bcJobNo || '',
      bcJobTaskNo: original.bcJobTaskNo || '',
      isRework: true,
      reworkOfJobId: original.id,
      updatedAt: new Date().toISOString(),
      assignment: null,
    };
    recompute([...jobs, rework], equipment, staff);
    setReworkOf(null);
    showToast(`${rework.name} created — schedule it like any other job.`);
  }
  // Safely switches JobModal from showing one job to another (used by the
  // "rework of" / "reworks of this job" links inside it). Naively calling
  // setEditingJob(target) while the modal is already open would NOT remount
  // it — React sees the same <JobModal> element either way, so every one of
  // its useState(job?.field) initialisers (which only ever run once, on
  // mount) would keep showing the PREVIOUS job's data under the new job's
  // id. Going through `null` first — in its own tick, not batched together
  // with the second update — actually unmounts it in between, so the second
  // update mounts a genuinely fresh instance.
  function openRelatedJob(jobId) {
    const target = jobs.find((j) => j.id === jobId);
    if (!target) return;
    setEditingJob(null);
    setTimeout(() => setEditingJob(target), 0);
  }
  function unpinJob(job) {
    const updated = { ...job, assignment: job.assignment ? { ...job.assignment, pinned: false } : null, updatedAt: new Date().toISOString() };
    recompute(jobs.map((j) => (j.id === job.id ? updated : j)), equipment, staff);
  }
  function unpinPart(job, partIndex) {
    const newParts = job.parts.map((p, i) => (i === partIndex ? { ...p, assignment: p.assignment ? { ...p.assignment, pinned: false } : null } : p));
    recompute(jobs.map((j) => (j.id === job.id ? { ...job, parts: newParts, updatedAt: new Date().toISOString() } : j)), equipment, staff);
  }
  // ============================================================
  // R&D PROJECTS AND TASKS
  // A project is tracking-only (name/description/status) — it is never
  // scheduled and never appears on the timeline itself. A task is what gets
  // scheduled: a non-job work item (maintenance, R&D, anything that isn't a
  // production job) that can optionally align to a project so its hours and
  // cost roll up there. See "R&D projects and tasks" in scheduler/CLAUDE.md.
  // ============================================================
  function addOrUpdateProject(data, isNew) {
    const stamped = { ...data, updatedAt: new Date().toISOString() };
    const next = isNew ? [...projects, stamped] : projects.map((p) => (p.id === stamped.id ? stamped : p));
    setProjects(next);
    saveKey(PROJECTS_KEY, next);
    setEditingProject(null);
  }
  function deleteProject(id) {
    const next = projects.filter((p) => p.id !== id);
    setProjects(next);
    saveKey(PROJECTS_KEY, next);
    // Tasks already logged against a deleted project keep their history —
    // same reasoning as a deleted template not erasing the jobs that used
    // it. `projectId` just stops resolving to anything in ProjectsView; the
    // task itself, its hours and its cost are untouched.
    setConfirmDelete(null);
    setEditingProject(null);
  }
  // A task is always created already pinned — Equipment and Planned start
  // date are both required fields (see TaskModal), there's no "automatic"
  // placement mode to fall back to the way an ordinary job has. Editing
  // either one rebuilds the pin exactly the way JobModal's own Equipment/
  // Planned start date fields do (#28) — `pinned: true, days: []`, letting
  // the recompute this triggers fill in the day-by-day plan.
  function addOrUpdateTask(data, isNew) {
    const stamped = { ...data, updatedAt: new Date().toISOString() };
    const nextTasks = isNew ? [...tasks, stamped] : tasks.map((t) => (t.id === stamped.id ? stamped : t));
    recompute(jobs, equipment, staff, nextTasks);
    const placed = lastTasksResultRef.current.find((t) => t.id === stamped.id);
    if (placed?.assignment?.conflict) {
      showToast(`${stamped.name} saved, but is over capacity on ${fmtDate(placed.assignment.startDate)} — see the Schedule view.`);
    } else {
      showToast(`${stamped.name} ${isNew ? 'created' : 'saved'}.`);
    }
    setEditingTask(null);
  }
  function deleteTask(id) {
    recompute(jobs, equipment, staff, tasks.filter((t) => t.id !== id));
    setConfirmDelete(null);
    setEditingTask(null);
    setBackfillTask(null);
  }
  function toggleTaskComplete(task) {
    if (task.status !== 'complete') {
      setPendingTaskComplete(task);
      return;
    }
    const updated = { ...task, status: 'active', completedDate: null, updatedAt: new Date().toISOString() };
    recompute(jobs, equipment, staff, tasks.map((t) => (t.id === task.id ? updated : t)));
  }
  function completeTaskWithHours(hours) {
    const task = pendingTaskComplete;
    if (!task) return;
    const updated = {
      ...task, status: 'complete', completedDate: isoDate(new Date()), actualHours: hours,
      updatedAt: new Date().toISOString(),
    };
    recompute(jobs, equipment, staff, tasks.map((t) => (t.id === task.id ? updated : t)));
    setPendingTaskComplete(null);
    showToast(`${task.name} marked complete — ${hours}h recorded.`);
  }
  // Same reasoning as unpinJob: this IS the manual-placement mechanism, not
  // a separate one — clearing the pin doesn't remove the task, just lets the
  // next recompute find it a new slot (or leave it in conflict if nothing
  // else fits, same as any unpinned-but-unplaceable job).
  function unpinTask(task) {
    const updated = { ...task, assignment: task.assignment ? { ...task.assignment, pinned: false } : null, updatedAt: new Date().toISOString() };
    recompute(jobs, equipment, staff, tasks.map((t) => (t.id === task.id ? updated : t)));
  }
  // Mirrors openRelatedJob — see its comment for why this can't just be
  // setEditingTask(target) while the modal's already open.
  function openTask(taskId) {
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return;
    setEditingTask(null);
    setTimeout(() => setEditingTask(target), 0);
  }
  // A backfilled task carries exactly one wf_timelog entry, by construction
  // (see BackfillTaskModal) — so unlike saveTimeLog (which replaces every
  // entry for one DATE, the whole-day-form semantics TimeLogModal needs),
  // this replaces every entry for one ITEM, regardless of what date it was
  // on before. That's what lets editing a logged entry's date/hours behave
  // like editing a single record instead of leaving the old date's entry
  // behind as an orphan.
  function replaceTaskLogEntry(taskId, date, hours, staffId) {
    const rest = timeLog.filter((e) => e.jobId !== taskId);
    const next = hours > 0 ? [...rest, { id: uid('tl'), jobId: taskId, date, hours, staffId: staffId || '', note: '' }] : rest;
    setTimeLog(next);
    saveKey(TIMELOG_KEY, next);
  }
  // "Log past work" (BackfillTaskModal) — see its own comment for why this
  // produces a task shaped differently from addOrUpdateTask's: already
  // complete, assignment: null, never touching the scheduler's placement
  // search at all (a complete task with no assignment is simply skipped by
  // every pass in runScheduler — see the "complete" replay note in
  // scheduler.js — so recompute here is just the normal save+persist path,
  // not a scheduling decision).
  function addOrUpdateBackfillTask(data, isNew, entry) {
    const stamped = {
      id: data.id || uid('task'),
      name: data.name, process: data.process, procedureId: data.procedureId || '',
      hoursTotal: entry.hours, readyDate: entry.date, dueDate: entry.date,
      projectId: data.projectId || null, staffId: data.staffId || null, notes: data.notes || '',
      status: 'complete', completedDate: entry.date, actualHours: entry.hours,
      isBackfilled: true,
      updatedAt: new Date().toISOString(),
      assignment: null,
    };
    const nextTasks = isNew ? [...tasks, stamped] : tasks.map((t) => (t.id === stamped.id ? stamped : t));
    recompute(jobs, equipment, staff, nextTasks);
    replaceTaskLogEntry(stamped.id, entry.date, entry.hours, entry.staffId);
    setBackfillTask(null);
    showToast(`${stamped.name} logged for ${fmtDate(entry.date)}.`);
  }

  // Resolves a dragged id back to either a whole job, or a specific part
  // within a split job — parts are draggable/droppable in their own right.
  function findDragTarget(dragId) {
    for (const j of jobs) {
      if (j.id === dragId) return { job: j, partIndex: null };
      if (Array.isArray(j.parts)) {
        const pi = j.parts.findIndex((p) => p.id === dragId);
        if (pi !== -1) return { job: j, partIndex: pi };
      }
    }
    return null;
  }
  function splitJob(job, hoursA) {
    const a = Math.max(0, Math.round(Number(hoursA) * 100) / 100);
    const b = Math.max(0, Math.round((job.hoursTotal - a) * 100) / 100);
    // Pre-filled so a freshly split job still reads sensibly everywhere it's
    // shown, but this is a real, independently editable field from here on —
    // not a label recomputed from the parent's name at render time (#18).
    const parts = [
      { id: uid('part'), name: `${job.name} (Part 1)`, hoursTotal: a, percentComplete: job.percentComplete || 0, status: 'active', assignment: null },
      { id: uid('part'), name: `${job.name} (Part 2)`, hoursTotal: b, percentComplete: 0, status: 'active', assignment: null },
    ];
    const updated = { ...job, parts, assignment: null, updatedAt: new Date().toISOString() };
    recompute(jobs.map((j) => (j.id === job.id ? updated : j)), equipment, staff);
    setEditingJob(null);
    showToast(`${job.name} split into two parts.`);
  }
  function mergeJobParts(job) {
    const totalHours = (job.parts || []).reduce((s, p) => s + (p.hoursTotal || 0), 0);
    const weightedPct = totalHours > 0
      ? Math.round((job.parts || []).reduce((s, p) => s + (p.percentComplete || 0) * (p.hoursTotal || 0), 0) / totalHours)
      : 0;
    const updated = {
      ...job,
      parts: null,
      hoursTotal: Math.round(totalHours * 100) / 100,
      percentComplete: weightedPct,
      status: 'active',
      completedDate: null,
      assignment: null,
      updatedAt: new Date().toISOString(),
    };
    recompute(jobs.map((j) => (j.id === job.id ? updated : j)), equipment, staff);
    setEditingJob(null);
    showToast(`${job.name}'s parts merged back into one job.`);
  }
  // A batch (#47) is jobs the user has said are the same scope and should run
  // back to back on one machine rather than wherever the scheduler happens to
  // find room first — see groupBatches/sliceBatchPlan in scheduler.js for how
  // that's actually enforced. Creating one just tags the jobs; the engine
  // does the rest on the next recompute.
  function createBatch(jobIds) {
    const batchId = uid('batch');
    const now = new Date().toISOString();
    const updated = jobs.map((j) => {
      const order = jobIds.indexOf(j.id);
      return order === -1 ? j : { ...j, batchId, batchOrder: order, updatedAt: now };
    });
    recompute(updated, equipment, staff);
    showToast(`Batched ${jobIds.length} jobs — they'll run back to back on the same equipment.`);
  }
  function leaveBatch(job) {
    const updated = jobs.map((j) => (j.id === job.id ? { ...j, batchId: null, batchOrder: null, updatedAt: new Date().toISOString() } : j));
    recompute(updated, equipment, staff);
    showToast(`${job.name} removed from its batch.`);
  }
  function handleDrop(equipId, date) {
    if (readOnly || !dragJobId) return;
    const target = findDragTarget(dragJobId);
    setDragJobId(null);
    setDropHint(null);
    if (!target) return;
    const { job, partIndex } = target;
    const eq = equipment.find((e) => e.id === equipId);
    if (!eq || !eq.processes.includes(job.process)) {
      showToast(`${eq ? eq.name : 'That equipment'} can't run ${job.process} — drop rejected.`);
      return;
    }
    const missingTags = (job.tags || []).filter((t) => !(eq.tags || []).includes(t));
    if (missingTags.length) {
      showToast(`${eq.name} doesn't have: ${missingTags.join(', ')} — drop rejected.`);
      return;
    }
    if (!job.readyDate) {
      showToast(`${job.name} has no ready-for-processing date set — set one on the job before scheduling it.`);
      return;
    }
    if (date < job.readyDate) {
      showToast(`${job.name} isn't received/ready until ${fmtDate(job.readyDate)} — can't schedule it earlier.`);
      return;
    }
    if ((eq.unavailableDates || []).includes(date)) {
      showToast(`${eq.name} is blocked on ${fmtDate(date)} — drop rejected.`);
      return;
    }
    // Dropping a job somewhere new discards its worked-out day plan, and with
    // it the record of who was on the job — which is why moving a job to
    // another machine used to hand it to a different person (and cascade a
    // reshuffle through everything else). Carry the person forward explicitly
    // so the next scheduler pass keeps them on it wherever they're still free.
    const prevAssignment = partIndex === null ? job.assignment : job.parts[partIndex].assignment;
    const newAssignment = {
      equipmentId: equipId, startDate: date, endDate: date, pinned: true, conflict: false,
      days: [], seedStaffId: primaryStaffOf(prevAssignment),
    };
    const updated = partIndex === null
      ? { ...job, updatedAt: new Date().toISOString(), assignment: newAssignment }
      : { ...job, updatedAt: new Date().toISOString(), parts: job.parts.map((p, i) => (i === partIndex ? { ...p, assignment: newAssignment } : p)) };
    // Before the recompute, not after: once this job is pinned it stops
    // generating candidates, so the run that knows what the scheduler would
    // have done on its own is the one already in lastTraceRef. Only whole-job
    // drops are recorded — a part's own placement is traced under the part's
    // id, not the job's, and pairing those up isn't worth guessing at here.
    if (partIndex === null) recordOverride(job, { equipmentId: equipId, startDate: date }, 'drag');
    const result = recompute(jobs.map((j) => (j.id === job.id ? updated : j)), equipment, staff);
    // Split-job parts aren't covered by the parallel-processing prompt yet —
    // each part's own conflict is one entry in a shared jobId's day-plan, and
    // findStaffConflictJobs isn't set up to point at "part 2 of job X"
    // specifically. Whole-job drops are the common case this solves.
    if (partIndex === null) checkParallelConflict(result, job.id);
  }

  // The task equivalent of handleDrop, much simpler for the same reason
  // TaskModal's own pin is simpler than JobModal's: no split parts, no
  // batches, no parallel-processing prompt (that's specifically about a job
  // sharing an operator with another JOB, and there's no equivalent review
  // panel for a task yet — see "R&D projects and tasks" in
  // scheduler/CLAUDE.md). A task drop rebuilds its pin exactly the way
  // dragging a job does — same validation (process match, ready date,
  // blocked day), same seedStaffId carry-forward so the person on it
  // doesn't change for no reason.
  function handleTaskDrop(equipId, date) {
    if (readOnly || !dragTaskId) return;
    const task = tasks.find((t) => t.id === dragTaskId);
    setDragTaskId(null);
    setDropHint(null);
    if (!task) return;
    const eq = equipment.find((e) => e.id === equipId);
    if (!eq || !eq.processes.includes(task.process)) {
      showToast(`${eq ? eq.name : 'That equipment'} can't run ${task.process} — drop rejected.`);
      return;
    }
    if (!task.readyDate) {
      showToast(`${task.name} has no ready-for-processing date set — set one on the task before scheduling it.`);
      return;
    }
    if (date < task.readyDate) {
      showToast(`${task.name} isn't ready for processing until ${fmtDate(task.readyDate)} — can't schedule it earlier.`);
      return;
    }
    if ((eq.unavailableDates || []).includes(date)) {
      showToast(`${eq.name} is blocked on ${fmtDate(date)} — drop rejected.`);
      return;
    }
    const updated = {
      ...task,
      updatedAt: new Date().toISOString(),
      assignment: {
        equipmentId: equipId, startDate: date, endDate: date, pinned: true, conflict: false,
        days: [], seedStaffId: primaryStaffOf(task.assignment),
      },
    };
    recompute(jobs, equipment, staff, tasks.map((t) => (t.id === task.id ? updated : t)));
  }

  // ---------- equipment / staff / template CRUD ----------
  function saveEquipment(item, isNew) {
    const list = isNew ? [...equipment, item] : equipment.map((e) => (e.id === item.id ? item : e));
    setEquipment(list);
    saveKey('wf_equipment', list);
    recompute(jobs, list, staff);
    setEditingEquipment(null);
  }
  // A day is "blocked" for a piece of equipment, not deleted from it — one
  // more entry in the same `unavailableDates` list `equipDayLock` already
  // reads in scheduler.js (closed days there return null from tryFit, so an
  // unpinned job just lands somewhere else instead of quietly refilling a
  // day the user emptied on purpose (#53) — dragging a job off previously
  // had nothing to stop the very next recompute handing the day to whichever
  // other job was next in line). A day already blocked toggles back open.
  function toggleEquipDay(equipId, date) {
    const eq = equipment.find((e) => e.id === equipId);
    if (!eq) return;
    const blocked = (eq.unavailableDates || []).includes(date);
    const unavailableDates = blocked
      ? eq.unavailableDates.filter((d) => d !== date)
      : [...(eq.unavailableDates || []), date];
    saveEquipment({ ...eq, unavailableDates }, false);
  }
  function deleteEquipment(id) {
    const list = equipment.filter((e) => e.id !== id);
    setEquipment(list);
    saveKey('wf_equipment', list);
    recompute(jobs, list, staff);
    setConfirmDelete(null);
  }
  function saveStaff(item, isNew) {
    const list = isNew ? [...staff, item] : staff.map((s) => (s.id === item.id ? item : s));
    setStaff(list);
    saveKey('wf_staff', list);
    recompute(jobs, equipment, list);
    setEditingStaff(null);
  }
  function deleteStaff(id) {
    const list = staff.filter((s) => s.id !== id);
    setStaff(list);
    saveKey('wf_staff', list);
    recompute(jobs, equipment, list);
    setConfirmDelete(null);
  }
  function saveTemplate(item, isNew) {
    const before = isNew ? null : templates.find((t) => t.id === item.id);
    const list = isNew ? [...templates, item] : templates.map((t) => (t.id === item.id ? item : t));
    setTemplates(list);
    saveKey('wf_templates', list);
    setEditingTemplate(null);

    // Capability requirements describe the work, so changing them on a template
    // has to reach the open jobs made from it — they were copied at the moment
    // the template was picked and then never looked at the template again.
    // A job whose requirements have since been edited by hand keeps them: this
    // app treats a manual decision as the more specific instruction (same as
    // pinning, or a hand-assigned person). The toast says how many of each, so
    // a customised job that *should* follow the template can be fixed
    // deliberately rather than being silently overwritten.
    const sameTags = (a, b) => {
      const x = [...(a || [])].sort(); const y = [...(b || [])].sort();
      return x.length === y.length && x.every((v, i) => v === y[i]);
    };
    if (before && !sameTags(before.tags, item.tags)) {
      let updated = 0, kept = 0;
      const nextJobs = jobs.map((j) => {
        if (j.templateId !== item.id || j.status === 'complete') return j;
        if (!sameTags(j.tags, before.tags)) { kept += 1; return j; }
        updated += 1;
        return { ...j, tags: [...(item.tags || [])], updatedAt: new Date().toISOString() };
      });
      if (updated) recompute(nextJobs, equipment, staff);
      if (updated || kept) {
        let msg = updated
          ? `Capability requirements updated on ${updated} open job${updated === 1 ? '' : 's'}.`
          : 'No open jobs took the new capability requirements.';
        if (kept) msg += ` ${kept} kept ${kept === 1 ? 'its' : 'their'} own edited requirements.`;
        showToast(msg);
      }
    }
  }

  // Replace every entry for one date with what the dialog was showing, so a
  // row cleared to blank removes its entry rather than leaving a stale one.
  function saveTimeLog(date, entries) {
    const rest = timeLog.filter((e) => e.date !== date);
    const kept = entries.filter((e) => Number(e.hours) > 0);
    const next = [...rest, ...kept];
    setTimeLog(next);
    saveKey(TIMELOG_KEY, next);
    setTimeLogDate(null);
    const total = Math.round(kept.reduce((s, e) => s + Number(e.hours), 0) * 100) / 100;
    showToast(kept.length
      ? `Logged ${total}h across ${kept.length} job${kept.length === 1 ? '' : 's'} for ${fmtDate(date)}.`
      : `Cleared the hours log for ${fmtDate(date)}.`);
  }

  function saveCategories(list) {
    // Same cascade as saveProcesses: a category removed here must not linger on
    // a template as a value the drop-down can no longer offer.
    const removed = categories.filter((c) => !list.includes(c));
    setCategories(list);
    saveKey('wf_categories', list);
    if (!removed.length) return;
    const hit = templates.filter((t) => removed.includes(t.category));
    if (hit.length) {
      const next = templates.map((t) => (removed.includes(t.category) ? { ...t, category: '' } : t));
      setTemplates(next);
      saveKey('wf_templates', next);
      showToast(`Removed ${removed.join(', ')} — ${hit.length} template${hit.length === 1 ? '' : 's'} moved to Uncategorised.`);
    }
  }
  function deleteTemplate(id) {
    const list = templates.filter((t) => t.id !== id);
    setTemplates(list);
    saveKey('wf_templates', list);
    setConfirmDelete(null);
  }
  function saveProcesses(list) {
    // Removing a process here used to leave it behind on every piece of
    // equipment and every staff member that had it: StaffView and the
    // Equipment section of CostingView still drew it as a capability chip,
    // but the editors only offer a checkbox per *current* process, so there
    // was no control left to untick it with. Cascade the removal so
    // resources can't keep a capability that no longer exists.
    const removed = processes.filter((p) => !list.includes(p));
    setProcesses(list);
    saveKey('wf_processes', list);
    if (!removed.length) return;

    const stale = (arr) => arr.some((p) => removed.includes(p));
    const strip = (arr) => arr.filter((p) => !removed.includes(p));

    const eqHit = equipment.filter((e) => stale(e.processes));
    if (eqHit.length) {
      const next = equipment.map((e) => (stale(e.processes) ? { ...e, processes: strip(e.processes) } : e));
      setEquipment(next);
      saveKey('wf_equipment', next);
    }
    const stHit = staff.filter((s) => stale(s.processes));
    if (stHit.length) {
      const next = staff.map((s) => (stale(s.processes) ? { ...s, processes: strip(s.processes) } : s));
      setStaff(next);
      saveKey('wf_staff', next);
    }

    // Templates and jobs deliberately keep their process string: it records
    // what the work actually is, and blanking it would silently unschedule
    // them. Say so instead, so the user can retarget them on purpose.
    const tplHit = templates.filter((t) => removed.includes(t.process)).length;
    const jobHit = jobs.filter((j) => removed.includes(j.process) && j.status !== 'complete').length;

    const cleared = [];
    if (eqHit.length) cleared.push(`${eqHit.length} equipment`);
    if (stHit.length) cleared.push(`${stHit.length} staff`);
    let msg = `Removed ${removed.join(', ')}`;
    msg += cleared.length ? ` from ${cleared.join(' and ')}.` : '.';
    if (tplHit || jobHit) {
      const orphaned = [];
      if (tplHit) orphaned.push(`${tplHit} template${tplHit > 1 ? 's' : ''}`);
      if (jobHit) orphaned.push(`${jobHit} open job${jobHit > 1 ? 's' : ''}`);
      msg += ` ${orphaned.join(' and ')} still use it and won't schedule until reassigned.`;
    }
    showToast(msg);
  }
  // Unlike deletion, a rename has a direct 1:1 replacement, so — unlike
  // saveProcesses, which deliberately leaves templates/jobs pointing at a
  // removed process rather than silently unscheduling them — it's safe (and
  // wanted) to cascade everywhere: equipment/staff capability lists,
  // templates, and every job's `process` string, then recompute so the
  // schedule reflects the new name immediately rather than on the next
  // unrelated action.
  function renameProcess(oldName, newName) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    if (processes.includes(trimmed)) { showToast(`"${trimmed}" is already a process name.`); return; }

    const swap = (arr) => arr.map((p) => (p === oldName ? trimmed : p));
    const list = swap(processes);
    setProcesses(list);
    saveKey('wf_processes', list);

    const nextEquip = equipment.map((e) => (e.processes.includes(oldName) ? { ...e, processes: swap(e.processes) } : e));
    const nextStaff = staff.map((s) => (s.processes.includes(oldName) ? { ...s, processes: swap(s.processes) } : s));
    setEquipment(nextEquip);
    saveKey('wf_equipment', nextEquip);
    setStaff(nextStaff);
    saveKey('wf_staff', nextStaff);

    const nextTemplates = templates.map((t) => (t.process === oldName ? { ...t, process: trimmed } : t));
    setTemplates(nextTemplates);
    saveKey('wf_templates', nextTemplates);

    const nextJobs = jobs.map((j) => (j.process === oldName ? { ...j, process: trimmed, updatedAt: new Date().toISOString() } : j));
    recompute(nextJobs, nextEquip, nextStaff);

    showToast(`Renamed "${oldName}" to "${trimmed}" everywhere it's used.`);
  }

  // ---------- costing: cost centres + procedures ----------
  function saveCostCentres(list) { setCostCentres(list); saveKey('wf_costcentres', list); }
  function saveProceduresList(list) { setProcedures(list); saveKey('wf_procedures', list); }
  function saveCostSettings(next) { setCostSettings(next); saveKey(COST_SETTINGS_KEY, next); }
  function saveCentre(cc) {
    const map = Object.fromEntries(costCentres.map((x) => [x.id, x]));
    map[cc.id] = cc;
    saveCostCentres(Object.values(map));
    setEditingCentre(null);
    setCostCentreSeed(null);
    showToast(`Saved cost centre ${cc.name}.`);
  }
  function deleteCentre(id) { saveCostCentres(costCentres.filter((x) => x.id !== id)); setEditingCentre(null); setCostCentreSeed(null); }
  function saveProcedure(p) {
    const map = Object.fromEntries(procedures.map((x) => [x.id, x]));
    map[p.id] = p;
    saveProceduresList(Object.values(map));
    setEditingProcedure(null);
    setProcedureSeed(null);
    showToast(`Saved procedure ${p.name}.`);
  }
  function deleteProcedure(id) { saveProceduresList(procedures.filter((x) => x.id !== id)); setEditingProcedure(null); setProcedureSeed(null); }
  function importCosting(data) {
    const parsed = parseCostingImport(data, processes);
    if (!parsed) { showToast("That file doesn't look like a cost-calculator export."); return; }
    const ccMap = Object.fromEntries(costCentres.map((x) => [x.id, x]));
    parsed.costCentres.forEach((c) => { ccMap[c.id] = c; });
    const pMap = Object.fromEntries(procedures.map((x) => [x.id, x]));
    parsed.procedures.forEach((p) => { pMap[p.id] = p; });
    saveCostCentres(Object.values(ccMap));
    saveProceduresList(Object.values(pMap));
    showToast(`Imported ${parsed.procedures.length} procedure(s) and ${parsed.costCentres.length} cost centre(s).`);
  }

  const staffById = useMemo(() => Object.fromEntries(staff.map((s) => [s.id, s])), [staff]);
  const equipById = useMemo(() => Object.fromEntries(equipment.map((e) => [e.id, e])), [equipment]);
  const allTags = useMemo(() => [...new Set([...equipment.flatMap((e) => e.tags || []), ...templates.flatMap((t) => t.tags || [])])].sort(), [equipment, templates]);

  // Flattened to part level (not just job level) so a split job's specific
  // unscheduled/conflicted/preference-missed part can be dragged onto the
  // schedule on its own.
  const unscheduledJobs = [];
  const conflictJobs = [];
  // Preferred equipment (job.preferredEquipmentId) is a soft nudge, not a
  // pin — the scheduler falls back to the best available alternative rather
  // than refusing to place the job. `preferredEquipmentUnmet` is how that
  // fallback gets surfaced instead of silently swallowed: same idea as
  // `conflictJobs`, just for a missed preference rather than an overbooking.
  const preferredEquipJobs = [];
  // A second person (job.secondStaffId — a training partner riding along on
  // the primary, see scheduler.js's attachSecondStaff) who couldn't actually
  // be paired onto the days the job landed on. Same treatment as a missed
  // preference above: the job itself is scheduled fine, this is a "you
  // wanted a trainee here too, but they weren't free" signal, not an
  // overbooking, so it gets its own panel rather than joining conflictJobs.
  const secondStaffUnmetJobs = [];
  jobs.forEach((j) => {
    if (j.status === 'complete') return;
    if (Array.isArray(j.parts)) {
      j.parts.forEach((p, i) => {
        if (p.status === 'complete') return;
        const unit = {
          id: p.id,
          // p.name is real from #18 on; the computed label only covers parts
          // saved before that field existed.
          name: p.name || (j.parts.length > 1 ? `${j.name} (Part ${i + 1})` : j.name),
          process: j.process,
          hoursTotal: p.hoursTotal,
          readyDate: j.readyDate,
          dueDate: j.dueDate,
          departmentDueDate: j.departmentDueDate,
          preferredEquipmentId: j.preferredEquipmentId,
          // Own field, not the parent's (#68's same reasoning) — a training
          // pairing is per part now, same as staffId/lockedEquipmentId.
          secondStaffId: p.secondStaffId,
          assignment: p.assignment,
          unschedReason: p.unschedReason,
          _parentJob: j,
        };
        if (!p.assignment) unscheduledJobs.push(unit);
        if (p.assignment && p.assignment.conflict) conflictJobs.push(unit);
        if (p.assignment && p.assignment.preferredEquipmentUnmet) preferredEquipJobs.push(unit);
        if (p.assignment && p.assignment.secondStaffUnmet) secondStaffUnmetJobs.push(unit);
      });
    } else {
      if (!j.assignment) unscheduledJobs.push(j);
      if (j.assignment && j.assignment.conflict) conflictJobs.push(j);
      if (j.assignment && j.assignment.preferredEquipmentUnmet) preferredEquipJobs.push(j);
      if (j.assignment && j.assignment.secondStaffUnmet) secondStaffUnmetJobs.push(j);
    }
  });
  // Same signal as secondStaffUnmetJobs, for tasks — no parts/batches to
  // flatten through, so this is the whole thing.
  const secondStaffUnmetTasks = tasks.filter((t) => t.status !== 'complete' && t.assignment && t.assignment.secondStaffUnmet);

  if (!loaded) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400">
        <Loader2 className="animate-spin mr-2" size={20} /> Loading schedule…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] bg-slate-800 border border-amber-600 text-amber-200 text-sm px-4 py-2.5 rounded-lg shadow-xl max-w-md text-center">
          {toast}
        </div>
      )}
      {/* Header */}
      <header className="bg-slate-950/95 sticky top-0 z-30 backdrop-blur" style={{ borderBottom: '2px solid #253646' }}>
        <div className="px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded bg-amber-500 flex items-center justify-center text-slate-950 font-bold text-sm">W</div>
            <div>
              <h1 className="font-bold text-slate-100 text-lg leading-tight tracking-tight">WELDCELL SCHEDULER</h1>
              <p className="text-[10px] text-slate-500 leading-tight uppercase" style={{ letterSpacing: '0.13em' }}>Production planning · shared &amp; synced</p>
            </div>
          </div>
          {!displayMode && (
            <nav className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1">
              {[
                { id: 'schedule', label: 'Schedule', icon: LayoutGrid },
                { id: 'backlog', label: 'Job Backlog', icon: ClipboardList },
                { id: 'staff', label: 'Staff', icon: Clock },
                { id: 'templates', label: 'Templates', icon: Calendar },
                { id: 'costing', label: 'Costing', icon: DollarSign },
                { id: 'reports', label: 'Value Reports', icon: DollarSign },
                { id: 'quality', label: 'Quality', icon: Wrench },
                { id: 'rd', label: 'R&D', icon: FlaskConical },
                { id: 'patterns', label: 'Patterns', icon: Target },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    tab === t.id ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <t.icon size={14} /> {t.label}
                </button>
              ))}
            </nav>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setReadOnly((r) => !r)}
              className={`${btnGhost} ${readOnly ? 'border-amber-500 text-amber-300' : ''}`}
              title="Toggle whether this screen can edit the schedule"
            >
              {readOnly ? <Pin size={14} /> : <PinOff size={14} />} {readOnly ? 'View only' : 'Editing'}
            </button>
            {!readOnly && !displayMode && (
              <button
                onClick={() => setTimeLogDate(isoDate(new Date()))}
                className={btnGhost}
                title="Record the hours actually worked on each job today"
              >
                <Clock size={14} /> Log hours
              </button>
            )}
            <button
              onClick={() => setDisplayMode((d) => !d)}
              className={`${btnGhost} ${displayMode ? 'border-amber-500 text-amber-300' : ''}`}
              title="Simplified full-screen view for a workshop monitor"
            >
              <Monitor size={14} /> {displayMode ? 'Exit display' : 'Display mode'}
            </button>
          </div>
        </div>
      </header>

      <main className={`p-4 sm:p-6 mx-auto ${tab === 'schedule' || displayMode ? 'max-w-none' : 'max-w-[1600px]'}`}>
        {(tab === 'schedule' || displayMode) && (
          <ScheduleView
            equipment={equipment}
            staff={staff}
            jobs={jobs}
            tasks={tasks}
            onEditTask={(t) => !readOnly && setEditingTask(t)}
            onAddTask={() => setEditingTask('new')}
            dragTaskId={dragTaskId}
            setDragTaskId={setDragTaskId}
            onDropTask={handleTaskDrop}
            visibleDays={visibleDays}
            rangeStart={rangeStart}
            setRangeStart={setRangeStart}
            rangeLength={rangeLength}
            setRangeLength={setRangeLength}
            totalDays={workingDays.length}
            todayIdx={todayIdx}
            readOnly={readOnly}
            displayMode={displayMode}
            dragJobId={dragJobId}
            setDragJobId={setDragJobId}
            dropHint={dropHint}
            setDropHint={setDropHint}
            onDrop={handleDrop}
            onEditJob={(j) => !readOnly && setEditingJob(j)}
            unscheduledJobs={unscheduledJobs}
            conflictJobs={conflictJobs}
            preferredEquipJobs={preferredEquipJobs}
            secondStaffUnmetJobs={secondStaffUnmetJobs}
            secondStaffUnmetTasks={secondStaffUnmetTasks}
            onAddJob={() => setEditingJob('new')}
            zoom={zoom}
            setZoom={setZoom}
            onToggleEquipDay={toggleEquipDay}
          />
        )}

        {tab === 'backlog' && !displayMode && (
          <BacklogView
            jobs={jobs}
            equipment={equipment}
            staff={staff}
            timeLog={timeLog}
            readOnly={readOnly}
            onAdd={() => setEditingJob('new')}
            onImport={() => setImportOpen(true)}
            onOpenParked={() => setParkedOpen(true)}
            parkedCount={parked.length}
            onEdit={(j) => setEditingJob(j)}
            onToggleComplete={toggleComplete}
            onUnpin={unpinJob}
            onDelete={(j) => setConfirmDelete({ type: 'job', id: j.id, name: j.name })}
            onCreateBatch={createBatch}
            onLeaveBatch={leaveBatch}
          />
        )}

        {tab === 'staff' && !displayMode && (
          <StaffView
            staff={staff}
            readOnly={readOnly}
            onUpdateStaff={(item) => saveStaff(item, false)}
            onAddStaff={() => setEditingStaff('new')}
            onEditStaff={(s) => setEditingStaff(s)}
            onDeleteStaff={(s) => setConfirmDelete({ type: 'staff', id: s.id, name: s.name })}
          />
        )}

        {tab === 'templates' && !displayMode && (
          <TemplatesView
            templates={templates}
            equipment={equipment}
            processes={processes}
            categories={categories}
            readOnly={readOnly}
            onAdd={() => setEditingTemplate('new')}
            onEdit={(t) => setEditingTemplate(t)}
            onDelete={(t) => setConfirmDelete({ type: 'template', id: t.id, name: t.name })}
            onSaveProcesses={saveProcesses}
            onRenameProcess={renameProcess}
            onSaveCategories={saveCategories}
          />
        )}

        {tab === 'costing' && !displayMode && (
          <CostingView
            procedures={procedures}
            costCentres={costCentres}
            costSettings={costSettings}
            onSaveCostSettings={saveCostSettings}
            processes={processes}
            readOnly={readOnly}
            onImport={importCosting}
            onNewProcedure={() => setProcedureChoiceOpen(true)}
            onEditProcedure={(p) => { setProcedureSeed(null); setEditingProcedure(p); }}
            onNewCentre={() => setCostCentreChoiceOpen(true)}
            onEditCentre={(c) => { setCostCentreSeed(null); setEditingCentre(c); }}
            equipment={equipment}
            onAddEquip={() => setEditingEquipment('new')}
            onEditEquip={(e) => setEditingEquipment(e)}
            onDeleteEquip={(e) => setConfirmDelete({ type: 'equipment', id: e.id, name: e.name })}
          />
        )}

        {tab === 'reports' && !displayMode && (
          <ReportsView jobs={jobs} equipment={equipment} staff={staff} procedures={procedures} costCentres={costCentres} costSettings={costSettings} />
        )}
        {tab === 'quality' && !displayMode && (
          <QualityView
            jobs={jobs}
            procedures={procedures}
            costCentres={costCentres}
            costSettings={costSettings}
            timeLog={timeLog}
            onEditJob={(j) => !readOnly && setEditingJob(j)}
          />
        )}
        {tab === 'rd' && !displayMode && (
          <ProjectsView
            projects={projects}
            tasks={tasks}
            timeLog={timeLog}
            procedures={procedures}
            costCentres={costCentres}
            costSettings={costSettings}
            staff={staff}
            readOnly={readOnly}
            onAddProject={() => setEditingProject('new')}
            onEditProject={(p) => !readOnly && setEditingProject(p)}
            onAddTask={() => setEditingTask('new')}
            // A backfilled entry (see BackfillTaskModal) opens back into that
            // same, simpler modal, not the normal TaskModal — which would
            // show empty, required Equipment/Planned start date fields for
            // something that was never scheduled and block Save until they
            // were filled in.
            onEditTask={(t) => !readOnly && (t.isBackfilled ? setBackfillTask(t) : setEditingTask(t))}
            onAddBackfillTask={() => setBackfillTask('new')}
          />
        )}
        {tab === 'patterns' && !displayMode && (
          <PatternsView
            overrides={overrides}
            equipment={equipment}
            templates={templates}
            procedures={procedures}
            readOnly={readOnly}
            onOpenTemplate={(id) => {
              const t = templates.find((x) => x.id === id);
              if (t) setEditingTemplate(t);
            }}
            onClearHistory={() => setConfirmClearPatterns(true)}
          />
        )}
      </main>

      {/* ---------- Modals ---------- */}
      {editingJob && (
        <JobModal
          job={editingJob === 'new' ? null : editingJob}
          templates={templates}
          processes={processes}
          staff={staff}
          equipment={equipment}
          procedures={procedures}
          costCentres={costCentres}
          costSettings={costSettings}
          jobs={jobs}
          timeLog={timeLog}
          onClose={() => setEditingJob(null)}
          onSave={(data) => addOrUpdateJob(data, editingJob === 'new')}
          onDelete={editingJob !== 'new' ? () => setConfirmDelete({ type: 'job', id: editingJob.id, name: editingJob.name }) : null}
          onToggleComplete={editingJob !== 'new' ? () => {
            // Only arm the reopen-after-complete flag on the way TO
            // complete — un-completing (editingJob.status === 'complete')
            // reverts synchronously inside toggleComplete itself and never
            // touches pendingComplete/completeWithHours, so nothing would
            // ever consume the flag and it would leak into some later,
            // unrelated completion.
            if (editingJob.status !== 'complete') setReopenJobAfterComplete(true);
            toggleComplete(editingJob);
            setEditingJob(null);
          } : null}
          onUnpin={editingJob !== 'new' && editingJob.assignment?.pinned ? () => { unpinJob(editingJob); setEditingJob(null); } : null}
          onSplit={editingJob !== 'new' && !editingJob.parts ? (hoursA) => splitJob(editingJob, hoursA) : null}
          onMerge={editingJob !== 'new' && editingJob.parts ? () => mergeJobParts(editingJob) : null}
          onUnpinPart={editingJob !== 'new' && editingJob.parts ? (partIndex) => { unpinPart(editingJob, partIndex); setEditingJob(null); } : null}
          onMarkForRework={editingJob !== 'new' && editingJob.status === 'complete' && !editingJob.parts
            ? () => { setReworkOf(editingJob); setEditingJob(null); } : null}
          onOpenRelatedJob={editingJob !== 'new' ? openRelatedJob : null}
        />
      )}

      {reworkOf && (
        <ReworkModal
          job={reworkOf}
          onCancel={() => setReworkOf(null)}
          onConfirm={(data) => createRework(reworkOf, data)}
        />
      )}

      {editingTask && (
        <TaskModal
          task={editingTask === 'new' ? null : editingTask}
          processes={processes}
          staff={staff}
          equipment={equipment}
          procedures={procedures}
          projects={projects}
          onClose={() => setEditingTask(null)}
          onSave={(data, isNew) => addOrUpdateTask(data, isNew)}
          onDelete={editingTask !== 'new' ? () => setConfirmDelete({ type: 'task', id: editingTask.id, name: editingTask.name }) : null}
          onToggleComplete={editingTask !== 'new' ? () => { toggleTaskComplete(editingTask); setEditingTask(null); } : null}
        />
      )}

      {backfillTask && (
        <BackfillTaskModal
          task={backfillTask === 'new' ? null : backfillTask}
          processes={processes}
          staff={staff}
          procedures={procedures}
          projects={projects}
          onClose={() => setBackfillTask(null)}
          onSave={(data, isNew, entry) => addOrUpdateBackfillTask(data, isNew, entry)}
          onDelete={backfillTask !== 'new' ? () => setConfirmDelete({ type: 'task', id: backfillTask.id, name: backfillTask.name }) : null}
        />
      )}

      {editingProject && (
        <ProjectModal
          project={editingProject === 'new' ? null : editingProject}
          onClose={() => setEditingProject(null)}
          onSave={(data, isNew) => addOrUpdateProject(data, isNew)}
          onDelete={editingProject !== 'new' ? () => setConfirmDelete({ type: 'project', id: editingProject.id, name: editingProject.name }) : null}
        />
      )}

      {importOpen && (
        <ImportJobsModal
          templates={templates}
          processes={processes}
          existingJobs={jobs}
          onClose={() => setImportOpen(false)}
          onImport={importJobs}
          onParkUnmatched={parkUnmatched}
        />
      )}

      {timeLogDate && (
        <TimeLogModal
          date={timeLogDate}
          // Tasks are ordinary rows in the same daily log as jobs (same
          // wf_timelog, keyed generically by "the schedulable item's id") —
          // merged here, at the point TimeLogModal is actually opened, so
          // the modal itself needs no changes at all to log hours against
          // either kind. See "R&D projects and tasks" in scheduler/CLAUDE.md.
          jobs={[...jobs, ...tasks]}
          staff={staff}
          entries={timeLog}
          onClose={() => setTimeLogDate(null)}
          onSave={saveTimeLog}
        />
      )}

      {parkedOpen && (
        <ImportJobsModal
          templates={templates}
          processes={processes}
          existingJobs={jobs}
          onClose={() => setParkedOpen(false)}
          onImport={importJobs}
          initialRows={parked}
        />
      )}

      {editingTemplate && (
        <TemplateModal
          template={editingTemplate === 'new' ? null : editingTemplate}
          equipment={equipment}
          processes={processes}
          procedures={procedures}
          costCentres={costCentres}
          allTags={allTags}
          categorySuggestions={categories}
          onClose={() => setEditingTemplate(null)}
          onSave={(data) => saveTemplate(data, editingTemplate === 'new')}
        />
      )}

      {editingEquipment && (
        <EquipmentModal
          item={editingEquipment === 'new' ? null : editingEquipment}
          processes={processes}
          allTags={allTags}
          onClose={() => setEditingEquipment(null)}
          onSave={(data) => saveEquipment(data, editingEquipment === 'new')}
        />
      )}

      {editingStaff && (
        <StaffModal
          item={editingStaff === 'new' ? null : editingStaff}
          processes={processes}
          onClose={() => setEditingStaff(null)}
          onSave={(data) => saveStaff(data, editingStaff === 'new')}
        />
      )}

      {procedureChoiceOpen && (
        <CreateChoiceModal
          title="New procedure"
          onClose={() => setProcedureChoiceOpen(false)}
          onCreateBlank={() => { setProcedureChoiceOpen(false); setProcedureSeed(null); setEditingProcedure('new'); }}
        >
          <ProcedureCopyPicker
            procedures={procedures}
            costCentres={costCentres}
            onPick={(p) => { setProcedureChoiceOpen(false); setProcedureSeed(p); setEditingProcedure('new'); }}
          />
        </CreateChoiceModal>
      )}

      {costCentreChoiceOpen && (
        <CreateChoiceModal
          title="New cost centre"
          onClose={() => setCostCentreChoiceOpen(false)}
          onCreateBlank={() => { setCostCentreChoiceOpen(false); setCostCentreSeed(null); setEditingCentre('new'); }}
        >
          <CostCentreCopyPicker
            costCentres={costCentres}
            onPick={(c) => { setCostCentreChoiceOpen(false); setCostCentreSeed(c); setEditingCentre('new'); }}
          />
        </CreateChoiceModal>
      )}

      {editingProcedure && (
        <ProcedureEditor
          procedure={editingProcedure === 'new' ? null : editingProcedure}
          seedFrom={editingProcedure === 'new' ? procedureSeed : null}
          processes={processes}
          costCentres={costCentres}
          onClose={() => { setEditingProcedure(null); setProcedureSeed(null); }}
          onSave={saveProcedure}
          onDelete={deleteProcedure}
        />
      )}

      {editingCentre && (
        <CostCentreEditor
          centre={editingCentre === 'new' ? null : editingCentre}
          seedFrom={editingCentre === 'new' ? costCentreSeed : null}
          onClose={() => { setEditingCentre(null); setCostCentreSeed(null); }}
          onSave={saveCentre}
          onDelete={deleteCentre}
        />
      )}

      {pendingComplete && (
        <ActualHoursModal
          logged={loggedHours(timeLog, pendingComplete.id)}
          job={pendingComplete}
          onCancel={() => {
            // Cancelling out of "how many hours" is "never mind, I wasn't
            // ready to complete this" — not "take me out of the job
            // entirely." Same reopen as completing (below), just with the
            // job unchanged, so backing out of this dialog doesn't also
            // strand the user back at the Backlog mid-edit.
            const job = pendingComplete;
            setPendingComplete(null);
            if (reopenJobAfterComplete) {
              setReopenJobAfterComplete(false);
              setTimeout(() => setEditingJob(job), 0);
            }
          }}
          onConfirm={completeWithHours}
        />
      )}

      {pendingTaskComplete && (
        <ActualHoursModal
          kind="task"
          logged={loggedHours(timeLog, pendingTaskComplete.id)}
          job={pendingTaskComplete}
          onCancel={() => setPendingTaskComplete(null)}
          onConfirm={completeTaskWithHours}
        />
      )}

      {confirmDelete && (
        <Modal title="Confirm delete" onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-slate-300 mb-4">
            Delete <span className="font-semibold text-slate-100">{confirmDelete.name}</span>? This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button
              className={btnDanger}
              onClick={() => {
                if (confirmDelete.type === 'job') deleteJob(confirmDelete.id);
                if (confirmDelete.type === 'template') deleteTemplate(confirmDelete.id);
                if (confirmDelete.type === 'equipment') deleteEquipment(confirmDelete.id);
                if (confirmDelete.type === 'staff') deleteStaff(confirmDelete.id);
                if (confirmDelete.type === 'task') deleteTask(confirmDelete.id);
                if (confirmDelete.type === 'project') deleteProject(confirmDelete.id);
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </Modal>
      )}

      {confirmClearPatterns && (
        <Modal title="Clear correction history" onClose={() => setConfirmClearPatterns(false)}>
          <p className="text-sm text-slate-300 mb-3">
            Discard all {overrides.length} recorded correction{overrides.length === 1 ? '' : 's'}? The patterns on
            this page are derived entirely from them, so they'll go too. This can't be undone.
          </p>
          <p className="text-xs text-slate-500 mb-4">
            Worth doing after something changes what "normal" means here — a new machine, a roster change, a
            different mix of work — since corrections from before that describe a department that no longer
            exists. Your schedule and jobs are not affected.
          </p>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setConfirmClearPatterns(false)}>Cancel</button>
            <button className={btnDanger} onClick={clearOverrideHistory}>
              <Trash2 size={14} /> Clear history
            </button>
          </div>
        </Modal>
      )}

      {parallelConflict && (
        <Modal title="Overbooked — same operator needed at once" onClose={() => setParallelConflict(null)}>
          <p className="text-sm text-slate-300 mb-3">
            <span className="font-semibold text-slate-100">{parallelConflict.job.name}</span> needs{' '}
            {parallelConflict.staffNames.length ? parallelConflict.staffNames.join(', ') : 'the same operator'} at
            the same time as {parallelConflict.candidates.map((c) => c.name).join(', ')}. By default the scheduler
            won't double-book a person — but if one of these is automated enough that an operator can mind it
            alongside the other, you can allow parallel processing.
          </p>
          <div className="space-y-1.5 mb-4">
            <button
              type="button"
              className="w-full text-left text-sm bg-slate-800 hover:bg-slate-700 rounded-md px-3 py-2 text-slate-200"
              onClick={() => allowParallelProcessing(parallelConflict.job.id)}
            >
              Allow parallel processing on <span className="font-semibold">{parallelConflict.job.name}</span>
            </button>
            {parallelConflict.candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                className="w-full text-left text-sm bg-slate-800 hover:bg-slate-700 rounded-md px-3 py-2 text-slate-200"
                onClick={() => allowParallelProcessing(c.id)}
              >
                Allow parallel processing on <span className="font-semibold">{c.name}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mb-3">
            The tag stays on whichever job you pick — it'll be free to share an operator with anything else it's
            scheduled alongside from now on, not just this pairing.
          </p>
          <div className="flex justify-end">
            <button className={btnGhost} onClick={() => setParallelConflict(null)}>Leave overbooked</button>
          </div>
        </Modal>
      )}

      {manualAssignConflict && (
        <Modal title="Person already committed elsewhere" onClose={() => setManualAssignConflict(null)}>
          <p className="text-sm text-slate-300 mb-3">
            <span className="font-semibold text-slate-100">{manualAssignConflict.job.name}</span> is manually
            assigned to <span className="font-semibold text-slate-100">{manualAssignConflict.person.name}</span>,
            but they're already pinned to{' '}
            {manualAssignConflict.blockers.length === 1 ? 'this job' : `these ${manualAssignConflict.blockers.length} jobs`}
            {' '}for the days it needs. Unpinning frees it to be rescheduled — onto other equipment, another day, or
            another operator — while this job takes the priority you gave it.
          </p>
          <div className="space-y-1.5 mb-4">
            {manualAssignConflict.blockers.map((b) => (
              <button
                key={b.id}
                type="button"
                className="w-full text-left text-sm bg-slate-800 hover:bg-slate-700 rounded-md px-3 py-2 text-slate-200"
                onClick={() => unpinForManualAssign(manualAssignConflict.job.id, [b.id])}
              >
                Unpin <span className="font-semibold">{b.name}</span> so it can move elsewhere
              </button>
            ))}
            {manualAssignConflict.blockers.length > 1 && (
              <button
                type="button"
                className="w-full text-left text-sm bg-slate-800 hover:bg-slate-700 rounded-md px-3 py-2 text-slate-200"
                onClick={() => unpinForManualAssign(manualAssignConflict.job.id, manualAssignConflict.blockers.map((b) => b.id))}
              >
                Unpin all {manualAssignConflict.blockers.length} so {manualAssignConflict.person.name} is free
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500 mb-3">
            {manualAssignConflict.person.name} isn't guaranteed to end up on the unpinned job again — if nobody
            else is free it may stay with them anyway. Check where things land afterwards.
          </p>
          <div className="flex justify-end">
            <button className={btnGhost} onClick={() => setManualAssignConflict(null)}>Leave unscheduled</button>
          </div>
        </Modal>
      )}

      {equipmentLockConflict && (
        <Modal title="Machine already committed elsewhere" onClose={() => setEquipmentLockConflict(null)}>
          <p className="text-sm text-slate-300 mb-3">
            <span className="font-semibold text-slate-100">{equipmentLockConflict.job.name}</span> is locked
            to <span className="font-semibold text-slate-100">{equipmentLockConflict.machine.name}</span>,
            but it's already pinned to{' '}
            {equipmentLockConflict.blockers.length === 1 ? 'this job' : `these ${equipmentLockConflict.blockers.length} jobs`}
            {' '}for the days it needs. Unpinning frees the machine to be rescheduled — onto another day or a
            different operator — while this job takes the priority you gave it.
          </p>
          <div className="space-y-1.5 mb-4">
            {equipmentLockConflict.blockers.map((b) => (
              <button
                key={b.id}
                type="button"
                className="w-full text-left text-sm bg-slate-800 hover:bg-slate-700 rounded-md px-3 py-2 text-slate-200"
                onClick={() => unpinForEquipmentLock(equipmentLockConflict.job.id, [b.id])}
              >
                Unpin <span className="font-semibold">{b.name}</span> so it can move elsewhere
              </button>
            ))}
            {equipmentLockConflict.blockers.length > 1 && (
              <button
                type="button"
                className="w-full text-left text-sm bg-slate-800 hover:bg-slate-700 rounded-md px-3 py-2 text-slate-200"
                onClick={() => unpinForEquipmentLock(equipmentLockConflict.job.id, equipmentLockConflict.blockers.map((b) => b.id))}
              >
                Unpin all {equipmentLockConflict.blockers.length} so {equipmentLockConflict.machine.name} is free
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500 mb-3">
            {equipmentLockConflict.machine.name} isn't guaranteed to end up free for this job again — if something
            else needs it just as urgently it may get pinned there anyway. Check where things land afterwards.
          </p>
          <div className="flex justify-end">
            <button className={btnGhost} onClick={() => setEquipmentLockConflict(null)}>Leave unscheduled</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ============================================================
   SCHEDULE (GANTT) VIEW
   ============================================================ */

// Greedy interval partitioning: gives each job on the same equipment a lane
// number such that no two jobs sharing a lane have overlapping date ranges.
// Equipment can legitimately run two different jobs on the same calendar day
// (e.g. different staff on day vs. afternoon shift), so a single equipment
// row can't assume only one job is ever "on" at a time.
// Lays out one equipment row's job blocks in a single lane. A day column
// represents one shift's worth of hours (8h) by default; if a day genuinely
// has both shifts in play, it splits into two halves. Within a shift's
// portion, multiple jobs (e.g. a job finishing after 5h and the next job
// taking the remaining 3h) sit side by side, each sized to its actual share
// of the hours — never stacked into a separate lane. Gap days inside a job's
// own span (no hours logged, e.g. an unstaffed weekday) still render as a
// full-width continuation of that job so its bar doesn't show a hole.
// Calmer, on-brand categorical palette for staff-coloured timeline bars.
const STAFF_PALETTE = ['#3E6B8B', '#2F8F86', '#C4634A', '#7E6BA8', '#C98A3E', '#5B8C5A', '#4E7CA1', '#B5677F', '#6A7F8C', '#8A9A3F'];
const UNASSIGNED_COLOR = '#475569';
const COMPLETE_GREY = '#64748b';
// A job due (effectiveDueDate — department due date if set, else the client
// one) within the current calendar month gets its name card and timeline bar
// picked out in this colour, so it reads apart from other work merely
// scheduled during the same window that isn't actually due yet. Deliberately
// its own hue, not a reused one: amber/coral is already the app's general-
// purpose accent (pins, warnings, markers), red means conflict, and sky/
// orange are already claimed for equipment-type colouring (and sky doubles
// as the parallel-processing icon on this same tile) — reusing any of them
// here would blur into an existing meaning instead of adding a new one.
// Applied via inline style/class, same as the conflict/pinned colours below,
// so it renders identically regardless of index.css's light-theme remap.
const DUE_THIS_MONTH_COLOR = '#8B5CF6';

// Positioned colour segments for one job's bar across the visible window. Each
// day's entries are laid out proportionally; a gap day inside the job's own
// span becomes a full-width continuation; adjacent same-staff segments merge;
// and the completed leading portion (by percentComplete, or all of it when the
// job is complete) is greyed.
function buildJobSegments(job, visibleDays, colWidth, staffColor) {
  const days = job.assignment.days || [];
  const start = job.assignment.startDate;
  const end = job.assignment.endDate;
  const segs = [];
  visibleDays.forEach((date, di) => {
    const entries = days
      .filter((e) => e.date === date)
      .sort((a, b) => (a.shift === 'afternoon' ? 1 : 0) - (b.shift === 'afternoon' ? 1 : 0));
    const x0 = di * colWidth;
    if (entries.length === 0) {
      if (start <= date && date <= end) segs.push({ left: x0, width: colWidth, staffId: null });
      return;
    }
    const segW = colWidth / entries.length;
    entries.forEach((e, ei) => segs.push({ left: x0 + ei * segW, width: segW, staffId: e.staffId }));
  });
  const merged = [];
  segs.forEach((sg) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.staffId === sg.staffId && Math.abs(prev.left + prev.width - sg.left) < 0.5) prev.width += sg.width;
    else merged.push({ ...sg });
  });
  const totalW = merged.reduce((s, g) => s + g.width, 0);
  let greyLeft = (job.status === 'complete' ? 100 : Math.max(0, Math.min(100, job.percentComplete || 0))) / 100 * totalW;
  merged.forEach((sg) => {
    const g = Math.min(sg.width, greyLeft);
    sg.grey = g > 0.01 ? g / sg.width : 0;
    sg.color = sg.staffId ? staffColor(sg.staffId) : UNASSIGNED_COLOR;
    greyLeft -= g;
  });
  return merged;
}

function ScheduleView({
  equipment, staff, jobs, tasks = [], onEditTask, onAddTask, dragTaskId, setDragTaskId, onDropTask, visibleDays, rangeStart, setRangeStart, rangeLength, setRangeLength, totalDays, todayIdx,
  readOnly, displayMode, dragJobId, setDragJobId, dropHint, setDropHint, onDrop,
  onEditJob, unscheduledJobs, conflictJobs, preferredEquipJobs = [], secondStaffUnmetJobs = [], secondStaffUnmetTasks = [], onAddJob, zoom, setZoom, onToggleEquipDay,
}) {
  // Zoom scales both axes of the grid so more of it — including the next
  // piece of equipment — fits on screen at once. Without it, a fully-booked
  // machine with many stacked jobs can push the next one below the fold,
  // making it impossible to see both a drag's source and target at the same
  // time (#27). Lifted up to the main component (#50) so it survives
  // switching tabs and back, same as rangeStart/rangeLength — still not
  // saved to storage, a viewing preference for the session, not schedule
  // data.
  // ZOOM_MIN sits below the 60% default (set in WeldingScheduler's own
  // useState) specifically so it's a genuine midpoint, zoomable both further
  // out and further in — it used to BE the minimum, which meant "default"
  // and "as far out as you can go" were the same thing.
  const ZOOM_MIN = 0.4, ZOOM_MAX = 1.6, ZOOM_STEP = 0.2;
  const colWidth = Math.round((displayMode ? 92 : 76) * zoom);
  const laneH = Math.round((displayMode ? 56 : 46) * zoom);
  // 240px cut most job names off mid-word — job number, staff colour dots and
  // hours all share this column with the name, so it needed real room, not
  // just enough for a couple of characters before the ellipsis.
  const JOB_COL_WIDTH = 320;
  const todayIso = useMemo(() => isoDate(new Date()), []);

  const staffColor = useMemo(() => {
    const m = {};
    // An explicit choice (StaffModal's "Timeline colour") wins outright;
    // otherwise fall back to the palette, indexed by list position same as
    // always.
    staff.forEach((s, i) => { m[s.id] = s.color || STAFF_PALETTE[i % STAFF_PALETTE.length]; });
    return (id) => m[id] || UNASSIGNED_COLOR;
  }, [staff]);

  const jobsByEquip = useMemo(() => {
    const map = {};
    equipment.forEach((e) => { map[e.id] = []; });
    // Grouped by equipment only here — NOT yet filtered to the visible date
    // window (see the per-equipment overlap filter below, where visibleDays
    // is actually in scope). Only a unit with no assignment at all is
    // dropped at this stage.
    const pushUnit = (unit) => {
      if (!unit.assignment) return;
      if (map[unit.assignment.equipmentId]) map[unit.assignment.equipmentId].push(unit);
    };
    jobs.forEach((j) => {
      if (Array.isArray(j.parts)) {
        // A split job has no single assignment of its own — each part is
        // independently placed and rendered as its own block, but still
        // opens the parent job's modal (see _parentJob) since parts aren't
        // separately editable outside it.
        j.parts.forEach((part, i) => {
          pushUnit({
            id: part.id,
            name: part.name || (j.parts.length > 1 ? `${j.name} (Part ${i + 1})` : j.name),
            // Each part's own manual assignment / lock, not the parent's
            // (#68) — see the matching comment in scheduler.js's flatten
            // step. Reading `j.staffId`/`j.lockedEquipmentId` here would
            // show the same "assigned manually"/lock marker on both parts'
            // tiles even after they'd been made genuinely independent.
            staffId: part.staffId || null,
            secondStaffId: part.secondStaffId || null,
            lockedEquipmentId: part.lockedEquipmentId || null,
            hoursTotal: part.hoursTotal,
            percentComplete: part.percentComplete,
            status: part.status,
            assignment: part.assignment,
            parallelProcessing: j.parallelProcessing,
            _parentJob: j,
          });
        });
      } else {
        pushUnit(j);
      }
    });
    return map;
  }, [equipment, jobs]);

  // Tasks get their own, much simpler lane per equipment — no split parts,
  // no drag-drop (a task is always placed exactly where TaskModal's
  // Equipment/Planned start date pinned it; see taskToJobUnit's comment for
  // why there's no "automatic" mode to reassign it out of), just a row that
  // opens TaskModal on click.
  const tasksByEquip = useMemo(() => {
    const map = {};
    equipment.forEach((e) => { map[e.id] = []; });
    tasks.forEach((t) => { if (t.assignment && map[t.assignment.equipmentId]) map[t.assignment.equipmentId].push(t); });
    return map;
  }, [equipment, tasks]);

  const canPrev = rangeStart > 0;
  const canNext = rangeStart + rangeLength < totalDays;
  const rangeLabel = visibleDays.length ? fmtDateRange(visibleDays[0], visibleDays[visibleDays.length - 1]) : '';
  // The window can be paged back into completed work, so give it a way home.
  const maxStart = Math.max(0, totalDays - rangeLength);
  const showingToday = todayIdx >= rangeStart && todayIdx < rangeStart + rangeLength;
  const inPast = rangeStart + rangeLength <= todayIdx;

  return (
    <div className="flex flex-col gap-4">
      <div className="w-full min-w-0">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <button
              className={btnGhost}
              disabled={!canPrev}
              onClick={() => setRangeStart((i) => Math.max(0, i - rangeLength))}
            ><ChevronLeft size={14} /></button>
            <h2 className={`font-bold ${displayMode ? 'text-2xl' : 'text-lg'} text-slate-100 min-w-[180px] text-center`}>
              {rangeLabel}
            </h2>
            <button
              className={btnGhost}
              disabled={!canNext}
              onClick={() => setRangeStart((i) => Math.min(maxStart, i + rangeLength))}
            ><ChevronRight size={14} /></button>
            {!showingToday && (
              <button
                className={`${btnGhost} border-amber-500/60 text-amber-300`}
                onClick={() => setRangeStart(Math.min(maxStart, todayIdx))}
                title="Jump back to today"
              >Today</button>
            )}
            {inPast && <span className="text-[11px] text-slate-500">Completed work — history only</span>}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 bg-slate-900 border border-slate-800 rounded-md px-1" title="Zoom the schedule grid">
              <button
                type="button"
                className="p-1.5 text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:hover:text-slate-400"
                disabled={zoom <= ZOOM_MIN}
                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))}
              ><ZoomOut size={14} /></button>
              <span className="text-[11px] text-slate-400 w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                className="p-1.5 text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:hover:text-slate-400"
                disabled={zoom >= ZOOM_MAX}
                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))}
              ><ZoomIn size={14} /></button>
            </div>
            {!displayMode && (
              <select
                className="bg-slate-900 border border-slate-800 rounded-md text-xs px-2.5 py-2 text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
                value={rangeLength}
                onChange={(e) => setRangeLength(Number(e.target.value))}
                title="How much of the schedule to show at once"
              >
                {RANGE_PRESETS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
              </select>
            )}
            {!readOnly && !displayMode && (
              <button className={btnGhost} onClick={onAddTask}><FlaskConical size={15} /> New task</button>
            )}
            {!readOnly && !displayMode && (
              <button className={btnPrimary} onClick={onAddJob}><Plus size={15} /> New job</button>
            )}
          </div>
        </div>

        <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900">
          {/* Both axes scroll together in this one container, bounded to a
              viewport-relative height, so the day header (sticky top) and the
              job column (sticky left) have an actual scrolling ancestor to
              stick within (#26) — an outer overflow-x-auto with an unbounded
              inner height, the previous approach, never gives position:sticky
              anything to stick relative to but the page itself. */}
          <div className="overflow-auto" style={{ maxHeight: displayMode ? '80vh' : '65vh' }}>
            <div style={{ minWidth: JOB_COL_WIDTH + visibleDays.length * colWidth }}>
              {/* Day header row */}
              <div className="flex border-b border-slate-800 bg-slate-900 sticky top-0 z-20">
                <div className="shrink-0 px-3 py-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wide border-r border-slate-800 sticky left-0 bg-slate-900" style={{ width: JOB_COL_WIDTH }}>
                  Equipment / Jobs
                </div>
                {visibleDays.map((day) => {
                  const { dow, dom } = fmtDay(day);
                  const isToday = day === todayIso;
                  const past = day < todayIso;
                  const weekend = isWeekendDate(day);
                  return (
                    <div
                      key={day}
                      style={{ width: colWidth }}
                      className={`shrink-0 text-center py-2 border-r border-slate-800/60 ${isToday ? 'bg-amber-500/10' : past ? 'bg-slate-950/40' : weekend ? 'bg-slate-950/70' : ''}`}
                    >
                      <div className={`text-[10px] uppercase tracking-wide ${isToday ? 'text-amber-400 font-semibold' : weekend || past ? 'text-slate-600' : 'text-slate-500'}`}>{dow}</div>
                      <div className={`text-sm font-semibold ${isToday ? 'text-amber-300' : weekend || past ? 'text-slate-600' : 'text-slate-300'}`}>{dom}</div>
                    </div>
                  );
                })}
              </div>

              {/* Equipment groups: a header row (name, type, total assigned
                  hours this period) with one lane per job beneath it. Job
                  number/name/staff/hours live in the left column; the timeline
                  bars are plain, coloured per staff, greyed as work completes. */}
              {equipment.map((eq) => {
                const color = EQUIP_COLOR[eq.type] || EQUIP_COLOR['Welding Robot'];
                const d0 = visibleDays[0];
                const d1 = visibleDays[visibleDays.length - 1];
                // A job's lane only earns a place on THIS page of the
                // timeline if it was actually scheduled sometime within the
                // window currently being viewed (#63) — otherwise a
                // completed job never leaves the grid again: every one ever
                // finished kept its own permanent row on every equipment,
                // on every page, forever, regardless of how long ago it
                // wrapped up. Paging back still finds it — its row reappears
                // the moment the visible window overlaps its own scheduled
                // span again — but it's not cluttering today's view once
                // history has moved on. Same overlap test the totalHrs sum
                // below already uses per-day; this just applies it to
                // whether the job shows up at all.
                const equipJobs = (jobsByEquip[eq.id] || []).filter(
                  (j) => j.assignment.startDate <= d1 && j.assignment.endDate >= d0
                );
                const totalHrs = Math.round(equipJobs.reduce((t, j) => t + (j.assignment.days || []).reduce((b, e) => (e.date >= d0 && e.date <= d1 ? b + e.hours : b), 0), 0) * 10) / 10;
                const equipTasks = (tasksByEquip[eq.id] || []).filter(
                  (t) => t.assignment.startDate <= d1 && t.assignment.endDate >= d0
                );
                // Jobs and tasks share one lane list, in actual schedule
                // order — start date, then claimOrder (tasks get one from
                // the same pinned-placement pass in scheduler.js a job
                // does, since taskToJobUnit merges them into the same
                // runScheduler call). Previously a task's lane was always
                // appended after every job lane regardless of date, which
                // read as "added to the bottom" instead of sitting where
                // it's actually scheduled.
                const equipLanes = [
                  ...equipJobs.map((job) => ({ kind: 'job', job })),
                  ...equipTasks.map((task) => ({ kind: 'task', task })),
                ].sort((a, b) => {
                  const av = a.kind === 'job' ? a.job : a.task;
                  const bv = b.kind === 'job' ? b.job : b.task;
                  if (av.assignment.startDate !== bv.assignment.startDate) {
                    return av.assignment.startDate < bv.assignment.startDate ? -1 : 1;
                  }
                  return (av.assignment.claimOrder ?? 0) - (bv.assignment.claimOrder ?? 0);
                });
                const cells = () => (
                  <div className="absolute inset-0 flex">
                    {visibleDays.map((day) => {
                      const isHint = dropHint && dropHint.equipId === eq.id && dropHint.date === day;
                      const weekend = isWeekendDate(day);
                      const past = day < todayIso;
                      const blocked = (eq.unavailableDates || []).includes(day);
                      return (
                        <div
                          key={day}
                          style={{ width: colWidth }}
                          title={blocked ? `${eq.name} is blocked on ${fmtDate(day)}` : undefined}
                          className={`h-full border-r border-slate-800/40 ${isHint ? 'bg-amber-500/20' : blocked ? 'bg-red-950/40' : past ? 'bg-slate-950/30' : weekend ? 'bg-slate-950/40' : ''}`}
                          onDragOver={(e) => { if (!readOnly) { e.preventDefault(); setDropHint({ equipId: eq.id, date: day }); } }}
                          onDragLeave={() => setDropHint(null)}
                          onDrop={(e) => { e.preventDefault(); if (dragTaskId) onDropTask(eq.id, day); else onDrop(eq.id, day); }}
                        />
                      );
                    })}
                  </div>
                );
                // Pulled out to plain functions (rather than inline
                // .map() callbacks) so equipLanes can render jobs and
                // tasks interleaved, in one combined, date-ordered pass —
                // see the equipLanes comment above.
                function renderJobLane(job) {
                  const parent = job._parentJob || job;
                  const jobNo = parent.bcJobNo || '—';
                  // Same effectiveDueDate the scheduler itself prioritises
                  // by (department due date if set, else the client one),
                  // not the raw job.dueDate — so the highlight tracks
                  // whatever date is actually driving urgency, consistent
                  // with the Backlog's Due column and "Needs scheduling"
                  // sort. Read off `parent`, not `job`: a split job's
                  // dates live at the job level only (see "Splitting a
                  // job") — a part has no dueDate/departmentDueDate of its
                  // own to read.
                  const jobDueDate = effectiveDueDate(parent);
                  const dueThisMonth = !!jobDueDate && jobDueDate.slice(0, 7) === todayIso.slice(0, 7);
                  // Includes secondStaffId (a paired training partner —
                  // see scheduler.js's attachSecondStaff) alongside the
                  // primary on purpose: they're genuinely both working
                  // it, so both get a colour dot and both show up in the
                  // name list, same as any other two people who happened
                  // to hand off the same job. When the pairing wasn't
                  // met, nothing was ever stamped onto `e.secondStaffId`
                  // (see the engine's all-or-nothing rule), so they
                  // correctly don't appear here at all — that absence
                  // plus the `secondUnmet` marker below IS the signal.
                  const staffIds = [...new Set((job.assignment.days || []).flatMap((e) => [e.staffId, e.secondStaffId]).filter(Boolean))];
                  const staffNames = staffIds.length ? (staffIds.map((id) => staff.find((s) => s.id === id)?.name).filter(Boolean).join(', ') || 'Unassigned') : 'Unassigned';
                  const conflict = job.assignment.conflict;
                  const preferredMissed = job.assignment.preferredEquipmentUnmet;
                  // From the tile's OWN unit, not `parent` (#68): for a
                  // split job's part, `job` here is the per-part object
                  // jobsByEquip pushed (with its own staffId/
                  // lockedEquipmentId — see that builder), which for a
                  // non-split job is simply the job itself, so this reads
                  // identically to before in that case.
                  const manualStaff = job.staffId ? staff.find((s) => s.id === job.staffId) : null;
                  const lockedEquip = job.lockedEquipmentId;
                  // A training pair that couldn't actually be honoured —
                  // same "own unit, not parent" reasoning as
                  // staffId/lockedEquipmentId above. When it WAS honoured
                  // there's nothing extra to call out here: the second
                  // person already got their own colour dot and their
                  // name already appears in `staffNames` above, exactly
                  // like any other two people who happened to hand off
                  // the same job — this only needs to flag the miss.
                  const secondUnmet = job.assignment.secondStaffUnmet;
                  const tip = `${jobNo} · ${job.name} · ${job.hoursTotal}h · ${staffNames}${manualStaff ? ' (assigned manually)' : ''}${lockedEquip ? ' · equipment locked' : ''}${job.parallelProcessing ? ' · parallel processing allowed' : ''}${conflict ? ' · OVERBOOKED' : ''}${preferredMissed ? ' · not on preferred equipment — review' : ''}${secondUnmet ? ' · training partner not paired — review' : ''}${dueThisMonth ? ' · due this month' : ''}`;
                  const segs = buildJobSegments(job, visibleDays, colWidth, staffColor);
                  // A job is being dragged over THIS row's name cell,
                  // about to take its slot on drop (#55) — distinct from
                  // dropHint's day-cell highlight, which this also sets,
                  // so the row and the exact day it'll land on are both
                  // visible at once.
                  const isReorderTarget = !!(dragJobId && dragJobId !== job.id
                    && dropHint && dropHint.equipId === job.assignment.equipmentId
                    && dropHint.date === job.assignment.startDate);
                  return (
                    <div key={job.id} className="flex border-b border-slate-800/40">
                      <div
                        // A background tint, not a border, for both the
                        // drag hint and the due-this-month highlight below —
                        // `border-r border-slate-800` on this element sets
                        // `border-color` (all four sides) with `!important`
                        // in index.css's light-theme remap, which would
                        // silently steamroll any `border-t-*` colour class
                        // added alongside it regardless of source order.
                        // `bg-amber-500/20` is the same already-mapped hint
                        // colour the day cells below already use. This has
                        // to stay a CLASS swap, not an inline `style`
                        // background layered on top of `bg-slate-900` —
                        // index.css's light-theme remap sets that class's
                        // background with `!important`, which beats any
                        // inline style regardless of source order, so a
                        // conditional class is the only way to actually
                        // change what renders. `bg-violet-500/15` has its
                        // own light-theme mapping in index.css for the same
                        // reason. The drag hint still wins when both are
                        // true — it's live feedback about where a drop will
                        // land, more urgent in the moment than a static
                        // due-date highlight.
                        className={`shrink-0 px-3 py-0.5 border-r border-slate-800 flex flex-col justify-center min-w-0 cursor-pointer sticky left-0 z-10 ${isReorderTarget ? 'bg-amber-500/20' : dueThisMonth ? 'bg-violet-500/15' : 'bg-slate-900'}`}
                        style={{ width: JOB_COL_WIDTH }}
                        // Same drag handle as the timeline bar itself
                        // (#51) — reassigning equipment/day by dragging
                        // was previously only grabbable from the coloured
                        // segment, which can be a sliver too thin to grab
                        // for a short job. The name column is a much
                        // bigger, easier target for exactly the same drag.
                        draggable={!readOnly}
                        onDragStart={() => setDragJobId(job.id)}
                        onDragEnd={() => { setDragJobId(null); setDropHint(null); }}
                        // Treats the stack of job names for one piece of
                        // equipment as a reorderable list (#55): dropping
                        // one job's name onto another's takes that row's
                        // exact (equipment, start date) slot — the same
                        // `onDrop` a timeline-cell drop already calls, so
                        // it inherits the existing "most recent drop wins,
                        // the incumbent slides" behaviour for free. That's
                        // what actually reorders the list — the dragged
                        // job lands where the target was, and everything
                        // from there on shuffles down exactly as it
                        // already does for any other pin. Works across
                        // equipment too: dropping onto a row in a
                        // different piece of equipment's list reassigns
                        // it there, same validation (process/tags/ready
                        // date) as any other drop.
                        onDragOver={(e) => {
                          if (readOnly || !dragJobId || dragJobId === job.id) return;
                          e.preventDefault();
                          setDropHint({ equipId: job.assignment.equipmentId, date: job.assignment.startDate });
                        }}
                        onDragLeave={() => setDropHint(null)}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (!dragJobId || dragJobId === job.id) return;
                          onDrop(job.assignment.equipmentId, job.assignment.startDate);
                        }}
                        onClick={() => onEditJob(job._parentJob || job)}
                        title={tip}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-mono text-[10px] shrink-0" style={{ color: '#E0523C' }}>{jobNo}</span>
                          <span className="text-[11px] font-semibold text-slate-200 truncate">{job.name}</span>
                          {conflict && <AlertTriangle size={10} className="text-red-400 shrink-0" />}
                          {job.assignment.pinned && !conflict && <Pin size={9} className="text-amber-400 shrink-0" />}
                          {!job.assignment.pinned && lockedEquip && <Lock size={9} className="text-amber-400 shrink-0" />}
                          {preferredMissed && <Target size={9} className="text-amber-400 shrink-0" />}
                          {secondUnmet && <Users size={9} className="text-amber-400 shrink-0" />}
                          {job.parallelProcessing && <Users size={9} className="text-sky-400 shrink-0" />}
                        </div>
                        <div className="flex items-center gap-1.5 min-w-0">
                          {staffIds.slice(0, 4).map((id) => (
                            <span key={id} className="shrink-0" style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: staffColor(id), display: 'inline-block' }} />
                          ))}
                          {manualStaff && <UserCheck size={9} className="text-amber-400 shrink-0" />}
                          <span className="text-[10px] text-slate-400 truncate">{staffNames} · {job.hoursTotal}h</span>
                        </div>
                        {job.percentComplete > 0 && (
                          <div style={{ height: 2, background: '#D8DBE0', borderRadius: 1, overflow: 'hidden', marginTop: 2 }}>
                            <div style={{ height: '100%', width: `${job.percentComplete}%`, background: '#E0523C' }} />
                          </div>
                        )}
                      </div>
                      <div className="relative" style={{ height: laneH, width: visibleDays.length * colWidth }}>
                        {cells()}
                        {segs.map((sg, si) => (
                          <div
                            key={si}
                            draggable={!readOnly}
                            onDragStart={() => setDragJobId(job.id)}
                            onDragEnd={() => { setDragJobId(null); setDropHint(null); }}
                            onClick={() => onEditJob(job._parentJob || job)}
                            title={tip}
                            className="absolute cursor-pointer"
                            style={{
                              left: sg.left + 1,
                              width: Math.max(4, sg.width - 2),
                              top: 7,
                              height: laneH - 14,
                              background: sg.grey >= 0.999
                                ? COMPLETE_GREY
                                : sg.grey > 0
                                ? `linear-gradient(90deg, ${COMPLETE_GREY} ${(sg.grey * 100).toFixed(1)}%, ${sg.color} ${(sg.grey * 100).toFixed(1)}%)`
                                : sg.color,
                              borderRadius: 4,
                              opacity: 0.92,
                              // conflict (a real scheduling problem) still
                              // wins over everything; due-this-month is
                              // deliberately checked ahead of the plain
                              // pinned border — pinned already has its own
                              // Pin icon in the name cell, so it doesn't
                              // need the border too, and due-this-month is
                              // the more useful thing to see at a glance
                              // here.
                              border: conflict
                                ? '1.5px solid #ef4444'
                                : dueThisMonth
                                ? `1.5px solid ${DUE_THIS_MONTH_COLOR}`
                                : job.assignment.pinned
                                ? '1.5px solid #E0523C'
                                : '1px solid rgba(37,54,70,.35)',
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  );
                }
                // Tasks (R&D/maintenance/anything that isn't a job) get the
                // same colour-by-staff-per-day language as a job tile
                // (buildJobSegments is generic) but a dashed border and a
                // flask icon so the distinction reads at a glance.
                // Draggable exactly like a job tile (name cell + each
                // segment), onto onDropTask instead of onDrop — there's
                // still no "automatic" placement mode for a task (see
                // taskToJobUnit's comment), so a drag is the ONLY way to
                // move one once created; it rebuilds the pin exactly the
                // way handleTaskDrop does.
                function renderTaskLane(task) {
                  // Same reasoning as renderJobLane's staffIds: includes
                  // secondStaffId (a paired training partner — see
                  // scheduler.js's attachSecondStaff) alongside the primary,
                  // since they're genuinely both on it. An unmet pairing
                  // never got stamped onto any day (the engine's all-or-
                  // nothing rule), so it correctly doesn't appear here —
                  // that absence plus the `secondUnmet` marker below is the
                  // whole signal, exactly like a job's own tile.
                  const staffIds = [...new Set((task.assignment.days || []).flatMap((e) => [e.staffId, e.secondStaffId]).filter(Boolean))];
                  const staffNames = staffIds.length ? (staffIds.map((id) => staff.find((s) => s.id === id)?.name).filter(Boolean).join(', ') || 'Unassigned') : 'Anyone qualified';
                  const conflict = task.assignment.conflict;
                  const secondUnmet = task.assignment.secondStaffUnmet;
                  const tip = `Task · ${task.name} · ${task.hoursTotal}h · ${staffNames}${conflict ? ' · OVER CAPACITY' : ''}${secondUnmet ? ' · training partner not paired — review' : ''}`;
                  const segs = buildJobSegments(task, visibleDays, colWidth, staffColor);
                  return (
                    <div key={task.id} className="flex border-b border-slate-800/40">
                      <div
                        className="shrink-0 px-3 py-0.5 border-r border-slate-800 flex flex-col justify-center min-w-0 cursor-pointer sticky left-0 z-10 bg-slate-900"
                        style={{ width: JOB_COL_WIDTH }}
                        draggable={!readOnly}
                        onDragStart={() => setDragTaskId(task.id)}
                        onDragEnd={() => { setDragTaskId(null); setDropHint(null); }}
                        onClick={() => onEditTask(task)}
                        title={tip}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <FlaskConical size={10} className="text-violet-400 shrink-0" />
                          <span className="text-[11px] font-semibold text-violet-200 truncate">{task.name}</span>
                          {conflict && <AlertTriangle size={10} className="text-red-400 shrink-0" />}
                          {secondUnmet && <Users size={9} className="text-amber-400 shrink-0" />}
                        </div>
                        <div className="flex items-center gap-1.5 min-w-0">
                          {staffIds.slice(0, 4).map((id) => (
                            <span key={id} className="shrink-0" style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: staffColor(id), display: 'inline-block' }} />
                          ))}
                          <span className="text-[10px] text-slate-400 truncate">{staffNames} · {task.hoursTotal}h</span>
                        </div>
                      </div>
                      <div className="relative" style={{ height: laneH, width: visibleDays.length * colWidth }}>
                        {cells()}
                        {segs.map((sg, si) => (
                          <div
                            key={si}
                            draggable={!readOnly}
                            onDragStart={() => setDragTaskId(task.id)}
                            onDragEnd={() => { setDragTaskId(null); setDropHint(null); }}
                            onClick={() => onEditTask(task)}
                            title={tip}
                            className="absolute cursor-pointer"
                            style={{
                              left: sg.left + 1,
                              width: Math.max(4, sg.width - 2),
                              top: 7,
                              height: laneH - 14,
                              background: sg.grey >= 0.999
                                ? COMPLETE_GREY
                                : sg.grey > 0
                                ? `linear-gradient(90deg, ${COMPLETE_GREY} ${(sg.grey * 100).toFixed(1)}%, ${sg.color} ${(sg.grey * 100).toFixed(1)}%)`
                                : sg.color,
                              borderRadius: 4,
                              opacity: 0.85,
                              border: conflict ? '1.5px solid #ef4444' : '1.5px dashed #a78bfa',
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={eq.id} className={`border-b border-slate-800/70 border-l-[3px] ${color.border}`}>
                    <div className="border-b border-slate-800/60 bg-slate-950/70 flex">
                      <div
                        className="shrink-0 px-3 py-1 flex flex-col justify-center min-w-0 sticky left-0 z-10 bg-slate-950/70"
                        style={{ width: JOB_COL_WIDTH }}
                      >
                        <span className="text-sm font-semibold text-slate-200 truncate">{eq.name}</span>
                        <span className="text-[10px] text-slate-400 truncate">
                          <span className={color.text}>{eq.type}</span> · {totalHrs}h assigned this period
                        </span>
                      </div>
                      {/* One button per visible day (#53) — click to block this
                          equipment out for that day entirely, so an unpinned job
                          dragged off it doesn't just get replaced by the next
                          job in line on the very next recompute. Reuses
                          `equipment.unavailableDates`, which the scheduler
                          already treats as fully closed (`equipDayLock`) —
                          this was previously only settable by hand-editing
                          data, with no UI anywhere to reach it. */}
                      <div className="flex" style={{ width: visibleDays.length * colWidth }}>
                        {visibleDays.map((day) => {
                          const past = day < todayIso;
                          const blocked = (eq.unavailableDates || []).includes(day);
                          return (
                            <div
                              key={day}
                              style={{ width: colWidth }}
                              className="shrink-0 flex items-center justify-center border-r border-slate-800/40"
                            >
                              {!readOnly && !past && (
                                <button
                                  type="button"
                                  onClick={() => onToggleEquipDay(eq.id, day)}
                                  title={blocked
                                    ? `${eq.name} is blocked on ${fmtDate(day)} — click to make it available again`
                                    : `Block ${eq.name} on ${fmtDate(day)} — nothing will be scheduled here`}
                                  className={blocked ? 'text-red-400 hover:text-red-300' : 'text-slate-700 hover:text-slate-400'}
                                >
                                  <CalendarOff size={12} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {equipLanes.length === 0 && (
                      <div className="flex">
                        <div className="shrink-0 px-3 border-r border-slate-800 flex items-center sticky left-0 bg-slate-900" style={{ width: JOB_COL_WIDTH }}>
                          <span className="text-[10px] text-slate-600">No jobs scheduled</span>
                        </div>
                        <div className="relative" style={{ height: 30, width: visibleDays.length * colWidth }}>{cells()}</div>
                      </div>
                    )}
                    {equipLanes.map((lane) => (lane.kind === 'job' ? renderJobLane(lane.job) : renderTaskLane(lane.task)))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-slate-500 mt-2">
          Drag a job block onto a different equipment row or day to reassign it — the rest of the schedule reflows automatically. A pin icon means it's manually placed; unpin it from the job's detail view to let it auto-schedule again.
        </p>
      </div>

      {!displayMode && (
        <div className="flex flex-col sm:flex-row gap-4">
          {conflictJobs.length > 0 && (
            <div className="flex-1 min-w-0 border border-red-900 bg-red-950/40 rounded-lg p-3">
              <h3 className="text-xs font-semibold text-red-300 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <AlertTriangle size={13} /> Overbooked ({conflictJobs.length})
              </h3>
              <div className="space-y-1.5">
                {conflictJobs.map((j) => (
                  <button key={j.id} onClick={() => onEditJob(j._parentJob || j)} className="w-full text-left text-xs bg-slate-900/60 hover:bg-slate-900 rounded px-2 py-1.5 text-slate-300">
                    {j.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {preferredEquipJobs.length > 0 && (
            <div className="flex-1 min-w-0 border border-amber-900 bg-amber-950/20 rounded-lg p-3">
              <h3 className="text-xs font-semibold text-amber-300 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Target size={13} /> Not on preferred equipment ({preferredEquipJobs.length})
              </h3>
              <div className="space-y-1.5">
                {preferredEquipJobs.map((j) => (
                  <button key={j.id} onClick={() => onEditJob(j._parentJob || j)} className="w-full text-left text-xs bg-slate-900/60 hover:bg-slate-900 rounded px-2 py-1.5 text-slate-300">
                    {j.name}
                    <span className="block text-slate-500">
                      wanted {equipment.find((e) => e.id === j.preferredEquipmentId)?.name || 'equipment no longer available'}, placed elsewhere — not a conflict, just worth a look
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {(secondStaffUnmetJobs.length > 0 || secondStaffUnmetTasks.length > 0) && (
            <div className="flex-1 min-w-0 border border-amber-900 bg-amber-950/20 rounded-lg p-3">
              <h3 className="text-xs font-semibold text-amber-300 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Users size={13} /> Training partner not paired ({secondStaffUnmetJobs.length + secondStaffUnmetTasks.length})
              </h3>
              <div className="space-y-1.5">
                {secondStaffUnmetJobs.map((j) => (
                  <button key={j.id} onClick={() => onEditJob(j._parentJob || j)} className="w-full text-left text-xs bg-slate-900/60 hover:bg-slate-900 rounded px-2 py-1.5 text-slate-300">
                    {j.name}
                    <span className="block text-slate-500">
                      wanted {staff.find((s) => s.id === j.secondStaffId)?.name || 'a second person'} alongside them, not free for all of it — job is scheduled fine, just missing its second person
                    </span>
                  </button>
                ))}
                {/* Same signal, for tasks — see secondStaffUnmetTasks in the
                    main component. */}
                {secondStaffUnmetTasks.map((t) => (
                  <button key={t.id} onClick={() => onEditTask(t)} className="w-full text-left text-xs bg-slate-900/60 hover:bg-slate-900 rounded px-2 py-1.5 text-slate-300">
                    {t.name}
                    <span className="block text-slate-500">
                      wanted {staff.find((s) => s.id === t.secondStaffId)?.name || 'a second person'} alongside them, not free for all of it — task is scheduled fine, just missing its second person
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex-1 min-w-0 border border-slate-800 bg-slate-900 rounded-lg p-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <ClipboardList size={13} /> Needs scheduling ({unscheduledJobs.length})
            </h3>
            {unscheduledJobs.length === 0 && <p className="text-xs text-slate-600">Everything active has a slot.</p>}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-1.5">
              {unscheduledJobs.map((j) => (
                <div
                  key={j.id}
                  draggable={!readOnly}
                  onDragStart={() => setDragJobId(j.id)}
                  onDragEnd={() => { setDragJobId(null); setDropHint(null); }}
                  onClick={() => onEditJob(j._parentJob || j)}
                  className="text-xs bg-slate-800 hover:bg-slate-700 rounded px-2 py-1.5 text-slate-300 cursor-pointer border border-slate-700"
                  title="Drag onto the schedule to place it"
                >
                  <div className="font-medium text-slate-200 truncate">
                    <span className="font-mono text-[10px]" style={{ color: '#E0523C' }}>{(j._parentJob || j).bcJobNo || '—'}</span> {j.name}
                  </div>
                  <div className="text-slate-500">{j.hoursTotal}h · ready {fmtDate(j.readyDate)} · due {fmtDate(effectiveDueDate(j))} · {j.unschedReason || 'no capacity or compatible resource found in horizon'}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   BACKLOG VIEW (table of all jobs)
   ============================================================ */

function BacklogView({ jobs, equipment, staff, timeLog = [], readOnly, onAdd, onImport, onOpenParked, parkedCount = 0, onEdit, onToggleComplete, onUnpin, onDelete, onCreateBatch, onLeaveBatch }) {
  const [filter, setFilter] = useState('active');
  const [selected, setSelected] = useState(new Set());
  const filtered = jobs.filter((j) => (filter === 'all' ? true : filter === 'complete' ? j.status === 'complete' : j.status !== 'complete'));
  // Same ordering the scheduler uses, so the list reads in the order the work
  // will actually be taken up.
  const sorted = [...filtered].sort((a, b) =>
    (new Date(effectiveDueDate(a)) - new Date(effectiveDueDate(b)))
    || ((b.needsFurtherProcessing ? 1 : 0) - (a.needsFurtherProcessing ? 1 : 0)));

  // Batching (#47): jobs that are really the same scope, meant to run back to
  // back on one machine instead of scattering across whichever is free
  // first. A row is only offerable if it could actually join a group —
  // already-split (independently-placed parts) or already-batched jobs
  // aren't, and neither is anything already complete.
  const batchable = (j) => !Array.isArray(j.parts) && !j.batchId && j.status !== 'complete';
  const toggleSelected = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectedJobs = sorted.filter((j) => selected.has(j.id));
  const sameProcess = selectedJobs.length > 1 && selectedJobs.every((j) => j.process === selectedJobs[0].process);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1">
          {['active', 'complete', 'all'].map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize ${filter === f ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'}`}>
              {f}
            </button>
          ))}
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <>
                <button
                  className={`${btnGhost} ${!sameProcess ? 'opacity-40 cursor-not-allowed' : ''}`}
                  disabled={!sameProcess}
                  title={sameProcess ? 'Run these back to back on the same equipment' : 'Select 2+ jobs with the same process to batch them'}
                  onClick={() => { onCreateBatch(selectedJobs.map((j) => j.id)); setSelected(new Set()); }}
                >
                  <LayoutGrid size={15} /> Batch {selected.size} jobs
                </button>
                <button className={btnGhost} onClick={() => setSelected(new Set())}>Clear selection</button>
              </>
            )}
            {parkedCount > 0 && (
              <button
                className={btnGhost}
                onClick={onOpenParked}
                title="Jobs the last WIP import left behind — pull one in if its scope has changed"
              >
                <FileWarning size={15} /> Parked <span className="opacity-70">{parkedCount}</span>
              </button>
            )}
            <button className={btnGhost} onClick={onImport}><Upload size={15} /> Import from BC WIP export</button>
            <button className={btnPrimary} onClick={onAdd}><Plus size={15} /> New job</button>
          </div>
        )}
      </div>

      <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900 overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
              {!readOnly && <th className="px-3 py-2 font-medium w-8"></th>}
              <th className="px-3 py-2 font-medium">Job #</th>
              <th className="px-3 py-2 font-medium">Job</th>
              <th className="px-3 py-2 font-medium">Process</th>
              <th className="px-3 py-2 font-medium">Qty</th>
              <th className="px-3 py-2 font-medium">Hours</th>
              <th className="px-3 py-2 font-medium">% Done</th>
              <th className="px-3 py-2 font-medium">Ready</th>
              <th className="px-3 py-2 font-medium">Due</th>
              <th className="px-3 py-2 font-medium">Assigned</th>
              <th className="px-3 py-2 font-medium">Total $</th>
              <th className="px-3 py-2 font-medium">Dept $</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((j) => {
              const eq = j.assignment && equipment.find((e) => e.id === j.assignment.equipmentId);
              const staffIds = j.assignment ? [...new Set((j.assignment.days || []).map((d) => d.staffId).filter(Boolean))] : [];
              const personLabel = staffIds.length === 1
                ? staff.find((s) => s.id === staffIds[0])?.name
                : staffIds.length > 1 ? `${staffIds.length} staff` : null;
              const isSplit = Array.isArray(j.parts);
              const scheduledParts = isSplit ? j.parts.filter((p) => p.assignment || p.status === 'complete').length : 0;
              return (
                <tr key={j.id} className="border-b border-slate-800/60 hover:bg-slate-800/40">
                  {!readOnly && (
                    <td className="px-3 py-2">
                      {batchable(j) && (
                        <input
                          type="checkbox"
                          className="accent-amber-500"
                          checked={selected.has(j.id)}
                          onChange={() => toggleSelected(j.id)}
                          title="Select to batch with other jobs of the same process"
                        />
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono text-xs text-slate-400 whitespace-nowrap cursor-pointer" onClick={() => onEdit(j)}>{j.bcJobNo || '—'}</td>
                  <td className="px-3 py-2 font-medium text-slate-200 cursor-pointer" onClick={() => onEdit(j)}>
                    <span className="flex items-center gap-1.5">
                      {j.name}
                      {isSplit && <span title="Split into two parts" className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-400">split</span>}
                      {j.isRework && <span title="Rework job — see the Quality tab" className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-950/60 border border-amber-900 text-amber-300">rework</span>}
                      {j.batchId && (
                        <span
                          title={`Batched — runs back to back on the same equipment as the rest of this batch (position ${(j.batchOrder ?? 0) + 1})`}
                          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-sky-950/60 text-sky-300 border border-sky-900"
                        >
                          batch #{(j.batchOrder ?? 0) + 1}
                          {!readOnly && (
                            <button
                              type="button"
                              title="Remove from batch"
                              className="hover:text-red-400"
                              onClick={(e) => { e.stopPropagation(); onLeaveBatch(j); }}
                            ><X size={10} /></button>
                          )}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{j.process}</td>
                  <td className="px-3 py-2 text-slate-400">{j.quantity}</td>
                  <td className="px-3 py-2 text-slate-400">
                    {j.hoursTotal}h
                    {(() => {
                      // Actual hours logged day by day, shown against the
                      // estimate so drift is visible before completion.
                      const lg = loggedHours(timeLog, j.id);
                      if (!lg) return null;
                      const over = lg > j.hoursTotal;
                      return (
                        <span
                          className={`block text-[10px] ${over ? 'text-amber-400' : 'text-emerald-400'}`}
                          title={over ? 'More hours logged than estimated' : 'Hours logged so far'}
                        >{lg}h logged</span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    <div className="flex items-center gap-2 w-24">
                      <div className="h-1.5 flex-1 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-amber-500 rounded-full" style={{ width: `${j.percentComplete || 0}%` }} />
                      </div>
                      <span className="text-[11px] w-8 text-right">{j.percentComplete || 0}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{fmtDate(j.readyDate)}</td>
                  <td className="px-3 py-2 text-slate-400">
                    <span className="flex items-center gap-1 whitespace-nowrap" title={j.departmentDueDate ? `Client/target date: ${fmtDate(j.dueDate)}` : undefined}>
                      {/* The date actually driving scheduling order — the
                          department due date when set (#44), the client/
                          target date otherwise — shown amber to flag that
                          it's not the client-facing date on this job. */}
                      <span className={j.departmentDueDate ? 'text-amber-400 font-medium' : undefined}>{fmtDate(effectiveDueDate(j))}</span>
                      {j.needsFurtherProcessing && (
                        <span title="Needs further processing after this department — takes priority on an equal due date" className="text-[10px] px-1 py-0.5 rounded bg-sky-950/60 text-sky-300 border border-sky-900">+proc</span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {j.status === 'complete' ? <span className="text-slate-600">—</span> : isSplit ? (
                      <span className="text-slate-400">{scheduledParts}/{j.parts.length} parts scheduled</span>
                    ) : eq ? (
                      <span className="flex items-center gap-1">
                        {eq.name}{personLabel ? ` · ${personLabel}` : ''}
                        {j.assignment.pinned && <Pin size={11} className="text-amber-400" />}
                        {!j.assignment.pinned && j.lockedEquipmentId && <Lock size={11} className="text-amber-400" title="Locked to this equipment" />}
                        {j.assignment.conflict && <AlertTriangle size={11} className="text-red-400" />}
                      </span>
                    ) : <span className="text-amber-500">Unscheduled</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-400 font-mono">${Number(j.totalValue || 0).toLocaleString()}</td>
                  <td className="px-3 py-2 text-emerald-400 font-mono">${Number(j.departmentValue || 0).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${j.status === 'complete' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-slate-800 text-slate-300'}`}>
                      {j.status === 'complete' ? 'Complete' : 'Active'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {!readOnly && (
                      <div className="flex items-center gap-1 justify-end">
                        {!isSplit && <button title="Mark complete" onClick={() => onToggleComplete(j)} className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-emerald-300"><Check size={14} /></button>}
                        {j.assignment?.pinned && <button title="Release to auto-schedule" onClick={() => onUnpin(j)} className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-amber-300"><PinOff size={14} /></button>}
                        <button title="Edit" onClick={() => onEdit(j)} className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200"><Pencil size={14} /></button>
                        <button title="Delete" onClick={() => onDelete(j)} className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"><Trash2 size={14} /></button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={13} className="px-3 py-8 text-center text-slate-600 text-sm">No jobs in this view.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================================================
   QUALITY VIEW
   Every rework job in the system, in one place. A rework job is an
   ordinary job (isRework/reworkOfJobId, created by "Mark for rework" on
   a completed job — see createRework in the main component) so hours
   logged and cost are computed with the exact same helpers as any other
   job (loggedHours, jobCost) — nothing rework-specific to keep in sync.
   ============================================================ */
function QualityView({ jobs, procedures = [], costCentres = [], costSettings, timeLog = [], onEditJob }) {
  const reworks = useMemo(
    () => jobs.filter((j) => j.isRework).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
    [jobs]
  );
  const totalHoursLogged = reworks.reduce((s, j) => s + loggedHours(timeLog, j.id), 0);
  const totalCost = reworks.reduce((s, j) => s + (jobCost(j, procedures, costCentres, costSettings) || 0), 0);
  const [reportOpen, setReportOpen] = useState(false);

  // Read-only and self-contained (nothing here is saved), so — unlike
  // BackfillTaskModal below — this doesn't need to be lifted into the main
  // component's busyEditing: there's no in-progress edit a remote sync
  // could clobber by reloading state underneath it.
  const buildQualityRows = useCallback((dateFrom, dateTo) => reportEntries(reworks, timeLog, dateFrom, dateTo).map((e) => ({
    date: e.date,
    job: e.item.bcJobNo || (jobs.find((o) => o.id === e.item.reworkOfJobId)?.name) || '—',
    name: e.item.name,
    reason: e.item.notes || '—',
    hours: e.hours,
    cost: hourlyRate(e.item, procedures, costCentres, costSettings) * e.hours,
  })), [reworks, timeLog, jobs, procedures, costCentres, costSettings]);
  const qualityColumns = [
    { key: 'date', label: 'Date', value: (r) => fmtDate(r.date) },
    { key: 'job', label: 'Job', value: (r) => r.job },
    { key: 'name', label: 'Job description/name', value: (r) => r.name },
    { key: 'hours', label: 'Hours logged', value: (r) => r.hours },
    { key: 'reason', label: 'Reason for rework', value: (r) => r.reason },
    { key: 'cost', label: 'Cost', value: (r) => fmtMoney(r.cost) },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Rework jobs</div>
          <div className="text-xl font-bold text-slate-100">{reworks.length}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Hours logged</div>
          <div className="text-xl font-bold text-slate-100">{Math.round(totalHoursLogged * 100) / 100}h</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Total rework cost</div>
          <div className="text-xl font-bold text-amber-300">{fmtMoney(totalCost)}</div>
        </div>
      </div>

      <div className="flex justify-end">
        <button className={btnGhost} onClick={() => setReportOpen(true)}><FileClock size={14} /> Report</button>
      </div>

      {reportOpen && (
        <ReportModal
          title="Quality report"
          description="Every rework entry logged in the chosen range — one row per day worked, or one row from the job's own completion record if it was never logged day by day (e.g. backfilled)."
          buildRows={buildQualityRows}
          columns={qualityColumns}
          filenamePrefix="quality-report"
          onClose={() => setReportOpen(false)}
        />
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/60 text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 text-left">Rework job</th>
              <th className="px-3 py-2 text-left">Rework of</th>
              <th className="px-3 py-2 text-left">Process</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Est. hours</th>
              <th className="px-3 py-2 text-right">Hours logged</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2 text-left">Reason</th>
            </tr>
          </thead>
          <tbody>
            {reworks.map((j) => {
              const original = jobs.find((o) => o.id === j.reworkOfJobId);
              const hours = loggedHours(timeLog, j.id);
              const cost = jobCost(j, procedures, costCentres, costSettings);
              const status = j.status === 'complete' ? 'Complete' : j.assignment ? 'Scheduled' : 'Unscheduled';
              return (
                <tr key={j.id} className="border-b border-slate-800/60 hover:bg-slate-800/40">
                  <td className="px-3 py-2 font-medium text-slate-200 cursor-pointer" onClick={() => onEditJob?.(j)}>{j.name}</td>
                  <td className="px-3 py-2 text-slate-400">
                    {original
                      ? <button type="button" className="hover:underline hover:text-slate-200" onClick={() => onEditJob?.(original)}>{original.name}</button>
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-400">{j.process}</td>
                  <td className="px-3 py-2">
                    <span className={
                      status === 'Complete' ? 'text-emerald-400' : status === 'Scheduled' ? 'text-slate-300' : 'text-amber-400'
                    }>{status}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-slate-400">{j.hoursTotal}h</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-slate-300">{hours}h</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-amber-300">{cost != null ? fmtMoney(cost) : '—'}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs max-w-xs truncate" title={j.notes}>{j.notes || '—'}</td>
                </tr>
              );
            })}
            {reworks.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-600 text-sm">
                No rework recorded — reworks created from a completed job's "Mark for rework" button will show up here.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================================================
   R&D PROJECTS AND TASKS
   A project is a tracking-only record — name, description, status — never
   scheduled and never shown on the timeline itself; it exists purely so
   tasks have something to roll their hours and cost up to. A task IS
   scheduled, sharing the engine with jobs (see taskToJobUnit/splitTaskUnits
   in the main component) but living in its own array — see PROJECTS_KEY/
   TASKS_KEY and "R&D projects and tasks" in scheduler/CLAUDE.md.
   ============================================================ */

function ProjectModal({ project, onClose, onSave, onDelete }) {
  const isNew = !project;
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [status, setStatus] = useState(project?.status || 'active');
  const canSave = name.trim().length > 0;
  return (
    <Modal title={isNew ? 'New R&D project' : 'Edit project'} onClose={onClose}>
      <Field label="Project name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Description (optional)">
        <textarea className={inputCls} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Status">
        <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active</option>
          <option value="onhold">On hold</option>
          <option value="complete">Complete</option>
        </select>
      </Field>
      <div className="flex items-center justify-between pt-2 border-t border-slate-800 mt-2">
        {onDelete ? <button className={btnDanger} onClick={onDelete}><Trash2 size={14} /> Delete</button> : <span />}
        <div className="flex gap-2">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button
            className={btnPrimary} disabled={!canSave}
            onClick={() => onSave({
              id: project?.id || uid('proj'),
              name: name.trim(),
              description,
              status,
              createdAt: project?.createdAt || new Date().toISOString(),
            }, isNew)}
          >
            <Check size={14} /> Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// The deliberately lighter modal from the original request: "no job
// numbers, no job values, none of the usual job specific data" — every
// field here is one of the eight the user actually asked for (task
// description, process, procedure, expected duration, required completion
// date, equipment, ready for processing, planned start date) plus the
// optional project link and a manual staff assignment (needed so "who it
// was done by" — see the R&D view's per-project rollup — has something to
// log against beyond whatever the daily hours log records by hand).
//
// A task is always created already pinned: Equipment and Planned start date
// are both required here, there's no "automatic, find it a slot" mode the
// way a job has — see taskToJobUnit's comment for why. Editing either field
// rebuilds the pin exactly like JobModal's own Equipment/Planned start date
// pair does (#28).
function TaskModal({ task, processes, staff, equipment = [], procedures = [], projects = [], onClose, onSave, onDelete, onToggleComplete }) {
  const isNew = !task;
  const [name, setName] = useState(task?.name || '');
  const [process, setProcess] = useState(task?.process || '');
  const [procedureId, setProcedureId] = useState(task?.procedureId || '');
  const [hoursTotal, setHoursTotal] = useState(task?.hoursTotal ?? '');
  const [readyDate, setReadyDate] = useState(task?.readyDate || '');
  const [dueDate, setDueDate] = useState(task?.dueDate || '');
  const [equipmentId, setEquipmentId] = useState(task?.assignment?.equipmentId || '');
  const [startDate, setStartDate] = useState(task?.assignment?.startDate || '');
  const [staffId, setStaffId] = useState(task?.staffId || '');
  // Same field, same rule as job.secondStaffId (see "Two-person jobs" in
  // scheduler/CLAUDE.md): a second person riding along on the task at the
  // same time, most often a trainee — only offered once a primary is
  // named, no sign-off required, their time is still blocked for the
  // task's days.
  const [secondStaffId, setSecondStaffId] = useState(task?.secondStaffId || '');
  const [projectId, setProjectId] = useState(task?.projectId || '');
  const [notes, setNotes] = useState(task?.notes || '');

  // No capability tags on a task (it has nothing equivalent to set them
  // with), so this is just the process match — simpler than JobModal's
  // qualifiedEquip, which also runs tagOk.
  const qualifiedEquip = process ? equipment.filter((e) => e.processes.includes(process)) : [];
  const qualifiedStaff = process ? staff.filter((s) => s.processes.includes(process)) : [];
  const relevantProcedures = process ? procedures.filter((p) => p.process === process) : [];

  const canSave = name.trim() && process && Number(hoursTotal) > 0 && dueDate && equipmentId && startDate;

  function handleSave() {
    const stamped = {
      id: task?.id || uid('task'),
      name: name.trim(),
      process,
      procedureId: procedureId || '',
      hoursTotal: Math.max(0, Math.round((Number(hoursTotal) || 0) * 100) / 100),
      readyDate: readyDate || '',
      dueDate,
      projectId: projectId || null,
      staffId: staffId || null,
      secondStaffId: secondStaffId || null,
      notes,
      status: task?.status || 'active',
      completedDate: task?.completedDate || null,
      actualHours: task?.actualHours ?? null,
      assignment: { equipmentId, startDate, endDate: startDate, pinned: true, conflict: false, days: [] },
    };
    onSave(stamped, isNew);
  }

  return (
    <Modal title={isNew ? 'New task' : 'Edit task'} onClose={onClose}>
      <Field label="Task description">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Process">
          <select
            className={inputCls} value={process}
            onChange={(e) => { setProcess(e.target.value); setProcedureId(''); setEquipmentId(''); setStaffId(''); }}
          >
            <option value="">Select…</option>
            {processes.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Procedure — for cost (optional)">
          <select className={inputCls} value={procedureId} onChange={(e) => setProcedureId(e.target.value)} disabled={!process}>
            <option value="">None</option>
            {relevantProcedures.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Expected duration (hours)">
          <input type="number" min={0} step={0.25} className={inputCls} value={hoursTotal} onChange={(e) => setHoursTotal(e.target.value)} />
        </Field>
        <Field label="Required completion date">
          <input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ready for processing">
          <input type="date" className={inputCls} value={readyDate} onChange={(e) => setReadyDate(e.target.value)} />
        </Field>
        <Field label="Planned start date">
          <input type="date" className={inputCls} min={readyDate} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Equipment">
          <select className={inputCls} value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} disabled={!process}>
            <option value="">Select…</option>
            {qualifiedEquip.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Assigned to (optional)">
          <select className={inputCls} value={staffId} onChange={(e) => setStaffId(e.target.value)} disabled={!process}>
            <option value="">Automatic — anyone qualified &amp; free</option>
            {qualifiedStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
      {/* A second person on the task at the same time — most often a
          trainee shadowing whoever's assigned above. Same rule as
          JobModal's own Training partner field: only offered once a
          primary is named, offers every OTHER staff member (not just
          qualifiedStaff — this is exactly the case where the person
          genuinely isn't signed off yet), no sign-off required. */}
      {staffId && (
        <Field label="Training partner (optional)">
          <select className={inputCls} value={secondStaffId} onChange={(e) => setSecondStaffId(e.target.value)}>
            <option value="">No one else — just {staff.find((s) => s.id === staffId)?.name || 'this person'}</option>
            {staff.filter((s) => s.id !== staffId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <p className="text-xs text-slate-500 mt-1">
            {secondStaffId
              ? `${staff.find((s) => s.id === secondStaffId)?.name || 'This person'} is also blocked out for the task's days, alongside ${staff.find((s) => s.id === staffId)?.name || 'the assigned person'} — no sign-off on ${process || 'the process'} required.`
              : 'For training: a second person present the whole time, without needing to be signed off yet.'}
          </p>
        </Field>
      )}
      <p className="text-xs text-slate-500 -mt-2 mb-3">
        {equipmentId && startDate
          ? `Pinned to ${equipment.find((e) => e.id === equipmentId)?.name || 'this equipment'} starting ${fmtDate(startDate)} on Save, same as a job pinned from its own modal — won't move until this is changed.`
          : 'Equipment and a planned start date are both required — a task is placed exactly where you put it, not auto-scheduled.'}
      </p>
      <Field label="Project (optional)">
        <select className={inputCls} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">No project — standalone task</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Notes (optional)">
        <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex items-center justify-between pt-2 border-t border-slate-800 mt-2">
        <div className="flex gap-2">
          {onDelete && <button className={btnDanger} onClick={onDelete}><Trash2 size={14} /> Delete</button>}
        </div>
        <div className="flex gap-2">
          {onToggleComplete && (
            <button className={btnGhost} onClick={onToggleComplete}>
              <CircleCheck size={14} /> {task?.status === 'complete' ? 'Mark active' : 'Mark complete'}
            </button>
          )}
          <button className={btnPrimary} disabled={!canSave} onClick={handleSave}><Check size={14} /> Save</button>
        </div>
      </div>
    </Modal>
  );
}

// "I would also like the option of adding entries directly to the R&D
// list, mainly so I can back-fill it with work done in the recent past" —
// TaskModal above can't do this: Equipment and Planned start date are both
// required there because a task is always pinned onto the timeline, and
// there's nothing to pin work that already happened onto. This is the
// alternative entry point: date worked + hours instead of equipment + a
// planned start date, producing a task that's already `status: 'complete'`
// with `assignment: null` — it was never scheduled, so it never appears on
// the Schedule view, but it's otherwise an ordinary completed task
// (isBackfilled: true is purely a UI badge — see the "logged" pill in
// ProjectsView's task table — nothing reads it for scheduling or costing).
//
// Saving also writes a matching wf_timelog entry directly (see
// addOrUpdateBackfillTask), which is what lets reportEntries() pick this up
// through the exact same day-by-day path a normally-logged task uses,
// rather than needing its own special case in the report.
function BackfillTaskModal({ task, processes, staff, procedures = [], projects = [], onClose, onSave, onDelete }) {
  const isNew = !task;
  const [name, setName] = useState(task?.name || '');
  const [process, setProcess] = useState(task?.process || '');
  const [procedureId, setProcedureId] = useState(task?.procedureId || '');
  const [date, setDate] = useState(task?.completedDate || isoDate(new Date()));
  const [hours, setHours] = useState(task?.actualHours ?? '');
  const [staffId, setStaffId] = useState(task?.staffId || '');
  const [projectId, setProjectId] = useState(task?.projectId || '');
  const [notes, setNotes] = useState(task?.notes || '');

  const relevantProcedures = process ? procedures.filter((p) => p.process === process) : [];
  const qualifiedStaff = process ? staff.filter((s) => s.processes.includes(process)) : [];
  const canSave = name.trim() && process && Number(hours) > 0 && date;

  function handleSave() {
    onSave(
      { id: task?.id, name: name.trim(), process, procedureId: procedureId || '', projectId: projectId || null, staffId: staffId || null, notes },
      isNew,
      { date, hours: Math.max(0, Math.round((Number(hours) || 0) * 100) / 100), staffId: staffId || null },
    );
  }

  return (
    <Modal title={isNew ? 'Log past work' : 'Edit logged entry'} onClose={onClose}>
      <p className="text-sm text-slate-300 mb-3">
        For work that's already done and was never put on the schedule — fills in the R&D list and report directly,
        with no equipment or start date to pin.
      </p>
      <Field label="Task description">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Process">
          <select
            className={inputCls} value={process}
            onChange={(e) => { setProcess(e.target.value); setProcedureId(''); setStaffId(''); }}
          >
            <option value="">Select…</option>
            {processes.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Procedure — for cost (optional)">
          <select className={inputCls} value={procedureId} onChange={(e) => setProcedureId(e.target.value)} disabled={!process}>
            <option value="">None</option>
            {relevantProcedures.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date worked">
          <input type="date" className={inputCls} max={isoDate(new Date())} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Hours">
          <input type="number" min={0} step={0.25} className={inputCls} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Who (optional)">
          <select className={inputCls} value={staffId} onChange={(e) => setStaffId(e.target.value)} disabled={!process}>
            <option value="">Unspecified</option>
            {qualifiedStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Project (optional)">
          <select className={inputCls} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">No project — standalone</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Notes (optional)">
        <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex items-center justify-between pt-2 border-t border-slate-800 mt-2">
        <div className="flex gap-2">
          {onDelete && <button className={btnDanger} onClick={onDelete}><Trash2 size={14} /> Delete</button>}
        </div>
        <div className="flex gap-2">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} disabled={!canSave} onClick={handleSave}><Check size={14} /> Save</button>
        </div>
      </div>
    </Modal>
  );
}

// Every task that names this project, for the rollup below — hours from the
// same loggedHours() any job uses, cost from the same jobCost() (task field
// names deliberately match: procedureId/status/actualHours/hoursTotal), so
// nothing project-specific had to be built for either number.
function projectRollup(project, tasks, timeLog, procedures, costCentres, costSettings) {
  const own = tasks.filter((t) => t.projectId === project.id);
  const hours = own.reduce((s, t) => s + loggedHours(timeLog, t.id), 0);
  const cost = own.reduce((s, t) => s + (jobCost(t, procedures, costCentres, costSettings) || 0), 0);
  return { taskCount: own.length, hours: Math.round(hours * 100) / 100, cost };
}

function ProjectsView({ projects, tasks, timeLog, procedures, costCentres, costSettings, staff, readOnly, onAddProject, onEditProject, onAddTask, onEditTask, onAddBackfillTask }) {
  const [projectFilter, setProjectFilter] = useState('all');
  const [reportOpen, setReportOpen] = useState(false);
  const sortedProjects = [...projects].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const visibleTasks = (projectFilter === 'all' ? tasks : tasks.filter((t) => t.projectId === projectFilter))
    .slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  // Read-only and self-contained, same reasoning as QualityView's own
  // report — no busyEditing involvement needed.
  const buildRdRows = useCallback((dateFrom, dateTo) => reportEntries(tasks, timeLog, dateFrom, dateTo).map((e) => {
    const project = projects.find((p) => p.id === e.item.projectId);
    const person = staff.find((s) => s.id === e.staffId);
    return {
      date: e.date,
      person: person ? person.name : '—',
      project: project ? project.name : '—',
      task: e.item.name,
      hours: e.hours,
      cost: hourlyRate(e.item, procedures, costCentres, costSettings) * e.hours,
    };
  }), [tasks, timeLog, projects, staff, procedures, costCentres, costSettings]);
  const rdColumns = [
    { key: 'date', label: 'Date', value: (r) => fmtDate(r.date) },
    { key: 'person', label: 'Person', value: (r) => r.person },
    { key: 'project', label: 'Project', value: (r) => r.project },
    { key: 'task', label: 'Task', value: (r) => r.task },
    { key: 'hours', label: 'Hours logged', value: (r) => r.hours },
    { key: 'cost', label: 'Cost', value: (r) => fmtMoney(r.cost) },
  ];

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Projects</h2>
          <div className="flex items-center gap-2">
            <button className={btnGhost} onClick={() => setReportOpen(true)}><FileClock size={14} /> Report</button>
            {!readOnly && <button className={btnPrimary} onClick={onAddProject}><Plus size={15} /> New project</button>}
          </div>
        </div>
        {sortedProjects.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-8 text-center text-slate-600 text-sm">
            No R&D projects yet — set one up to start tracking hours and cost against it, or leave tasks standalone.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {sortedProjects.map((p) => {
              const roll = projectRollup(p, tasks, timeLog, procedures, costCentres, costSettings);
              return (
                <button
                  key={p.id} type="button"
                  className="text-left bg-slate-900 border border-slate-800 rounded-lg p-3 hover:border-slate-600 transition-colors"
                  onClick={() => onEditProject(p)}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="font-semibold text-slate-100 text-sm truncate">{p.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border shrink-0 ${
                      p.status === 'complete' ? 'bg-emerald-950/60 border-emerald-900 text-emerald-300'
                      : p.status === 'onhold' ? 'bg-slate-800 border-slate-700 text-slate-400'
                      : 'bg-amber-950/60 border-amber-900 text-amber-300'
                    }`}>{p.status === 'onhold' ? 'On hold' : p.status === 'complete' ? 'Complete' : 'Active'}</span>
                  </div>
                  {p.description && <p className="text-xs text-slate-500 mb-2 line-clamp-2">{p.description}</p>}
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span>{roll.taskCount} task{roll.taskCount === 1 ? '' : 's'}</span>
                    <span>{roll.hours}h logged</span>
                    <span className="text-amber-300 font-mono">{fmtMoney(roll.cost)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {reportOpen && (
        <ReportModal
          title="R&D report"
          description="Every task entry logged in the chosen range — one row per day worked, or one row from the task's own completion record if it was never logged day by day (e.g. backfilled with Log past work)."
          buildRows={buildRdRows}
          columns={rdColumns}
          filenamePrefix="rd-report"
          onClose={() => setReportOpen(false)}
        />
      )}

      <div>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Tasks</h2>
          <div className="flex items-center gap-2">
            <select
              className="bg-slate-900 border border-slate-800 rounded-md text-xs px-2.5 py-2 text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
              value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="all">All tasks</option>
              <option value="">No project (standalone)</option>
              {sortedProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {!readOnly && <button className={btnGhost} onClick={onAddBackfillTask} title="Add a record for work that's already done, without scheduling it"><FileClock size={15} /> Log past work</button>}
            {!readOnly && <button className={btnPrimary} onClick={onAddTask}><Plus size={15} /> New task</button>}
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/60 text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Task</th>
                <th className="px-3 py-2 text-left">Project</th>
                <th className="px-3 py-2 text-left">Process</th>
                <th className="px-3 py-2 text-left">Who</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Est. hours</th>
                <th className="px-3 py-2 text-right">Hours logged</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map((t) => {
                const project = projects.find((p) => p.id === t.projectId);
                const person = staff.find((s) => s.id === t.staffId);
                const hours = loggedHours(timeLog, t.id);
                const cost = jobCost(t, procedures, costCentres, costSettings);
                const status = t.status === 'complete' ? 'Complete' : t.assignment?.conflict ? 'Over capacity' : 'Scheduled';
                return (
                  <tr key={t.id} className="border-b border-slate-800/60 hover:bg-slate-800/40 cursor-pointer" onClick={() => onEditTask(t)}>
                    <td className="px-3 py-2 font-medium text-slate-200">
                      <span className="flex items-center gap-1.5">
                        {t.name}
                        {t.isBackfilled && (
                          <span title="Logged directly — never scheduled on the timeline" className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-950/60 border border-violet-900 text-violet-300">logged</span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-400">{project ? project.name : '—'}</td>
                    <td className="px-3 py-2 text-slate-400">{t.process}</td>
                    <td className="px-3 py-2 text-slate-400">{person ? person.name : 'Anyone qualified'}</td>
                    <td className="px-3 py-2">
                      <span className={
                        status === 'Complete' ? 'text-emerald-400' : status === 'Over capacity' ? 'text-red-400' : 'text-slate-300'
                      }>{status}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-slate-400">{t.hoursTotal}h</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-slate-300">{hours}h</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-amber-300">{cost != null ? fmtMoney(cost) : '—'}</td>
                  </tr>
                );
              })}
              {visibleTasks.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-600 text-sm">
                  No tasks{projectFilter !== 'all' ? ' for this project' : ''} yet — set one up from here or straight
                  from the Schedule view.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   TEMPLATES VIEW
   ============================================================ */

// Which equipment a template's jobs will actually schedule on — the same
// process + capability-tag test the scheduler itself applies (tagOk), not a
// stored, manually-picked list. (#23) A template's "equipment this can run
// on" used to be a MultiCheck the user filled in by hand, defaulting to
// every process-capable machine if left alone — indistinguishable, at a
// glance, from "the scheduler will only use these", when the scheduler
// never looked at it. Deriving it live keeps the display honest and means
// it can never drift from what the engine actually does.
function equipmentForTemplate(t, equipment) {
  return equipment.filter((e) => e.processes.includes(t.process) && tagOk(t, e));
}

// Group templates by category (untitled → "Uncategorised"), sorted by name.
function groupTemplatesByCategory(templates) {
  const map = {};
  templates.forEach((t) => {
    const key = t.category || 'Uncategorised';
    (map[key] = map[key] || []).push(t);
  });
  return Object.keys(map).sort().map((k) => [k, map[k]]);
}

function TemplatesView({ templates, equipment, processes, categories = [], readOnly, onAdd, onEdit, onDelete, onSaveProcesses, onRenameProcess, onSaveCategories }) {
  const [newProcess, setNewProcess] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [editingProcess, setEditingProcess] = useState(null); // the process name currently being renamed, or null
  const [editProcessValue, setEditProcessValue] = useState('');
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-100">Job templates</h2>
          {!readOnly && <button className={btnPrimary} onClick={onAdd}><Plus size={15} /> New template</button>}
        </div>
        {groupTemplatesByCategory(templates).map(([category, group]) => (
          <div key={category} className="mb-4">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{category} ({group.length})</div>
            <div className="grid sm:grid-cols-2 gap-3">
              {group.map((t) => (
                <div key={t.id} className="border border-slate-800 bg-slate-900 rounded-lg p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-slate-100 text-sm">{t.name}</h3>
                    {!readOnly && (
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => onEdit(t)} className="p-1 rounded hover:bg-slate-700 text-slate-400"><Pencil size={13} /></button>
                        <button onClick={() => onDelete(t)} className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"><Trash2 size={13} /></button>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{t.process}</p>
                  <p className="text-xs text-slate-400 mt-2">{t.hoursPerUnit}h per unit</p>
                  {(t.tags || []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {t.tags.map((tag) => <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">{tag}</span>)}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {equipmentForTemplate(t, equipment).map((eq) => (
                      <span key={eq.id} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{eq.name}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div>
        <h2 className="text-lg font-bold text-slate-100 mb-4">Template categories</h2>
        <div className="border border-slate-800 bg-slate-900 rounded-lg p-4 mb-6">
          <div className="space-y-1.5 mb-3">
            {categories.length === 0 && <p className="text-xs text-slate-500 italic">None yet — add one to group your templates.</p>}
            {categories.map((c) => {
              const used = templates.filter((t) => t.category === c).length;
              return (
                <div key={c} className="flex items-center justify-between text-sm text-slate-300 bg-slate-800/60 rounded px-2 py-1.5">
                  <span>{c} <span className="text-[11px] text-slate-500">· {used}</span></span>
                  {!readOnly && (
                    <button onClick={() => onSaveCategories(categories.filter((x) => x !== c))} className="text-slate-500 hover:text-red-400"><X size={13} /></button>
                  )}
                </div>
              );
            })}
          </div>
          {!readOnly && (
            <div className="flex gap-2">
              <input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const v = newCategory.trim();
                  if (v && !categories.includes(v)) { onSaveCategories([...categories, v].sort()); setNewCategory(''); }
                }}
                placeholder="Add a category…"
                className={inputCls}
              />
              <button
                className={btnGhost}
                onClick={() => {
                  const v = newCategory.trim();
                  if (v && !categories.includes(v)) { onSaveCategories([...categories, v].sort()); setNewCategory(''); }
                }}
              ><Plus size={14} /></button>
            </div>
          )}
        </div>

        <h2 className="text-lg font-bold text-slate-100 mb-4">Welding &amp; coating processes</h2>
        <div className="border border-slate-800 bg-slate-900 rounded-lg p-4">
          <div className="space-y-1.5 mb-3">
            {processes.map((p) => (
              <div key={p} className="flex items-center justify-between text-sm text-slate-300 bg-slate-800/60 rounded px-2 py-1.5 gap-2">
                {editingProcess === p ? (
                  <>
                    <input
                      autoFocus
                      className={`${inputCls} py-1`}
                      value={editProcessValue}
                      onChange={(e) => setEditProcessValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { onRenameProcess(p, editProcessValue); setEditingProcess(null); }
                        if (e.key === 'Escape') setEditingProcess(null);
                      }}
                    />
                    <div className="flex gap-1 shrink-0">
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { onRenameProcess(p, editProcessValue); setEditingProcess(null); }}
                        className="text-emerald-400 hover:text-emerald-300"
                      ><Check size={14} /></button>
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setEditingProcess(null)}
                        className="text-slate-500 hover:text-slate-300"
                      ><X size={14} /></button>
                    </div>
                  </>
                ) : (
                  <>
                    <span>{p}</span>
                    {!readOnly && (
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => { setEditingProcess(p); setEditProcessValue(p); }} className="text-slate-500 hover:text-amber-400"><Pencil size={13} /></button>
                        <button onClick={() => onSaveProcesses(processes.filter((x) => x !== p))} className="text-slate-500 hover:text-red-400"><X size={13} /></button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          {!readOnly && (
            <div className="flex gap-2">
              <input value={newProcess} onChange={(e) => setNewProcess(e.target.value)} placeholder="Add a process…" className={inputCls} />
              <button
                className={btnGhost}
                onClick={() => { if (newProcess.trim()) { onSaveProcesses([...processes, newProcess.trim()]); setNewProcess(''); } }}
              ><Plus size={14} /></button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   STAFF VIEW (identity + capabilities + weekly roster + leave)
   ============================================================ */

// Staff identity/capabilities (name, certified processes, add/edit/delete) and
// roster (weekly working pattern, leave/absences) used to be two separate
// tabs — "Equipment & Staff" and "Roster" — so everything about one person
// was split across two screens with no link between them. Merged here (#20):
// one tab, the weekly roster table doubles as the staff list (its sticky
// name column now also carries capability tags and edit/delete), with leave
// underneath as before.
function StaffView({ staff, readOnly, onAddStaff, onEditStaff, onDeleteStaff, onUpdateStaff }) {
  const [leaveModalFor, setLeaveModalFor] = useState(null); // staff object or null
  // Set only when editing an existing period (vs. adding a new one) — same
  // modal either way, this just decides whether saveLeave replaces an entry
  // or appends one, and drives the title/button wording.
  const [editingLeaveId, setEditingLeaveId] = useState(null);
  const [leaveStart, setLeaveStart] = useState(isoDate(new Date()));
  const [leaveEnd, setLeaveEnd] = useState(isoDate(new Date()));
  const [leaveReason, setLeaveReason] = useState('');
  const [leaveKind, setLeaveKind] = useState('leave');

  function updateDay(member, dayKey, patch) {
    const roster = { ...(member.weeklyRoster || defaultWeeklyRoster()) };
    roster[dayKey] = { ...roster[dayKey], ...patch };
    onUpdateStaff({ ...member, weeklyRoster: roster });
  }

  function openAddLeave(member) {
    setLeaveModalFor(member);
    setEditingLeaveId(null);
    setLeaveStart(isoDate(new Date()));
    setLeaveEnd(isoDate(new Date()));
    setLeaveReason('');
    setLeaveKind('leave');
  }
  function openEditLeave(period) {
    const member = staff.find((s) => s.id === period.staffId);
    if (!member) return;
    setLeaveModalFor(member);
    setEditingLeaveId(period.id);
    setLeaveStart(period.startDate);
    setLeaveEnd(period.endDate);
    setLeaveReason(period.reason || '');
    setLeaveKind(period.kind);
  }
  function saveLeave() {
    if (!leaveModalFor) return;
    const entry = { id: editingLeaveId || uid('lv'), kind: leaveKind, startDate: leaveStart, endDate: leaveEnd, reason: leaveReason.trim() };
    const existing = leaveModalFor.leavePeriods || [];
    const periods = editingLeaveId
      ? existing.map((p) => (p.id === editingLeaveId ? entry : p))
      : [...existing, entry];
    onUpdateStaff({ ...leaveModalFor, leavePeriods: periods });
    setLeaveModalFor(null);
    setEditingLeaveId(null);
    setLeaveReason('');
    setLeaveKind('leave');
  }
  function removeLeave(member, id) {
    onUpdateStaff({ ...member, leavePeriods: (member.leavePeriods || []).filter((p) => p.id !== id) });
  }

  const today = isoDate(new Date());
  const allLeave = staff.flatMap((m) => (m.leavePeriods || []).map((p) => ({ ...p, staffName: m.name, staffId: m.id })))
    .filter((p) => p.endDate >= today)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-slate-100">Weekly roster</h2>
          {!readOnly && <button className={btnPrimary} onClick={onAddStaff}><Plus size={15} /> Add staff</button>}
        </div>
        <p className="text-xs text-slate-500 mb-4">Set each person's normal working pattern — which days, which shift, and how many hours. The scheduler uses this instead of assuming an 8-hour, 5-day week for everyone. The same table is your staff list — edit or remove someone from their row.</p>
        <div className="border border-slate-800 bg-slate-900 rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2 font-medium sticky left-0 bg-slate-900" style={{ minWidth: 200 }}>Staff</th>
                {DAY_COLS.map(([key, label]) => <th key={key} className="px-2 py-2 font-medium text-center">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {staff.map((m) => (
                <tr key={m.id} className="border-b border-slate-800/60">
                  <td className="px-3 py-2 sticky left-0 bg-slate-900 align-top" style={{ minWidth: 200 }}>
                    <div className="flex items-start justify-between gap-1.5">
                      <span className="font-medium text-slate-200 whitespace-nowrap">{m.name}</span>
                      {!readOnly && (
                        <div className="flex gap-0.5 shrink-0">
                          <button onClick={() => onEditStaff(m)} className="p-1 rounded hover:bg-slate-700 text-slate-400"><Pencil size={12} /></button>
                          <button onClick={() => onDeleteStaff(m)} className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"><Trash2 size={12} /></button>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {m.processes.map((p) => <span key={p} className="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-slate-500">{p}</span>)}
                    </div>
                  </td>
                  {DAY_COLS.map(([key]) => {
                    const pattern = (m.weeklyRoster || {})[key] || { working: false, production: true, shift: 'day', hours: 0 };
                    const nonProd = pattern.working && pattern.production === false;
                    return (
                      <td key={key} className="px-1.5 py-2 text-center">
                        <div className="flex flex-col items-center gap-1">
                          <select
                            disabled={readOnly}
                            title={nonProd ? 'On site but not available for scheduled production work' : undefined}
                            className={`bg-slate-800 border rounded text-[11px] px-1 py-1 w-[74px] ${nonProd ? 'border-sky-800 text-sky-300' : 'border-slate-700 text-slate-200'}`}
                            value={!pattern.working ? 'off' : nonProd ? 'nonprod' : pattern.shift}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === 'off') updateDay(m, key, { working: false, production: true, hours: 0 });
                              else if (v === 'nonprod') updateDay(m, key, { working: true, production: false, hours: 0 });
                              // Saturday is a shortened day on the shop floor (6h, not the
                              // ordinary 8h shift) — defaulting a freshly-turned-on Saturday
                              // to the same 8h as a weekday silently over-rostered it unless
                              // someone remembered to correct it by hand (#59).
                              else updateDay(m, key, { working: true, production: true, shift: v, hours: pattern.hours || (key === 'sat' ? 6 : SHIFT_DEFS[v].defaultHours) });
                            }}
                          >
                            <option value="off">Off</option>
                            <option value="day">Day</option>
                            <option value="afternoon">Afternoon</option>
                            <option value="nonprod">No prod.</option>
                          </select>
                          {pattern.working && !nonProd && (
                            <input
                              type="number"
                              min={0}
                              max={16}
                              step={0.5}
                              disabled={readOnly}
                              value={pattern.hours}
                              onChange={(e) => updateDay(m, key, { hours: Number(e.target.value) || 0 })}
                              className="bg-slate-800 border border-slate-700 rounded text-[11px] px-1 py-0.5 text-slate-200 w-[74px] text-center"
                            />
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {staff.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-600 text-sm">No staff yet — add one above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500 mt-2">
          Day and Afternoon shifts don't overlap in time, so if one person covers the day shift and another covers the afternoon on the same machine, a job can be worked on by both across that day — the schedule will show it as spanning two shifts.
        </p>
        <p className="text-[11px] text-slate-500 mt-1">
          <span className="text-sky-300">No prod.</span> means rostered on but not available for scheduled production work — training, covering the office, on the tools elsewhere. The scheduler skips the day the same as an off day, but the roster still shows the person is in, so you don't have to book leave or zero their hours to get the same effect.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2"><CalendarOff size={17} /> Leave &amp; absences</h2>
        </div>
        <div className="border border-slate-800 bg-slate-900 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2 font-medium">Staff</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">From</th>
                <th className="px-3 py-2 font-medium">To</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {allLeave.map((p) => (
                <tr key={p.id} className="border-b border-slate-800/60">
                  <td className="px-3 py-2 text-slate-200">{p.staffName}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${
                      p.kind === 'sick' ? 'bg-red-950/50 text-red-300'
                        : p.kind === 'training' ? 'bg-sky-950/50 text-sky-300'
                        : p.kind === 'other' ? 'bg-slate-800 text-slate-300'
                        : 'bg-amber-950/50 text-amber-300'
                    }`}>{absenceKindLabel(p.kind)}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{fmtDate(p.startDate)}</td>
                  <td className="px-3 py-2 text-slate-400">{fmtDate(p.endDate)}</td>
                  <td className="px-3 py-2 text-slate-400">{p.reason || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {!readOnly && (
                      <div className="flex justify-end gap-0.5">
                        <button onClick={() => openEditLeave(p)} className="p-1.5 rounded hover:bg-slate-700 text-slate-400"><Pencil size={13} /></button>
                        <button onClick={() => removeLeave(staff.find((s) => s.id === p.staffId), p.id)} className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"><Trash2 size={13} /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {allLeave.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-600 text-sm">No upcoming leave or absences booked.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {!readOnly && (
          <div className="mt-3 flex flex-wrap gap-2">
            {staff.map((m) => (
              <button
                key={m.id}
                className={btnGhost}
                onClick={() => openAddLeave(m)}
              >
                <Plus size={13} /> Absence for {m.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {leaveModalFor && (
        <Modal title={`${editingLeaveId ? 'Edit' : 'Add'} absence — ${leaveModalFor.name}`} onClose={() => setLeaveModalFor(null)}>
          <Field label="Type">
            <select className={inputCls} value={leaveKind} onChange={(e) => setLeaveKind(e.target.value)}>
              {ABSENCE_KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <p className="text-xs text-slate-500 mt-1">All types make the person unavailable to the scheduler — the type is for your records, so a course or a stint on other duties doesn't have to be booked as leave.</p>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From"><input type="date" className={inputCls} value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} /></Field>
            <Field label="To"><input type="date" className={inputCls} value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} /></Field>
          </div>
          <Field label="Reason (optional)"><input className={inputCls} value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} placeholder="e.g. Annual leave" /></Field>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800 mt-3">
            <button className={btnGhost} onClick={() => setLeaveModalFor(null)}>Cancel</button>
            <button className={btnPrimary} onClick={saveLeave}><Check size={14} /> {editingLeaveId ? 'Save changes' : 'Save absence'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ============================================================
   JOB MODAL
   ============================================================ */

function JobModal({ job, templates, processes, staff, equipment = [], procedures = [], costCentres = [], costSettings, jobs = [], timeLog = [], onClose, onSave, onDelete, onToggleComplete, onUnpin, onSplit, onMerge, onUnpinPart, onMarkForRework, onOpenRelatedJob }) {
  const isNew = !job;
  // Each part carries its own manual staff assignment and equipment lock,
  // independent of the other part's and of the (now unused, for a split job)
  // job-level fields below (#68) — see the matching comment in scheduler.js's
  // flatten step. `_origEquipId`/`_origStartDate` are UI-only scratch, mirroring
  // `origEquipId`/`origStartDate` below for the whole-job case: they're what
  // `computePartAssignment` compares against to tell "the user actually
  // touched this part's pin fields" from "this is just what was already
  // there", so merely opening and saving the modal doesn't force-pin a part
  // that was auto-placed. Stripped back out before saving — see handleSave.
  const [parts, setParts] = useState(job?.parts ? job.parts.map((p) => ({
    ...p,
    staffId: p.staffId || '',
    secondStaffId: p.secondStaffId || '',
    lockedEquipmentId: p.lockedEquipmentId || '',
    manualEquipId: p.assignment?.equipmentId || '',
    manualStartDate: p.assignment?.startDate || '',
    _origEquipId: p.assignment?.equipmentId || '',
    _origStartDate: p.assignment?.startDate || '',
  })) : null);
  const [splitHoursA, setSplitHoursA] = useState(job ? Math.round((job.hoursTotal / 2) * 100) / 100 : 0);
  // Rework linkage, both directions: if this job WAS a rework, who it's a
  // rework of; if this job HAS reworks, which ones. Purely informational —
  // see createRework() for how the link is made and "Rework" in
  // scheduler/CLAUDE.md for why the original is never edited from here.
  const reworkOfJob = job?.reworkOfJobId ? jobs.find((j) => j.id === job.reworkOfJobId) : null;
  const linkedReworks = useMemo(() => (job ? jobs.filter((j) => j.reworkOfJobId === job.id) : []), [jobs, job]);
  // A new job starts with NO template picked (#59) — it used to default to
  // templates[0], and the "custom job instead" toggle below only cleared
  // templateId itself, not the name/process/hours it had already copied in,
  // so there was no way to actually land on a blank job: the toggle changed
  // what got saved but the fields on screen still showed template #1's data
  // either way. Editing an existing job is unaffected — it still opens on
  // whatever template (or none) it already has.
  const [templateId, setTemplateId] = useState(job?.templateId || '');
  const [name, setName] = useState(job?.name || '');
  const [process, setProcess] = useState(job?.process || processes[0] || '');
  const [quantity, setQuantity] = useState(job?.quantity ?? 1);
  const [hoursPerUnit, setHoursPerUnit] = useState(job ? (job.quantity ? job.hoursTotal / job.quantity : job.hoursTotal) : 1);
  // Blank by default, not today (#59) — this is the scheduling gate that
  // says materials/prior-stage work have actually arrived, which isn't true
  // just because someone happened to create the job today. See the
  // "Ready for processing" field below, and whyUnscheduled/#59 in
  // scheduler.js for what a blank one does at placement time.
  const [readyDate, setReadyDate] = useState(job?.readyDate || '');
  const [needsFurtherProcessing, setNeedsFurtherProcessing] = useState(!!job?.needsFurtherProcessing);
  const [parallelProcessing, setParallelProcessing] = useState(!!job?.parallelProcessing);
  const [dueDate, setDueDate] = useState(job?.dueDate || addDays(isoDate(new Date()), 14));
  const [departmentDueDate, setDepartmentDueDate] = useState(job?.departmentDueDate || '');
  const [notes, setNotes] = useState(job?.notes || '');
  const [custom, setCustom] = useState(isNew ? false : !job.templateId);
  const [totalValue, setTotalValue] = useState(job?.totalValue ?? 0);
  const [departmentValue, setDepartmentValue] = useState(job?.departmentValue ?? 0);
  const [percentComplete, setPercentComplete] = useState(job?.percentComplete ?? 0);
  const [bcJobNo, setBcJobNo] = useState(job?.bcJobNo || '');
  const [bcJobTaskNo, setBcJobTaskNo] = useState(job?.bcJobTaskNo || '');
  const [search, setSearch] = useState('');
  // '' (no category filter applied yet) when no template is selected, vs.
  // the real 'Uncategorised' bucket once a found template's own category is
  // blank — those are different states: the first means nothing's been
  // picked, the second means something was picked and genuinely has no
  // category (see templateCategories() below, which buckets those there).
  const [category, setCategory] = useState(() => {
    const t = templates.find((x) => x.id === templateId);
    return t ? (t.category || 'Uncategorised') : '';
  });
  const [staffId, setStaffId] = useState(job?.staffId || '');
  // A second person riding along on the job above — most often a trainee
  // shadowing whoever's actually doing the work. Only ever meaningful
  // alongside a primary (staffId); clearing staffId clears this too, below.
  // Deliberately lightweight — see "Two-person jobs" in scheduler/CLAUDE.md:
  // it's a pure post-check on the placement the primary already gets, not a
  // second slot the scheduler searches for, so it never needs its own sign-off
  // or its own eligibility list.
  const [secondStaffId, setSecondStaffId] = useState(job?.secondStaffId || '');
  const [tags, setTags] = useState(job?.tags || (job ? [] : (templates.find((t) => t.id === templateId) || {}).tags) || []);
  const [procedureId, setProcedureId] = useState(job?.procedureId || (job ? '' : (templates.find((t) => t.id === templateId) || {}).procedureId) || '');
  // A soft nudge, not a pin — deliberately its own field, independent of
  // manualEquipId/manualStartDate below. Those two build a hard placement
  // (exact day, no operator picked automatically); this only ever narrows
  // which machine the scheduler tries first, so conflating the two would
  // mean a template's preferred equipment (or picking one here) could
  // silently force-pin a job the user never asked to lock down.
  const [preferredEquipmentId, setPreferredEquipmentId] = useState(job?.preferredEquipmentId || (job ? '' : (templates.find((t) => t.id === templateId) || {}).preferredEquipmentId) || '');
  // A hard restriction, but a lighter one than manualEquipId/manualStartDate
  // below: it confines the job to one machine — the scheduler will not place
  // it anywhere else, and waits for that machine rather than quietly using a
  // free one, same as job.staffId does for a person — but still picks the day
  // and the operator automatically, same as an ordinary unpinned job. Neither
  // the full pin (which also fixes the day and stops the operator moving) nor
  // preferredEquipmentId (which only narrows the scheduler's first choice and
  // falls back freely) covers that middle case on its own.
  const [lockedEquipmentId, setLockedEquipmentId] = useState(job?.lockedEquipmentId || '');
  // Equipment/start date shown here reflect wherever the job currently sits
  // (auto-placed or pinned) — editing either is equivalent to dragging the
  // job on the Schedule view (#28), so it only actually re-pins the job if
  // one of them is genuinely changed from what's already there; otherwise an
  // auto-placed job is left free to keep moving on future recomputes just by
  // having had this modal opened and saved.
  const origEquipId = job?.assignment?.equipmentId || '';
  const origStartDate = job?.assignment?.startDate || '';
  const [manualEquipId, setManualEquipId] = useState(origEquipId);
  const [manualStartDate, setManualStartDate] = useState(origStartDate);

  const templateCategories = () => { const s = new Set(); templates.forEach((t) => s.add(t.category || 'Uncategorised')); return [...s].sort(); };
  const matchTemplates = (q) => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return templates.filter((t) => { const hay = `${t.name} ${t.category || ''} ${t.process || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  };

  function applyTemplate(id) {
    const prevTemplate = templates.find((x) => x.id === templateId);
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) {
      // Only fill the name for a NEW job whose name is still untouched (empty
      // or still the previously selected template's name) — never rename an
      // existing job or clobber a customised description.
      if (isNew && (!name.trim() || name === (prevTemplate?.name || ''))) setName(t.name);
      setProcess(t.process);
      setHoursPerUnit(t.hoursPerUnit);
      setTags(t.tags || []);
      setProcedureId(t.procedureId || '');
      setPreferredEquipmentId(t.preferredEquipmentId || '');
      if (t.totalValuePerUnit) setTotalValue(Math.round(t.totalValuePerUnit * quantity * 100) / 100);
      if (t.departmentValuePerUnit) setDepartmentValue(Math.round(t.departmentValuePerUnit * quantity * 100) / 100);
    }
  }

  function handleQuantityChange(q) {
    setQuantity(q);
    const t = templates.find((x) => x.id === templateId);
    if (!custom && t) {
      if (t.totalValuePerUnit) setTotalValue(Math.round(t.totalValuePerUnit * Number(q) * 100) / 100);
      if (t.departmentValuePerUnit) setDepartmentValue(Math.round(t.departmentValuePerUnit * Number(q) * 100) / 100);
    }
  }

  const valueWarning = Number(departmentValue) > Number(totalValue) && Number(totalValue) > 0;

  // Who could be put on this job, and who the scheduler has on it right now
  // (across every part, for a split job).
  const qualifiedStaff = staff.filter((s) => s.processes.includes(process));
  // Same process+tag test the scheduler itself applies (tagOk) — the only
  // equipment this job could actually land on, same as what a drag onto the
  // Schedule view would accept.
  const qualifiedEquip = equipment.filter((e) => e.processes.includes(process) && tagOk({ tags }, e));
  const currentlyOn = useMemo(() => {
    const assignments = job?.parts ? job.parts.map((p) => p.assignment) : [job?.assignment];
    const ids = new Set();
    assignments.forEach((a) => (a?.days || []).forEach((d) => d.staffId && ids.add(d.staffId)));
    return [...ids].map((id) => staff.find((s) => s.id === id)?.name).filter(Boolean);
  }, [job, staff]);

  // Turns the Equipment/Planned start date fields below into an assignment,
  // the same shape handleDrop builds for a drag-and-drop reassignment —
  // editing these fields IS a manual placement, not a separate mechanism
  // (#28). Left untouched, the job keeps exactly whatever assignment it
  // already had (pinned or auto); cleared back to "Automatic" it unpins a
  // pinned job but otherwise leaves an auto-placed one to recompute as
  // normal. Split jobs place each part independently, so this only applies
  // to the job's own (non-split) assignment.
  function computeAssignment() {
    if (parts) return job?.assignment || null;
    if (!manualEquipId) {
      return job?.assignment?.pinned ? { ...job.assignment, pinned: false } : (job?.assignment || null);
    }
    // No ready date and no explicit planned start picked leaves nothing to
    // pin to (#59) — a blank string isn't a real date, and this job isn't
    // meant to be scheduled at all yet, so picking equipment alone can't
    // manufacture a placement out of it. Falls back to whatever the job
    // already had rather than silently doing nothing on Save.
    const startDate = manualStartDate || readyDate;
    if (!startDate) return job?.assignment || null;
    if (manualEquipId === origEquipId && manualStartDate === origStartDate) return job?.assignment || null;
    return {
      equipmentId: manualEquipId,
      startDate,
      endDate: startDate,
      pinned: true,
      conflict: false,
      days: [],
      seedStaffId: primaryStaffOf(job?.assignment || null),
    };
  }

  // The per-part equivalent of computeAssignment above, same reasoning: the
  // Equipment + Planned start date fields on a part ARE a manual placement,
  // built the same shape a drag onto that part would (#68) — this is what
  // finally gives the modal a way to pin a part's equipment at all, rather
  // than only via dragging it on the Schedule view.
  function computePartAssignment(part) {
    if (!part.manualEquipId) {
      return part.assignment?.pinned ? { ...part.assignment, pinned: false } : (part.assignment || null);
    }
    const startDate = part.manualStartDate || readyDate;
    if (!startDate) return part.assignment || null;
    if (part.manualEquipId === part._origEquipId && part.manualStartDate === part._origStartDate) return part.assignment || null;
    return {
      equipmentId: part.manualEquipId,
      startDate,
      endDate: startDate,
      pinned: true,
      conflict: false,
      days: [],
      seedStaffId: primaryStaffOf(part.assignment || null),
    };
  }

  function handleSave() {
    const hoursTotal = Math.round(quantity * hoursPerUnit * 100) / 100;
    const data = {
      id: job?.id || uid('job'),
      name: name.trim() || 'Untitled job',
      process,
      quantity: Number(quantity) || 1,
      readyDate,
      dueDate,
      departmentDueDate: departmentDueDate || null,
      needsFurtherProcessing,
      parallelProcessing,
      templateId: custom ? null : templateId,
      notes,
      totalValue: Number(totalValue) || 0,
      departmentValue: Number(departmentValue) || 0,
      tags,
      procedureId,
      staffId: staffId || null,
      // Never saved without a primary to anchor it — the engine already
      // guards this too (attachSecondStaff only runs when both are set), but
      // clearing it here as well means a job that once had a training pair
      // and then had its primary cleared doesn't keep a dangling, invisible
      // secondStaffId that would silently reappear the moment someone new is
      // assigned as primary.
      secondStaffId: staffId && secondStaffId ? secondStaffId : null,
      preferredEquipmentId: preferredEquipmentId || null,
      lockedEquipmentId: lockedEquipmentId || null,
      actualHours: job?.actualHours,
      bcJobNo: bcJobNo.trim(),
      bcJobTaskNo: bcJobTaskNo.trim(),
      completedDate: job?.completedDate || null,
      // Not editable from this modal — joining/leaving a batch happens from
      // the Backlog row instead — so carried straight through untouched.
      // Without this, saving ANY edit here (this modal builds its `data`
      // object from scratch rather than merging into the existing job)
      // silently dropped a job out of its batch, since the fresh object
      // never had these fields to begin with (#59).
      batchId: job?.batchId ?? null,
      batchOrder: job?.batchOrder ?? null,
      // Same trap, same fix as batchId/batchOrder just above: not editable
      // from this modal (a rework is created via "Mark for rework" on the
      // ORIGINAL job, never toggled here), so it has to be carried through
      // explicitly or it silently vanishes the moment ANY field on the
      // rework job is edited and saved — the rework quietly turns into an
      // ordinary job, disappearing from the Quality tab and losing its link
      // back to the original with no error or warning. Reported from
      // testing: adding a procedure to a rework job and saving was enough
      // to trigger it.
      isRework: job?.isRework || false,
      reworkOfJobId: job?.reworkOfJobId ?? null,
      assignment: computeAssignment(),
      // hoursTotal/percentComplete/status are derived from parts by the
      // scheduler on the very next recompute when the job is split, but set
      // sensible values here too in case anything reads them first.
      hoursTotal: parts ? parts.reduce((s, p) => s + (p.hoursTotal || 0), 0) : hoursTotal,
      percentComplete: parts
        ? Math.round(parts.reduce((s, p) => s + (p.percentComplete || 0) * (p.hoursTotal || 0), 0) / Math.max(1, parts.reduce((s, p) => s + (p.hoursTotal || 0), 0)))
        : Math.max(0, Math.min(100, Number(percentComplete) || 0)),
      status: parts ? (parts.every((p) => p.status === 'complete') ? 'complete' : 'active') : (job?.status || 'active'),
      // Built explicitly, not a plain `{ ...p }` spread (#68): `p` here also
      // carries the UI-only scratch fields the parts editor uses
      // (manualEquipId/manualStartDate/_origEquipId/_origStartDate — see the
      // `parts` state init above), which must not leak into the stored
      // shape. `assignment` is computed fresh via computePartAssignment so a
      // part's Equipment/Planned start date fields actually take effect,
      // same as the whole-job Equipment fields already do via
      // computeAssignment.
      parts: parts ? parts.map((p) => ({
        id: p.id,
        name: p.name,
        hoursTotal: p.hoursTotal,
        percentComplete: p.percentComplete,
        status: p.status,
        staffId: p.staffId || null,
        // Same guard as the whole-job field — never saved without that same
        // part's own staffId to anchor it.
        secondStaffId: p.staffId && p.secondStaffId ? p.secondStaffId : null,
        lockedEquipmentId: p.lockedEquipmentId || null,
        assignment: computePartAssignment(p),
      })) : null,
    };
    onSave(data);
  }

  return (
    <Modal title={isNew ? 'New job' : 'Edit job'} onClose={onClose} size="lg">
      {!parts && !custom && templates.length > 0 && (
        <Section title="Template" defaultOpen={isNew}>
          <Field label="Search templates">
            <input
              className={inputCls}
              value={search}
              onChange={(e) => {
                const v = e.target.value; setSearch(v);
                if (v.trim()) { const m = matchTemplates(v); if (m.length && !m.some((t) => t.id === templateId)) applyTemplate(m[0].id); }
                else {
                  const t = templates.find((x) => x.id === templateId);
                  setCategory(t ? (t.category || 'Uncategorised') : '');
                }
              }}
              placeholder="Keyword search across name, category and process…"
            />
          </Field>
          {search.trim() ? (
            matchTemplates(search).length ? (
              <Field label={`Matching templates (${matchTemplates(search).length})`}>
                <select className={inputCls} value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">— Select a template —</option>
                  {matchTemplates(search).map((t) => <option key={t.id} value={t.id}>{t.name} — {t.category || 'Uncategorised'}</option>)}
                </select>
              </Field>
            ) : <p className="text-xs text-slate-500 mb-3">No templates match that search.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <select className={inputCls} value={category} onChange={(e) => {
                  const c = e.target.value; setCategory(c);
                  const ts = templates.filter((t) => (t.category || 'Uncategorised') === c);
                  if (ts.length && !ts.some((t) => t.id === templateId)) applyTemplate(ts[0].id);
                }}>
                  <option value="">— Select a category —</option>
                  {templateCategories().map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Template">
                <select className={inputCls} value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">— Select a template —</option>
                  {templates.filter((t) => (t.category || 'Uncategorised') === category).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            </div>
          )}
        </Section>
      )}
      {!parts && templates.length > 0 && (
        <button type="button" className="text-xs text-amber-400 mb-3 hover:underline" onClick={() => setCustom((c) => !c)}>
          {custom ? 'Use a template instead' : 'Set up a custom (one-off) job instead'}
        </button>
      )}

      <div className="grid md:grid-cols-2 gap-x-4">
        <div>
          <Field label="Job name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field label="Capability requirements (optional)">
            <TagEditor value={tags} onChange={setTags} suggestions={[...new Set([...equipment.flatMap((e) => e.tags || []), ...templates.flatMap((t) => t.tags || [])])].sort()} />
            <p className="text-xs text-slate-500 mt-1">This job will only be scheduled on — or allowed to be dragged onto — equipment carrying every tag.</p>
          </Field>

          {(parts || custom) && (
            <Field label="Welding / coating process">
              <select
                className={inputCls} value={process}
                onChange={(e) => {
                  const nv = e.target.value; setProcess(nv);
                  // A procedure belongs to one process — carrying the old
                  // one across a process change would price the job against
                  // the wrong process's rate, same reasoning as TaskModal's
                  // process select.
                  if (!procedures.some((p) => p.id === procedureId && p.process === nv)) setProcedureId('');
                }}
              >
                {processes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
          )}

          {!parts && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Quantity">
                  <input type="number" min={1} className={inputCls} value={quantity} onChange={(e) => handleQuantityChange(e.target.value)} />
                </Field>
                <Field label="Hours per unit">
                  <input type="number" min={0.1} step={0.1} className={inputCls} value={hoursPerUnit} onChange={(e) => setHoursPerUnit(e.target.value)} />
                </Field>
              </div>
              <p className="text-xs text-slate-500 -mt-2 mb-3">Total: {Math.round(quantity * hoursPerUnit * 100) / 100} hours</p>
            </>
          )}

          <Field label="Notes">
            <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        <div>
          <Section title="Scheduling">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Ready for processing">
                <input type="date" className={inputCls} value={readyDate} onChange={(e) => setReadyDate(e.target.value)} />
              </Field>
              <Field label="Due date">
                <input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
            </div>
            <p className="text-xs text-slate-500 -mt-2 mb-3">
              {readyDate
                ? "The job will never be auto-scheduled — or allowed to be dragged — before this date, since materials/prior-stage work won't be in your department yet."
                : "Blank means not confirmed ready yet — the job will sit out of scheduling entirely (it won't be auto-placed or draggable) until a date is set."}
            </p>

            {/* Optional and separate from the due date above on purpose (#44):
                that date is when the client (or an end-of-month target) needs
                the finished job — not necessarily when THIS department needs
                to be done with it, if there's further scope after us. Setting
                this is what actually makes that earlier, so the scheduler
                treats it as binding instead of just the same-due-date
                needsFurtherProcessing tie-break below. */}
            <Field label="Department due date (optional)">
              <input type="date" className={inputCls} value={departmentDueDate} onChange={(e) => setDepartmentDueDate(e.target.value)} />
            </Field>
            <p className="text-xs text-slate-500 -mt-2 mb-3">
              {departmentDueDate
                ? `This department is scheduling to ${fmtDate(departmentDueDate)}, not the ${fmtDate(dueDate)} client/target date above — there's scope after us and that's when we actually need to be finished.`
                : "Leave blank if the due date above is also when this department needs to be finished. Set this only when there's further scope after us and our own deadline is earlier."}
            </p>

            <label className="flex items-start gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                className="accent-amber-500 mt-0.5"
                checked={needsFurtherProcessing}
                onChange={(e) => setNeedsFurtherProcessing(e.target.checked)}
              />
              <span className="text-sm text-slate-300">
                Needs further processing after this department
                <span className="block text-xs text-slate-500">Machining, manual work, etc. Scheduled ahead of a job with the same due date that ships straight from here.</span>
              </span>
            </label>

            {/* Parallel processing (#30). Off by default — the scheduler never
                double-books an operator on its own. Turning this on lets the
                job share its operator with whatever else it lands alongside, on
                any equipment, not just whichever job it happens to conflict with
                first; that's also what "Allow parallel processing on…" in the
                overbooked-conflict prompt sets. */}
            <label className="flex items-start gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                className="accent-amber-500 mt-0.5"
                checked={parallelProcessing}
                onChange={(e) => setParallelProcessing(e.target.checked)}
              />
              <span className="text-sm text-slate-300">
                Allow parallel processing
                <span className="block text-xs text-slate-500">Automated enough that an operator can mind another job on different equipment at the same time. Lets this job share an operator instead of being flagged as overbooked.</span>
              </span>
            </label>

            {/* Equipment + planned start date — the same information a drag onto
                the Schedule view sets, editable straight from here (#28) instead of
                requiring the job to be visible on-screen to move it. Only equipment
                matching the process + capability requirements above is offered,
                same as what a drag would accept. Not shown for a split job — each
                part is placed independently, in its own section below. */}
            {!parts && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Equipment">
                  <select className={inputCls} value={manualEquipId} onChange={(e) => {
                    const v = e.target.value; setManualEquipId(v);
                    if (v && !manualStartDate) setManualStartDate(readyDate);
                  }}>
                    <option value="">Automatic — best available</option>
                    {qualifiedEquip.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    {manualEquipId && !qualifiedEquip.some((e) => e.id === manualEquipId) && (
                      <option value={manualEquipId}>
                        {equipment.find((e) => e.id === manualEquipId)?.name || 'Former equipment'} — no longer compatible
                      </option>
                    )}
                  </select>
                </Field>
                <Field label="Planned start date">
                  <input
                    type="date" className={inputCls} min={readyDate} disabled={!manualEquipId}
                    value={manualStartDate} onChange={(e) => setManualStartDate(e.target.value)}
                  />
                </Field>
              </div>
            )}
            {!parts && (
              <p className="text-xs text-slate-500 -mt-2 mb-3">
                {manualEquipId
                  ? `Pinned to ${equipment.find((e) => e.id === manualEquipId)?.name || 'this equipment'} starting ${fmtDate(manualStartDate || readyDate)} on Save — same as dragging it there on the Schedule view. Won't move until this is changed or unpinned.`
                  : 'The scheduler will pick whichever compatible, free equipment fits it in soonest.'}
              </p>
            )}

            {/* Locked equipment: a hard restriction, but not a pin — the
                middle ground between the Equipment field above (which also
                fixes the exact day and stops the operator moving) and
                Preferred equipment below (which is only a nudge and falls
                back freely). The scheduler will only ever place this job on
                the locked machine — waiting for it rather than quietly using
                a free one, same as job.staffId does for a person — but the
                day and the operator are still picked and kept up to date
                automatically, same as any other unpinned job. If the locked
                machine genuinely can't take it in the horizon, the job lands
                in "Needs scheduling" naming the machine, same as a manually
                assigned job would name an unavailable person. */}
            {!parts && (
              <Field label="Locked equipment (optional)">
                <select className={inputCls} value={lockedEquipmentId} onChange={(e) => setLockedEquipmentId(e.target.value)}>
                  <option value="">Not locked — any compatible equipment</option>
                  {qualifiedEquip.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  {lockedEquipmentId && !qualifiedEquip.some((e) => e.id === lockedEquipmentId) && (
                    <option value={lockedEquipmentId}>
                      {equipment.find((e) => e.id === lockedEquipmentId)?.name || 'Former equipment'} — no longer compatible
                    </option>
                  )}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  {lockedEquipmentId
                    ? `Locked to ${equipment.find((e) => e.id === lockedEquipmentId)?.name || 'this equipment'} — the job waits for it instead of moving to whatever's free, but the scheduler still chooses the day and the operator.`
                    : 'Confines the job to one machine (waits for it rather than using another) without fixing the day or operator like the Equipment field above.'}
                </p>
              </Field>
            )}

            {/* Preferred equipment: a soft nudge, not a pin (unlike the two
                fields above). Some jobs can technically run on any compatible
                machine but are better suited to one in particular — this
                narrows the scheduler's choice to it when possible without
                fixing the day or operator. If that machine genuinely can't
                take it (booked solid, no longer compatible), the job is
                auto-placed on the best available alternative instead and
                flagged for review on the Schedule view rather than left
                unscheduled. Also settable as a default on the job's template
                (TemplateModal) — picking a template here copies it across,
                same as tags/process. */}
            {!parts && (
              <Field label="Preferred equipment (optional)">
                <select className={inputCls} value={preferredEquipmentId} onChange={(e) => setPreferredEquipmentId(e.target.value)}>
                  <option value="">No preference — any compatible equipment</option>
                  {qualifiedEquip.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  {preferredEquipmentId && !qualifiedEquip.some((e) => e.id === preferredEquipmentId) && (
                    <option value={preferredEquipmentId}>
                      {equipment.find((e) => e.id === preferredEquipmentId)?.name || 'Former equipment'} — no longer compatible
                    </option>
                  )}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  {preferredEquipmentId
                    ? "The scheduler will try this machine first when placing the job, without pinning its day or operator. If it can't, the job goes to the best available alternative instead and is flagged for review."
                    : "Set this when a job can run on several machines but is better suited to one — doesn't pin the day or operator like the Equipment field above."}
                </p>
              </Field>
            )}

            {/* Manual staff assignment. Normally the scheduler picks whoever is free
                and signed off on the process; naming someone here overrides that for
                this job — it waits for them rather than handing the work to anyone
                else, and won't quietly swap them out when the schedule is recomputed
                or the job is dragged onto other equipment. Not shown for a split job
                (#68) — each part has its own "Assigned to" in the Parts section
                below, since two parts of the same job can genuinely need two
                different people. This field used to sit here unguarded and silently
                lock BOTH parts to the same person, which is what read on the shop
                floor as "changing one part's person changes the other's". */}
            {!parts && (
              <Field label="Assigned to">
                <select className={inputCls} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                  <option value="">Automatic — whoever is free</option>
                  {qualifiedStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  {/* A lock on someone who has since lost the sign-off (or on a job whose
                      process changed) stays selectable, so it's visible rather than
                      silently reverting to automatic. */}
                  {staffId && !qualifiedStaff.some((s) => s.id === staffId) && (
                    <option value={staffId}>
                      {staff.find((s) => s.id === staffId)?.name || 'Former staff member'} — not signed off on {process || 'this process'}
                    </option>
                  )}
                </select>
              </Field>
            )}
            {!parts && (
              <p className="text-xs text-slate-500 -mt-2 mb-3">
                {staffId
                  ? `Locked to ${staff.find((s) => s.id === staffId)?.name || 'this person'} — the job waits for them instead of going to whoever is free, and stays with them if you move it to other equipment.`
                  : currentlyOn.length
                  ? `Currently on it: ${currentlyOn.join(', ')}. Pick a name to keep the job with one person regardless of how the rest of the schedule reflows.`
                  : 'The scheduler will pick whoever is signed off on this process and has the hours free.'}
              </p>
            )}

            {/* A second person on the job at the same time — most often a
                trainee shadowing whoever's assigned above. Only offered once
                a primary is named: a "second" person means nothing without a
                first to be second TO. Deliberately every other staff member,
                not just qualifiedStaff — this is exactly the case where the
                person genuinely ISN'T signed off yet. Their time is still
                blocked for the job's days (they can't be double-booked
                elsewhere), it's only the sign-off check that's skipped. */}
            {!parts && staffId && (
              <Field label="Training partner (optional)">
                <select className={inputCls} value={secondStaffId} onChange={(e) => setSecondStaffId(e.target.value)}>
                  <option value="">No one else — just {staff.find((s) => s.id === staffId)?.name || 'this person'}</option>
                  {staff.filter((s) => s.id !== staffId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  {secondStaffId
                    ? `${staff.find((s) => s.id === secondStaffId)?.name || 'This person'} is also blocked out for the job's days, alongside ${staff.find((s) => s.id === staffId)?.name || 'the assigned person'} — no sign-off on ${process || 'the process'} required.`
                    : 'For training: a second person present the whole time, without needing to be signed off yet.'}
                </p>
              </Field>
            )}

            {!parts && !isNew && (
              <Field label={`% complete — ${percentComplete}%`}>
                <input type="range" min={0} max={100} step={5} value={percentComplete} onChange={(e) => setPercentComplete(e.target.value)} className="w-full accent-amber-500" />
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden mt-1">
                  <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${percentComplete}%` }} />
                </div>
              </Field>
            )}

            {/* The daily log (TimeLogModal) had nowhere this actually showed
                up afterward — logging hours against a job produced no
                visible confirmation anywhere the job itself was reviewed.
                Shown for any existing job, active or complete, not hidden
                at 0h the way the Backlog's subtext is: the point here is
                confirming the log is working, which is exactly the case
                where "nothing shows" is most confusing. */}
            {!parts && !isNew && (
              <Field label="Hours logged">
                {(() => {
                  const lg = loggedHours(timeLog, job.id);
                  const usedForCost = job.status === 'complete' && Number(job.actualHours) > 0 ? Number(job.actualHours) : null;
                  return (
                    <div className="text-sm">
                      <span className={`font-mono ${lg > job.hoursTotal ? 'text-amber-400' : 'text-slate-200'}`}>{lg}h</span>
                      <span className="text-slate-500 text-xs"> logged day-by-day, against {job.hoursTotal}h estimated</span>
                      {usedForCost != null && (
                        <p className="text-xs text-slate-500 mt-1">
                          This job is complete — cost below is calculated from the recorded actual hours,{' '}
                          <span className="font-mono text-slate-300">{usedForCost}h</span>
                          {usedForCost !== lg ? ', adjusted from the daily log total when it was marked complete' : ''}.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </Field>
            )}
          </Section>

          <Section title="Value & costing">
            {/* Independent of the Template section above — templates set this
                as a starting point (applyTemplate copies template.procedureId
                across, same as tags/hours), but it's an ordinary field from
                there, editable regardless of whether the job has a template
                at all. A custom (one-off) job, or a template-less shop that
                never uses templates, previously had no way to get a
                procedureId onto a job at all, which meant jobCost() always
                came back null for it — cost tracking silently required a
                template even though nothing else about it does. */}
            <Field label="Procedure — for cost (optional)">
              <select className={inputCls} value={procedureId} onChange={(e) => setProcedureId(e.target.value)} disabled={!process}>
                <option value="">None</option>
                {procedures.filter((p) => p.process === process).map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(procedureCost(p, costCentres))}/hr</option>)}
              </select>
              {!process && <p className="text-xs text-slate-500 mt-1">Pick a process first — a procedure is specific to one.</p>}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Total job value ($)">
                <input type="number" min={0} step={1} className={inputCls} value={totalValue} onChange={(e) => setTotalValue(e.target.value)} />
              </Field>
              <Field label="Value of your department's work ($)">
                <input type="number" min={0} step={1} className={inputCls} value={departmentValue} onChange={(e) => setDepartmentValue(e.target.value)} />
                <DirtyButton
                  className="text-[11px] text-amber-400 hover:underline mt-1"
                  onClick={() => setDepartmentValue(totalValue)}
                >
                  100% to department
                </DirtyButton>
              </Field>
            </div>
            {valueWarning && (
              <p className="text-xs text-amber-400 -mt-2 mb-3 flex items-center gap-1"><AlertTriangle size={12} /> Department value is higher than the total job value — double check these numbers.</p>
            )}

            {procedureId && (() => {
              const proc = procedures.find((p) => p.id === procedureId);
              if (!proc) return null;
              // Blended, not the procedure's raw $/hr — matches jobCost()
              // elsewhere, since scheduled hours aren't all productive
              // process time. See effectiveHourlyRate.
              const rate = effectiveHourlyRate(proc, costCentres, costSettings);
              const estHrs = Math.round((Number(quantity) || 0) * (Number(hoursPerUnit) || 0) * 100) / 100;
              // Once the job is complete, cost is (and always was, via
              // jobCost()/jobHoursForCost() elsewhere) calculated from the
              // recorded actual hours, not the estimate — but THIS preview
              // used to always multiply by quantity × hoursPerUnit
              // regardless, so a completed job's own modal kept showing
              // "cost = rate × predicted hours" even though the real
              // jobCost() used for Quality/Value Reports/everywhere else
              // had already moved on to the actual figure. Reported from
              // testing as the cost breakdown not being trustworthy.
              const actualHrs = job?.status === 'complete' && Number(job?.actualHours) > 0 ? Number(job.actualHours) : null;
              const hrsForCost = actualHrs != null ? actualHrs : estHrs;
              const cost = rate * hrsForCost;
              const dep = Number(departmentValue) || 0;
              const margin = dep - cost;
              return (
                <div className="rounded-md border border-slate-700 bg-slate-800/60 p-3 text-xs">
                  <div className="flex justify-between text-slate-400">
                    <span>Cost — {fmtMoney(rate)}/hr × {hrsForCost}h{actualHrs != null ? ' (actual)' : ' (estimated)'}</span>
                    <span className="font-mono text-slate-200">{fmtMoney(cost)}</span>
                  </div>
                  <div className="flex justify-between text-slate-400 mt-1"><span>Your department value</span><span className="font-mono text-slate-200">{fmtMoney(dep)}</span></div>
                  <div className="flex justify-between mt-1 pt-1 border-t border-slate-700">
                    <span className="text-slate-300 font-medium">{margin >= 0 ? 'Estimated margin' : 'Estimated loss'}</span>
                    <span className={`font-mono font-semibold ${margin >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtMoney(margin)}</span>
                  </div>
                </div>
              );
            })()}
          </Section>
        </div>
      </div>

      {parts && (
        <div className="mb-3">
          <span className="block text-xs font-medium text-slate-400 mb-1.5 tracking-wide uppercase">
            Parts — pulled off before completion, tracked separately
          </span>
          <div className="space-y-2">
            {parts.map((part, i) => (
              <div key={part.id} className="bg-slate-800/50 border border-slate-700 rounded-md p-2.5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Part {i + 1}</span>
                  <button
                    type="button"
                    className="text-[11px] text-amber-400 hover:underline flex items-center gap-1"
                    onClick={() => setParts((ps) => ps.map((p, pi) => (pi === i ? { ...p, status: p.status === 'complete' ? 'active' : 'complete', percentComplete: p.status === 'complete' ? p.percentComplete : 100 } : p)))}
                  >
                    <CircleCheck size={12} /> {part.status === 'complete' ? 'Mark active' : 'Mark complete'}
                  </button>
                </div>
                <Field label="Name">
                  <input
                    type="text"
                    className={inputCls}
                    // Parts saved before this field existed have no `name` —
                    // fall back to the label they used to be shown under, so
                    // the box isn't blank the first time an old split job is
                    // reopened. Editing it here is real from now on, not a
                    // label recomputed from the parent's name (#18).
                    value={part.name ?? `${name || 'Untitled job'} (Part ${i + 1})`}
                    onChange={(e) => setParts((ps) => ps.map((p, pi) => (pi === i ? { ...p, name: e.target.value } : p)))}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2 items-end">
                  <Field label="Hours">
                    <input
                      type="number" min={0} step={0.5} className={inputCls}
                      value={part.hoursTotal}
                      onChange={(e) => setParts((ps) => ps.map((p, pi) => (pi === i ? { ...p, hoursTotal: Number(e.target.value) || 0 } : p)))}
                    />
                  </Field>
                  <div className="pb-2">
                    <span className="block text-xs font-medium text-slate-400 mb-1 tracking-wide uppercase">{`% complete — ${part.percentComplete}%`}</span>
                    <input
                      type="range" min={0} max={100} step={5} className="w-full accent-amber-500"
                      value={part.percentComplete}
                      onChange={(e) => setParts((ps) => ps.map((p, pi) => (pi === i ? { ...p, percentComplete: Number(e.target.value) } : p)))}
                    />
                  </div>
                </div>
                {/* Equipment + Planned start date, Assigned to, and Locked
                    equipment — the per-part equivalents of the whole-job
                    fields above (#68). Before this a split job's parts could
                    only be pinned by dragging them on the Schedule view, and
                    had no independent staff/lock controls at all — the
                    single whole-job "Assigned to" silently applied to both
                    parts identically. `qualifiedEquip`/`qualifiedStaff` are
                    shared across parts on purpose: process and capability
                    tags are properties of the WORK, same for every part of
                    it (see scheduler.js), so the same two lists that gate
                    the whole job's own fields are exactly right here too. */}
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <Field label="Equipment">
                    <select
                      className={inputCls} value={part.manualEquipId}
                      onChange={(e) => {
                        const v = e.target.value;
                        setParts((ps) => ps.map((p, pi) => (pi === i
                          ? { ...p, manualEquipId: v, manualStartDate: v && !p.manualStartDate ? readyDate : p.manualStartDate }
                          : p)));
                      }}
                    >
                      <option value="">Automatic — best available</option>
                      {qualifiedEquip.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                      {part.manualEquipId && !qualifiedEquip.some((e) => e.id === part.manualEquipId) && (
                        <option value={part.manualEquipId}>
                          {equipment.find((e) => e.id === part.manualEquipId)?.name || 'Former equipment'} — no longer compatible
                        </option>
                      )}
                    </select>
                  </Field>
                  <Field label="Planned start date">
                    <input
                      type="date" className={inputCls} min={readyDate} disabled={!part.manualEquipId}
                      value={part.manualStartDate}
                      onChange={(e) => setParts((ps) => ps.map((p, pi) => (pi === i ? { ...p, manualStartDate: e.target.value } : p)))}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <Field label="Assigned to">
                    <select
                      className={inputCls} value={part.staffId}
                      onChange={(e) => setParts((ps) => ps.map((p, pi) => (pi === i ? { ...p, staffId: e.target.value } : p)))}
                    >
                      <option value="">Automatic</option>
                      {qualifiedStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      {part.staffId && !qualifiedStaff.some((s) => s.id === part.staffId) && (
                        <option value={part.staffId}>
                          {staff.find((s) => s.id === part.staffId)?.name || 'Former staff member'} — not signed off
                        </option>
                      )}
                    </select>
                  </Field>
                  <Field label="Locked equipment">
                    <select
                      className={inputCls} value={part.lockedEquipmentId}
                      onChange={(e) => setParts((ps) => ps.map((p, pi) => (pi === i ? { ...p, lockedEquipmentId: e.target.value } : p)))}
                    >
                      <option value="">Not locked</option>
                      {qualifiedEquip.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                      {part.lockedEquipmentId && !qualifiedEquip.some((e) => e.id === part.lockedEquipmentId) && (
                        <option value={part.lockedEquipmentId}>
                          {equipment.find((e) => e.id === part.lockedEquipmentId)?.name || 'Former equipment'} — no longer compatible
                        </option>
                      )}
                    </select>
                  </Field>
                </div>
                {/* Per-part training partner — same reasoning as the
                    whole-job field above, scoped to just this part. Only
                    offered once THIS part has its own primary. */}
                {part.staffId && (
                  <Field label="Training partner (optional)">
                    <select
                      className={inputCls} value={part.secondStaffId}
                      onChange={(e) => setParts((ps) => ps.map((p, pi) => (pi === i ? { ...p, secondStaffId: e.target.value } : p)))}
                    >
                      <option value="">No one else</option>
                      {staff.filter((s) => s.id !== part.staffId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </Field>
                )}
                <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-1.5">
                  <span>
                    {part.manualEquipId
                      ? `Pinned to ${equipment.find((e) => e.id === part.manualEquipId)?.name || 'this equipment'} starting ${fmtDate(part.manualStartDate || readyDate)} on Save.`
                      : part.assignment
                      ? `Scheduled ${fmtDate(part.assignment.startDate)}–${fmtDate(part.assignment.endDate)}${part.assignment.conflict ? ' · Overbooked' : ''}`
                      : part.status === 'complete' ? 'Complete' : 'Not yet scheduled'}
                  </span>
                  {part.assignment?.pinned && onUnpinPart && (
                    // Same as the equivalent whole-job button: unpins immediately
                    // and closes the modal (see onUnpinPart wiring), rather than
                    // waiting on Save — so there's no pending-pin-fields state in
                    // this modal to reconcile against it.
                    <button type="button" className="text-amber-400 hover:underline flex items-center gap-0.5" onClick={() => onUnpinPart(i)}>
                      <PinOff size={11} /> Unpin
                    </button>
                  )}
                </p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-1.5">
            Total {Math.round(parts.reduce((s, p) => s + (p.hoursTotal || 0), 0) * 100) / 100}h · each part is scheduled independently and can land on different equipment or times.
          </p>
          {onMerge && (
            <button type="button" className="text-xs text-amber-400 mt-2 hover:underline" onClick={onMerge}>
              Merge parts back into one job
            </button>
          )}
        </div>
      )}

      {!parts && !isNew && onSplit && (
        <Section title="Split job into two parts" defaultOpen={false}>
          <p className="text-[11px] text-slate-500 mb-2">
            For when this job has to come off before it's done — e.g. an urgent job needs the cell.
            The remaining hours become a separate, independently-schedulable part; both still count as one job here and on the Backlog.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hours for part 1">
              <input
                type="number" min={0} max={job?.hoursTotal ?? 0} step={0.5} className={inputCls}
                value={splitHoursA}
                onChange={(e) => setSplitHoursA(e.target.value)}
              />
            </Field>
            <Field label="Hours for part 2">
              <input type="number" className={`${inputCls} opacity-60`} value={Math.max(0, Math.round(((job?.hoursTotal ?? 0) - Number(splitHoursA)) * 100) / 100)} disabled />
            </Field>
          </div>
          <button type="button" className={btnPrimary} onClick={() => onSplit(splitHoursA)}>Split</button>
        </Section>
      )}

      <Section title="Business Central linking (optional)" defaultOpen={!!(job?.bcJobNo || job?.bcJobTaskNo)}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="BC Job No.">
            <input className={inputCls} value={bcJobNo} onChange={(e) => setBcJobNo(e.target.value)} placeholder="e.g. J00120" />
          </Field>
          <Field label="BC Job Task No.">
            <input className={inputCls} value={bcJobTaskNo} onChange={(e) => setBcJobTaskNo(e.target.value)} placeholder="e.g. 1000" />
          </Field>
        </div>
        <p className="text-[11px] text-slate-500">Not connected yet — these just tag this job with its Business Central reference so a future sync knows which record to update.</p>
      </Section>

      {!isNew && job.assignment && (
        <div className="text-xs text-slate-400 bg-slate-800/60 rounded-md p-2.5 mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <span>Scheduled {fmtDate(job.assignment.startDate)}–{fmtDate(job.assignment.endDate)}</span>
            {job.assignment.conflict && <span className="text-red-400 font-medium">Over capacity — please review</span>}
          </div>
          {job.assignment.days && job.assignment.days.length > 0 && (
            <div className="space-y-1 mt-1.5 max-h-32 overflow-y-auto pr-1">
              {job.assignment.days.map((d, i) => {
                const person = staff.find((s) => s.id === d.staffId);
                return (
                  <div key={i} className="flex items-center justify-between text-[11px] bg-slate-900/60 rounded px-2 py-1">
                    <span>{fmtDate(d.date)} · {d.shift === 'afternoon' ? 'Afternoon' : 'Day'} shift</span>
                    <span className="text-slate-300">{person ? person.name : 'Unassigned'} · {d.hours}h</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {(reworkOfJob || linkedReworks.length > 0) && (
        <div className="text-xs text-slate-400 bg-slate-800/60 rounded-md p-2.5 mb-3 space-y-1">
          {reworkOfJob && (
            <div className="flex items-center gap-1.5">
              <Wrench size={12} className="text-amber-400 shrink-0" />
              <span>Rework of{' '}
                <button type="button" className="text-amber-300 hover:underline" onClick={() => onOpenRelatedJob?.(reworkOfJob.id)}>
                  {reworkOfJob.name}
                </button>
              </span>
            </div>
          )}
          {linkedReworks.map((rw) => (
            <div key={rw.id} className="flex items-center gap-1.5">
              <Wrench size={12} className="text-amber-400 shrink-0" />
              <span>Rework logged against this job:{' '}
                <button type="button" className="text-amber-300 hover:underline" onClick={() => onOpenRelatedJob?.(rw.id)}>
                  {rw.name}
                </button>
                {' '}({rw.status === 'complete' ? 'complete' : 'scheduled'})
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Sticky rather than just the last thing in the form — this modal has
          grown long enough (#33) that the footer used to need scrolling past
          everything else to reach. `-mx-5 px-5`/`-mb-5 pb-5` counteract the
          parent's `p-5` so it still spans the dialog edge-to-edge, matching
          the header's own sticky treatment above. */}
      <div className="flex items-center justify-between pt-2 pb-5 -mx-5 -mb-5 px-5 border-t border-slate-800 mt-2 sticky bottom-0 bg-slate-900">
        <div className="flex gap-2">
          {onDelete && <button className={btnDanger} onClick={onDelete}><Trash2 size={14} /> Delete</button>}
          {onUnpin && <button className={btnGhost} onClick={onUnpin}><PinOff size={14} /> Unpin</button>}
          {onMarkForRework && (
            <button className={btnGhost} onClick={onMarkForRework}><Wrench size={14} /> Mark for rework</button>
          )}
        </div>
        <div className="flex gap-2">
          {onToggleComplete && !parts && (
            <button className={btnGhost} onClick={onToggleComplete}>
              <CircleCheck size={14} /> {job.status === 'complete' ? 'Mark active' : 'Mark complete'}
            </button>
          )}
          <button className={btnPrimary} onClick={handleSave}><Check size={14} /> Save</button>
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================
   IMPORT JOBS MODAL
   ------------------------------------------------------------
   Two ways in, one review screen out:

   1. A Business Central WIP export (.xlsx) read directly — the standalone
      wip-importer's engine now lives in src/wipImport.js, so the user no
      longer has to run a second tool and carry a JSON file across. The
      keyword matching, duplicate detection and completion flagging are the
      same logic, wrapped in this app's UI.
   2. The .json the standalone importer still produces, for anyone who
      already works that way.

   Either path lands on the same "assign a template" review table, because
   neither source carries shop-floor hours — see the note there.
   ============================================================ */

const WIP_SETTINGS_KEY = 'wf_wipsettings';

// Rows a WIP import left behind, so a job whose scope later grows into our
// work can be pulled in without re-running the import just for it.
//
// This is a DELIBERATE, NARROW exception to "WIP data is never persisted"
// (see both CLAUDE.md files) and the only one. What is stored is exactly the
// job-shaped record an imported row becomes — the same fields a matched row
// contributes, nothing more. The parsed spreadsheet, its columns, the analysis
// records and every unmapped column are still discarded when the modal closes.
// Don't widen this to the raw rows: in shared mode it lands in
// scheduler-data.json on the host PC, readable by everyone on the network.
//
// Replaced wholesale by each import, so it always describes the most recent
// export rather than accumulating rows that no longer exist in BC.
const PARKED_KEY = 'wf_wipparked';

// One row per job per day of hours actually worked:
// { id, jobId, date, hours, staffId, note }. Deliberately keyed by job rather
// than by assignment, so a day's work still records against the right job when
// the plan it was entered against later moves.
const TIMELOG_KEY = 'wf_timelog';

// Where the user overruled the scheduler: one record per manual placement that
// landed a job somewhere other than where it had been auto-placed, pairing the
// scheduler's choice with the user's, both described by the same weight-free
// feature vector. See src/overrides.js for the shape and why it's kept.
//
// Recorded ONLY. Nothing reads this back into scheduling, and nothing should
// until the data has actually been looked at — a pattern being detectable is
// not the same as the scheduler being right to act on it.
//
// Job names are denormalised into each record so it still reads after the job
// is deleted. That is the only content here beyond ids and dates: no costs, no
// values, no WIP. Capped (MAX_OVERRIDES) because in shared mode this lands in
// scheduler-data.json on the host PC like everything else.
const OVERRIDES_KEY = 'wf_overrides';

// R&D projects — tracking-only records (name/description/status), never
// scheduled themselves. See "R&D projects and tasks" in scheduler/CLAUDE.md.
const PROJECTS_KEY = 'wf_projects';

// { avgLabourRate, efficiency } — see effectiveHourlyRate and "Costing:
// efficiency and average labour cost" in scheduler/CLAUDE.md.
const COST_SETTINGS_KEY = 'wf_costsettings';

// Non-job schedulable items — see "R&D projects and tasks" in
// scheduler/CLAUDE.md for why these are a separate array from `jobs` (kept
// out of Job Backlog, Reports, batching, WIP import) while still sharing the
// scheduling engine (see taskToJobUnit/splitTaskUnits below).
const TASKS_KEY = 'wf_tasks';

// Hours logged against a job so far, across every day.
function loggedHours(timeLog, jobId) {
  return Math.round(
    (timeLog || []).filter((e) => e.jobId === jobId).reduce((s, e) => s + (Number(e.hours) || 0), 0) * 100
  ) / 100;
}

/* ============================================================
   REPORTS — Quality (rework) and R&D (task) exports over a chosen
   timeframe. See "Reports" in scheduler/CLAUDE.md.
   ============================================================ */

// $/hr for whatever procedure an item (job/task/rework) carries — the same
// effectiveHourlyRate() jobCost() uses (efficiency-blended, not the raw
// procedure rate), but exposed on its own so a report can price EACH
// logged entry individually (entry.hours × rate) instead of only the
// item's lifetime total — valid for a single day's partial hours too,
// since the blend is linear (see effectiveHourlyRate's comment). Returns
// 0, not null, so a report row's cost column is always summable — no
// procedure just means no cost, not missing data.
function hourlyRate(item, procedures, costCentres, costSettings) {
  if (!item || !item.procedureId) return 0;
  const p = (procedures || []).find((x) => x.id === item.procedureId);
  return p ? effectiveHourlyRate(p, costCentres, costSettings) : 0;
}

// One row per unit of logged work, for a report over [dateFrom, dateTo].
// Two sources, never both for the same item:
//  - day-by-day wf_timelog entries, if the item has any in range — exactly
//    what was actually logged, by whom, that day. The normal case for
//    anything worked while it was open on the schedule.
//  - otherwise, ONE synthesised row from the item's own completion record
//    (completedDate/actualHours) if that falls in range. This is what
//    makes a backfilled entry — created already complete, with no
//    day-by-day log of its own (see BackfillTaskModal) — show up at all.
function reportEntries(items, timeLog, dateFrom, dateTo) {
  const rows = [];
  (items || []).forEach((item) => {
    const entries = (timeLog || []).filter((e) => e.jobId === item.id && e.date >= dateFrom && e.date <= dateTo);
    if (entries.length) {
      entries.forEach((e) => rows.push({ item, date: e.date, staffId: e.staffId || null, hours: Number(e.hours) || 0 }));
    } else if (item.status === 'complete' && item.completedDate && item.completedDate >= dateFrom && item.completedDate <= dateTo) {
      rows.push({ item, date: item.completedDate, staffId: item.staffId || null, hours: Number(item.actualHours) || 0 });
    }
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// Quote/escape one CSV field — only wraps in quotes (doubling any inner
// quotes) when the value actually needs it, so a plain number or short
// word stays readable in the raw file.
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Client-side only, same as everything else in this app that touches WIP or
// cost data (see the "no network" rule in the top-level CLAUDE.md) — builds
// the file in memory and hands it straight to the browser's own download
// mechanism. Nothing leaves the machine.
function downloadCsv(filename, rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => csvEscape(c.value(r))).join(','));
  const csv = [header, ...lines].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Shared shell for both reports: a date range, a running total, an export
// button, and a table — `columns` (each `{ key, label, value(row) }`) and
// `buildRows(dateFrom, dateTo)` are the only things that differ between
// the Quality and R&D versions (see their call sites), so the shell itself
// carries no domain knowledge of jobs vs. tasks.
function ReportModal({ title, description, buildRows, columns, filenamePrefix, onClose }) {
  const todayIso = isoDate(new Date());
  const [dateFrom, setDateFrom] = useState(addDays(todayIso, -30));
  const [dateTo, setDateTo] = useState(todayIso);
  const rows = useMemo(() => buildRows(dateFrom, dateTo), [buildRows, dateFrom, dateTo]);
  const totalHours = Math.round(rows.reduce((s, r) => s + (Number(r.hours) || 0), 0) * 100) / 100;
  const totalCost = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);

  return (
    <Modal title={title} onClose={onClose} size="lg">
      {description && <p className="text-sm text-slate-300 mb-3">{description}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="From">
          <input type="date" className={inputCls} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} max={dateTo} />
        </Field>
        <Field label="To">
          <input type="date" className={inputCls} value={dateTo} onChange={(e) => setDateTo(e.target.value)} min={dateFrom} />
        </Field>
      </div>
      <div className="flex items-center justify-between rounded-md bg-slate-800/60 border border-slate-700 px-3 py-2 mb-3">
        <span className="text-xs text-slate-400">
          {rows.length} entr{rows.length === 1 ? 'y' : 'ies'} · {totalHours}h · <span className="text-amber-300 font-mono">{fmtMoney(totalCost)}</span>
        </span>
        <button
          className={btnPrimary}
          disabled={rows.length === 0}
          onClick={() => downloadCsv(`${filenamePrefix}-${dateFrom}-to-${dateTo}.csv`, rows, columns)}
        >
          <Download size={14} /> Export CSV
        </button>
      </div>
      <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900 overflow-x-auto max-h-[50vh] overflow-y-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead className="sticky top-0 bg-slate-800/60 text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              {columns.map((c) => <th key={c.key} className="px-3 py-2 text-left">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-slate-800/60">
                {columns.map((c) => <td key={c.key} className="px-3 py-2 text-slate-300 whitespace-nowrap">{c.value(r)}</td>)}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-slate-600 text-sm">
                Nothing logged in this range.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end pt-3">
        <button className={btnGhost} onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

// A task, adapted into the job shape runScheduler expects, so it competes
// for the exact same equipment/staff capacity a job would — no separate
// blocking mechanism to keep in sync with leave/rosters/unavailable dates.
// `_isTask` survives the round trip (runScheduler spreads/mutates units in
// place, it never rebuilds a narrower object — see splitTaskUnits below,
// which relies on that), so the merged result can be split straight back
// into jobs vs. tasks with no extra bookkeeping. Always pinned: a task's
// equipment and planned start date are both required at creation (see
// TaskModal), there is no "automatic" placement mode for one.
function taskToJobUnit(t) {
  return {
    id: t.id,
    _isTask: true,
    name: t.name,
    process: t.process,
    hoursTotal: t.hoursTotal,
    readyDate: t.readyDate,
    dueDate: t.dueDate,
    departmentDueDate: null,
    status: t.status,
    actualHours: t.actualHours,
    parts: null,
    batchId: null,
    needsFurtherProcessing: false,
    parallelProcessing: false,
    preferredEquipmentId: null,
    staffId: t.staffId || null,
    // Same field, same all-or-nothing rule as a job's (see
    // attachSecondStaff in scheduler.js) — only meaningful alongside a
    // primary staffId, only checked once the primary's own placement
    // already exists.
    secondStaffId: t.secondStaffId || null,
    lockedEquipmentId: null,
    tags: [],
    assignment: t.assignment ? { ...t.assignment } : null,
  };
}
// The reverse of taskToJobUnit: pull the scheduler's output apart into the
// real jobs array and the real tasks array (merging each scheduled unit's
// fresh `assignment` back onto the task's own record, which carries
// everything else — description, procedureId, projectId, etc. — that the
// engine never needed to see).
function splitTaskUnits(merged, tasksList) {
  const jobsResult = merged.filter((u) => !u._isTask);
  const tasksResult = merged.filter((u) => u._isTask).map((u) => ({
    ...(tasksList.find((t) => t.id === u.id) || {}),
    assignment: u.assignment,
  }));
  return { jobsResult, tasksResult };
}

// Chip editor for the include/exclude keyword lists. Deliberately plain: type
// a word, Enter or Add, click × to drop it.
function KeywordChips({ words, onChange, placeholder, tone }) {
  const [input, setInput] = useState('');
  const chipCls = tone === 'exclude'
    ? 'bg-red-950/40 text-red-300 border border-red-900'
    : 'bg-amber-500/20 text-amber-300';
  const add = () => {
    const parts = input.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const next = [...words];
    parts.forEach((p) => { if (!next.includes(p)) next.push(p); });
    onChange(next);
    setInput('');
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-2">
        {words.length === 0 && <span className="text-[11px] text-slate-500 italic">None</span>}
        {words.map((w) => (
          <span key={w} className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 ${chipCls}`}>
            {w}
            <button type="button" className="text-slate-500 hover:text-red-400" onClick={() => onChange(words.filter((x) => x !== w))}>×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className={smallInput}
          value={input}
          placeholder={placeholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          // Typed-but-not-confirmed text used to vanish with no warning the
          // moment focus left the field — including by clicking Save, which is
          // exactly what looked like "adding this doesn't do anything" (#9).
          // Commit it wherever focus goes, same as a tag/topic input elsewhere.
          onBlur={() => { if (input.trim()) add(); }}
        />
        {/* See TagEditor's Add button — same blur/click race, same fix. */}
        <button type="button" className="text-xs px-2 py-1 rounded border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700" onMouseDown={(e) => e.preventDefault()} onClick={add}>Add</button>
      </div>
    </div>
  );
}

// Chip editor for combination rules — the "include body, include elbow, but
// not when a row is both" case that plain keyword lists can't express. A rule
// is two or more words that must ALL appear in the description (whole-word,
// see hasWord in wipImport) for it to fire; a fired rule excludes the row.
// The engine has always supported these, but until now there was no way to
// enter one, so the feature was unreachable.
function ComboChips({ rules, onChange }) {
  const [input, setInput] = useState('');
  const words = input.split(/[+,]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const keyOf = (ws) => [...ws].sort().join('+');
  const add = () => {
    // A single word is just an exclude keyword; a combination needs two.
    if (words.length < 2) return;
    const key = keyOf(words);
    if (!rules.some((r) => keyOf(r.words || []) === key)) onChange([...rules, { words }]);
    setInput('');
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-2">
        {rules.length === 0 && <span className="text-[11px] text-slate-500 italic">None</span>}
        {rules.map((r) => {
          const key = keyOf(r.words || []);
          return (
            <span key={key} className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 bg-slate-700/60 text-slate-200 border border-slate-600">
              {(r.words || []).join(' + ')}
              <button
                type="button"
                className="text-slate-400 hover:text-red-400"
                onClick={() => onChange(rules.filter((x) => keyOf(x.words || []) !== key))}
              >×</button>
            </span>
          );
        })}
      </div>
      <div className="flex gap-2">
        <input
          className={smallInput}
          value={input}
          placeholder="body + elbow"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          // See TagEditor's onBlur — same fix, same reason.
          onBlur={() => { if (input.trim()) add(); }}
        />
        {/* See TagEditor's Add button — same blur/click race, same fix. */}
        <button
          type="button"
          disabled={words.length < 2}
          className="text-xs px-2 py-1 rounded border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800"
          onMouseDown={(e) => e.preventDefault()}
          onClick={add}
        >Add</button>
      </div>
      {input.trim() && words.length < 2 && (
        <p className="text-[10px] text-slate-500 mt-1">Separate two or more words with + or a comma.</p>
      )}
    </div>
  );
}

// Highlight the matched keywords inside a description, so it's obvious *why* a
// row matched when auditing keyword coverage. Built from React nodes, never
// innerHTML — file content must never be treated as markup.
function highlightHits(text, hits) {
  if (!text) return null;
  const list = (hits || []).filter(Boolean);
  if (!list.length) return text;
  const low = text.toLowerCase();
  const ranges = [];
  for (const h of list) {
    const hl = h.toLowerCase();
    let from = 0, idx;
    while ((idx = low.indexOf(hl, from)) !== -1) { ranges.push([idx, idx + hl.length]); from = idx + hl.length; }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const out = [];
  let pos = 0;
  merged.forEach(([a, b], i) => {
    if (a > pos) out.push(text.slice(pos, a));
    out.push(<mark key={i} className="bg-amber-500/20 text-amber-300 rounded px-0.5">{text.slice(a, b)}</mark>);
    pos = b;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

// `initialRows` opens the modal straight at the review step on rows that came
// from the parked list rather than a file — same table, same template
// assignment, same splitting, so there is only one review flow to maintain.
function ImportJobsModal({ templates, processes, existingJobs, onClose, onImport, onParkUnmatched, initialRows = null }) {
  const fromParked = !!initialRows;
  const [rows, setRows] = useState(null); // set once we reach the review step
  const [fileName, setFileName] = useState('');
  const [parseError, setParseError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bulkTemplateId, setBulkTemplateId] = useState('');
  const fileInputRef = useRef(null);

  // ---- WIP (.xlsx) step ----
  const [parsed, setParsed] = useState(null);      // { headers, rows, sheetName, headerRowNumber }
  const [mapping, setMapping] = useState({});      // logical field -> header name
  const [wipSettings, setWipSettings] = useState({ include: DEFAULT_INCLUDE, exclude: DEFAULT_EXCLUDE, combos: DEFAULT_COMBOS });
  const [selected, setSelected] = useState(() => new Set());
  const [tickOverrides, setTickOverrides] = useState({}); // record id -> ticked by hand

  // Opened on the parked list: jump straight to the review table.
  useEffect(() => {
    // Nothing ticked by default here — the point is to go and find the one
    // job whose scope changed, not to re-import everything left behind.
    if (initialRows) setRows(toReviewRows(initialRows).map((r) => ({ ...r, include: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [wipView, setWipView] = useState('matched');
  const [wipSearch, setWipSearch] = useState('');
  const [showMapping, setShowMapping] = useState(false);

  // Keyword lists persist (they're the user's department vocabulary and worth
  // keeping); the WIP data itself never touches storage.
  useEffect(() => {
    let alive = true;
    loadKey(WIP_SETTINGS_KEY, null).then((s) => {
      if (!alive || !s) return;
      setWipSettings({ include: s.include || DEFAULT_INCLUDE, exclude: s.exclude || [], combos: s.combos || [] });
    });
    return () => { alive = false; };
  }, []);
  function updateSettings(patch) {
    setWipSettings((s) => { const next = { ...s, ...patch }; saveKey(WIP_SETTINGS_KEY, next); return next; });
  }

  const analysis = useMemo(
    () => (parsed ? analyse(parsed.rows, mapping, wipSettings) : null),
    [parsed, mapping, wipSettings]
  );
  // Re-analysing (a mapping or keyword change) recomputes the default tick set,
  // then re-applies whatever the user has ticked or unticked by hand on top.
  // It used to just reset to the new default, the way the standalone tool did:
  // adding one more keyword silently re-ticked every row you had gone through
  // and dismissed, so a long review had to be redone from scratch each time.
  // Record ids are row indices into the parsed sheet, so they stay valid across
  // a re-analysis; `tickOverrides` is cleared when a different file is loaded.
  useEffect(() => {
    if (!analysis) return;
    const next = new Set(analysis.defaultSelected);
    Object.entries(tickOverrides).forEach(([id, on]) => {
      if (on) next.add(Number(id)); else next.delete(Number(id));
    });
    setSelected(next);
  }, [analysis, tickOverrides]);

  const existingKeys = useMemo(() => {
    const keys = new Set();
    existingJobs.forEach((j) => {
      if (j.bcJobNo) keys.add(`${j.bcJobNo}::${j.bcJobTaskNo || ''}`);
    });
    return keys;
  }, [existingJobs]);

  // Turn scheduler-shaped job objects (from either source) into review rows.
  function toReviewRows(list) {
    const now = new Date().toISOString();
    return list.map((raw, i) => {
      const name = (raw?.name || '').trim();
      const bcJobNo = raw?.bcJobNo || '';
      const bcJobTaskNo = raw?.bcJobTaskNo || '';
      const dup = !!bcJobNo && existingKeys.has(`${bcJobNo}::${bcJobTaskNo}`);
      return {
        _rowId: i,
        _invalid: !name,
        _dup: dup,
        _parkId: raw?.parkId ?? null, // set when the row came from the parked list
        include: !!name && !dup,
        name: name || 'Untitled job',
        process: raw?.process || '',
        quantity: Number(raw?.quantity) > 0 ? Number(raw.quantity) : 1,
        hoursTotal: Number(raw?.hoursTotal) || 0,
        // Blank, not today (#59) — a WIP export doesn't tell us whether a job
        // has actually arrived in this department; the reviewer sets this per
        // row below, same as they already do for process/hours/template.
        readyDate: raw?.readyDate || '',
        dueDate: raw?.dueDate || addDays(isoDate(new Date()), 14),
        templateId: raw?.templateId || null,
        preferredEquipmentId: raw?.preferredEquipmentId || null,
        notes: raw?.notes || '',
        totalValue: Number(raw?.totalValue) || 0,
        departmentValue: Number(raw?.departmentValue) || 0,
        percentComplete: Number(raw?.percentComplete) || 0,
        // Old .json exports from the retired standalone importer predate this
        // field, so it falls back to false rather than undefined.
        needsFurtherProcessing: !!raw?.needsFurtherProcessing,
        status: 'active',
        completedDate: null,
        bcJobNo,
        bcJobTaskNo,
        updatedAt: now,
      };
    });
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError('');
    if (/\.xlsx$/i.test(file.name)) readXlsxFile(file);
    else readJsonFile(file);
  }

  async function readXlsxFile(file) {
    setBusy(true);
    try {
      const p = await parseXlsx(await file.arrayBuffer());
      setParsed(p);
      setMapping(autoMap(p.headers));
      setWipView('matched');
      setWipSearch('');
      setTickOverrides({}); // ids are row indices — meaningless against a new sheet
    } catch (err) {
      setParseError(err?.message || 'That .xlsx could not be read.');
      setParsed(null);
    } finally {
      setBusy(false);
    }
  }

  function readJsonFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch {
        setParseError('That file is not valid JSON — choose a .xlsx WIP export, or the .json the WIP importer produces.');
        setRows(null);
        return;
      }
      const list = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : null;
      if (!list) {
        setParseError("Expected a jobs array, or an object with a \"jobs\" array — this doesn't look like a WIP importer export.");
        setRows(null);
        return;
      }
      setRows(toReviewRows(list));
    };
    reader.readAsText(file);
  }

  function resetFile() {
    setRows(null); setParsed(null); setFileName(''); setParseError(''); setTickOverrides({});
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ---- WIP step derived data ----
  const counts = useMemo(() => {
    if (!analysis) return null;
    const a = analysis.records;
    return {
      total: a.length,
      matched: a.filter((r) => r.matched && !r.isDupe).length,
      dupes: a.filter((r) => r.isDupe).length,
      unmatched: a.filter((r) => !r.matched && !r.isDupe).length,
      held: a.filter((r) => r.combos.length && !r.isDupe).length,
      done: a.filter((r) => r.matched && !r.isDupe && r.doneConfirmed).length,
      warned: a.filter((r) => r.matched && !r.isDupe && r.warnings.length).length,
    };
  }, [analysis]);

  const selectedValue = useMemo(() => {
    if (!analysis) return 0;
    return analysis.records.filter((r) => selected.has(r.id)).reduce((s, r) => s + (r.value || 0), 0);
  }, [analysis, selected]);

  const visibleRecs = useMemo(() => {
    if (!analysis) return [];
    let recs = analysis.records;
    if (wipView === 'matched') recs = recs.filter((r) => r.matched && !r.isDupe);
    else if (wipView === 'dupes') recs = recs.filter((r) => r.isDupe);
    // "Not matched" excludes duplicates: a duplicate is already accounted for by
    // its keeper under Duplicates, and this view exists to audit keyword gaps.
    else if (wipView === 'unmatched') recs = recs.filter((r) => !r.matched && !r.isDupe);
    const q = wipSearch.trim().toLowerCase();
    if (q) recs = recs.filter((r) => `${r.jobNo} ${r.hay} ${r.customer}`.toLowerCase().includes(q));
    return recs;
  }, [analysis, wipView, wipSearch]);

  // Ticking records the user's intent in `tickOverrides`; the effect above
  // derives `selected` from the current default set plus those overrides, so a
  // hand-made decision survives the next keyword or mapping change.
  function toggleRec(id, on) {
    setTickOverrides((o) => ({ ...o, [id]: on }));
  }
  function tickVisible(on) {
    setTickOverrides((o) => {
      const n = { ...o };
      visibleRecs.forEach((r) => { n[r.id] = on; });
      return n;
    });
  }
  function continueFromWip() {
    setRows(toReviewRows(buildSchedulerJobs(analysis.records, selected)));
  }

  // ---- review step ----
  function updateRow(rowId, patch) {
    setRows((rs) => rs.map((r) => (r._rowId === rowId ? { ...r, ...patch } : r)));
  }

  // One WIP row can cover several things this department has to schedule
  // separately — distinct components on the one BC job, or stages done at
  // different times. Splitting it here produces independent jobs, each with
  // its own name and hours, rather than the job-level `parts` split: parts
  // deliberately share one name and one backlog row, which is the opposite of
  // what's wanted when the pieces are different components.
  //
  // Quantity, hours and both $ figures divide across the new rows so the
  // totals still add up to what BC exported; the remainder goes to the first
  // row. Every piece keeps the same BC job/task number, since they genuinely
  // are the same BC line.
  function splitRow(rowId) {
    setRows((rs) => {
      const i = rs.findIndex((r) => r._rowId === rowId);
      if (i < 0) return rs;
      const src = rs[i];
      const nextId = rs.reduce((m, r) => Math.max(m, r._rowId), 0) + 1;
      const group = src._splitGroup ?? src._rowId;

      const half = (n, first) => {
        const v = Number(n) || 0;
        const b = Math.round((v / 2) * 100) / 100;
        return first ? Math.round((v - b) * 100) / 100 : b;
      };
      const qA = Math.ceil((Number(src.quantity) || 1) / 2);
      const qB = Math.max(1, (Number(src.quantity) || 1) - qA);

      const base = src._splitGroup == null ? src.name : src.name.replace(/\s+—\s+\d+$/, '');
      const piece = (first) => ({
        ...src,
        _splitGroup: group,
        quantity: first ? qA : qB,
        hoursTotal: half(src.hoursTotal, first),
        totalValue: half(src.totalValue, first),
        departmentValue: half(src.departmentValue, first),
      });

      // Number the new piece past the highest suffix already in the group, not
      // by group size: splitting piece 1 and then piece 2 of a three-way split
      // would otherwise hand out a number that already exists.
      const suffixOf = (n) => { const m = /\s+—\s+(\d+)$/.exec(n); return m ? Number(m[1]) : 0; };
      const used = src._splitGroup == null
        ? [1] // the source row becomes "— 1" below
        : rs.filter((r) => (r._splitGroup ?? r._rowId) === group).map((r) => suffixOf(r.name));
      const nextSuffix = Math.max(0, ...used) + 1;

      const a = { ...piece(true), name: src._splitGroup == null ? `${base} — 1` : src.name };
      const b = { ...piece(false), _rowId: nextId, name: `${base} — ${nextSuffix}` };
      // Keep the pieces adjacent so a split group reads as one block.
      return [...rs.slice(0, i), a, b, ...rs.slice(i + 1)];
    });
  }

  function removeRow(rowId) {
    setRows((rs) => rs.filter((r) => r._rowId !== rowId));
  }

  function applyTemplateToRow(rowId, templateId) {
    const t = templates.find((x) => x.id === templateId);
    if (!t) { updateRow(rowId, { templateId: null }); return; }
    setRows((rs) => rs.map((r) => {
      if (r._rowId !== rowId) return r;
      const hoursTotal = Math.round(r.quantity * t.hoursPerUnit * 100) / 100;
      const departmentValue = r.departmentValue > 0 ? r.departmentValue : Math.round(r.quantity * (t.departmentValuePerUnit || 0) * 100) / 100;
      return { ...r, templateId, process: t.process, hoursTotal, departmentValue, preferredEquipmentId: t.preferredEquipmentId || null };
    }));
  }

  function applyBulkTemplate() {
    const t = templates.find((x) => x.id === bulkTemplateId);
    if (!t) return;
    setRows((rs) => rs.map((r) => {
      if (!r.include || r.templateId) return r; // don't clobber rows already assigned
      const hoursTotal = Math.round(r.quantity * t.hoursPerUnit * 100) / 100;
      const departmentValue = r.departmentValue > 0 ? r.departmentValue : Math.round(r.quantity * (t.departmentValuePerUnit || 0) * 100) / 100;
      return { ...r, templateId: bulkTemplateId, process: t.process, hoursTotal, departmentValue, preferredEquipmentId: t.preferredEquipmentId || null };
    }));
  }

  // Names are editable now (a split needs distinct ones), so a blank name is a
  // live condition rather than something settled when the rows were built.
  const includedRows = rows ? rows.filter((r) => r.include && r.name.trim()) : [];
  const missingHours = includedRows.filter((r) => !r.hoursTotal || !r.process).length;
  // A blank ready date isn't a defect the way missing hours is — it's the
  // normal starting state (#59) — but it does mean the job won't schedule
  // until someone sets one, so it's worth the same nudge before Import.
  const missingReady = includedRows.filter((r) => !r.readyDate).length;
  const dupCount = rows ? rows.filter((r) => r._dup).length : 0;
  const invalidCount = rows ? rows.filter((r) => r._invalid).length : 0;

  function handleImportClick() {
    const toImport = includedRows.map(({ _rowId, _invalid, _dup, _splitGroup, _parkId, include, ...job }) => job);
    const consumed = new Set(includedRows.map((r) => r._parkId).filter(Boolean));

    // Whatever this export offered and we didn't take is kept for review. Only
    // for a .xlsx import — a parked-list session has no analysis of its own,
    // and a .json export carries no notion of "unmatched".
    if (analysis && onParkUnmatched) {
      const leftover = new Set(
        analysis.records.filter((r) => !r.matched && !r.isDupe && !selected.has(r.id)).map((r) => r.id)
      );
      onParkUnmatched(buildSchedulerJobs(analysis.records, leftover).map((j, i) => ({ ...j, parkId: `pk_${Date.now()}_${i}` })));
    }
    onImport(toImport, consumed);
  }

  const stage = rows ? 'review' : parsed ? 'wip' : 'pick';
  const title = fromParked ? 'Parked jobs — bring one into the backlog'
    : stage === 'wip' ? 'WIP export — choose the jobs that are ours'
    : 'Import jobs from a WIP export';

  const viewTabs = counts ? [
    ['matched', 'Ours', counts.matched],
    ['unmatched', 'Not matched', counts.unmatched],
    ['dupes', 'Duplicates', counts.dupes],
    ['all', 'All rows', counts.total],
  ] : [];

  return (
    <Modal title={title} onClose={onClose} size="xl">
      {/* ---------------- step 1: choose a file ---------------- */}
      {stage === 'pick' && (
        <div>
          <p className="text-sm text-slate-400 mb-1">
            Choose the Business Central WIP export (<code className="text-slate-300">.xlsx</code>) and this will
            find the jobs that belong to the department, drop duplicates and pull through what the scheduler needs.
          </p>
          <p className="text-xs text-slate-500 mb-4">
            The <code className="text-slate-400">scheduler-jobs-*.json</code> from the standalone WIP importer also
            still works. Nothing is read off this machine and nothing is imported until you review the list.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/json,.json"
            onChange={handleFile}
            className="block w-full text-sm text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-amber-500 file:text-slate-950 file:font-semibold file:text-sm hover:file:bg-amber-400"
          />
          {busy && (
            <p className="text-xs text-slate-400 mt-3 flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" /> Reading {fileName}…</p>
          )}
          {parseError && (
            <p className="text-xs text-red-400 mt-3 flex items-start gap-1.5"><FileWarning size={13} className="mt-0.5 shrink-0" /> {parseError}</p>
          )}
        </div>
      )}

      {/* ---------------- step 2: WIP review (.xlsx only) ---------------- */}
      {stage === 'wip' && analysis && (
        // Fixed height, so nothing inside can change the dialog's outer size.
        // The keyword rail and the row table were already pinned, but the
        // notices above them appear and disappear as rules fire, which still
        // moved the whole centred dialog mid-edit — the exact complaint.
        <div className="flex flex-col h-[68vh]">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3 flex-none">
            <p className="text-xs text-slate-400">
              {fileName} · sheet “{parsed.sheetName}” · headers on row {parsed.headerRowNumber} · {counts.total} rows
            </p>
            <button type="button" className="text-xs text-amber-400 hover:underline" onClick={resetFile}>Choose a different file</button>
          </div>

          {/* stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3 flex-none">
            {[
              ['Rows in file', counts.total, 'text-slate-200'],
              ['Match your keywords', counts.matched, 'text-emerald-400'],
              ['Duplicate job no.', counts.dupes, 'text-slate-400'],
              ['No keyword match', counts.unmatched, 'text-slate-400'],
              ['Already complete', counts.done, 'text-slate-400'],
              ['Value of selection', `$${Math.round(selectedValue).toLocaleString()}`, 'text-amber-400'],
            ].map(([label, val, cls]) => (
              <div key={label} className="bg-slate-800/50 border border-slate-800 rounded-md px-2.5 py-2">
                <div className={`text-base font-semibold ${cls}`}>{val}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
              </div>
            ))}
          </div>

          {counts.matched === 0 && (
            <p className="text-xs text-amber-400 mb-3 flex items-start gap-1.5 flex-none">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              No rows matched. Check the keywords below, and that the Description column is mapped to the right header.
            </p>
          )}
          {counts.held > 0 && (
            <p className="text-[11px] text-slate-400 mb-3 flex-none">
              {counts.held} row{counts.held === 1 ? '' : 's'} excluded by a combination rule — under “Not matched”, still tickable if one should come in.
            </p>
          )}

          {/* Two columns: the keyword editors live in a fixed-width rail on the
              left, where growing a chip list scrolls the rail instead of
              resizing the modal and shoving the whole UI around, and the row
              list gets the full remaining width. */}
          <div className="grid lg:grid-cols-[250px_1fr] gap-3 flex-1 min-h-0">
          <aside className="space-y-3 overflow-y-auto lg:pr-1 min-h-0">
            <div className="bg-slate-800/50 border border-slate-700 rounded-md p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">Include if the description contains</div>
              <KeywordChips words={wipSettings.include} placeholder="weld, spray, hvof…" onChange={(w) => updateSettings({ include: w })} />
            </div>
            <div className="bg-slate-800/50 border border-slate-700 rounded-md p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">Never include if it contains</div>
              <KeywordChips words={wipSettings.exclude} tone="exclude" placeholder="machining, hire…" onChange={(w) => updateSettings({ exclude: w })} />
            </div>
            <div className="bg-slate-800/50 border border-slate-700 rounded-md p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">Exclude only in combination</div>
              <ComboChips rules={wipSettings.combos || []} onChange={(c) => updateSettings({ combos: c })} />
            </div>

            {/* column mapping */}
            <div>
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-200 mb-2 inline-flex items-center gap-1.5"
                onClick={() => setShowMapping((v) => !v)}
              >
                <Settings2 size={13} /> {showMapping ? 'Hide' : 'Check'} column mapping
              </button>
              {showMapping && (
                <div className="space-y-2 bg-slate-800/50 border border-slate-700 rounded-md p-2.5">
                  {FIELDS.map((f) => (
                    <label key={f.key} className="block">
                      <span className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                        {f.label}{f.need && <span className="text-amber-400"> *</span>}
                      </span>
                      <select
                        className={smallInput}
                        value={mapping[f.key] || ''}
                        onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                      >
                        <option value="">— not mapped —</option>
                        {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </aside>

          <div className="min-w-0 flex flex-col min-h-0">
          {/* view tabs + search */}
          <div className="flex items-center gap-2 flex-wrap mb-2 flex-none">
            {viewTabs.map(([id, label, n]) => (
              <button
                key={id}
                type="button"
                onClick={() => setWipView(id)}
                className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
                  wipView === id ? 'bg-amber-500/20 border-amber-500 text-amber-300' : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                {label} <span className="opacity-70">{n}</span>
              </button>
            ))}
            <input
              className={`${smallInput} ml-auto w-auto min-w-[180px]`}
              placeholder="Search job no., description, customer…"
              value={wipSearch}
              onChange={(e) => setWipSearch(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-3 mb-2 text-[11px] text-slate-500 flex-none">
            <button type="button" className="hover:text-amber-400" onClick={() => tickVisible(true)}>Tick all in view</button>
            <button type="button" className="hover:text-amber-400" onClick={() => tickVisible(false)}>Untick all in view</button>
          </div>

          {/* Fixed height, not max-height: the row count changes as keywords
              are edited, and letting that resize the modal moved the whole
              dialog under the pointer mid-edit. */}
          <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900 overflow-x-auto flex-1 min-h-0 overflow-y-auto">
            <table className="w-full text-sm min-w-[1000px]">
              <thead className="sticky top-0 bg-slate-900 z-10">
                <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 font-medium"></th>
                  <th className="px-3 py-2 font-medium">Job / task</th>
                  {/* w-full on an otherwise-unconstrained table-auto column
                      makes it absorb whatever width the other columns don't
                      need, instead of the table stopping short of the dialog's
                      edge and leaving a blank margin — the "unused horizontal
                      space" complaint. */}
                  <th className="px-3 py-2 font-medium w-full">Description</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                  <th className="px-3 py-2 font-medium">BC status</th>
                </tr>
              </thead>
              <tbody>
                {visibleRecs.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500 text-xs">Nothing in this view.</td></tr>
                )}
                {visibleRecs.map((r) => (
                  <tr key={r.id} className={`border-b border-slate-800/60 ${r.isDupe ? 'opacity-60' : ''}`}>
                    <td className="px-3 py-2 align-top">
                      <input type="checkbox" className="accent-amber-500" checked={selected.has(r.id)} onChange={(e) => toggleRec(r.id, e.target.checked)} />
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-slate-400 whitespace-nowrap">
                      {r.jobNo || '—'}{r.taskNo ? ` / ${r.taskNo}` : ''}
                    </td>
                    <td className="px-3 py-2 align-top text-slate-200">
                      {/* w-0 min-w-full: truncate needs a bounded width to clip
                          against, but the column itself is now flexible (see
                          the header's w-full above) — this ties the div to
                          whatever width the column actually resolves to,
                          rather than a fixed cap that left space unused on a
                          wide dialog or clipped text on a narrow one. */}
                      <div className="truncate w-0 min-w-full" title={r.desc}>{highlightHits(r.desc, r.incHits)}</div>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {r.isDupe && <span className="text-[10px] text-slate-400">duplicate of job {r.jobNo}</span>}
                        {r.doneConfirmed && <span className="text-[10px] text-emerald-400">complete in BC</span>}
                        {r.combos.length > 0 && <span className="text-[10px] text-red-400">excluded: {r.combos.map((c) => c.words.join(' + ')).join(', ')}</span>}
                        {r.excHits.length > 0 && <span className="text-[10px] text-red-400">excluded: {r.excHits.join(', ')}</span>}
                      </div>
                      {r.warnings.map((w) => (
                        <div key={w} className="text-[10px] text-amber-400 flex items-start gap-1 mt-0.5">
                          <AlertTriangle size={10} className="mt-0.5 shrink-0" />{w}
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2 align-top text-slate-400 text-xs max-w-[220px] truncate" title={r.customer}>{r.customer || '—'}</td>
                    <td className="px-3 py-2 align-top text-slate-400 font-mono text-xs whitespace-nowrap">{r.value == null ? '—' : `$${Math.round(r.value).toLocaleString()}`}</td>
                    <td className="px-3 py-2 align-top text-slate-400 text-xs">{r.qty == null ? '—' : r.qty}</td>
                    <td className="px-3 py-2 align-top text-slate-400 text-xs whitespace-nowrap">{r.target ? fmtDate(r.target) : '—'}</td>
                    <td className="px-3 py-2 align-top text-slate-400 text-xs max-w-[170px] truncate" title={r.status}>{r.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
          </div>

          <div className="flex items-center justify-between pt-4 mt-3 border-t border-slate-800 flex-none">
            <span className="text-xs text-slate-500">{selected.size} job{selected.size === 1 ? '' : 's'} ticked</span>
            <div className="flex gap-2">
              <button className={btnGhost} onClick={onClose}>Cancel</button>
              <button
                className={`${btnPrimary} disabled:opacity-40 disabled:cursor-not-allowed`}
                disabled={selected.size === 0}
                onClick={continueFromWip}
              >
                Next: set hours <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- step 3: review + assign templates ---------------- */}
      {stage === 'review' && (
        <div>
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <p className="text-xs text-slate-400">
              {fromParked ? 'Parked from a previous WIP import' : fileName} · {rows.length} job{rows.length === 1 ? '' : 's'}
              {dupCount > 0 && <span className="text-amber-400"> · {dupCount} look already imported (same BC job/task no.) — unchecked</span>}
              {invalidCount > 0 && <span className="text-red-400"> · {invalidCount} skipped (no name)</span>}
            </p>
            {fromParked ? null : parsed ? (
              <button type="button" className="text-xs text-amber-400 hover:underline inline-flex items-center gap-1" onClick={() => setRows(null)}>
                <ChevronLeft size={12} /> Back to the WIP review
              </button>
            ) : (
              <button type="button" className="text-xs text-amber-400 hover:underline" onClick={resetFile}>Choose a different file</button>
            )}
          </div>

          {templates.length > 0 && (
            <div className="flex items-center gap-2 mb-3 bg-slate-800/50 border border-slate-700 rounded-md p-2.5 flex-wrap">
              <span className="text-xs text-slate-400 whitespace-nowrap">Apply template to selected rows without one:</span>
              <select className={`${inputCls} py-1.5 flex-1 min-w-[160px]`} value={bulkTemplateId} onChange={(e) => setBulkTemplateId(e.target.value)}>
                <option value="">Choose a template…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.process})</option>)}
              </select>
              <button type="button" className={btnGhost} disabled={!bulkTemplateId} onClick={applyBulkTemplate}>Apply</button>
            </div>
          )}

          {missingHours > 0 && (
            <p className="text-xs text-amber-400 mb-3 flex items-center gap-1.5">
              <AlertTriangle size={13} /> {missingHours} selected job{missingHours === 1 ? '' : 's'} still {missingHours === 1 ? 'has' : 'have'} no process/hours set —
              WIP exports don't carry shop-floor hours, so the scheduler can't place {missingHours === 1 ? 'it' : 'them'} until a template or hours are set
              (you can still import and fix this later from the Backlog).
            </p>
          )}

          {missingReady > 0 && (
            <p className="text-xs text-amber-400 mb-3 flex items-center gap-1.5">
              <AlertTriangle size={13} /> {missingReady} selected job{missingReady === 1 ? '' : 's'} still {missingReady === 1 ? 'has' : 'have'} no ready date set —
              set the "Ready" column below for {missingReady === 1 ? 'it' : 'them'}, or {missingReady === 1 ? 'it' : 'they'} won't be scheduled until you do (you can still import and fix this later from the Backlog).
            </p>
          )}

          <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900 overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm min-w-[1080px]">
              <thead className="sticky top-0 bg-slate-900 z-10">
                <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 font-medium"></th>
                  {/* w-full: same trick as the WIP-review table's Description
                      column — an otherwise-unconstrained table-auto column
                      absorbs whatever space the fixed-width ones don't need,
                      so the job-name field actually grows on a wide dialog. */}
                  <th className="px-3 py-2 font-medium w-full">Job</th>
                  <th className="px-3 py-2 font-medium">BC Job/Task</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium" title="Won't be scheduled until this is set">Ready</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">Total $</th>
                  <th className="px-3 py-2 font-medium">Template</th>
                  <th className="px-3 py-2 font-medium">Process</th>
                  <th className="px-3 py-2 font-medium">Hours</th>
                  <th className="px-3 py-2 font-medium" title="Needs further processing after this department">+Proc</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._rowId} className={`border-b border-slate-800/60 ${r._invalid ? 'opacity-40' : r._dup ? 'opacity-60' : ''}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={r.include}
                        disabled={r._invalid}
                        onChange={(e) => updateRow(r._rowId, { include: e.target.checked })}
                        className="accent-amber-500"
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-200">
                      <div className={`flex items-center gap-1.5 ${r._splitGroup != null ? 'border-l-2 border-amber-600/60 pl-2' : ''}`}>
                        <input
                          type="text"
                          className="w-full min-w-[200px] max-w-[520px] bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-200"
                          value={r.name}
                          title={r.name}
                          onChange={(e) => updateRow(r._rowId, { name: e.target.value })}
                        />
                        <button
                          type="button"
                          title="Split into another job — for separate components or stages scheduled independently"
                          className="text-slate-500 hover:text-amber-400 shrink-0"
                          onClick={() => splitRow(r._rowId)}
                        ><Plus size={13} /></button>
                        {r._splitGroup != null && (
                          <button
                            type="button"
                            title="Remove this piece of the split"
                            className="text-slate-500 hover:text-red-400 shrink-0"
                            onClick={() => removeRow(r._rowId)}
                          ><Trash2 size={12} /></button>
                        )}
                      </div>
                      {r._dup && <span className="text-[10px] text-amber-400">already imported?</span>}
                      {r.include && !r.name.trim() && <span className="text-[10px] text-red-400">name required — won't import</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">{r.bcJobNo || '—'}{r.bcJobTaskNo ? ` / ${r.bcJobTaskNo}` : ''}</td>
                    <td className="px-3 py-2 text-slate-400">{r.quantity}</td>
                    <td className="px-3 py-2">
                      <input
                        type="date"
                        className={`bg-slate-800 border rounded text-xs px-1.5 py-1 text-slate-200 ${r.include && !r.readyDate ? 'border-amber-600' : 'border-slate-700'}`}
                        value={r.readyDate || ''}
                        onChange={(e) => updateRow(r._rowId, { readyDate: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtDate(r.dueDate)}</td>
                    <td className="px-3 py-2 text-slate-400 font-mono">${Number(r.totalValue || 0).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      <select
                        className="w-[180px] bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-200"
                        value={r.templateId || ''}
                        onChange={(e) => applyTemplateToRow(r._rowId, e.target.value)}
                      >
                        <option value="">—</option>
                        {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className="w-[160px] bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-200"
                        value={r.process}
                        onChange={(e) => updateRow(r._rowId, { process: e.target.value, templateId: null })}
                      >
                        <option value="">Not set</option>
                        {processes.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number" min={0} step={0.5}
                        className="w-16 bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-200"
                        value={r.hoursTotal}
                        onChange={(e) => updateRow(r._rowId, { hoursTotal: Number(e.target.value) || 0, templateId: null })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="accent-sky-500"
                        title="Needs machining, manual work or similar after this department"
                        checked={!!r.needsFurtherProcessing}
                        onChange={(e) => updateRow(r._rowId, { needsFurtherProcessing: e.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-4 mt-3 border-t border-slate-800">
            <span className="text-xs text-slate-500">{includedRows.length} job{includedRows.length === 1 ? '' : 's'} selected to import</span>
            <div className="flex gap-2">
              <button className={btnGhost} onClick={onClose}>Cancel</button>
              <button
                className={`${btnPrimary} disabled:opacity-40 disabled:cursor-not-allowed`}
                disabled={includedRows.length === 0}
                onClick={handleImportClick}
              >
                <Upload size={14} /> Import {includedRows.length || ''} job{includedRows.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ============================================================
   TEMPLATE MODAL
   ============================================================ */

// Shared chip editor for capability tags: type to add (Enter or the Add
// button), click × to remove, with datalist suggestions to keep spellings
// consistent across equipment/templates/jobs.
function TagEditor({ value, onChange, suggestions }) {
  const [input, setInput] = useState('');
  // Typing already fires Modal's blanket onChange bubbling; removing a chip
  // is a plain button click and doesn't, so it needs to say so explicitly.
  const markDirty = useContext(DirtyContext);
  const add = () => { const t = input.trim(); if (t && !value.includes(t)) { markDirty(); onChange([...value, t]); } setInput(''); };
  return (
    <div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {value.map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 flex items-center gap-1">
              {t}
              <button type="button" className="text-slate-500 hover:text-red-400" onClick={() => { markDirty(); onChange(value.filter((x) => x !== t)); }}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          className={inputCls}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          // Typing a tag and clicking Save without pressing Enter/Add first
          // discarded it silently — no error, nothing in the saved template —
          // which is exactly what "adding a capability requirement does
          // nothing" looks like from the outside (#9). Commit on blur, same as
          // KeywordChips/ComboChips: whatever takes focus next (including the
          // Save button) gets the tag included rather than losing it.
          onBlur={() => { if (input.trim()) add(); }}
          list="cap-tags"
          placeholder="e.g. 1T Positioner, 5T Positioner…"
        />
        {/* preventDefault on mousedown stops the browser shifting focus off
            the input before the click lands — without it, clicking Add fired
            blur (committing via the handler above) *and then* this button's
            own onClick, both racing to add the same tag from a stale closure:
            usually harmless, but occasionally the second, stale write landed
            after the first and the chip that had just appeared vanished
            again. One commit per click, full stop. */}
        <button type="button" className={btnGhost} onMouseDown={(e) => e.preventDefault()} onClick={add}>Add</button>
      </div>
      <datalist id="cap-tags">{(suggestions || []).filter((x) => !value.includes(x)).map((x) => <option key={x} value={x} />)}</datalist>
    </div>
  );
}

function TemplateModal({ template, equipment, processes, procedures = [], costCentres = [], allTags = [], categorySuggestions = [], onClose, onSave }) {
  const isNew = !template;
  const [name, setName] = useState(template?.name || '');
  const [category, setCategory] = useState(template?.category || '');
  const [tags, setTags] = useState(template?.tags || []);
  const [process, setProcess] = useState(template?.process || processes[0] || '');
  const [procedureId, setProcedureId] = useState(template?.procedureId || '');
  const [hoursPerUnit, setHoursPerUnit] = useState(template?.hoursPerUnit ?? 1);
  const [totalValuePerUnit, setTotalValuePerUnit] = useState(template?.totalValuePerUnit ?? '');
  const [departmentValuePerUnit, setDepartmentValuePerUnit] = useState(template?.departmentValuePerUnit ?? '');
  const [preferredEquipmentId, setPreferredEquipmentId] = useState(template?.preferredEquipmentId || '');

  const compatibleEquip = equipment.filter((e) => e.processes.includes(process));
  // Live preview of what the scheduler will actually use — same test as
  // equipmentForTemplate/tagOk, run against the in-progress process/tags
  // rather than the saved template, so it updates as either is edited.
  const matchingEquip = compatibleEquip.filter((e) => tagOk({ tags }, e));
  const procsForProcess = procedures.filter((p) => p.process === process);
  // Keep a template's existing category selectable even if it has since been
  // removed from the list, so opening an old template doesn't silently
  // reassign it just by being opened.
  const categoryOptions = [...new Set([...categorySuggestions, ...(category ? [category] : [])])].sort();

  return (
    <Modal title={isNew ? 'New template' : 'Edit template'} onClose={onClose}>
      <Field label="Template name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Category">
        <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">— Uncategorised —</option>
          {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {category && !categorySuggestions.includes(category) && (
          <p className="text-xs text-amber-400 mt-1">“{category}” isn’t in the category list any more — pick another, or re-add it under Templates.</p>
        )}
        {categorySuggestions.length === 0 && (
          <p className="text-xs text-slate-500 mt-1">Define categories in the Templates tab to group templates here.</p>
        )}
      </Field>
      <Field label="Process">
        <select className={inputCls} value={process} onChange={(e) => {
          const nv = e.target.value; setProcess(nv);
          const fm = procedures.filter((p) => p.process === nv);
          setProcedureId(fm.some((p) => p.id === procedureId) ? procedureId : (fm[0] ? fm[0].id : ''));
        }}>
          {processes.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </Field>
      <Field label="Procedure (sets hourly cost)">
        <select className={inputCls} value={procedureId} onChange={(e) => setProcedureId(e.target.value)}>
          <option value="">— none —</option>
          {procsForProcess.map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(procedureCost(p, costCentres))}/hr</option>)}
        </select>
      </Field>
      <Field label="Capability requirements (optional)">
        <TagEditor value={tags} onChange={setTags} suggestions={allTags} />
        <p className="text-xs text-slate-500 mt-1">Jobs from this template only schedule on equipment carrying every tag — e.g. a positioner load rating.</p>
      </Field>
      <Field label="Hours per unit"><input type="number" min={0.1} step={0.1} className={inputCls} value={hoursPerUnit} onChange={(e) => setHoursPerUnit(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Total value per unit ($, optional)">
          <input type="number" min={0} step={1} className={inputCls} value={totalValuePerUnit} onChange={(e) => setTotalValuePerUnit(e.target.value)} placeholder="e.g. 120" />
        </Field>
        <Field label="Dept. value per unit ($, optional)">
          <input type="number" min={0} step={1} className={inputCls} value={departmentValuePerUnit} onChange={(e) => setDepartmentValuePerUnit(e.target.value)} placeholder="e.g. 45" />
        </Field>
      </div>
      <p className="text-xs text-slate-500 -mt-2 mb-3">If set, these pre-fill a new job's total and department value based on quantity — still editable per job.</p>
      <Field label="Equipment this can run on">
        <p className="text-xs text-slate-500 mb-2">
          Determined automatically from the process and capability requirements above, not picked by hand — a job only ever schedules on equipment that matches both.
        </p>
        {compatibleEquip.length === 0 ? (
          <p className="text-xs text-slate-500">No equipment supports this process yet — add it under Equipment &amp; Staff.</p>
        ) : matchingEquip.length === 0 ? (
          <p className="text-xs text-amber-400">No equipment currently has every required capability tag — jobs from this template won't be placeable until one does.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {matchingEquip.map((e) => (
              <span key={e.id} className="text-xs px-2 py-1 rounded bg-slate-800 text-slate-300">{e.name}</span>
            ))}
          </div>
        )}
      </Field>
      <Field label="Preferred equipment (optional)">
        <select className={inputCls} value={preferredEquipmentId} onChange={(e) => setPreferredEquipmentId(e.target.value)}>
          <option value="">No preference — any compatible equipment</option>
          {matchingEquip.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          {preferredEquipmentId && !matchingEquip.some((e) => e.id === preferredEquipmentId) && (
            <option value={preferredEquipmentId}>
              {equipment.find((e) => e.id === preferredEquipmentId)?.name || 'Former equipment'} — no longer compatible
            </option>
          )}
        </select>
        <p className="text-xs text-slate-500 mt-1">
          A job made from this template (directly, or via WIP import) starts with this as its own preferred equipment — a soft nudge the scheduler tries first, not a pin. Still editable per job.
        </p>
      </Field>
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-800 mt-3">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button
          className={btnPrimary}
          onClick={() => onSave({
            id: template?.id || uid('tpl'),
            name: name.trim() || 'Untitled template',
            category: category.trim(),
            tags,
            process,
            procedureId,
            hoursPerUnit: Number(hoursPerUnit) || 1,
            totalValuePerUnit: totalValuePerUnit === '' ? null : Number(totalValuePerUnit),
            departmentValuePerUnit: departmentValuePerUnit === '' ? null : Number(departmentValuePerUnit),
            preferredEquipmentId: preferredEquipmentId || null,
          })}
        ><Check size={14} /> Save</button>
      </div>
    </Modal>
  );
}

/* ============================================================
   EQUIPMENT MODAL
   ============================================================ */

function EquipmentModal({ item, processes, allTags = [], onClose, onSave }) {
  const isNew = !item;
  const [name, setName] = useState(item?.name || '');
  const [type, setType] = useState(item?.type || EQUIP_TYPES[0]);
  const [procs, setProcs] = useState(item?.processes || []);
  const [tags, setTags] = useState(item?.tags || []);
  const [bcResourceNo, setBcResourceNo] = useState(item?.bcResourceNo || '');

  return (
    <Modal title={isNew ? 'Add equipment' : 'Edit equipment'} onClose={onClose}>
      <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Type">
        <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
          {EQUIP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Processes it can run">
        <MultiCheck options={processes} value={procs} onChange={setProcs} showOrphans />
      </Field>
      <Field label="Capability tags (optional)">
        <TagEditor value={tags} onChange={setTags} suggestions={allTags} />
        <p className="text-xs text-slate-500 mt-1">What this system is fitted with — jobs requiring a tag only schedule on equipment that has it.</p>
      </Field>
      <Field label="Business Central Resource No. (optional)">
        <input className={inputCls} value={bcResourceNo} onChange={(e) => setBcResourceNo(e.target.value)} placeholder="e.g. EQ-ROBOT-01" />
      </Field>
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-800 mt-3">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button
          className={btnPrimary}
          onClick={() => onSave({ id: item?.id || uid('eq'), name: name.trim() || 'Untitled', type, tags, processes: procs, unavailableDates: item?.unavailableDates || [], bcResourceNo: bcResourceNo.trim() })}
        ><Check size={14} /> Save</button>
      </div>
    </Modal>
  );
}

/* ============================================================
   STAFF MODAL
   ============================================================ */

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && aEnd >= bStart;
}

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

/* ============================================================
   PATTERNS VIEW — what the scheduler has noticed about your corrections
   ------------------------------------------------------------
   Step 2 of learning from overrides (see scheduler/CLAUDE.md). Strictly a
   REVIEW surface: it reads `wf_overrides` and shows what the history implies,
   and the only thing it can write is clearing that history.

   It deliberately does NOT apply anything. Every finding here is a claim about
   how the user works, derived from a small sample by a heuristic, and the
   entire purpose of showing it is so a person can say "no, that's not why I
   did that" BEFORE any of it is trusted. A view that silently acted on these
   would remove the only checkpoint the design has.

   The one action offered is navigational: a template-level finding can open
   that template so the user can set the preference themselves. Showing someone
   where to go is not the same as going there for them.
   ============================================================ */
function PatternsView({ overrides, equipment, templates, procedures, onOpenTemplate, onClearHistory, readOnly }) {
  const equipName = (id) => equipment.find((e) => e.id === id)?.name || id || '—';
  const labelFor = (key, value) => {
    if (key === 'templateId') return templates.find((t) => t.id === value)?.name || 'Deleted template';
    if (key === 'procedureId') return procedures.find((p) => p.id === value)?.name || 'Deleted procedure';
    return value;
  };
  const ATTRS = [
    ['templateId', 'Template'],
    ['process', 'Process'],
    ['procedureId', 'Procedure'],
    ['tags', 'Capability tag'],
  ];

  const summary = useMemo(() => summariseOverrides(overrides), [overrides]);
  const flow = useMemo(() => equipmentFlow(overrides), [overrides]);
  const range = useMemo(() => overrideDateRange(overrides), [overrides]);
  const evidence = useMemo(() => weightEvidence(overrides), [overrides]);
  // Deduped: a template has exactly one process, so every template finding
  // would otherwise reappear verbatim as a process finding (and often as a
  // capability-tag one), making one pattern look like three corroborating
  // ones. A genuinely broader group — several templates all feeding the same
  // machine — survives, since it spans records no single template covers.
  const findings = useMemo(() => {
    const byKey = {};
    ATTRS.forEach(([key]) => { byKey[key] = affinityFindings(overrides, key); });
    const deduped = dedupeFindings(byKey);
    return ATTRS.map(([key, label]) => [key, label, deduped[key] || []]);
  }, [overrides]);
  const anyFindings = findings.some(([, , f]) => f.length);

  if (!overrides.length) {
    return (
      <div className="border border-slate-800 bg-slate-900 rounded-lg p-6 text-center">
        <h2 className="text-sm font-semibold text-slate-200 mb-1">No corrections recorded yet</h2>
        <p className="text-xs text-slate-500 max-w-xl mx-auto">
          Every time you drag a job to different equipment, pin one from its detail view, or lock one to a
          machine, that correction is recorded here alongside what the scheduler had chosen. Once there are a
          few, this page will show what they have in common. Nothing recorded here changes how the scheduler
          behaves.
        </p>
      </div>
    );
  }

  const tierLabel = { 'too-few': 'too few to call', emerging: 'emerging', consistent: 'consistent' };

  return (
    <div className="space-y-4">
      <div className="border border-slate-800 bg-slate-900 rounded-lg p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-slate-200">
              {summary.n} correction{summary.n === 1 ? '' : 's'} recorded
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {range ? `${fmtDate(range.first.slice(0, 10))} – ${fmtDate(range.last.slice(0, 10))}. ` : ''}
              {summary.byChange.equipment || 0} changed the machine, {summary.byChange.startDate || 0} changed the day.
            </p>
          </div>
          {!readOnly && (
            <button className={btnGhost} onClick={onClearHistory} title="Discard every recorded correction">
              <Trash2 size={14} /> Clear history
            </button>
          )}
        </div>
        {/* The honest caveat, stated up front rather than buried. Nothing on
            this page is a significance test, and a page that looks analytical
            invites more trust than a handful of clicks can justify. */}
        <p className="text-[11px] text-slate-500 mt-3 border-t border-slate-800 pt-3">
          These are observations from a small sample, not statistics — read them as “is that actually why I did
          that?”, and ignore anything that doesn’t match how you'd describe your own reasoning. Nothing here
          changes how the scheduler behaves.
        </p>
      </div>

      {/* ---- the actionable half: this kind of work keeps going to that machine ---- */}
      {anyFindings && (
        <div className="border border-slate-800 bg-slate-900 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
            Work that keeps moving to the same machine
          </h3>
          <div className="space-y-4">
            {findings.filter(([, , f]) => f.length).map(([key, label, list]) => (
              <div key={key}>
                <p className="text-[11px] uppercase tracking-wide text-slate-600 mb-1.5">{label}</p>
                <div className="space-y-1.5">
                  {list.map((f) => {
                    // These two read almost identically in the numbers and call
                    // for completely different fixes — see classifyAffinity.
                    const ignored = f.kind === 'preference-ignored';
                    return (
                      <div
                        key={`${key}:${f.value}`}
                        className={`rounded-md px-3 py-2 border ${ignored ? 'border-amber-900 bg-amber-950/20' : 'border-slate-700 bg-slate-800/50'}`}
                      >
                        <div className="flex items-baseline justify-between gap-3 flex-wrap">
                          <span className="text-sm text-slate-200 font-medium">{labelFor(key, f.value)}</span>
                          <span className="text-[11px] text-slate-500">
                            {f.count} of {f.n} moves → {equipName(f.equipmentId)} ({Math.round(f.share * 100)}%) · {tierLabel[f.tier]}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">
                          {ignored ? (
                            <>
                              This work <span className="text-amber-300">already prefers {equipName(f.equipmentId)}</span>, and
                              you still have to move it there by hand — the preference is set but keeps being
                              outvoted when the scheduler picks a machine.
                            </>
                          ) : key === 'templateId' ? (
                            <>Consider setting this template’s preferred equipment to {equipName(f.equipmentId)}.</>
                          ) : (
                            // Only a template carries a preferredEquipmentId. A
                            // process, procedure or tag has no field to set, so
                            // pointing at one would send the user looking for a
                            // control that doesn't exist.
                            <>
                              Work like this keeps ending up on {equipName(f.equipmentId)} — worth setting preferred
                              equipment on the templates that produce it.
                            </>
                          )}
                        </p>
                        {key === 'templateId' && !ignored && !readOnly && onOpenTemplate && (
                          <button
                            className="text-[11px] text-amber-400 hover:underline mt-1"
                            onClick={() => onOpenTemplate(f.value)}
                          >
                            Open this template →
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-4">
        <div className="flex-1 min-w-0 border border-slate-800 bg-slate-900 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Where work gets moved</h3>
          {Object.keys(flow).length === 0 ? (
            <p className="text-xs text-slate-600">No machine changes recorded — every correction so far has been about timing.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-600 uppercase text-[10px]">
                  <th className="text-left font-medium pb-1">Equipment</th>
                  <th className="text-right font-medium pb-1">Moved off</th>
                  <th className="text-right font-medium pb-1">Moved onto</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(flow)
                  .sort((a, b) => (b[1].movedFrom + b[1].movedTo) - (a[1].movedFrom + a[1].movedTo))
                  .map(([id, f]) => (
                    <tr key={id} className="border-t border-slate-800">
                      <td className="py-1.5 text-slate-300">{equipName(id)}</td>
                      <td className="py-1.5 text-right text-slate-400 font-mono">{f.movedFrom}</td>
                      <td className="py-1.5 text-right text-slate-400 font-mono">{f.movedTo}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex-1 min-w-0 border border-slate-800 bg-slate-900 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">What you trade off</h3>
          <p className="text-[11px] text-slate-600 mb-3">
            From {summary.nComparable} correction{summary.nComparable === 1 ? '' : 's'} where the scheduler had
            actually evaluated the machine you picked.
          </p>
          {!evidence.length ? (
            <p className="text-xs text-slate-600">
              {summary.nComparable === 0
                ? 'None of the recorded corrections are directly comparable yet — see below.'
                : 'No consistent trade-off yet: the machines you moved between scored about the same, so these corrections were made for a reason the scheduler doesn’t currently measure.'}
            </p>
          ) : (
            <div className="space-y-1.5">
              {evidence.map((e) => (
                <div key={e.term} className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] text-slate-500 w-10 text-right shrink-0">
                    {e.mean > 0 ? '+' : ''}{e.mean.toFixed(1)}
                  </span>
                  <span className="text-xs text-slate-300">You {e.reading || e.term}</span>
                </div>
              ))}
            </div>
          )}
          {(summary.notComparable.infeasiblePick > 0 || summary.notComparable.movedToUnevaluatedDay > 0) && (
            <p className="text-[11px] text-slate-600 mt-3 border-t border-slate-800 pt-2">
              {summary.notComparable.movedToUnevaluatedDay > 0 && (
                <>{summary.notComparable.movedToUnevaluatedDay} correction(s) moved a job to a day the scheduler
                  never considered, so there’s nothing to compare against. </>
              )}
              {summary.notComparable.infeasiblePick > 0 && (
                <>{summary.notComparable.infeasiblePick} put a job somewhere the scheduler found no room at all.</>
              )}
            </p>
          )}
        </div>
      </div>

      <div className="border border-slate-800 bg-slate-900 rounded-lg p-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Recent corrections</h3>
        <div className="space-y-1">
          {[...overrides].slice(-12).reverse().map((r) => (
            <div key={r.id} className="flex items-baseline gap-2 text-xs border-t border-slate-800 pt-1.5 first:border-t-0 first:pt-0">
              <span className="text-slate-600 font-mono text-[10px] shrink-0">{(r.at || '').slice(0, 10)}</span>
              <span className="text-slate-300 truncate">{r.jobName}</span>
              {/* A timing-only correction has the same machine on both sides,
                  which renders as "Robot 1 → Robot 1" and reads as a no-op.
                  Show whichever dimension the user actually changed. */}
              <span className="text-slate-500 ml-auto shrink-0 text-right">
                {(r.changed || []).includes('equipment')
                  ? <>{equipName(r.scheduler?.equipmentId)} → {equipName(r.user?.equipmentId)}</>
                  : <>{fmtDate(r.scheduler?.startDate)} → {fmtDate(r.user?.startDate)}</>}
                <span className="text-slate-600"> · {r.source}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReportsView({ jobs, equipment, staff, procedures = [], costCentres = [], costSettings }) {
  const today = new Date();
  const [basis, setBasis] = useState('completed'); // completed | scheduled | due
  const [rangeStart, setRangeStart] = useState(isoDate(startOfMonth(today)));
  const [rangeEnd, setRangeEnd] = useState(isoDate(endOfMonth(today)));

  function setPreset(preset) {
    if (preset === 'thisMonth') {
      setRangeStart(isoDate(startOfMonth(today)));
      setRangeEnd(isoDate(endOfMonth(today)));
    } else if (preset === 'lastMonth') {
      const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      setRangeStart(isoDate(startOfMonth(lm)));
      setRangeEnd(isoDate(endOfMonth(lm)));
    } else if (preset === 'quarter') {
      const q = new Date(today.getFullYear(), today.getMonth() - 2, 1);
      setRangeStart(isoDate(startOfMonth(q)));
      setRangeEnd(isoDate(endOfMonth(today)));
    } else if (preset === 'ytd') {
      setRangeStart(isoDate(new Date(today.getFullYear(), 0, 1)));
      setRangeEnd(isoDate(endOfMonth(today)));
    }
  }

  const included = useMemo(() => {
    return jobs.filter((j) => {
      if (basis === 'completed') {
        // effectiveCompletionDate, not the raw completedDate (when someone
        // happened to click "Mark complete") — see its own comment. A job
        // finished Friday but not marked complete until the following
        // Wednesday used to land in Wednesday's reporting period; this
        // places it back in the period it was actually finished in.
        const ecd = effectiveCompletionDate(j);
        return j.status === 'complete' && ecd && ecd >= rangeStart && ecd <= rangeEnd;
      }
      if (basis === 'scheduled') {
        return j.assignment && overlaps(j.assignment.startDate, j.assignment.endDate, rangeStart, rangeEnd);
      }
      // due
      return j.dueDate >= rangeStart && j.dueDate <= rangeEnd;
    });
  }, [jobs, basis, rangeStart, rangeEnd]);

  const totalCompanyValue = included.reduce((s, j) => s + Number(j.totalValue || 0), 0);
  const totalDeptValue = included.reduce((s, j) => s + Number(j.departmentValue || 0), 0);
  const sharePct = totalCompanyValue > 0 ? Math.round((totalDeptValue / totalCompanyValue) * 1000) / 10 : 0;
  const totalCost = included.reduce((s, j) => s + (jobCost(j, procedures, costCentres, costSettings) || 0), 0);
  const deptMargin = totalDeptValue - totalCost;
  const marginPct = totalDeptValue > 0 ? Math.round((deptMargin / totalDeptValue) * 1000) / 10 : 0;
  const costedCount = included.filter((j) => jobCost(j, procedures, costCentres, costSettings) != null).length;

  const byProcess = useMemo(() => {
    const map = {};
    included.forEach((j) => {
      if (!map[j.process]) map[j.process] = { process: j.process, count: 0, totalValue: 0, departmentValue: 0 };
      map[j.process].count += 1;
      map[j.process].totalValue += Number(j.totalValue || 0);
      map[j.process].departmentValue += Number(j.departmentValue || 0);
    });
    return Object.values(map).sort((a, b) => b.departmentValue - a.departmentValue);
  }, [included]);

  const maxDept = Math.max(1, ...byProcess.map((p) => p.departmentValue));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <h2 className="text-lg font-bold text-slate-100">Department value report</h2>
          <p className="text-xs text-slate-500 mt-0.5">What your department contributes, separate from the total value of each job to the company.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1">
            {[
              { id: 'completed', label: 'Completed' },
              { id: 'scheduled', label: 'Scheduled' },
              { id: 'due', label: 'Due' },
            ].map((b) => (
              <button key={b.id} onClick={() => setBasis(b.id)} className={`px-3 py-1.5 rounded-md text-xs font-medium ${basis === b.id ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'}`}>
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <button className={btnGhost} onClick={() => setPreset('thisMonth')}>This month</button>
        <button className={btnGhost} onClick={() => setPreset('lastMonth')}>Last month</button>
        <button className={btnGhost} onClick={() => setPreset('quarter')}>Last 3 months</button>
        <button className={btnGhost} onClick={() => setPreset('ytd')}>Year to date</button>
        <div className="flex items-center gap-1.5 ml-2">
          <input type="date" className={`${inputCls} w-auto`} value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
          <span className="text-slate-600 text-xs">to</span>
          <input type="date" className={`${inputCls} w-auto`} value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
        </div>
      </div>

      <p className="text-xs text-slate-500 mb-4">
        {basis === 'completed' && 'Jobs your department finished within this date range.'}
        {basis === 'scheduled' && 'Jobs with schedule time in this range, whether finished or still upcoming.'}
        {basis === 'due' && 'Jobs whose customer due date falls in this range, regardless of status.'}
      </p>

      <div className="grid sm:grid-cols-3 gap-3 mb-4">
        <div className="border border-slate-800 bg-slate-900 rounded-lg p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Operating cost of these jobs</p>
          <p className="text-2xl font-bold text-slate-100 font-mono">{fmtMoney(totalCost)}</p>
          {/* "Estimated" used to be unconditional — misleading once a job
              completes, since jobCost() switches to actualHours the moment
              it does (see jobHoursForCost). The "Contributing jobs" table
              below breaks this exact total down row by row, actual vs
              estimated, so it isn't just an assertion. */}
          <p className="text-[10px] text-slate-500 mt-1">{costedCount} of {included.length} have a costed procedure — actual hours where complete, estimated otherwise</p>
        </div>
        <div className={`border rounded-lg p-4 ${deptMargin >= 0 ? 'border-emerald-700/50 bg-emerald-950/20' : 'border-red-800/50 bg-red-950/20'}`}>
          <p className={`text-[11px] uppercase tracking-wide mb-1 ${deptMargin >= 0 ? 'text-emerald-400/80' : 'text-red-400/80'}`}>Department margin (value − cost)</p>
          <p className={`text-2xl font-bold font-mono ${deptMargin >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{fmtMoney(deptMargin)}</p>
        </div>
        <div className="border border-slate-800 bg-slate-900 rounded-lg p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Margin on department value</p>
          <p className="text-2xl font-bold text-slate-100 font-mono">{marginPct}%</p>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-3 mb-6">
        <div className="border border-slate-800 bg-slate-900 rounded-lg p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total value of these jobs to the company</p>
          <p className="text-2xl font-bold text-slate-100 font-mono">${totalCompanyValue.toLocaleString()}</p>
        </div>
        <div className="border border-amber-700/50 bg-amber-950/20 rounded-lg p-4">
          <p className="text-[11px] uppercase tracking-wide text-amber-500/80 mb-1">Value your department provided</p>
          <p className="text-2xl font-bold text-amber-300 font-mono">${totalDeptValue.toLocaleString()}</p>
        </div>
        <div className="border border-slate-800 bg-slate-900 rounded-lg p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Department's share of total value</p>
          <p className="text-2xl font-bold text-slate-100 font-mono">{sharePct}%</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">By process</h3>
          <div className="border border-slate-800 bg-slate-900 rounded-lg p-4 space-y-3">
            {byProcess.length === 0 && <p className="text-xs text-slate-600">No jobs in this range yet.</p>}
            {byProcess.map((p) => (
              <div key={p.process}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-300">{p.process} <span className="text-slate-600">({p.count})</span></span>
                  <span className="text-amber-300 font-mono">${p.departmentValue.toLocaleString()}</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-amber-500 rounded-full" style={{ width: `${(p.departmentValue / maxDept) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Contributing jobs ({included.length})</h3>
          {/* Hours + Cost columns exist so the operating-cost/margin tiles
              above are checkable, not just asserted — each is the same
              jobHoursForCost()/jobCost() the tiles' own totals are summed
              from, per row, so they add back up to exactly what's shown
              there. "actual"/"est" makes explicit which hours a completed
              job's own cost was actually priced against, since that's what
              was reported as impossible to verify before this existed. */}
          <div className="border border-slate-800 bg-slate-900 rounded-lg overflow-hidden max-h-[320px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-900">
                <tr className="border-b border-slate-800 text-left text-slate-500 uppercase tracking-wide">
                  <th className="px-3 py-2 font-medium">Job</th>
                  <th className="px-3 py-2 font-medium">Total $</th>
                  <th className="px-3 py-2 font-medium">Dept $</th>
                  <th className="px-3 py-2 font-medium">Hours</th>
                  <th className="px-3 py-2 font-medium">Cost</th>
                  {/* Only meaningful for the Completed basis — the OTHER
                      two bases don't filter on this date at all, and most
                      rows there aren't complete yet to have one. */}
                  {basis === 'completed' && <th className="px-3 py-2 font-medium">Completed</th>}
                </tr>
              </thead>
              <tbody>
                {included.map((j) => {
                  const hrs = jobHoursForCost(j);
                  const isActualHrs = j.status === 'complete' && Number(j.actualHours) > 0;
                  const cost = jobCost(j, procedures, costCentres, costSettings);
                  const ecd = basis === 'completed' ? effectiveCompletionDate(j) : null;
                  return (
                    <tr key={j.id} className="border-b border-slate-800/60">
                      <td className="px-3 py-1.5 text-slate-300">{j.name}</td>
                      <td className="px-3 py-1.5 text-slate-500 font-mono">${Number(j.totalValue || 0).toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-amber-300 font-mono">${Number(j.departmentValue || 0).toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-slate-400 font-mono whitespace-nowrap">
                        {hrs}h <span className="text-slate-600">({isActualHrs ? 'actual' : 'est'})</span>
                      </td>
                      <td className="px-3 py-1.5 text-slate-300 font-mono">{cost != null ? fmtMoney(cost) : '—'}</td>
                      {basis === 'completed' && (
                        <td
                          className="px-3 py-1.5 text-slate-400 font-mono whitespace-nowrap"
                          title={ecd !== j.completedDate ? `Marked complete ${fmtDate(j.completedDate)} — this is when it actually finished, based on the schedule and actual hours` : 'Same as when it was marked complete'}
                        >
                          {fmtDate(ecd)}{ecd !== j.completedDate && <span className="text-amber-400"> *</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {included.length === 0 && <tr><td colSpan={basis === 'completed' ? 6 : 5} className="px-3 py-6 text-center text-slate-600">Nothing here yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {basis === 'completed' && (
            <p className="text-[10px] text-slate-600 mt-1.5">
              Completed date is when the job actually finished — based on its schedule and actual vs. estimated hours — not
              necessarily the day it was marked complete in the app. <span className="text-amber-400">*</span> flags a row where
              the two differ; hover it for both dates.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function StaffModal({ item, processes, onClose, onSave }) {
  const isNew = !item;
  const [name, setName] = useState(item?.name || '');
  const [procs, setProcs] = useState(item?.processes || []);
  const [bcResourceNo, setBcResourceNo] = useState(item?.bcResourceNo || '');
  // '' means "automatic" — falls back to STAFF_PALETTE[index in staff list],
  // same as before this existed. An explicit choice here overrides that and
  // stays fixed regardless of list order (add/remove/reorder no longer
  // shuffles everyone's colour on the Schedule view).
  const [color, setColor] = useState(item?.color || '');

  return (
    <Modal title={isNew ? 'Add staff member' : 'Edit staff member'} onClose={onClose}>
      <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Certified / competent processes">
        <MultiCheck options={processes} value={procs} onChange={setProcs} showOrphans />
      </Field>
      <Field label="Timeline colour">
        <div className="flex flex-wrap items-center gap-2">
          {STAFF_PALETTE.map((c) => (
            <DirtyButton
              key={c}
              onClick={() => setColor(c)}
              className={`w-7 h-7 rounded-full ${color === c ? 'ring-2 ring-offset-2 ring-offset-slate-900 ring-amber-400' : ''}`}
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
          <DirtyButton
            onClick={() => setColor('')}
            className={`text-[11px] px-2 py-1.5 rounded border ${!color ? 'border-amber-400 text-amber-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'}`}
          >Automatic</DirtyButton>
        </div>
        <p className="text-xs text-slate-500 mt-1">Shown as this person's colour on the Schedule view. Automatic assigns one from the palette based on staff order.</p>
      </Field>
      <Field label="Business Central Resource No. (optional)">
        <input className={inputCls} value={bcResourceNo} onChange={(e) => setBcResourceNo(e.target.value)} placeholder="e.g. RES-0042" />
      </Field>
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-800 mt-3">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button
          className={btnPrimary}
          onClick={() => onSave({
            id: item?.id || uid('st'),
            name: name.trim() || 'Untitled',
            processes: procs,
            color: color || null,
            bcResourceNo: bcResourceNo.trim(),
            weeklyRoster: item?.weeklyRoster || defaultWeeklyRoster(),
            leavePeriods: item?.leavePeriods || [],
          })}
        ><Check size={14} /> Save</button>
      </div>
    </Modal>
  );
}
