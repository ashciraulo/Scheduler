import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Plus, X, Settings2, Calendar, Users, Wrench, Check, AlertTriangle,
  Monitor, ChevronLeft, ChevronRight, Trash2, Pencil, Pin, PinOff,
  Loader2, ClipboardList, LayoutGrid, CircleCheck, DollarSign, Clock, CalendarOff,
  Upload, FileWarning
} from 'lucide-react';

/* ============================================================
   SHIFTS & ROSTER CONSTANTS
   ============================================================ */

const SHIFT_DEFS = {
  day: { id: 'day', label: 'Day Shift', defaultHours: 8 },
  afternoon: { id: 'afternoon', label: 'Afternoon Shift', defaultHours: 8 },
};
const SHIFT_ORDER = ['day', 'afternoon'];
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // indexed by Date.getDay()
const DAY_COLS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

function defaultWeeklyRoster(shift = 'day') {
  return {
    mon: { working: true, shift, hours: 8 },
    tue: { working: true, shift, hours: 8 },
    wed: { working: true, shift, hours: 8 },
    thu: { working: true, shift, hours: 8 },
    fri: { working: true, shift, hours: 8 },
    sat: { working: false, shift: 'day', hours: 0 },
    sun: { working: false, shift: 'day', hours: 0 },
  };
}
function normalizeStaff(s) {
  return {
    ...s,
    weeklyRoster: s.weeklyRoster || defaultWeeklyRoster(),
    leavePeriods: s.leavePeriods || [],
  };
}

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
   percentComplete              →  informational status field — NOT the same as BC's calculated
                                    WIP % (BC derives WIP from actual vs. budgeted cost/sales
                                    ledger entries). Push this to a custom/status field, not the
                                    WIP calculation itself, unless real cost postings back it up.
   totalValue                   →  Job / Job Task "Contract (Total Price)" — value to the company
   departmentValue              →  no standard BC field — candidate for a custom field on the
                                    Job Task Line (this department's share of the contract value)
   status / completedDate       →  Job "Status" (Open/Completed) and its status-change date
   bcJobNo                      →  Job No. (the BC key to link back to) — optional, blank until linked
   bcJobTaskNo                  →  Job Task No. — optional, blank until linked
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
    { id: 'tp_1', name: 'Bracket Weld - Standard', category: 'Brackets & Frames', tags: [], process: 'Robotic MIG Welding', hoursPerUnit: 0.5, equipmentIds: ['eq_1', 'eq_2', 'eq_3', 'eq_4'], totalValuePerUnit: 120, departmentValuePerUnit: 45 },
    { id: 'tp_2', name: 'Chassis Frame Weld', category: 'Brackets & Frames', tags: ['5T Positioner'], process: 'Robotic TIG Welding', hoursPerUnit: 2, equipmentIds: ['eq_1', 'eq_2', 'eq_4'], totalValuePerUnit: 850, departmentValuePerUnit: 310 },
    { id: 'tp_3', name: 'Hydraulic Shaft HVOF Coating', category: 'Shafts & Rollers', tags: [], process: 'Thermal Spray - HVOF', hoursPerUnit: 1.5, equipmentIds: ['eq_5', 'eq_6'], totalValuePerUnit: 640, departmentValuePerUnit: 210 },
    { id: 'tp_4', name: 'Turbine Blade Plasma Coat', category: 'Turbine Components', tags: [], process: 'Thermal Spray - Plasma Spray', hoursPerUnit: 3, equipmentIds: ['eq_5'], totalValuePerUnit: 2100, departmentValuePerUnit: 780 },
    { id: 'tp_5', name: 'Wear Plate Arc Spray', category: 'Wear Plates', tags: [], process: 'Thermal Spray - Arc Spray', hoursPerUnit: 1, equipmentIds: ['eq_6'], totalValuePerUnit: 300, departmentValuePerUnit: 95 },
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

function mkJob({ name, process, quantity, hoursPerUnit, dueDate, readyDate = null, templateId = null, notes = '', totalValue = 0, departmentValue = 0, percentComplete = 0 }) {
  return {
    id: uid('job'),
    name,
    process,
    quantity,
    hoursTotal: Math.round(quantity * hoursPerUnit * 100) / 100,
    dueDate,
    readyDate: readyDate || isoDate(new Date()),
    templateId,
    notes,
    totalValue: Number(totalValue) || 0,
    departmentValue: Number(departmentValue) || 0,
    percentComplete: Number(percentComplete) || 0,
    status: 'active',
    completedDate: null,
    tags: [],
    procedureId: '',
    bcJobNo: '',
    bcJobTaskNo: '',
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
      powder: { material: 'WC-CoCr 86/10/4', pricePerKg: 82, gPerMin: 83.33 },
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
      powder: { material: 'Cr₃C₂-NiCr (WOKA 7202)', pricePerKg: 95, gPerMin: 75 },
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
      powder: { material: 'NiCrAlY', pricePerKg: 120, gPerMin: 63.33 },
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
// Procedure → per-category and total $/hr.
function procedureParts(p, costCentres) {
  if (!p) return { powder: 0, gas: 0, electricity: 0, spares: 0, maintenance: 0, consumables: 0, depreciation: 0, labour: 0, qa: 0, total: 0 };
  const pw = p.powder || {}, el = p.electricity || {};
  const cc = (costCentres || []).find((c) => c.id === p.costCentreId);
  const t = {};
  t.powder = (Number(pw.pricePerKg) || 0) * ((Number(pw.gPerMin) || 0) * 0.06);
  t.gas = (p.gases || []).reduce((s, g) => s + (Number(g.pricePerUnit) || 0) * gasUnitsHr(g), 0);
  t.electricity = (Number(el.kw) || 0) * (Number(el.tariff) || 0);
  t.spares = (p.spares || []).reduce((s, r) => s + (Number(r.life) > 0 ? (Number(r.cost) || 0) / Number(r.life) : 0), 0);
  t.maintenance = (p.maintenance || []).reduce((s, r) => s + (Number(r.interval) > 0 ? (Number(r.cost) || 0) / Number(r.interval) : 0), 0);
  t.consumables = (p.consumables || []).reduce((s, r) => s + (Number(r.costPerHour) || 0), 0);
  t.depreciation = costCentrePerHr(cc);
  t.labour = (p.labour || []).reduce((s, r) => s + (Number(r.rate) || 0) * (Number(r.count) || 0), 0);
  t.qa = (p.qa || []).reduce((s, r) => s + (Number(r.costPerHour) || 0), 0);
  t.total = t.powder + t.gas + t.electricity + t.spares + t.maintenance + t.consumables + t.depreciation + t.labour + t.qa;
  return t;
}
const procedureCost = (p, costCentres) => procedureParts(p, costCentres).total;
// Hours used to cost a job: actual once complete, otherwise the estimate.
const jobHoursForCost = (j) => (j && j.status === 'complete' && Number(j.actualHours) > 0 ? Number(j.actualHours) : Number((j && j.hoursTotal) || 0));
function jobCost(j, procedures, costCentres) {
  if (!j || !j.procedureId) return null;
  const p = (procedures || []).find((x) => x.id === j.procedureId);
  if (!p) return null;
  return procedureCost(p, costCentres) * jobHoursForCost(j);
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
    powder: s.powder || { material: '', pricePerKg: 0, gPerMin: 0 }, gases: Array.isArray(s.gases) ? s.gases : [], electricity: s.electricity || { kw: 0, tariff: 0 },
    spares: Array.isArray(s.spares) ? s.spares : [], maintenance: Array.isArray(s.maintenance) ? s.maintenance : [], consumables: Array.isArray(s.consumables) ? s.consumables : [],
    labour: Array.isArray(s.labour) ? s.labour : [], qa: Array.isArray(s.qa) ? s.qa : [],
  }));
  return { costCentres, procedures };
}

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/* ============================================================
   DATE HELPERS
   ============================================================ */

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
function generateCalendarDays(startDateStr, numCalendarDays) {
  const days = [];
  let d = new Date(startDateStr + 'T00:00:00');
  for (let i = 0; i < numCalendarDays; i++) {
    days.push(isoDate(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}
function isWeekendDate(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  return dow === 0 || dow === 6;
}
function isOnLeave(staffMember, dateStr) {
  return (staffMember.leavePeriods || []).some((p) => dateStr >= p.startDate && dateStr <= p.endDate);
}
function getStaffDayInfo(staffMember, dateStr) {
  if (isOnLeave(staffMember, dateStr)) return { working: false, shift: null, hours: 0 };
  const key = DAY_KEYS[new Date(dateStr + 'T00:00:00').getDay()];
  const pattern = (staffMember.weeklyRoster || {})[key];
  if (!pattern || !pattern.working) return { working: false, shift: null, hours: 0 };
  return { working: true, shift: pattern.shift || 'day', hours: Number(pattern.hours) || 0 };
}
function fmtDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return {
    dow: d.toLocaleDateString('en-US', { weekday: 'short' }),
    dom: d.getDate(),
  };
}
function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateRange(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const year = new Date(endIso + 'T00:00:00').getFullYear();
  return `${fmtDate(startIso)} – ${fmtDate(endIso)}, ${year}`;
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
   SCHEDULING ENGINE
   Capacity is now tracked per equipment/day/shift, and per staff
   member/day (staff work at most one shift a day, per their
   roster). A single job can be fulfilled by different staff on
   different days, or even by two different people on the same
   day if it runs across both a day-shift and afternoon-shift
   block on the same equipment.
   ============================================================ */

function buildCapacityMaps(equipment, staff, days) {
  // equipDayLock[equipId][date] = the id of the job currently "set up" on that
  // equipment that day (or 'closed' for a marked-unavailable day), else null.
  // A day is locked once a job has claimed it AND still has hours left to go
  // after that day — i.e. every day strictly before a job's last working day.
  // Equipment is a physical cell/robot — once a job claims it, nothing else can
  // use it, even an idle gap day within that job's own span, because tearing
  // down and re-fixturing a different job just to grab a few spare hours isn't
  // realistic. A job's *final* day (where its hours run out) is the exception:
  // whatever's left over that specific day, after the job is done, is fair
  // game for the next job to use the same day — see equipShiftUsed.
  const equipDayLock = {};
  const equipShiftUsed = {}; // equipShiftUsed[equipId][date][shift] = hours already spoken for
  equipment.forEach((e) => {
    equipDayLock[e.id] = {};
    equipShiftUsed[e.id] = {};
    days.forEach((day) => {
      equipDayLock[e.id][day] = (e.unavailableDates || []).includes(day) ? 'closed' : null;
      equipShiftUsed[e.id][day] = { day: 0, afternoon: 0 };
    });
  });
  const staffDayRemain = {}; // staffDayRemain[staffId][date] = hours available that day
  const staffDayShift = {}; // staffDayShift[staffId][date] = 'day' | 'afternoon' | null
  staff.forEach((s) => {
    staffDayRemain[s.id] = {};
    staffDayShift[s.id] = {};
    days.forEach((day) => {
      const info = getStaffDayInfo(s, day);
      staffDayRemain[s.id][day] = info.hours;
      staffDayShift[s.id][day] = info.shift;
    });
  });
  return { equipDayLock, equipShiftUsed, staffDayRemain, staffDayShift };
}

function tryFit(days, startIdx, hoursNeeded, equipId, compatibleStaffIds, equipDayLock, equipShiftUsed, staffDayRemain, staffDayShift) {
  // A job with no positive hours has nothing to place; return null so the
  // caller falls into its conflict/placeholder path instead of accepting an
  // empty (but truthy) plan that would render as a blank block.
  if (!(hoursNeeded > 0.001)) return null;
  let remaining = hoursNeeded;
  let idx = startIdx;
  const plan = [];
  let preferredStaffId = null; // once someone starts this job, keep them on it where possible
  while (remaining > 0.001) {
    if (idx >= days.length) return null;
    const date = days[idx];
    // Someone else's unfinished job already has this whole day claimed (or
    // it's marked unavailable) — this job can't slot into the gap, full stop.
    if (equipDayLock[equipId]?.[date]) return null;
    for (const shift of SHIFT_ORDER) {
      if (remaining <= 0.001) break;
      const already = equipShiftUsed[equipId]?.[date]?.[shift] ?? 0;
      const shiftCap = SHIFT_DEFS[shift].defaultHours - already;
      if (shiftCap <= 0.001) continue;

      let candidate = null;
      const preferredStillAvailable =
        preferredStaffId &&
        staffDayShift[preferredStaffId]?.[date] === shift &&
        (staffDayRemain[preferredStaffId]?.[date] ?? 0) > 0.001;
      if (preferredStillAvailable) {
        candidate = preferredStaffId;
      } else {
        // No one is already "on" this job for this shift (or the person who was
        // isn't rostered/available today) — pick whoever has the most free hours
        // this shift, since that person is least likely to force another handover
        // later in the job.
        const options = compatibleStaffIds.filter(
          (sid) => staffDayShift[sid]?.[date] === shift && (staffDayRemain[sid]?.[date] ?? 0) > 0.001
        );
        if (options.length) {
          options.sort((a, b) => (staffDayRemain[b][date] ?? 0) - (staffDayRemain[a][date] ?? 0));
          candidate = options[0];
        }
      }
      if (!candidate) continue;
      const use = Math.min(shiftCap, staffDayRemain[candidate][date], remaining);
      if (use <= 0.001) continue;
      plan.push({ date, shift, staffId: candidate, hours: use });
      remaining -= use;
      preferredStaffId = candidate;
    }
    idx++;
  }
  return plan;
}

function consume(plan, equipId, jobId, days, equipDayLock, equipShiftUsed, staffDayRemain) {
  if (!plan.length) return;
  const startDate = plan[0].date;
  const finalDate = plan[plan.length - 1].date;
  // Lock every calendar day strictly before the job's last working day —
  // fully exclusive, including any idle gap day, since the job isn't done
  // until that last day. The last day itself is only "used up" for the hours
  // actually spent (below), so whatever's left over is free the same day.
  let inSpan = false;
  for (const d of days) {
    if (d === startDate) inSpan = true;
    if (inSpan && d !== finalDate) equipDayLock[equipId][d] = jobId;
    if (d === finalDate) break;
  }
  plan.forEach(({ date, shift, staffId, hours }) => {
    equipShiftUsed[equipId][date][shift] += hours;
    staffDayRemain[staffId][date] -= hours;
  });
}

// A job schedules on a piece of equipment only if the equipment carries every
// capability tag the job requires (e.g. a positioner load rating). Untagged
// jobs run anywhere their process allows, exactly as before.
function tagOk(job, equip) {
  const need = job.tags || [];
  return !need.length || need.every((t) => (equip.tags || []).includes(t));
}

// Human-readable reason a job couldn't be auto-placed, shown on its
// "Needs scheduling" card. Checked in order of severity.
function whyUnscheduled(job, equipment, staff, days) {
  if (!(job.hoursTotal > 0.001)) return 'no hours set on this job yet — add hours (or a template) so it can be scheduled';
  const runsProcess = equipment.filter((e) => e.processes.includes(job.process));
  if (!runsProcess.length) return `no equipment runs ${job.process}`;
  const need = job.tags || [];
  if (need.length) {
    const ok = runsProcess.filter((e) => tagOk(job, e));
    if (!ok.length) {
      const missing = need.filter((t) => !runsProcess.some((e) => (e.tags || []).includes(t)));
      return missing.length
        ? `no equipment running ${job.process} has: ${missing.join(', ')}`
        : `no single ${job.process} system has all of: ${need.join(', ')}`;
    }
  }
  if (!staff.filter((s) => s.processes.includes(job.process)).length) return `no staff can run ${job.process}`;
  if (job.readyDate && job.readyDate > days[days.length - 1]) return `not ready until ${fmtDate(job.readyDate)} — beyond the schedule horizon`;
  return `no free equipment/staff capacity in the horizon for ${job.hoursTotal}h`;
}

function runScheduler(jobsIn, equipment, staff, days) {
  const order = jobsIn.map((j) => j.id);

  // A split job (job.parts set) doesn't get scheduled as one unit — each part
  // is independently placeable (they may end up on different equipment, at
  // different times), so it's flattened into its parts here and reassembled
  // at the end. A regular job passes through unchanged.
  const splitParents = new Map(); // parentId -> original job, for reassembly
  const jobs = [];
  jobsIn.forEach((j) => {
    if (Array.isArray(j.parts) && j.parts.length > 0) {
      splitParents.set(j.id, j);
      j.parts.forEach((part, i) => {
        jobs.push({
          id: part.id,
          _parentId: j.id,
          _partIndex: i,
          name: j.name,
          process: j.process,
          hoursTotal: part.hoursTotal,
          readyDate: j.readyDate,
          dueDate: j.dueDate,
          percentComplete: part.percentComplete,
          status: part.status,
          assignment: part.assignment ? { ...part.assignment } : null,
        });
      });
    } else {
      jobs.push({ ...j, assignment: j.assignment ? { ...j.assignment } : null });
    }
  });

  const { equipDayLock, equipShiftUsed, staffDayRemain, staffDayShift } = buildCapacityMaps(equipment, staff, days);
  let claimCounter = 0; // stamped onto each placed assignment so the Schedule view can lay out same-day handoffs left-to-right in the order they were actually claimed

  const complete = jobs.filter((j) => j.status === 'complete');
  const active = jobs.filter((j) => j.status !== 'complete');
  const pinned = active.filter((j) => j.assignment && j.assignment.pinned);
  const unpinned = active.filter((j) => !(j.assignment && j.assignment.pinned));

  // 1. Place pinned (manually placed) jobs first - reserve their capacity.
  //    Which staff/shift cover each day is worked out automatically from
  //    the roster; a job can span a day-shift stint and an afternoon-shift
  //    stint (different people) on the same date if that's what it takes.
  pinned.forEach((job) => {
    const a = job.assignment;
    const compatibleStaffIds = staff.filter((s) => s.processes.includes(job.process)).map((s) => s.id);
    const startIdx = days.indexOf(a.startDate);
    const notYetReady = job.readyDate && a.startDate < job.readyDate;
    let conflict = false;
    let plan = [];
    if (startIdx === -1 || notYetReady || !equipDayLock[a.equipmentId]) {
      conflict = true;
    } else {
      const fit = tryFit(days, startIdx, job.hoursTotal, a.equipmentId, compatibleStaffIds, equipDayLock, equipShiftUsed, staffDayRemain, staffDayShift);
      if (fit) {
        plan = fit;
        consume(plan, a.equipmentId, job.id, days, equipDayLock, equipShiftUsed, staffDayRemain);
      } else {
        conflict = true;
      }
    }
    if (conflict) {
      // Forced fallback so the job still shows up where the user dropped it,
      // clearly flagged as overbooked rather than silently vanishing.
      let idx = Math.max(0, startIdx);
      let remaining = job.hoursTotal;
      while (remaining > 0.001 && idx < days.length) {
        const date = days[idx];
        const use = Math.min(SHIFT_DEFS.day.defaultHours, remaining);
        plan.push({ date, shift: 'day', staffId: null, hours: use });
        remaining -= use;
        idx++;
      }
      if (plan.length === 0) plan = [{ date: a.startDate, shift: 'day', staffId: null, hours: job.hoursTotal }];
    }
    job.assignment = {
      equipmentId: a.equipmentId,
      startDate: plan[0]?.date || a.startDate,
      endDate: plan[plan.length - 1]?.date || a.startDate,
      pinned: true,
      conflict,
      days: plan,
      claimOrder: claimCounter++,
    };
  });

  // 2. Auto-schedule unpinned jobs, earliest due date first, into earliest available slot.
  unpinned.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  // How many pending jobs can run on ONLY this one piece of equipment (no
  // alternative machine). Used below so that when a job with a choice of
  // machines finds them equally good, it defers to whichever one nothing
  // else is depending on exclusively — instead of camping on a machine a
  // less-flexible job needs and blocking it for no benefit to anyone.
  const exclusiveDemand = {};
  equipment.forEach((e) => { exclusiveDemand[e.id] = 0; });
  unpinned.forEach((j) => {
    const compat = equipment.filter((e) => e.processes.includes(j.process) && tagOk(j, e));
    if (compat.length === 1) exclusiveDemand[compat[0].id] += 1;
  });

  unpinned.forEach((job) => {
    const compatibleEquip = equipment.filter((e) => e.processes.includes(job.process) && tagOk(job, e));
    const compatibleStaffIds = staff.filter((s) => s.processes.includes(job.process)).map((s) => s.id);
    let best = null;
    let floorIdx = 0;
    if (job.readyDate) {
      floorIdx = days.findIndex((d) => d >= job.readyDate);
      if (floorIdx === -1) floorIdx = days.length;
    }
    if (compatibleEquip.length && compatibleStaffIds.length) {
      const candidates = [];
      for (const e of compatibleEquip) {
        for (let idx = floorIdx; idx < days.length; idx++) {
          const fit = tryFit(days, idx, job.hoursTotal, e.id, compatibleStaffIds, equipDayLock, equipShiftUsed, staffDayRemain, staffDayShift);
          if (fit) {
            candidates.push({ equipId: e.id, plan: fit, startDate: fit[0].date, endDate: fit[fit.length - 1].date });
            break; // this is the earliest start this particular machine can offer
          }
        }
      }
      // Pick whichever compatible machine finishes the job soonest (ties broken by
      // earliest start). This is the key fix: previously the first machine in the
      // list that could fit the job *at all* was used, even if it meant dragging
      // the job out over many sparse days while an equally-capable machine sat
      // completely free — which is exactly what was piling every job onto one
      // robot and pushing due dates out.
      if (candidates.length) {
        candidates.sort((a, b) => {
          if (a.endDate !== b.endDate) return a.endDate < b.endDate ? -1 : 1;
          if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
          // This job would finish equally well on either machine — prefer the
          // one fewer other pending jobs are exclusively stuck with, so a
          // flexible job doesn't block a less-flexible one for no gain.
          const aExcl = exclusiveDemand[a.equipId] || 0;
          const bExcl = exclusiveDemand[b.equipId] || 0;
          if (aExcl !== bExcl) return aExcl - bExcl;
          const aStaffCount = new Set(a.plan.map((d) => d.staffId)).size;
          const bStaffCount = new Set(b.plan.map((d) => d.staffId)).size;
          if (aStaffCount !== bStaffCount) return aStaffCount - bStaffCount; // fewer different people = less handover
          return a.plan.length - b.plan.length; // fewer chunks = less fragmented
        });
        best = candidates[0];
      }
    }
    if (best) {
      consume(best.plan, best.equipId, job.id, days, equipDayLock, equipShiftUsed, staffDayRemain);
      job.assignment = {
        equipmentId: best.equipId,
        startDate: best.plan[0].date,
        endDate: best.plan[best.plan.length - 1].date,
        pinned: false,
        conflict: false,
        days: best.plan,
        claimOrder: claimCounter++,
      };
    } else {
      job.assignment = null;
      job.unschedReason = whyUnscheduled(job, equipment, staff, days);
    }
  });

  const flatResult = [...pinned, ...unpinned, ...complete];

  // Reassemble: collapse each split job's scheduled parts back onto its
  // parent (hoursTotal/percentComplete/status become aggregates; the parent
  // itself carries no single assignment — see its parts instead). Regular
  // jobs pass through untouched.
  const collapsedByParent = new Map();
  const all = [];
  flatResult.forEach((unit) => {
    if (!unit._parentId) { all.push(unit); return; }
    let collapsed = collapsedByParent.get(unit._parentId);
    if (!collapsed) {
      const parent = splitParents.get(unit._parentId);
      collapsed = { ...parent, parts: new Array(parent.parts.length) };
      collapsedByParent.set(unit._parentId, collapsed);
      all.push(collapsed);
    }
    collapsed.parts[unit._partIndex] = {
      id: unit.id,
      hoursTotal: unit.hoursTotal,
      percentComplete: unit.percentComplete,
      status: unit.status,
      assignment: unit.assignment,
      unschedReason: unit.unschedReason,
    };
  });
  collapsedByParent.forEach((collapsed) => {
    const totalHours = collapsed.parts.reduce((s, p) => s + (p.hoursTotal || 0), 0);
    const weightedPct = totalHours > 0
      ? collapsed.parts.reduce((s, p) => s + (p.percentComplete || 0) * (p.hoursTotal || 0), 0) / totalHours
      : 0;
    collapsed.hoursTotal = Math.round(totalHours * 100) / 100;
    collapsed.percentComplete = Math.round(weightedPct);
    collapsed.status = collapsed.parts.every((p) => p.status === 'complete') ? 'complete' : 'active';
    collapsed.assignment = null;
  });

  all.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return all;
}

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
const inputCls = "w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/60 focus:border-amber-500/60";
const btnPrimary = "inline-flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-sm px-3 py-2 rounded-md transition-colors";
const btnGhost = "inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm px-3 py-2 rounded-md transition-colors border border-slate-700";
const btnDanger = "inline-flex items-center gap-1.5 bg-red-950 hover:bg-red-900 text-red-300 text-sm px-3 py-2 rounded-md transition-colors border border-red-900";

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className={`bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full ${wide ? 'max-w-5xl' : 'max-w-md'} max-h-[85vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 sticky top-0 bg-slate-900">
          <h3 className="font-semibold text-slate-100 text-base">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function MultiCheck({ options, value, onChange, getLabel = (x) => x, getId = (x) => x }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const id = getId(opt);
        const active = value.includes(id);
        return (
          <button
            type="button"
            key={id}
            onClick={() => onChange(active ? value.filter((v) => v !== id) : [...value, id])}
            className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
              active ? 'bg-amber-500/20 border-amber-500 text-amber-300' : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}
          >
            {getLabel(opt)}
          </button>
        );
      })}
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

export default function WeldingScheduler() {
  const [loaded, setLoaded] = useState(false);
  const [equipment, setEquipment] = useState([]);
  const [staff, setStaff] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [processes, setProcesses] = useState(DEFAULT_PROCESSES);
  const [jobs, setJobs] = useState([]);

  const [tab, setTab] = useState('schedule');
  const [readOnly, setReadOnly] = useState(false);
  const [displayMode, setDisplayMode] = useState(false);

  const [editingJob, setEditingJob] = useState(null); // job object or 'new' or null
  const [importOpen, setImportOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [editingEquipment, setEditingEquipment] = useState(null);
  const [editingStaff, setEditingStaff] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // {type, id, name}

  const [dragJobId, setDragJobId] = useState(null);
  const [dropHint, setDropHint] = useState(null); // {equipId, date}
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  function showToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  const todayIso = useMemo(() => isoDate(new Date()), []);
  const workingDays = useMemo(() => generateCalendarDays(todayIso, HORIZON_DAYS), [todayIso]);
  const [rangeStart, setRangeStart] = useState(0); // index into workingDays
  const [rangeLength, setRangeLength] = useState(30); // days shown at once — see RANGE_PRESETS
  const visibleDays = useMemo(
    () => workingDays.slice(rangeStart, rangeStart + rangeLength),
    [workingDays, rangeStart, rangeLength]
  );

  // ---------- initial load ----------
  useEffect(() => {
    (async () => {
      const [eq, st, tp, pr, jb] = await Promise.all([
        loadKey('wf_equipment', null),
        loadKey('wf_staff', null),
        loadKey('wf_templates', null),
        loadKey('wf_processes', null),
        loadKey('wf_jobs', null),
      ]);
      const finalEq = eq || seedEquipment();
      const finalSt = (st || seedStaff()).map(normalizeStaff);
      const finalTp = tp || seedTemplates();
      const finalPr = pr || DEFAULT_PROCESSES;
      const finalJb = jb || seedJobs();

      setEquipment(finalEq);
      setStaff(finalSt);
      setTemplates(finalTp);
      setProcesses(finalPr);

      const wd = generateCalendarDays(isoDate(new Date()), HORIZON_DAYS);
      const scheduled = runScheduler(finalJb, finalEq, finalSt, wd);
      setJobs(scheduled);

      if (!eq) saveKey('wf_equipment', finalEq);
      saveKey('wf_staff', finalSt);
      if (!tp) saveKey('wf_templates', finalTp);
      if (!pr) saveKey('wf_processes', finalPr);
      saveKey('wf_jobs', scheduled);

      setLoaded(true);
    })();
  }, []);

  const recompute = useCallback((jobsList, eqList, stList) => {
    const result = runScheduler(jobsList, eqList, stList, workingDays);
    setJobs(result);
    saveKey('wf_jobs', result);
    return result;
  }, [workingDays]);

  // ---------- job actions ----------
  function addOrUpdateJob(jobData, isNew) {
    const stamped = { ...jobData, updatedAt: new Date().toISOString() };
    let newJobs;
    if (isNew) {
      newJobs = [...jobs, stamped];
    } else {
      newJobs = jobs.map((j) => (j.id === stamped.id ? stamped : j));
    }
    recompute(newJobs, equipment, staff);
    setEditingJob(null);
  }
  function importJobs(newJobs) {
    const now = new Date().toISOString();
    const stamped = newJobs.map((j) => ({ ...j, id: uid('job'), updatedAt: now, assignment: null }));
    recompute([...jobs, ...stamped], equipment, staff);
    setImportOpen(false);
    showToast(`Imported ${stamped.length} job${stamped.length === 1 ? '' : 's'} from WIP export.`);
  }
  function deleteJob(id) {
    recompute(jobs.filter((j) => j.id !== id), equipment, staff);
    setConfirmDelete(null);
    setEditingJob(null);
  }
  function toggleComplete(job) {
    const nowComplete = job.status !== 'complete';
    const updated = {
      ...job,
      status: nowComplete ? 'complete' : 'active',
      completedDate: nowComplete ? isoDate(new Date()) : null,
      percentComplete: nowComplete ? 100 : job.percentComplete,
      updatedAt: new Date().toISOString(),
    };
    recompute(jobs.map((j) => (j.id === job.id ? updated : j)), equipment, staff);
  }
  function unpinJob(job) {
    const updated = { ...job, assignment: job.assignment ? { ...job.assignment, pinned: false } : null, updatedAt: new Date().toISOString() };
    recompute(jobs.map((j) => (j.id === job.id ? updated : j)), equipment, staff);
  }
  function unpinPart(job, partIndex) {
    const newParts = job.parts.map((p, i) => (i === partIndex ? { ...p, assignment: p.assignment ? { ...p.assignment, pinned: false } : null } : p));
    recompute(jobs.map((j) => (j.id === job.id ? { ...job, parts: newParts, updatedAt: new Date().toISOString() } : j)), equipment, staff);
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
    const parts = [
      { id: uid('part'), hoursTotal: a, percentComplete: job.percentComplete || 0, status: 'active', assignment: null },
      { id: uid('part'), hoursTotal: b, percentComplete: 0, status: 'active', assignment: null },
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
    if (job.readyDate && date < job.readyDate) {
      showToast(`${job.name} isn't received/ready until ${fmtDate(job.readyDate)} — can't schedule it earlier.`);
      return;
    }
    const newAssignment = { equipmentId: equipId, startDate: date, endDate: date, pinned: true, conflict: false, days: [] };
    const updated = partIndex === null
      ? { ...job, updatedAt: new Date().toISOString(), assignment: newAssignment }
      : { ...job, updatedAt: new Date().toISOString(), parts: job.parts.map((p, i) => (i === partIndex ? { ...p, assignment: newAssignment } : p)) };
    recompute(jobs.map((j) => (j.id === job.id ? updated : j)), equipment, staff);
  }

  // ---------- equipment / staff / template CRUD ----------
  function saveEquipment(item, isNew) {
    const list = isNew ? [...equipment, item] : equipment.map((e) => (e.id === item.id ? item : e));
    setEquipment(list);
    saveKey('wf_equipment', list);
    recompute(jobs, list, staff);
    setEditingEquipment(null);
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
    const list = isNew ? [...templates, item] : templates.map((t) => (t.id === item.id ? item : t));
    setTemplates(list);
    saveKey('wf_templates', list);
    setEditingTemplate(null);
  }
  function deleteTemplate(id) {
    const list = templates.filter((t) => t.id !== id);
    setTemplates(list);
    saveKey('wf_templates', list);
    setConfirmDelete(null);
  }
  function saveProcesses(list) {
    setProcesses(list);
    saveKey('wf_processes', list);
  }

  const staffById = useMemo(() => Object.fromEntries(staff.map((s) => [s.id, s])), [staff]);
  const equipById = useMemo(() => Object.fromEntries(equipment.map((e) => [e.id, e])), [equipment]);

  // Flattened to part level (not just job level) so a split job's specific
  // unscheduled/conflicted part can be dragged onto the schedule on its own.
  const unscheduledJobs = [];
  const conflictJobs = [];
  jobs.forEach((j) => {
    if (j.status === 'complete') return;
    if (Array.isArray(j.parts)) {
      j.parts.forEach((p, i) => {
        if (p.status === 'complete') return;
        const unit = {
          id: p.id,
          name: j.parts.length > 1 ? `${j.name} (Part ${i + 1})` : j.name,
          process: j.process,
          hoursTotal: p.hoursTotal,
          readyDate: j.readyDate,
          dueDate: j.dueDate,
          assignment: p.assignment,
          _parentJob: j,
        };
        if (!p.assignment) unscheduledJobs.push(unit);
        if (p.assignment && p.assignment.conflict) conflictJobs.push(unit);
      });
    } else {
      if (!j.assignment) unscheduledJobs.push(j);
      if (j.assignment && j.assignment.conflict) conflictJobs.push(j);
    }
  });

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
      <header className="border-b border-slate-800 bg-slate-950/95 sticky top-0 z-30 backdrop-blur">
        <div className="px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded bg-amber-500 flex items-center justify-center text-slate-950 font-bold text-sm">W</div>
            <div>
              <h1 className="font-bold text-slate-100 text-sm leading-tight tracking-tight">WELDCELL SCHEDULER</h1>
              <p className="text-[11px] text-slate-500 leading-tight">Production planning · shared &amp; synced</p>
            </div>
          </div>
          {!displayMode && (
            <nav className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1">
              {[
                { id: 'schedule', label: 'Schedule', icon: LayoutGrid },
                { id: 'backlog', label: 'Job Backlog', icon: ClipboardList },
                { id: 'roster', label: 'Roster', icon: Clock },
                { id: 'templates', label: 'Templates', icon: Calendar },
                { id: 'resources', label: 'Equipment & Staff', icon: Wrench },
                { id: 'reports', label: 'Value Reports', icon: DollarSign },
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
            visibleDays={visibleDays}
            rangeStart={rangeStart}
            setRangeStart={setRangeStart}
            rangeLength={rangeLength}
            setRangeLength={setRangeLength}
            totalDays={workingDays.length}
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
            onAddJob={() => setEditingJob('new')}
          />
        )}

        {tab === 'backlog' && !displayMode && (
          <BacklogView
            jobs={jobs}
            equipment={equipment}
            staff={staff}
            readOnly={readOnly}
            onAdd={() => setEditingJob('new')}
            onImport={() => setImportOpen(true)}
            onEdit={(j) => setEditingJob(j)}
            onToggleComplete={toggleComplete}
            onUnpin={unpinJob}
            onDelete={(j) => setConfirmDelete({ type: 'job', id: j.id, name: j.name })}
          />
        )}

        {tab === 'roster' && !displayMode && (
          <RosterView
            staff={staff}
            readOnly={readOnly}
            onUpdateStaff={(item) => saveStaff(item, false)}
          />
        )}

        {tab === 'templates' && !displayMode && (
          <TemplatesView
            templates={templates}
            equipment={equipment}
            processes={processes}
            readOnly={readOnly}
            onAdd={() => setEditingTemplate('new')}
            onEdit={(t) => setEditingTemplate(t)}
            onDelete={(t) => setConfirmDelete({ type: 'template', id: t.id, name: t.name })}
            onSaveProcesses={saveProcesses}
          />
        )}

        {tab === 'reports' && !displayMode && (
          <ReportsView jobs={jobs} equipment={equipment} staff={staff} />
        )}

        {tab === 'resources' && !displayMode && (
          <ResourcesView
            equipment={equipment}
            staff={staff}
            processes={processes}
            readOnly={readOnly}
            onAddEquip={() => setEditingEquipment('new')}
            onEditEquip={(e) => setEditingEquipment(e)}
            onDeleteEquip={(e) => setConfirmDelete({ type: 'equipment', id: e.id, name: e.name })}
            onAddStaff={() => setEditingStaff('new')}
            onEditStaff={(s) => setEditingStaff(s)}
            onDeleteStaff={(s) => setConfirmDelete({ type: 'staff', id: s.id, name: s.name })}
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
          onClose={() => setEditingJob(null)}
          onSave={(data) => addOrUpdateJob(data, editingJob === 'new')}
          onDelete={editingJob !== 'new' ? () => setConfirmDelete({ type: 'job', id: editingJob.id, name: editingJob.name }) : null}
          onToggleComplete={editingJob !== 'new' ? () => { toggleComplete(editingJob); setEditingJob(null); } : null}
          onUnpin={editingJob !== 'new' && editingJob.assignment?.pinned ? () => { unpinJob(editingJob); setEditingJob(null); } : null}
          onSplit={editingJob !== 'new' && !editingJob.parts ? (hoursA) => splitJob(editingJob, hoursA) : null}
          onMerge={editingJob !== 'new' && editingJob.parts ? () => mergeJobParts(editingJob) : null}
          onUnpinPart={editingJob !== 'new' && editingJob.parts ? (partIndex) => { unpinPart(editingJob, partIndex); setEditingJob(null); } : null}
        />
      )}

      {importOpen && (
        <ImportJobsModal
          templates={templates}
          processes={processes}
          existingJobs={jobs}
          onClose={() => setImportOpen(false)}
          onImport={importJobs}
        />
      )}

      {editingTemplate && (
        <TemplateModal
          template={editingTemplate === 'new' ? null : editingTemplate}
          equipment={equipment}
          processes={processes}
          onClose={() => setEditingTemplate(null)}
          onSave={(data) => saveTemplate(data, editingTemplate === 'new')}
        />
      )}

      {editingEquipment && (
        <EquipmentModal
          item={editingEquipment === 'new' ? null : editingEquipment}
          processes={processes}
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
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
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
function buildEquipRowSegments(equipJobs, visibleDays, colWidth) {
  const byDateShift = {};
  visibleDays.forEach((d) => { byDateShift[d] = { day: [], afternoon: [] }; });
  equipJobs.forEach((job) => {
    (job.assignment.days || []).forEach((entry) => {
      if (byDateShift[entry.date]) byDateShift[entry.date][entry.shift].push({ job, hours: entry.hours });
    });
  });
  Object.values(byDateShift).forEach((cell) => {
    SHIFT_ORDER.forEach((s) => cell[s].sort((a, b) => (a.job.assignment.claimOrder ?? 0) - (b.job.assignment.claimOrder ?? 0)));
  });

  const raw = [];
  visibleDays.forEach((date, dayIdx) => {
    const cell = byDateShift[date];
    const activeShifts = SHIFT_ORDER.filter((s) => cell[s].length > 0);
    const colLeft = dayIdx * colWidth;
    if (activeShifts.length === 0) {
      const owner = equipJobs.find((j) => j.assignment.startDate <= date && date <= j.assignment.endDate);
      if (owner) raw.push({ job: owner, left: colLeft, width: colWidth });
      return;
    }
    const splitHalf = activeShifts.length > 1;
    activeShifts.forEach((shift, si) => {
      const sectionWidth = splitHalf ? colWidth / 2 : colWidth;
      let offset = splitHalf ? si * sectionWidth : 0;
      cell[shift].forEach(({ job, hours }) => {
        const w = Math.min(sectionWidth, (hours / SHIFT_DEFS[shift].defaultHours) * sectionWidth);
        raw.push({ job, left: colLeft + offset, width: Math.min(w, colLeft + colWidth - (colLeft + offset)) });
        offset += w;
      });
    });
  });

  raw.sort((a, b) => a.left - b.left);
  const merged = [];
  raw.forEach((seg) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.job.id === seg.job.id && Math.abs(prev.left + prev.width - seg.left) < 0.5) {
      prev.width += seg.width;
    } else {
      merged.push({ ...seg });
    }
  });
  const labeled = new Set();
  merged.forEach((seg) => {
    if (!labeled.has(seg.job.id)) { seg.isLabel = true; labeled.add(seg.job.id); }
  });
  return merged;
}

function ScheduleView({
  equipment, staff, jobs, visibleDays, rangeStart, setRangeStart, rangeLength, setRangeLength, totalDays,
  readOnly, displayMode, dragJobId, setDragJobId, dropHint, setDropHint, onDrop,
  onEditJob, unscheduledJobs, conflictJobs, onAddJob,
}) {
  const colWidth = displayMode ? 92 : 76;
  const rowHeight = displayMode ? 76 : 60;

  const jobsByEquip = useMemo(() => {
    const map = {};
    equipment.forEach((e) => { map[e.id] = []; });
    const pushUnit = (unit) => {
      if (unit.status === 'complete' || !unit.assignment) return;
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
            name: j.parts.length > 1 ? `${j.name} (Part ${i + 1})` : j.name,
            hoursTotal: part.hoursTotal,
            percentComplete: part.percentComplete,
            status: part.status,
            assignment: part.assignment,
            _parentJob: j,
          });
        });
      } else {
        pushUnit(j);
      }
    });
    return map;
  }, [equipment, jobs]);

  const canPrev = rangeStart > 0;
  const canNext = rangeStart + rangeLength < totalDays;
  const rangeLabel = visibleDays.length ? fmtDateRange(visibleDays[0], visibleDays[visibleDays.length - 1]) : '';

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
              onClick={() => setRangeStart((i) => Math.min(Math.max(0, totalDays - rangeLength), i + rangeLength))}
            ><ChevronRight size={14} /></button>
          </div>
          <div className="flex items-center gap-2">
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
              <button className={btnPrimary} onClick={onAddJob}><Plus size={15} /> New job</button>
            )}
          </div>
        </div>

        <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900">
          <div className="overflow-x-auto">
            <div style={{ minWidth: 180 + visibleDays.length * colWidth }}>
              {/* Day header row */}
              <div className="flex border-b border-slate-800 bg-slate-900 sticky top-0 z-10">
                <div className="shrink-0 w-[180px] px-3 py-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wide border-r border-slate-800">
                  Equipment
                </div>
                {visibleDays.map((day) => {
                  const { dow, dom } = fmtDay(day);
                  const isToday = day === isoDate(new Date());
                  const weekend = isWeekendDate(day);
                  return (
                    <div
                      key={day}
                      style={{ width: colWidth }}
                      className={`shrink-0 text-center py-2 border-r border-slate-800/60 ${isToday ? 'bg-amber-500/10' : weekend ? 'bg-slate-950/70' : ''}`}
                    >
                      <div className={`text-[10px] uppercase tracking-wide ${isToday ? 'text-amber-400 font-semibold' : weekend ? 'text-slate-600' : 'text-slate-500'}`}>{dow}</div>
                      <div className={`text-sm font-semibold ${isToday ? 'text-amber-300' : weekend ? 'text-slate-600' : 'text-slate-300'}`}>{dom}</div>
                    </div>
                  );
                })}
              </div>

              {/* Equipment rows */}
              {equipment.map((eq) => {
                const color = EQUIP_COLOR[eq.type] || EQUIP_COLOR['Welding Robot'];
                const equipJobs = jobsByEquip[eq.id] || [];
                const segments = buildEquipRowSegments(equipJobs, visibleDays, colWidth);
                return (
                  <div key={eq.id} className={`flex border-b border-slate-800/70 border-l-[3px] ${color.border}`}>
                    <div className="shrink-0 w-[180px] px-3 py-2 border-r border-slate-800 flex flex-col justify-center">
                      <div className="text-sm font-semibold text-slate-200 truncate">{eq.name}</div>
                      <div className={`text-[10px] ${color.text} truncate`}>{eq.type}</div>
                    </div>
                    <div className="relative" style={{ height: rowHeight, width: visibleDays.length * colWidth }}>
                      {/* drop-target background cells */}
                      <div className="absolute inset-0 flex">
                        {visibleDays.map((day) => {
                          const isHint = dropHint && dropHint.equipId === eq.id && dropHint.date === day;
                          const weekend = isWeekendDate(day);
                          return (
                            <div
                              key={day}
                              style={{ width: colWidth }}
                              className={`h-full border-r border-slate-800/40 ${isHint ? 'bg-amber-500/20' : weekend ? 'bg-slate-950/40' : ''}`}
                              onDragOver={(e) => { if (!readOnly) { e.preventDefault(); setDropHint({ equipId: eq.id, date: day }); } }}
                              onDragLeave={() => setDropHint(null)}
                              onDrop={(e) => { e.preventDefault(); onDrop(eq.id, day); }}
                            />
                          );
                        })}
                      </div>
                      {/* job blocks — one lane; each segment sized to the actual
                          share of the day/shift it uses, so a job that finishes
                          partway through a day can hand the rest of that day off
                          to the next job instead of stacking into a new row */}
                      {segments.map((seg, i) => {
                        const job = seg.job;
                        const staffIds = [...new Set((job.assignment.days || []).map((d) => d.staffId).filter(Boolean))];
                        const hasAfternoon = (job.assignment.days || []).some((d) => d.shift === 'afternoon');
                        const hasDay = (job.assignment.days || []).some((d) => d.shift === 'day');
                        let personLabel = 'Unassigned';
                        if (staffIds.length === 1) personLabel = staff.find((s) => s.id === staffIds[0])?.name || 'Unassigned';
                        else if (staffIds.length > 1) personLabel = `${staffIds.length} staff`;
                        const conflict = job.assignment.conflict;
                        const left = seg.left + 2;
                        const width = Math.max(6, seg.width - 4);
                        const isPart = !!job._parentJob;
                        return (
                          <div
                            key={`${job.id}_${i}`}
                            draggable={!readOnly}
                            onDragStart={() => setDragJobId(job.id)}
                            onDragEnd={() => { setDragJobId(null); setDropHint(null); }}
                            onClick={() => onEditJob(isPart ? job._parentJob : job)}
                            style={{ position: 'absolute', left, width, top: 5, height: rowHeight - 10 }}
                            className={`rounded-md px-2 py-1 cursor-pointer overflow-hidden shadow-sm border transition-transform hover:scale-[1.015] ${
                              conflict
                                ? 'bg-red-950 border-red-700'
                                : job.assignment.pinned
                                ? 'bg-slate-800 border-amber-600'
                                : 'bg-slate-800 border-slate-600'
                            }`}
                            title={`${job.name} · ${job.hoursTotal}h${staffIds.length ? ' · ' + staffIds.map((id) => staff.find((s) => s.id === id)?.name).filter(Boolean).join(', ') : ''}`}
                          >
                            {seg.isLabel && (
                              <>
                                <div className="flex items-center gap-1 text-[11px] font-semibold text-slate-100 truncate">
                                  {conflict && <AlertTriangle size={11} className="text-red-400 shrink-0" />}
                                  {job.assignment.pinned && !conflict && <Pin size={10} className="text-amber-400 shrink-0" />}
                                  <span className="truncate">{job.name}</span>
                                </div>
                                <div className="text-[10px] text-slate-400 truncate flex items-center gap-1">
                                  <span className="truncate">{personLabel} · {job.hoursTotal}h</span>
                                  {hasDay && hasAfternoon && <span className="shrink-0 text-[9px] px-1 rounded bg-slate-700 text-slate-300">2 shifts</span>}
                                </div>
                                {job.percentComplete > 0 && (
                                  <div className="h-1 bg-slate-700 rounded-full overflow-hidden mt-0.5">
                                    <div className="h-full bg-amber-500 rounded-full" style={{ width: `${job.percentComplete}%` }} />
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
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
                  <div className="font-medium text-slate-200 truncate">{j.name}</div>
                  <div className="text-slate-500">{j.hoursTotal}h · ready {fmtDate(j.readyDate)} · due {fmtDate(j.dueDate)} · no capacity or compatible resource found in horizon</div>
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

function BacklogView({ jobs, equipment, staff, readOnly, onAdd, onImport, onEdit, onToggleComplete, onUnpin, onDelete }) {
  const [filter, setFilter] = useState('active');
  const filtered = jobs.filter((j) => (filter === 'all' ? true : filter === 'complete' ? j.status === 'complete' : j.status !== 'complete'));
  const sorted = [...filtered].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

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
            <button className={btnGhost} onClick={onImport}><Upload size={15} /> Import from WIP export</button>
            <button className={btnPrimary} onClick={onAdd}><Plus size={15} /> New job</button>
          </div>
        )}
      </div>

      <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900 overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
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
                  <td className="px-3 py-2 font-medium text-slate-200 cursor-pointer" onClick={() => onEdit(j)}>
                    <span className="flex items-center gap-1.5">
                      {j.name}
                      {isSplit && <span title="Split into two parts" className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-400">split</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{j.process}</td>
                  <td className="px-3 py-2 text-slate-400">{j.quantity}</td>
                  <td className="px-3 py-2 text-slate-400">{j.hoursTotal}h</td>
                  <td className="px-3 py-2 text-slate-400">
                    <div className="flex items-center gap-2 w-24">
                      <div className="h-1.5 flex-1 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-amber-500 rounded-full" style={{ width: `${j.percentComplete || 0}%` }} />
                      </div>
                      <span className="text-[11px] w-8 text-right">{j.percentComplete || 0}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{fmtDate(j.readyDate)}</td>
                  <td className="px-3 py-2 text-slate-400">{fmtDate(j.dueDate)}</td>
                  <td className="px-3 py-2 text-slate-400">
                    {j.status === 'complete' ? <span className="text-slate-600">—</span> : isSplit ? (
                      <span className="text-slate-400">{scheduledParts}/{j.parts.length} parts scheduled</span>
                    ) : eq ? (
                      <span className="flex items-center gap-1">
                        {eq.name}{personLabel ? ` · ${personLabel}` : ''}
                        {j.assignment.pinned && <Pin size={11} className="text-amber-400" />}
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
              <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-600 text-sm">No jobs in this view.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================================================
   TEMPLATES VIEW
   ============================================================ */

function TemplatesView({ templates, equipment, processes, readOnly, onAdd, onEdit, onDelete, onSaveProcesses }) {
  const [newProcess, setNewProcess] = useState('');
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-100">Job templates</h2>
          {!readOnly && <button className={btnPrimary} onClick={onAdd}><Plus size={15} /> New template</button>}
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          {templates.map((t) => (
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
              <div className="flex flex-wrap gap-1 mt-2">
                {t.equipmentIds.map((id) => {
                  const eq = equipment.find((e) => e.id === id);
                  return eq ? <span key={id} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{eq.name}</span> : null;
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h2 className="text-lg font-bold text-slate-100 mb-4">Welding &amp; coating processes</h2>
        <div className="border border-slate-800 bg-slate-900 rounded-lg p-4">
          <div className="space-y-1.5 mb-3">
            {processes.map((p) => (
              <div key={p} className="flex items-center justify-between text-sm text-slate-300 bg-slate-800/60 rounded px-2 py-1.5">
                <span>{p}</span>
                {!readOnly && (
                  <button onClick={() => onSaveProcesses(processes.filter((x) => x !== p))} className="text-slate-500 hover:text-red-400"><X size={13} /></button>
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
   RESOURCES VIEW (equipment + staff)
   ============================================================ */

/* ============================================================
   ROSTER VIEW (weekly shift pattern + leave per staff member)
   ============================================================ */

function RosterView({ staff, readOnly, onUpdateStaff }) {
  const [leaveModalFor, setLeaveModalFor] = useState(null); // staff object or null
  const [leaveStart, setLeaveStart] = useState(isoDate(new Date()));
  const [leaveEnd, setLeaveEnd] = useState(isoDate(new Date()));
  const [leaveReason, setLeaveReason] = useState('');

  function updateDay(member, dayKey, patch) {
    const roster = { ...(member.weeklyRoster || defaultWeeklyRoster()) };
    roster[dayKey] = { ...roster[dayKey], ...patch };
    onUpdateStaff({ ...member, weeklyRoster: roster });
  }

  function addLeave() {
    if (!leaveModalFor) return;
    const periods = [...(leaveModalFor.leavePeriods || []), { id: uid('lv'), startDate: leaveStart, endDate: leaveEnd, reason: leaveReason.trim() }];
    onUpdateStaff({ ...leaveModalFor, leavePeriods: periods });
    setLeaveModalFor(null);
    setLeaveReason('');
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
        <h2 className="text-lg font-bold text-slate-100 mb-1">Weekly roster</h2>
        <p className="text-xs text-slate-500 mb-4">Set each person's normal working pattern — which days, which shift, and how many hours. The scheduler uses this instead of assuming an 8-hour, 5-day week for everyone.</p>
        <div className="border border-slate-800 bg-slate-900 rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2 font-medium sticky left-0 bg-slate-900">Staff</th>
                {DAY_COLS.map(([key, label]) => <th key={key} className="px-2 py-2 font-medium text-center">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {staff.map((m) => (
                <tr key={m.id} className="border-b border-slate-800/60">
                  <td className="px-3 py-2 font-medium text-slate-200 sticky left-0 bg-slate-900 whitespace-nowrap">{m.name}</td>
                  {DAY_COLS.map(([key]) => {
                    const pattern = (m.weeklyRoster || {})[key] || { working: false, shift: 'day', hours: 0 };
                    return (
                      <td key={key} className="px-1.5 py-2 text-center">
                        <div className="flex flex-col items-center gap-1">
                          <select
                            disabled={readOnly}
                            className="bg-slate-800 border border-slate-700 rounded text-[11px] px-1 py-1 text-slate-200 w-[74px]"
                            value={pattern.working ? pattern.shift : 'off'}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === 'off') updateDay(m, key, { working: false, hours: 0 });
                              else updateDay(m, key, { working: true, shift: v, hours: pattern.hours || SHIFT_DEFS[v].defaultHours });
                            }}
                          >
                            <option value="off">Off</option>
                            <option value="day">Day</option>
                            <option value="afternoon">Afternoon</option>
                          </select>
                          {pattern.working && (
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
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-600 text-sm">Add staff under Equipment &amp; Staff first.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500 mt-2">
          Day and Afternoon shifts don't overlap in time, so if one person covers the day shift and another covers the afternoon on the same machine, a job can be worked on by both across that day — the schedule will show it as spanning two shifts.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2"><CalendarOff size={17} /> Leave</h2>
        </div>
        <div className="border border-slate-800 bg-slate-900 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2 font-medium">Staff</th>
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
                  <td className="px-3 py-2 text-slate-400">{fmtDate(p.startDate)}</td>
                  <td className="px-3 py-2 text-slate-400">{fmtDate(p.endDate)}</td>
                  <td className="px-3 py-2 text-slate-400">{p.reason || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {!readOnly && (
                      <button onClick={() => removeLeave(staff.find((s) => s.id === p.staffId), p.id)} className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"><Trash2 size={13} /></button>
                    )}
                  </td>
                </tr>
              ))}
              {allLeave.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-600 text-sm">No upcoming leave booked.</td></tr>
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
                onClick={() => { setLeaveModalFor(m); setLeaveStart(isoDate(new Date())); setLeaveEnd(isoDate(new Date())); setLeaveReason(''); }}
              >
                <Plus size={13} /> Leave for {m.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {leaveModalFor && (
        <Modal title={`Add leave — ${leaveModalFor.name}`} onClose={() => setLeaveModalFor(null)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From"><input type="date" className={inputCls} value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} /></Field>
            <Field label="To"><input type="date" className={inputCls} value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} /></Field>
          </div>
          <Field label="Reason (optional)"><input className={inputCls} value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} placeholder="e.g. Annual leave" /></Field>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800 mt-3">
            <button className={btnGhost} onClick={() => setLeaveModalFor(null)}>Cancel</button>
            <button className={btnPrimary} onClick={addLeave}><Check size={14} /> Save leave</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ResourcesView({ equipment, staff, processes, readOnly, onAddEquip, onEditEquip, onDeleteEquip, onAddStaff, onEditStaff, onDeleteStaff }) {
  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2"><Wrench size={17} /> Equipment</h2>
          {!readOnly && <button className={btnPrimary} onClick={onAddEquip}><Plus size={15} /> Add</button>}
        </div>
        <div className="space-y-2">
          {equipment.map((e) => {
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
      </div>
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2"><Users size={17} /> Staff</h2>
          {!readOnly && <button className={btnPrimary} onClick={onAddStaff}><Plus size={15} /> Add</button>}
        </div>
        <div className="space-y-2">
          {staff.map((s) => (
            <div key={s.id} className="border border-slate-800 bg-slate-900 rounded-lg p-3">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-slate-100 text-sm">{s.name}</h3>
                {!readOnly && (
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => onEditStaff(s)} className="p-1 rounded hover:bg-slate-700 text-slate-400"><Pencil size={13} /></button>
                    <button onClick={() => onDeleteStaff(s)} className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"><Trash2 size={13} /></button>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {s.processes.map((p) => <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{p}</span>)}
              </div>
              {s.leavePeriods?.length > 0 && <p className="text-[10px] text-slate-600 mt-2">{s.leavePeriods.length} leave period(s) on file — see Roster tab</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   JOB MODAL
   ============================================================ */

function JobModal({ job, templates, processes, staff, onClose, onSave, onDelete, onToggleComplete, onUnpin, onSplit, onMerge, onUnpinPart }) {
  const isNew = !job;
  const [parts, setParts] = useState(job?.parts ? job.parts.map((p) => ({ ...p })) : null);
  const [showSplit, setShowSplit] = useState(false);
  const [splitHoursA, setSplitHoursA] = useState(job ? Math.round((job.hoursTotal / 2) * 100) / 100 : 0);
  const [templateId, setTemplateId] = useState(job?.templateId || (templates[0]?.id ?? ''));
  const [name, setName] = useState(job?.name || templates[0]?.name || '');
  const [process, setProcess] = useState(job?.process || templates[0]?.process || processes[0] || '');
  const [quantity, setQuantity] = useState(job?.quantity ?? 1);
  const [hoursPerUnit, setHoursPerUnit] = useState(job ? (job.quantity ? job.hoursTotal / job.quantity : job.hoursTotal) : (templates[0]?.hoursPerUnit ?? 1));
  const [readyDate, setReadyDate] = useState(job?.readyDate || isoDate(new Date()));
  const [dueDate, setDueDate] = useState(job?.dueDate || addDays(isoDate(new Date()), 14));
  const [notes, setNotes] = useState(job?.notes || '');
  const [custom, setCustom] = useState(isNew ? false : !job.templateId);
  const [totalValue, setTotalValue] = useState(job?.totalValue ?? (templates[0]?.totalValuePerUnit ? templates[0].totalValuePerUnit * (job?.quantity ?? 1) : 0));
  const [departmentValue, setDepartmentValue] = useState(job?.departmentValue ?? (templates[0]?.departmentValuePerUnit ? templates[0].departmentValuePerUnit * (job?.quantity ?? 1) : 0));
  const [percentComplete, setPercentComplete] = useState(job?.percentComplete ?? 0);
  const [bcJobNo, setBcJobNo] = useState(job?.bcJobNo || '');
  const [bcJobTaskNo, setBcJobTaskNo] = useState(job?.bcJobTaskNo || '');
  const [showBcLink, setShowBcLink] = useState(!!(job?.bcJobNo || job?.bcJobTaskNo));

  function applyTemplate(id) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) {
      setName(t.name);
      setProcess(t.process);
      setHoursPerUnit(t.hoursPerUnit);
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

  function handleSave() {
    const hoursTotal = Math.round(quantity * hoursPerUnit * 100) / 100;
    const data = {
      id: job?.id || uid('job'),
      name: name.trim() || 'Untitled job',
      process,
      quantity: Number(quantity) || 1,
      readyDate,
      dueDate,
      templateId: custom ? null : templateId,
      notes,
      totalValue: Number(totalValue) || 0,
      departmentValue: Number(departmentValue) || 0,
      bcJobNo: bcJobNo.trim(),
      bcJobTaskNo: bcJobTaskNo.trim(),
      completedDate: job?.completedDate || null,
      assignment: job?.assignment || null,
      // hoursTotal/percentComplete/status are derived from parts by the
      // scheduler on the very next recompute when the job is split, but set
      // sensible values here too in case anything reads them first.
      hoursTotal: parts ? parts.reduce((s, p) => s + (p.hoursTotal || 0), 0) : hoursTotal,
      percentComplete: parts
        ? Math.round(parts.reduce((s, p) => s + (p.percentComplete || 0) * (p.hoursTotal || 0), 0) / Math.max(1, parts.reduce((s, p) => s + (p.hoursTotal || 0), 0)))
        : Math.max(0, Math.min(100, Number(percentComplete) || 0)),
      status: parts ? (parts.every((p) => p.status === 'complete') ? 'complete' : 'active') : (job?.status || 'active'),
      parts: parts ? parts.map((p) => ({ ...p })) : null,
    };
    onSave(data);
  }

  return (
    <Modal title={isNew ? 'New job' : 'Edit job'} onClose={onClose}>
      {!parts && !custom && templates.length > 0 && (
        <Field label="Template">
          <select className={inputCls} value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}
      {!parts && templates.length > 0 && (
        <button type="button" className="text-xs text-amber-400 mb-3 hover:underline" onClick={() => setCustom((c) => !c)}>
          {custom ? 'Use a template instead' : 'Set up a custom (one-off) job instead'}
        </button>
      )}

      <Field label="Job name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      {(parts || custom) && (
        <Field label="Welding / coating process">
          <select className={inputCls} value={process} onChange={(e) => setProcess(e.target.value)}>
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

      <div className="grid grid-cols-2 gap-3">
        <Field label="Ready for processing">
          <input type="date" className={inputCls} value={readyDate} onChange={(e) => setReadyDate(e.target.value)} />
        </Field>
        <Field label="Due date">
          <input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-slate-500 -mt-2 mb-3">The job will never be auto-scheduled — or allowed to be dragged — before the ready date, since materials/prior-stage work won't be in your department yet.</p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Total job value ($)">
          <input type="number" min={0} step={1} className={inputCls} value={totalValue} onChange={(e) => setTotalValue(e.target.value)} />
        </Field>
        <Field label="Value of your department's work ($)">
          <input type="number" min={0} step={1} className={inputCls} value={departmentValue} onChange={(e) => setDepartmentValue(e.target.value)} />
        </Field>
      </div>
      {valueWarning && (
        <p className="text-xs text-amber-400 -mt-2 mb-3 flex items-center gap-1"><AlertTriangle size={12} /> Department value is higher than the total job value — double check these numbers.</p>
      )}

      {!parts && !isNew && (
        <Field label={`% complete — ${percentComplete}%`}>
          <input type="range" min={0} max={100} step={5} value={percentComplete} onChange={(e) => setPercentComplete(e.target.value)} className="w-full accent-amber-500" />
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden mt-1">
            <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${percentComplete}%` }} />
          </div>
        </Field>
      )}

      {parts && (
        <div className="mb-3">
          <span className="block text-xs font-medium text-slate-400 mb-1.5 tracking-wide uppercase">
            Parts — pulled off before completion, tracked separately
          </span>
          <div className="space-y-2">
            {parts.map((part, i) => (
              <div key={part.id} className="bg-slate-800/50 border border-slate-700 rounded-md p-2.5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-slate-300">Part {i + 1}</span>
                  <button
                    type="button"
                    className="text-[11px] text-amber-400 hover:underline flex items-center gap-1"
                    onClick={() => setParts((ps) => ps.map((p, pi) => (pi === i ? { ...p, status: p.status === 'complete' ? 'active' : 'complete', percentComplete: p.status === 'complete' ? p.percentComplete : 100 } : p)))}
                  >
                    <CircleCheck size={12} /> {part.status === 'complete' ? 'Mark active' : 'Mark complete'}
                  </button>
                </div>
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
                <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-1.5">
                  <span>
                    {part.assignment
                      ? `Scheduled ${fmtDate(part.assignment.startDate)}–${fmtDate(part.assignment.endDate)}${part.assignment.conflict ? ' · Overbooked' : ''}`
                      : part.status === 'complete' ? 'Complete' : 'Not yet scheduled'}
                  </span>
                  {part.assignment?.pinned && onUnpinPart && (
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
        <div className="mb-3">
          <button type="button" className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1" onClick={() => setShowSplit((s) => !s)}>
            {showSplit ? '▾' : '▸'} Split job into two parts
          </button>
          {showSplit && (
            <div className="bg-slate-800/50 border border-slate-700 rounded-md p-3 mt-1.5">
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
            </div>
          )}
        </div>
      )}

      <Field label="Notes">
        <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <button type="button" className="text-xs text-slate-400 hover:text-slate-200 mb-3 flex items-center gap-1" onClick={() => setShowBcLink((s) => !s)}>
        {showBcLink ? '▾' : '▸'} Business Central linking (optional)
      </button>
      {showBcLink && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-md p-3 mb-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="BC Job No.">
              <input className={inputCls} value={bcJobNo} onChange={(e) => setBcJobNo(e.target.value)} placeholder="e.g. J00120" />
            </Field>
            <Field label="BC Job Task No.">
              <input className={inputCls} value={bcJobTaskNo} onChange={(e) => setBcJobTaskNo(e.target.value)} placeholder="e.g. 1000" />
            </Field>
          </div>
          <p className="text-[11px] text-slate-500">Not connected yet — these just tag this job with its Business Central reference so a future sync knows which record to update.</p>
        </div>
      )}

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

      <div className="flex items-center justify-between pt-2 border-t border-slate-800 mt-2">
        <div className="flex gap-2">
          {onDelete && <button className={btnDanger} onClick={onDelete}><Trash2 size={14} /> Delete</button>}
          {onUnpin && <button className={btnGhost} onClick={onUnpin}><PinOff size={14} /> Unpin</button>}
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
   IMPORT JOBS MODAL (from wip-importer's JSON export)
   ============================================================ */

function ImportJobsModal({ templates, processes, existingJobs, onClose, onImport }) {
  const [rows, setRows] = useState(null); // null until a file is parsed
  const [fileName, setFileName] = useState('');
  const [parseError, setParseError] = useState('');
  const [bulkTemplateId, setBulkTemplateId] = useState('');
  const fileInputRef = useRef(null);

  const existingKeys = useMemo(() => {
    const keys = new Set();
    existingJobs.forEach((j) => {
      if (j.bcJobNo) keys.add(`${j.bcJobNo}::${j.bcJobTaskNo || ''}`);
    });
    return keys;
  }, [existingJobs]);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError('');
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch {
        setParseError('That file is not valid JSON.');
        setRows(null);
        return;
      }
      const list = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : null;
      if (!list) {
        setParseError("Expected a jobs array, or an object with a \"jobs\" array — this doesn't look like a WIP importer export.");
        setRows(null);
        return;
      }
      const now = new Date().toISOString();
      const built = list.map((raw, i) => {
        const name = (raw?.name || '').trim();
        const invalid = !name;
        const bcJobNo = raw?.bcJobNo || '';
        const bcJobTaskNo = raw?.bcJobTaskNo || '';
        const dup = !!bcJobNo && existingKeys.has(`${bcJobNo}::${bcJobTaskNo}`);
        return {
          _rowId: i,
          _invalid: invalid,
          _dup: dup,
          include: !invalid && !dup,
          name: name || 'Untitled job',
          process: raw?.process || '',
          quantity: Number(raw?.quantity) > 0 ? Number(raw.quantity) : 1,
          hoursTotal: Number(raw?.hoursTotal) || 0,
          readyDate: raw?.readyDate || isoDate(new Date()),
          dueDate: raw?.dueDate || addDays(isoDate(new Date()), 14),
          templateId: raw?.templateId || null,
          notes: raw?.notes || '',
          totalValue: Number(raw?.totalValue) || 0,
          departmentValue: Number(raw?.departmentValue) || 0,
          percentComplete: Number(raw?.percentComplete) || 0,
          status: 'active',
          completedDate: null,
          bcJobNo,
          bcJobTaskNo,
          updatedAt: now,
        };
      });
      setRows(built);
    };
    reader.readAsText(file);
  }

  function updateRow(rowId, patch) {
    setRows((rs) => rs.map((r) => (r._rowId === rowId ? { ...r, ...patch } : r)));
  }

  function applyTemplateToRow(rowId, templateId) {
    const t = templates.find((x) => x.id === templateId);
    if (!t) { updateRow(rowId, { templateId: null }); return; }
    setRows((rs) => rs.map((r) => {
      if (r._rowId !== rowId) return r;
      const hoursTotal = Math.round(r.quantity * t.hoursPerUnit * 100) / 100;
      const departmentValue = r.departmentValue > 0 ? r.departmentValue : Math.round(r.quantity * (t.departmentValuePerUnit || 0) * 100) / 100;
      return { ...r, templateId, process: t.process, hoursTotal, departmentValue };
    }));
  }

  function applyBulkTemplate() {
    const t = templates.find((x) => x.id === bulkTemplateId);
    if (!t) return;
    setRows((rs) => rs.map((r) => {
      if (!r.include || r.templateId) return r; // don't clobber rows already assigned
      const hoursTotal = Math.round(r.quantity * t.hoursPerUnit * 100) / 100;
      const departmentValue = r.departmentValue > 0 ? r.departmentValue : Math.round(r.quantity * (t.departmentValuePerUnit || 0) * 100) / 100;
      return { ...r, templateId: bulkTemplateId, process: t.process, hoursTotal, departmentValue };
    }));
  }

  const includedRows = rows ? rows.filter((r) => r.include) : [];
  const missingHours = includedRows.filter((r) => !r.hoursTotal || !r.process).length;
  const dupCount = rows ? rows.filter((r) => r._dup).length : 0;
  const invalidCount = rows ? rows.filter((r) => r._invalid).length : 0;

  function handleImportClick() {
    const toImport = includedRows.map(({ _rowId, _invalid, _dup, include, ...job }) => job);
    onImport(toImport);
  }

  return (
    <Modal title="Import jobs from WIP export" onClose={onClose} wide>
      {!rows && (
        <div>
          <p className="text-sm text-slate-400 mb-4">
            Choose the <code className="text-slate-300">scheduler-jobs-*.json</code> file produced by the WIP
            importer. Nothing is imported until you review the list and click Import below.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleFile}
            className="block w-full text-sm text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-amber-500 file:text-slate-950 file:font-semibold file:text-sm hover:file:bg-amber-400"
          />
          {parseError && (
            <p className="text-xs text-red-400 mt-3 flex items-center gap-1.5"><FileWarning size={13} /> {parseError}</p>
          )}
        </div>
      )}

      {rows && (
        <div>
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <p className="text-xs text-slate-400">
              {fileName} · {rows.length} job{rows.length === 1 ? '' : 's'} found
              {dupCount > 0 && <span className="text-amber-400"> · {dupCount} look already imported (same BC job/task no.) — unchecked</span>}
              {invalidCount > 0 && <span className="text-red-400"> · {invalidCount} skipped (no name)</span>}
            </p>
            <button
              type="button"
              className="text-xs text-amber-400 hover:underline"
              onClick={() => { setRows(null); setFileName(''); setParseError(''); if (fileInputRef.current) fileInputRef.current.value = ''; }}
            >
              Choose a different file
            </button>
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

          <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900 overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="sticky top-0 bg-slate-900 z-10">
                <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 font-medium"></th>
                  <th className="px-3 py-2 font-medium">Job</th>
                  <th className="px-3 py-2 font-medium">BC Job/Task</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">Total $</th>
                  <th className="px-3 py-2 font-medium">Template</th>
                  <th className="px-3 py-2 font-medium">Process</th>
                  <th className="px-3 py-2 font-medium">Hours</th>
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
                    <td className="px-3 py-2 text-slate-200 max-w-[220px] truncate" title={r.name}>
                      {r.name}
                      {r._dup && <span className="ml-1.5 text-[10px] text-amber-400">already imported?</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">{r.bcJobNo || '—'}{r.bcJobTaskNo ? ` / ${r.bcJobTaskNo}` : ''}</td>
                    <td className="px-3 py-2 text-slate-400">{r.quantity}</td>
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtDate(r.dueDate)}</td>
                    <td className="px-3 py-2 text-slate-400 font-mono">${Number(r.totalValue || 0).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      <select
                        className="bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-200"
                        value={r.templateId || ''}
                        onChange={(e) => applyTemplateToRow(r._rowId, e.target.value)}
                      >
                        <option value="">—</option>
                        {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className="bg-slate-800 border border-slate-700 rounded text-xs px-1.5 py-1 text-slate-200"
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

function TemplateModal({ template, equipment, processes, onClose, onSave }) {
  const isNew = !template;
  const [name, setName] = useState(template?.name || '');
  const [process, setProcess] = useState(template?.process || processes[0] || '');
  const [hoursPerUnit, setHoursPerUnit] = useState(template?.hoursPerUnit ?? 1);
  const [equipmentIds, setEquipmentIds] = useState(template?.equipmentIds || []);
  const [totalValuePerUnit, setTotalValuePerUnit] = useState(template?.totalValuePerUnit ?? '');
  const [departmentValuePerUnit, setDepartmentValuePerUnit] = useState(template?.departmentValuePerUnit ?? '');

  const compatibleEquip = equipment.filter((e) => e.processes.includes(process));

  return (
    <Modal title={isNew ? 'New template' : 'Edit template'} onClose={onClose}>
      <Field label="Template name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Process">
        <select className={inputCls} value={process} onChange={(e) => { setProcess(e.target.value); setEquipmentIds([]); }}>
          {processes.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
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
        {compatibleEquip.length === 0 ? (
          <p className="text-xs text-slate-500">No equipment supports this process yet — add it under Equipment &amp; Staff.</p>
        ) : (
          <MultiCheck options={compatibleEquip} value={equipmentIds} onChange={setEquipmentIds} getId={(e) => e.id} getLabel={(e) => e.name} />
        )}
      </Field>
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-800 mt-3">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button
          className={btnPrimary}
          onClick={() => onSave({
            id: template?.id || uid('tpl'),
            name: name.trim() || 'Untitled template',
            process,
            hoursPerUnit: Number(hoursPerUnit) || 1,
            equipmentIds: equipmentIds.length ? equipmentIds : compatibleEquip.map((e) => e.id),
            totalValuePerUnit: totalValuePerUnit === '' ? null : Number(totalValuePerUnit),
            departmentValuePerUnit: departmentValuePerUnit === '' ? null : Number(departmentValuePerUnit),
          })}
        ><Check size={14} /> Save</button>
      </div>
    </Modal>
  );
}

/* ============================================================
   EQUIPMENT MODAL
   ============================================================ */

function EquipmentModal({ item, processes, onClose, onSave }) {
  const isNew = !item;
  const [name, setName] = useState(item?.name || '');
  const [type, setType] = useState(item?.type || EQUIP_TYPES[0]);
  const [procs, setProcs] = useState(item?.processes || []);
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
        <MultiCheck options={processes} value={procs} onChange={setProcs} />
      </Field>
      <Field label="Business Central Resource No. (optional)">
        <input className={inputCls} value={bcResourceNo} onChange={(e) => setBcResourceNo(e.target.value)} placeholder="e.g. EQ-ROBOT-01" />
      </Field>
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-800 mt-3">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button
          className={btnPrimary}
          onClick={() => onSave({ id: item?.id || uid('eq'), name: name.trim() || 'Untitled', type, processes: procs, unavailableDates: item?.unavailableDates || [], bcResourceNo: bcResourceNo.trim() })}
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

function ReportsView({ jobs, equipment, staff }) {
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
        return j.status === 'complete' && j.completedDate && j.completedDate >= rangeStart && j.completedDate <= rangeEnd;
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
          <div className="border border-slate-800 bg-slate-900 rounded-lg overflow-hidden max-h-[320px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-900">
                <tr className="border-b border-slate-800 text-left text-slate-500 uppercase tracking-wide">
                  <th className="px-3 py-2 font-medium">Job</th>
                  <th className="px-3 py-2 font-medium">Total $</th>
                  <th className="px-3 py-2 font-medium">Dept $</th>
                </tr>
              </thead>
              <tbody>
                {included.map((j) => (
                  <tr key={j.id} className="border-b border-slate-800/60">
                    <td className="px-3 py-1.5 text-slate-300">{j.name}</td>
                    <td className="px-3 py-1.5 text-slate-500 font-mono">${Number(j.totalValue || 0).toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-amber-300 font-mono">${Number(j.departmentValue || 0).toLocaleString()}</td>
                  </tr>
                ))}
                {included.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-600">Nothing here yet.</td></tr>}
              </tbody>
            </table>
          </div>
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

  return (
    <Modal title={isNew ? 'Add staff member' : 'Edit staff member'} onClose={onClose}>
      <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Certified / competent processes">
        <MultiCheck options={processes} value={procs} onChange={setProcs} />
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
            bcResourceNo: bcResourceNo.trim(),
            weeklyRoster: item?.weeklyRoster || defaultWeeklyRoster(),
            leavePeriods: item?.leavePeriods || [],
          })}
        ><Check size={14} /> Save</button>
      </div>
    </Modal>
  );
}
