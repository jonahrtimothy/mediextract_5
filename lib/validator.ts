// lib/validator.ts
// Layer 5 — Field Validator + Confidence Scorer

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface ValidatedField {
  value: string | string[] | number | null;
  confidence: ConfidenceLevel;
  valid: boolean;
  reason?: string;
}

export interface ValidationResult {
  fields: Record<string, ValidatedField>;
  flags: string[];
  overall_confidence: number;
  validated_count: number;
  failed_count: number;
  warning_count: number;
}

export type RawFields = Record<string, string | string[] | number | null | undefined>;

// ─────────────────────────────────────────────────────────────
// REGEX PATTERNS
// ─────────────────────────────────────────────────────────────

const PATTERNS = {
  npi:              /^\d{10}$/,
  icd10:            /^[A-Z][0-9]{2}(\.[A-Z0-9]{1,4})?$/i,
  cpt:              /^[0-9]{5}$/,
  hcpcs:            /^[A-Z][0-9]{4}$/i,
  date:             /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})$/,
  amount:           /^\$?\d{1,7}(\.\d{2})?$/,
  member_id:        /^[A-Z0-9\-]{6,20}$/i,
  group_number:     /^[A-Z0-9\-]{3,20}$/i,
  auth_number:      /^[A-Z0-9\-]{6,20}$/i,
  carc:             /^(CO|PR|OA|PI|CR)-\d{1,3}$/i,
  rarc:             /^(M|N|MA|MB)\d{1,3}$/i,
  anesthesia_units: /^\d{1,3}(\.\d{1,2})?$/,
  modifier:         /^[A-Z0-9]{2}$/i,
  tax_id:           /^\d{9}$|^\d{2}-\d{7}$/,
  phone:            /^[\(\)\-\s\.\+\d]{10,15}$/,
  zip:              /^\d{5}(\-\d{4})?$/,
  state:            /^[A-Z]{2}$/,
  pos:              /^\d{2}$/,
  revenue_code:     /^\d{4}$/,
  drg:              /^\d{3}$/,
};

// ─────────────────────────────────────────────────────────────
// KNOWN VALID VALUE SETS
// ─────────────────────────────────────────────────────────────

const ANESTHESIA_MODIFIERS = new Set(['AA','QK','QX','QY','QZ','AD','GC','GJ']);

const CLAIM_MODIFIERS = new Set([
  '25','26','59','76','77','GT','GY','GZ','TC','LT','RT',
  '50','51','52','AT','CR','KX','AA','QK','QX','QY','QZ','AD','GC','GJ',
]);

const VALID_POS = new Set([
  '01','02','03','04','05','06','07','08','09','10',
  '11','12','13','14','15','16','17','18','19','20',
  '21','22','23','24','25','26','27','28','29','30',
  '31','32','33','34','41','42','49','50','51','52',
  '53','54','55','56','57','58','60','61','62','65',
  '71','72','81','99',
]);

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function toStr(value: string | string[] | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(',');
  return String(value).trim();
}

function isEmpty(value: string | string[] | number | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  const s = String(value).trim().toLowerCase();
  return s === '' || s === 'null' || s === 'n/a' || s === 'unknown';
}

function parseDate(raw: string): Date | null {
  const mdy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdy) {
    const year = mdy[3].length === 2 ? parseInt('20' + mdy[3]) : parseInt(mdy[3]);
    return new Date(year, parseInt(mdy[1]) - 1, parseInt(mdy[2]));
  }
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    return new Date(parseInt(ymd[1]), parseInt(ymd[2]) - 1, parseInt(ymd[3]));
  }
  return null;
}

function makeField(
  value: string | string[] | number | null,
  confidence: ConfidenceLevel,
  valid: boolean,
  reason?: string
): ValidatedField {
  return { value, confidence, valid, ...(reason ? { reason } : {}) };
}

// ─────────────────────────────────────────────────────────────
// INDIVIDUAL FIELD VALIDATORS
// ─────────────────────────────────────────────────────────────

function validateNpi(raw: string): ValidatedField {
  if (isEmpty(raw)) return makeField(null, 'low', false, 'NPI is missing');
  const clean = raw.replace(/\s/g, '');
  if (!PATTERNS.npi.test(clean)) {
    return makeField(clean, 'low', false, `NPI must be exactly 10 digits — got ${clean.length}`);
  }
  if (/^(\d)\1{9}$/.test(clean)) {
    return makeField(clean, 'low', false, 'NPI appears to be all repeated digits');
  }
  return makeField(clean, 'high', true);
}

function validateIcd10(raw: string | string[]): ValidatedField {
  const codes = Array.isArray(raw) ? raw : [raw];
  if (codes.length === 0 || (codes.length === 1 && isEmpty(codes[0]))) {
    return makeField(null, 'low', false, 'No ICD-10 codes found');
  }
  const invalid = codes.filter(c => !PATTERNS.icd10.test(c.trim().toUpperCase()));
  if (invalid.length > 0) {
    return makeField(codes, 'medium', false, `Invalid ICD-10 format: ${invalid.join(', ')}`);
  }
  return makeField(codes, 'high', true);
}

function validateCpt(raw: string | string[]): ValidatedField {
  const codes = Array.isArray(raw) ? raw : [raw];
  if (codes.length === 0 || (codes.length === 1 && isEmpty(codes[0]))) {
    return makeField(null, 'low', false, 'No CPT codes found');
  }
  const invalid = codes.filter(c => {
    const clean = c.trim();
    if (!PATTERNS.cpt.test(clean)) return true;
    const num = parseInt(clean);
    return num < 100 || num > 99999;
  });
  if (invalid.length > 0) {
    return makeField(codes, 'medium', false, `Invalid CPT codes: ${invalid.join(', ')}`);
  }
  return makeField(codes, 'high', true);
}

function validateDate(raw: string, fieldName: string): ValidatedField {
  if (isEmpty(raw)) return makeField(null, 'low', false, `${fieldName} is missing`);
  if (!PATTERNS.date.test(raw.trim())) {
    return makeField(raw, 'low', false, `${fieldName} format not recognized: ${raw}`);
  }
  const parsed = parseDate(raw.trim());
  if (!parsed || isNaN(parsed.getTime())) {
    return makeField(raw, 'low', false, `${fieldName} could not be parsed as a valid date`);
  }
  const now = new Date();
  const year = parsed.getFullYear();
  if (year < 1900 || year > now.getFullYear() + 1) {
    return makeField(raw, 'medium', false, `${fieldName} year ${year} looks incorrect`);
  }
  return makeField(raw, 'high', true);
}

function validateAmount(raw: string, fieldName: string): ValidatedField {
  if (isEmpty(raw)) return makeField(null, 'low', false, `${fieldName} is missing`);
  const clean = raw.trim();
  if (!PATTERNS.amount.test(clean)) {
    return makeField(clean, 'low', false, `${fieldName} format invalid: ${clean}`);
  }
  const num = parseFloat(clean.replace('$', ''));
  if (num === 0) {
    return makeField(clean, 'medium', true, `${fieldName} is $0.00 — verify this is correct`);
  }
  if (num > 999999) {
    return makeField(clean, 'medium', true, `${fieldName} is unusually large: ${clean}`);
  }
  return makeField(clean, 'high', true);
}

function validateMemberId(raw: string): ValidatedField {
  if (isEmpty(raw)) return makeField(null, 'low', false, 'Member ID is missing');
  const clean = raw.trim().toUpperCase();
  if (!PATTERNS.member_id.test(clean)) {
    return makeField(clean, 'medium', false, `Member ID format looks unusual: ${clean}`);
  }
  return makeField(clean, 'high', true);
}

function validateAuthNumber(raw: string): ValidatedField {
  if (isEmpty(raw)) return makeField(null, 'low', false, 'Auth number is missing');
  const clean = raw.trim().toUpperCase();
  if (!PATTERNS.auth_number.test(clean)) {
    return makeField(clean, 'medium', false, `Auth number format looks unusual: ${clean}`);
  }
  return makeField(clean, 'high', true);
}

function validateModifiers(raw: string | string[]): ValidatedField {
  const mods = Array.isArray(raw) ? raw : [raw];
  if (mods.length === 0 || (mods.length === 1 && isEmpty(mods[0]))) {
    return makeField([], 'high', true);
  }
  const cleaned = mods.map(m => m.trim().toUpperCase());
  const unknown = cleaned.filter(m => m && !CLAIM_MODIFIERS.has(m));
  if (unknown.length > 0) {
    return makeField(cleaned, 'medium', true, `Unrecognized modifiers: ${unknown.join(', ')} — verify`);
  }
  return makeField(cleaned, 'high', true);
}

function validatePos(raw: string): ValidatedField {
  if (isEmpty(raw)) return makeField(null, 'medium', false, 'Place of service is missing');
  const clean = raw.trim().padStart(2, '0');
  if (!VALID_POS.has(clean)) {
    return makeField(clean, 'low', false, `Place of service ${clean} is not a recognized CMS POS code`);
  }
  return makeField(clean, 'high', true);
}

function validateCarcRarc(raw: string | string[]): ValidatedField {
  const codes = Array.isArray(raw) ? raw : [raw];
  if (codes.length === 0 || (codes.length === 1 && isEmpty(codes[0]))) {
    return makeField(null, 'low', false, 'No CARC/RARC codes found');
  }
  const invalid = codes.filter(c => {
    const u = c.trim().toUpperCase();
    return !PATTERNS.carc.test(u) && !PATTERNS.rarc.test(u);
  });
  if (invalid.length > 0) {
    return makeField(codes, 'medium', false, `Unrecognized denial codes: ${invalid.join(', ')}`);
  }
  return makeField(codes, 'high', true);
}

function validateAnesthesiaUnits(raw: string, fieldName: string): ValidatedField {
  if (isEmpty(raw)) return makeField(null, 'medium', false, `${fieldName} not found`);
  const clean = raw.trim();
  if (!PATTERNS.anesthesia_units.test(clean)) {
    return makeField(clean, 'low', false, `${fieldName} format invalid: ${clean}`);
  }
  const num = parseFloat(clean);
  if (num > 200) {
    return makeField(clean, 'medium', true, `${fieldName} value ${clean} seems high — verify`);
  }
  return makeField(clean, 'high', true);
}

function validateGenericText(raw: string, fieldName: string, required = true): ValidatedField {
  if (isEmpty(raw)) {
    return makeField(null, required ? 'low' : 'medium', !required, `${fieldName} is missing`);
  }
  const clean = raw.trim();
  if (clean.length < 2) {
    return makeField(clean, 'medium', false, `${fieldName} value too short: "${clean}"`);
  }
  return makeField(clean, 'high', true);
}

// ─────────────────────────────────────────────────────────────
// FIELD ROUTER
// ─────────────────────────────────────────────────────────────

function routeField(key: string, value: string | string[] | number | null | undefined): ValidatedField {
  const raw = toStr(value);
  const k = key.toLowerCase();

  if (k === 'npi' || k.includes('npi'))                                                       return validateNpi(raw);
  if (k.includes('icd') || k.includes('diagnosis_code'))                                      return validateIcd10(value as string | string[]);
  if (k.includes('cpt') || k.includes('procedure_code'))                                      return validateCpt(value as string | string[]);
  if (k.includes('modifier'))                                                                  return validateModifiers(value as string | string[]);
  if (k.includes('carc') || k.includes('rarc') || k.includes('denial_code'))                  return validateCarcRarc(value as string | string[]);
  if (k.includes('date'))                                                                      return validateDate(raw, key);
  if (k.includes('charge') || k.includes('amount') || k.includes('payment') || k.includes('balance') || k.includes('billed')) return validateAmount(raw, key);
  if (k === 'member_id' || k.includes('member_id'))                                           return validateMemberId(raw);
  if (k.includes('auth_number') || k.includes('auth_no'))                                     return validateAuthNumber(raw);
  if (k.includes('pos') || k.includes('place_of_service'))                                    return validatePos(raw);
  if (k.includes('base_unit') || k.includes('time_unit') || k.includes('qualifying_unit'))    return validateAnesthesiaUnits(raw, key);

  const optional = ['secondary', 'note', 'comment', 'remark', 'additional'];
  const isOptional = optional.some(o => k.includes(o));
  return validateGenericText(raw, key, !isOptional);
}

// ─────────────────────────────────────────────────────────────
// DATE CROSS-VALIDATION
// ─────────────────────────────────────────────────────────────

function crossValidateDates(fields: Record<string, ValidatedField>): string[] {
  const flags: string[] = [];

  const get = (key: string): Date | null => {
    const f = fields[key];
    if (!f || !f.value) return null;
    return parseDate(String(f.value));
  };

  const serviceFrom  = get('service_date_from') || get('date_of_service') || get('service_date');
  const serviceTo    = get('service_date_to');
  const admitDate    = get('admission_date');
  const dischargeDate = get('discharge_date');
  const signatureDate = get('signature_date');
  const today = new Date();

  if (serviceFrom && serviceFrom > today) flags.push('Service date is in the future — verify');
  if (serviceFrom && serviceTo && serviceTo < serviceFrom) flags.push('Service end date is before service start date');
  if (admitDate && dischargeDate && dischargeDate < admitDate) flags.push('Discharge date is before admission date');
  if (signatureDate && serviceFrom && signatureDate < serviceFrom) flags.push('Signature date precedes service date');

  return flags;
}

// ─────────────────────────────────────────────────────────────
// BILLING LOGIC FLAGS
// ─────────────────────────────────────────────────────────────

function generateBillingFlags(fields: Record<string, ValidatedField>): string[] {
  const flags: string[] = [];

  const charge = fields['total_charge'] || fields['billed_amount'];
  if (charge?.valid) {
    const amt = parseFloat(String(charge.value).replace('$', ''));
    if (amt === 0) flags.push('Total charge is $0.00 — likely a data extraction error');
  }

  const mods = fields['modifiers'];
  if (mods?.valid && Array.isArray(mods.value)) {
    const hasAnesthesia = mods.value.some((m: string) => ANESTHESIA_MODIFIERS.has(m));
    const baseUnits = fields['base_units'];
    if (hasAnesthesia && (!baseUnits || !baseUnits.valid)) {
      flags.push('Anesthesia modifier present but base units are missing or invalid');
    }
  }

  const icd = fields['icd10_codes'] || fields['diagnosis_codes'];
  const cpt = fields['cpt_codes'] || fields['procedure_codes'];
  if (icd && !icd.valid && cpt && !cpt.valid) {
    flags.push('Both ICD-10 and CPT codes failed validation — document may be misclassified');
  }

  return flags;
}

// ─────────────────────────────────────────────────────────────
// OVERALL CONFIDENCE SCORE
// ─────────────────────────────────────────────────────────────

function computeOverallConfidence(fields: Record<string, ValidatedField>): number {
  const entries = Object.values(fields);
  if (entries.length === 0) return 0;

  let total = 0;

  for (const f of entries) {
    const score = f.confidence === 'high' ? 1.0 : f.confidence === 'medium' ? 0.6 : 0.2;
    total += f.valid ? score : score * 0.3;
  }

  return Math.round((total / entries.length) * 100) / 100;
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────

export function validateFields(rawFields: RawFields): ValidationResult {
  const fields: Record<string, ValidatedField> = {};

  for (const [key, value] of Object.entries(rawFields)) {
    fields[key] = routeField(key, value);
  }

  const dateFlags    = crossValidateDates(fields);
  const billingFlags = generateBillingFlags(fields);
  const flags        = [...dateFlags, ...billingFlags];

  const validated_count = Object.values(fields).filter(f => f.valid).length;
  const failed_count    = Object.values(fields).filter(f => !f.valid).length;
  const warning_count   = Object.values(fields).filter(f => f.valid && f.confidence !== 'high').length;
  const overall_confidence = computeOverallConfidence(fields);

  return { fields, flags, overall_confidence, validated_count, failed_count, warning_count };
}