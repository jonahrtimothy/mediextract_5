// lib/claude.ts
// Layer 4 — Claude Vision Extractor
// Two-step process: detect doc type → route to specialist prompt
// 13 RCM-specific extraction prompts

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-opus-4-5';

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type DocType =
  | 'cms_1500'
  | 'ub_04'
  | 'denial_letter'
  | 'era_remittance'
  | 'eob'
  | 'insurance_card'
  | 'referral_letter'
  | 'clinical_note'
  | 'discharge_summary'
  | 'anesthesia_record'
  | 'anesthesia_demographics'
  | 'prior_auth_request'
  | 'prior_auth_response'
  | 'operative_report'
  | 'unknown';

export interface DetectionResult {
  doc_type: DocType;
  confidence: number;
  reason: string;
  token_usage: TokenUsage;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
}

export interface ExtractionResult {
  doc_type: DocType;
  detection_confidence: number;
  fields: Record<string, string | string[] | number | null>;
  raw_text: string;
  token_usage: TokenUsage;
}

type MessageContent =
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'text'; text: string };

// ─────────────────────────────────────────────────────────────
// STEP 1 — DETECTION PROMPT
// Quick classification call — what document type is this?
// ─────────────────────────────────────────────────────────────

const DETECTION_PROMPT = `You are a healthcare document classifier with deep RCM expertise.

Examine this document and identify its type. Respond ONLY with a JSON object — no markdown, no explanation.

Document types to choose from:
- cms_1500: Professional claim form (CMS-1500 / HCFA-1500)
- ub_04: Facility/hospital claim form (UB-04 / CMS-1450)
- denial_letter: Insurance denial letter with CARC/RARC codes
- era_remittance: Electronic Remittance Advice / 835 transaction
- eob: Explanation of Benefits (patient-facing)
- insurance_card: Health insurance member card
- referral_letter: Physician referral or authorization letter
- clinical_note: SOAP note, progress note, or clinical documentation
- discharge_summary: Hospital discharge summary
- anesthesia_record: Anesthesia record with units and modifiers
- prior_auth_request: Prior authorization request form
- prior_auth_response: Prior authorization approval or denial response
- operative_report: Surgical or operative report
- unknown: Cannot determine document type

Respond with exactly this JSON structure:
{
  "doc_type": "<type from list above>",
  "confidence": <0.0 to 1.0>,
  "reason": "<one sentence explaining your classification>"
}`;

// ─────────────────────────────────────────────────────────────
// STEP 2 — 13 SPECIALIST EXTRACTION PROMPTS
// ─────────────────────────────────────────────────────────────

const EXTRACTION_PROMPTS: Record<DocType, string> = {

  cms_1500: `You are an expert medical billing specialist extracting data from a CMS-1500 claim form.
Extract every field you can read. Respond ONLY with a JSON object — no markdown, no explanation.

Required fields to extract:
{
  "patient_name": "LAST, First Middle",
  "patient_dob": "MM/DD/YYYY",
  "patient_address": "full address",
  "patient_sex": "M or F",
  "insured_name": "name or SAME",
  "insured_id": "member ID",
  "insured_group_number": "group number",
  "insurance_plan_name": "payer name",
  "secondary_insurance": "secondary payer or null",
  "referring_provider": "name or null",
  "referring_npi": "10-digit NPI or null",
  "service_date_from": "MM/DD/YYYY",
  "service_date_to": "MM/DD/YYYY",
  "pos": "place of service code",
  "cpt_codes": ["list of CPT codes"],
  "modifiers": ["list of modifiers"],
  "icd10_codes": ["list of ICD-10 codes"],
  "charges_per_line": ["charge per service line"],
  "total_charge": "$amount",
  "rendering_provider": "name",
  "rendering_npi": "10-digit NPI",
  "billing_provider": "practice or facility name",
  "billing_npi": "10-digit NPI",
  "billing_address": "full address",
  "tax_id": "EIN or SSN",
  "signature_date": "MM/DD/YYYY or null",
  "accept_assignment": "YES or NO",
  "prior_auth_number": "auth number or null"
}`,

  ub_04: `You are an expert medical billing specialist extracting data from a UB-04 facility claim form.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "LAST, First",
  "patient_dob": "MM/DD/YYYY",
  "patient_address": "full address",
  "admission_date": "MM/DD/YYYY",
  "discharge_date": "MM/DD/YYYY",
  "admission_hour": "HH or null",
  "discharge_hour": "HH or null",
  "patient_status": "2-digit discharge status code",
  "type_of_bill": "3-digit TOB code",
  "facility_name": "hospital or facility name",
  "facility_npi": "10-digit NPI",
  "facility_address": "full address",
  "attending_provider": "name",
  "attending_npi": "10-digit NPI",
  "operating_provider": "name or null",
  "operating_npi": "10-digit NPI or null",
  "payer_name": "primary payer",
  "member_id": "member ID",
  "group_number": "group number or null",
  "revenue_codes": ["list of 4-digit revenue codes"],
  "hcpcs_codes": ["list of HCPCS/CPT codes"],
  "service_units": ["units per revenue line"],
  "charges_per_line": ["charge per revenue line"],
  "total_charge": "$amount",
  "icd10_principal": "principal diagnosis code",
  "icd10_additional": ["additional diagnosis codes"],
  "icd10_procedures": ["ICD-10 PCS procedure codes or null"],
  "drg": "DRG number or null",
  "prior_auth_number": "auth number or null",
  "occurrence_codes": ["occurrence code + date pairs or null"],
  "value_codes": ["value code + amount pairs or null"]
}`,

  denial_letter: `You are an expert RCM denial management specialist extracting data from an insurance denial letter.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "name",
  "member_id": "member ID",
  "claim_number": "claim number",
  "date_of_service": "MM/DD/YYYY",
  "date_of_denial": "MM/DD/YYYY",
  "payer_name": "insurance company name",
  "provider_name": "rendering provider or facility",
  "denial_reason": "full denial reason text",
  "carc_codes": ["CO-### or PR-### codes"],
  "rarc_codes": ["M### or N### remark codes"],
  "denied_amount": "$amount",
  "allowed_amount": "$amount or null",
  "patient_responsibility": "$amount or null",
  "appeal_deadline": "MM/DD/YYYY or null",
  "appeal_address": "where to send appeal or null",
  "reference_number": "payer reference number or null",
  "cpt_codes": ["denied CPT codes"],
  "icd10_codes": ["diagnosis codes on claim"],
  "corrective_action": "recommended action or null"
}`,

  era_remittance: `You are an expert medical billing specialist extracting data from an ERA / Electronic Remittance Advice (835).
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "payer_name": "payer name",
  "payer_id": "payer ID",
  "payee_name": "provider or practice name",
  "payee_npi": "NPI or null",
  "check_number": "check or EFT number",
  "check_date": "MM/DD/YYYY",
  "total_payment": "$amount",
  "claims": [
    {
      "patient_name": "name",
      "claim_number": "claim number",
      "date_of_service": "MM/DD/YYYY",
      "billed_amount": "$amount",
      "allowed_amount": "$amount",
      "paid_amount": "$amount",
      "patient_responsibility": "$amount",
      "adjustment_reason": "CARC code + description",
      "remark_codes": ["RARC codes"]
    }
  ],
  "total_claims": "number of claims",
  "total_billed": "$total billed",
  "total_allowed": "$total allowed",
  "total_adjustments": "$total adjustments"
}`,

  eob: `You are an expert at reading Explanation of Benefits documents.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "name",
  "member_id": "member ID",
  "group_number": "group number or null",
  "payer_name": "insurance company",
  "provider_name": "provider or facility",
  "date_of_service": "MM/DD/YYYY",
  "claim_number": "claim number",
  "service_description": "description of service",
  "cpt_codes": ["CPT codes if listed"],
  "billed_amount": "$amount",
  "allowed_amount": "$amount",
  "plan_discount": "$amount or null",
  "plan_paid": "$amount",
  "deductible_applied": "$amount",
  "copay": "$amount or null",
  "coinsurance": "$amount or null",
  "patient_responsibility": "$amount",
  "denial_reason": "reason if denied or null",
  "remarks": "any remarks or notes"
}`,

  insurance_card: `You are an expert at reading health insurance member cards.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "member_name": "full name on card",
  "member_id": "member ID number",
  "group_number": "group number or null",
  "plan_name": "plan or product name",
  "payer_name": "insurance company name",
  "payer_id": "payer ID or null",
  "effective_date": "MM/DD/YYYY or null",
  "termination_date": "MM/DD/YYYY or null",
  "copay_primary": "$amount or null",
  "copay_specialist": "$amount or null",
  "copay_er": "$amount or null",
  "copay_urgent_care": "$amount or null",
  "deductible": "$amount or null",
  "out_of_pocket_max": "$amount or null",
  "rx_bin": "BIN number or null",
  "rx_pcn": "PCN or null",
  "rx_group": "Rx group or null",
  "claims_address": "where to mail claims or null",
  "provider_phone": "phone number or null",
  "member_phone": "member services phone or null",
  "website": "payer website or null",
  "front_text": "any other text on front",
  "back_text": "any other text on back"
}`,

  referral_letter: `You are an expert at extracting data from physician referral letters.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "full name",
  "patient_dob": "MM/DD/YYYY or null",
  "patient_member_id": "member ID or null",
  "referring_provider": "name",
  "referring_npi": "NPI or null",
  "referring_practice": "practice name",
  "referring_phone": "phone number",
  "referring_fax": "fax number or null",
  "referred_to_provider": "specialist name",
  "referred_to_specialty": "specialty",
  "referred_to_practice": "practice name or null",
  "referred_to_phone": "phone or null",
  "referral_date": "MM/DD/YYYY",
  "referral_number": "referral number or null",
  "referral_expiry": "MM/DD/YYYY or null",
  "visits_authorized": "number or null",
  "reason_for_referral": "clinical reason",
  "diagnosis": "ICD-10 or description",
  "urgency": "routine or urgent or null",
  "prior_auth_required": "YES or NO or null",
  "prior_auth_number": "auth number or null",
  "clinical_notes": "summary of clinical notes included"
}`,

  clinical_note: `You are an expert clinical documentation specialist extracting data from a clinical or SOAP note.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "full name",
  "patient_dob": "MM/DD/YYYY or null",
  "date_of_service": "MM/DD/YYYY",
  "provider_name": "provider name",
  "provider_npi": "NPI or null",
  "facility": "clinic or facility name or null",
  "visit_type": "new patient / established / follow-up / telehealth",
  "chief_complaint": "chief complaint",
  "subjective": "subjective findings summary",
  "objective": "objective findings summary",
  "vital_signs": {
    "bp": "blood pressure or null",
    "hr": "heart rate or null",
    "temp": "temperature or null",
    "weight": "weight or null",
    "height": "height or null",
    "o2_sat": "O2 saturation or null"
  },
  "assessment": "assessment summary",
  "plan": "treatment plan summary",
  "icd10_codes": ["diagnosis codes"],
  "cpt_codes": ["procedure codes if documented"],
  "em_level": "E&M level (99211-99215 or null)",
  "medications": ["current medications"],
  "allergies": "allergies or NKDA",
  "follow_up": "follow up instructions or null",
  "referrals": "referrals made or null",
  "signature": "provider signature or null"
}`,

  discharge_summary: `You are an expert clinical documentation specialist extracting data from a hospital discharge summary.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "full name",
  "patient_dob": "MM/DD/YYYY or null",
  "mrn": "medical record number or null",
  "admission_date": "MM/DD/YYYY",
  "discharge_date": "MM/DD/YYYY",
  "length_of_stay": "number of days",
  "facility": "hospital name",
  "attending_physician": "name",
  "attending_npi": "NPI or null",
  "admitting_diagnosis": "diagnosis at admission",
  "principal_diagnosis": "final principal diagnosis",
  "secondary_diagnoses": ["additional diagnoses"],
  "icd10_principal": "ICD-10 code",
  "icd10_secondary": ["ICD-10 codes"],
  "procedures_performed": ["procedures with dates"],
  "icd10_procedures": ["ICD-10 PCS or CPT codes"],
  "drg": "DRG or null",
  "discharge_disposition": "discharge status",
  "discharge_condition": "condition at discharge",
  "follow_up_instructions": "follow up plan",
  "medications_at_discharge": ["medication list"],
  "allergies": "allergies or NKDA",
  "diet": "diet instructions or null",
  "activity_restrictions": "restrictions or null",
  "wound_care": "wound care instructions or null"
}`,

  anesthesia_record: `You are an expert anesthesia billing specialist extracting data from an anesthesia record.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "full name",
  "patient_dob": "MM/DD/YYYY or null",
  "date_of_service": "MM/DD/YYYY",
  "facility": "facility name",
  "anesthesiologist": "name",
  "anesthesiologist_npi": "NPI or null",
  "crna": "CRNA name or null",
  "crna_npi": "NPI or null",
  "supervising_physician": "name or null",
  "anesthesia_type": "general / regional / MAC / local",
  "procedure": "surgical procedure name",
  "surgeon": "surgeon name or null",
  "cpt_code": "anesthesia CPT code (00100-01999)",
  "modifiers": ["AA / QK / QX / QY / QZ / AD"],
  "icd10_codes": ["diagnosis codes"],
  "base_units": "numeric base units",
  "time_units": "numeric time units",
  "qualifying_units": "numeric qualifying units or null",
  "total_units": "total anesthesia units",
  "start_time": "HH:MM or null",
  "end_time": "HH:MM or null",
  "total_minutes": "total anesthesia minutes or null",
  "asa_physical_status": "ASA I through VI or null",
  "emergency": "YES or NO",
  "complications": "complications or NONE",
  "pre_anesthesia_eval": "MM/DD/YYYY or null",
  "post_anesthesia_eval": "MM/DD/YYYY or null"
}`,

  prior_auth_request: `You are an expert RCM specialist extracting data from a prior authorization request form.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "full name",
  "patient_dob": "MM/DD/YYYY",
  "member_id": "member ID",
  "group_number": "group number or null",
  "payer_name": "insurance company",
  "requesting_provider": "provider name",
  "requesting_npi": "NPI or null",
  "requesting_facility": "facility name or null",
  "requesting_phone": "phone number",
  "requesting_fax": "fax number or null",
  "service_requested": "description of service or procedure",
  "cpt_codes": ["requested CPT codes"],
  "icd10_codes": ["diagnosis codes supporting request"],
  "requested_service_date": "MM/DD/YYYY or null",
  "urgency": "routine or urgent or emergent",
  "clinical_justification": "summary of clinical justification",
  "referring_provider": "name or null",
  "referring_npi": "NPI or null",
  "facility_requested": "where service will be performed or null",
  "facility_npi": "NPI or null",
  "supporting_documents": "list of attached documents or null",
  "contact_name": "contact person at requesting office or null",
  "contact_phone": "contact phone or null"
}`,

  prior_auth_response: `You are an expert RCM specialist extracting data from a prior authorization response (approval or denial).
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "full name",
  "member_id": "member ID",
  "payer_name": "insurance company",
  "auth_number": "authorization number or null",
  "decision": "APPROVED or DENIED or PARTIAL or PENDING",
  "decision_date": "MM/DD/YYYY",
  "effective_date": "MM/DD/YYYY or null",
  "expiration_date": "MM/DD/YYYY or null",
  "approved_cpt_codes": ["approved CPT codes or null"],
  "denied_cpt_codes": ["denied CPT codes or null"],
  "approved_units": "approved quantity or null",
  "approved_facility": "approved facility or null",
  "denial_reason": "reason for denial or null",
  "denial_codes": ["denial reason codes or null"],
  "partial_approval_notes": "notes if partial approval or null",
  "appeal_rights": "appeal instructions or null",
  "appeal_deadline": "MM/DD/YYYY or null",
  "reviewer_name": "medical reviewer or null",
  "reviewer_credentials": "MD / RN / etc or null",
  "contact_phone": "payer contact phone or null",
  "reference_number": "payer reference number or null"
}`,

  operative_report: `You are an expert clinical documentation specialist extracting data from a surgical operative report.
Respond ONLY with a JSON object — no markdown, no explanation.

{
  "patient_name": "full name",
  "patient_dob": "MM/DD/YYYY or null",
  "mrn": "medical record number or null",
  "date_of_surgery": "MM/DD/YYYY",
  "facility": "hospital or surgery center name",
  "surgeon": "primary surgeon name",
  "surgeon_npi": "NPI or null",
  "assistant_surgeon": "assistant name or null",
  "anesthesiologist": "name or null",
  "anesthesia_type": "general / regional / MAC / local or null",
  "preoperative_diagnosis": "pre-op diagnosis",
  "postoperative_diagnosis": "post-op diagnosis",
  "procedure_name": "full procedure name",
  "cpt_codes": ["CPT codes"],
  "icd10_codes": ["ICD-10 diagnosis codes"],
  "laterality": "left / right / bilateral / null",
  "approach": "open / laparoscopic / robotic / endoscopic or null",
  "implants_used": ["implants or hardware or null"],
  "specimens_sent": "pathology specimens or null",
  "estimated_blood_loss": "EBL in mL or null",
  "fluids_given": "IV fluids administered or null",
  "complications": "intraoperative complications or NONE",
  "tourniquet_time": "minutes or null",
  "operative_time": "total OR time in minutes or null",
  "findings": "key operative findings summary",
  "closure": "closure method or null",
  "disposition": "patient disposition post-op"
}`,

  anesthesia_demographics: `You are an expert healthcare registration specialist extracting data from an anesthesia department patient demographics document. This may be a multi-page PDF.

IMPORTANT INSTRUCTIONS:
1. Extract all 5 sections below. If a section is not present in the document, return null for that section.
2. PAGE IDENTITY CHECK: Read every page. Extract patient name and DOB from each page. If any page has a different patient name or DOB than page 1, flag it as a mismatch with the page number.
3. STICKER DETECTION: Some handwritten pages may have a printed digital sticker pasted on them. If the surrounding page is handwritten or unreadable, extract patient details from the sticker.
4. BILLING NOTE: If there is any note about billing instructions (e.g. "consultation fees waived", "charge only medicine", "do not charge", "partial payment only"), extract it as raw text.
5. MINOR CHECK: If patient age is under 18 or DOB indicates the patient is under 18, set is_minor to true.
6. INSURANCE TIERS: Only extract insurance tiers (primary, secondary, tertiary) that are actually present in the document.

Respond ONLY with a JSON object — no markdown, no explanation.

{
  "page_count": "total number of pages in document",
  "identity_check": {
    "anchor_name": "patient name from page 1",
    "anchor_dob": "DOB from page 1",
    "mismatched_pages": [
      { "page": 2, "name_found": "different name", "dob_found": "different DOB" }
    ]
  },

  "section1_patient": {
    "first_name": "first name or null",
    "last_name": "last name or null",
    "middle_name": "middle name or null",
    "suffix": "suffix or null",
    "age": "age or null",
    "gender": "gender or null",
    "date_of_birth": "MM/DD/YYYY or null",
    "is_minor": "true or false",
    "street_address": "street address or null",
    "city": "city or null",
    "state": "state or null",
    "zip_code": "zip or null",
    "country": "country or null",
    "has_usa_address": "true or false or null",
    "medical_record_number": "MRN or null",
    "billing_status": "billing status or null",
    "marital_status": "marital status or null",
    "social_security_number": "SSN or null",
    "home_number": "home phone or null",
    "mobile_number": "mobile phone or null",
    "work_number": "work phone or null",
    "email_address": "email or null",
    "billing_note": "raw billing instruction text or null",
    "multiple_patients": "true or false or null"
  },

  "section2_accident": {
    "present": "true or false",
    "accident_type": "accident type or null",
    "date_of_accident": "MM/DD/YYYY or null"
  },

  "section3_guarantor": {
    "present": "true or false",
    "full_name": "guarantor full name or null",
    "email_address": "email or null",
    "city": "city or null",
    "work_number": "work phone or null",
    "home_number": "home phone or null",
    "mobile_number": "mobile phone or null",
    "zip_code": "zip or null",
    "street_address": "street address or null",
    "gender": "gender or null",
    "relationship": "relationship to patient or null",
    "country": "country or null",
    "has_usa_address": "true or false or null"
  },

  "section4_insurance": {
    "primary": {
      "present": "true or false",
      "insurance_coverage": "coverage type or null",
      "insurance_type": "type or null",
      "insurance_name": "payer name or null",
      "insurance_contract_number": "contract number or null",
      "insurance_group_number": "group number or null",
      "subscriber_name": "subscriber name or null",
      "subscriber_dob": "MM/DD/YYYY or null",
      "subscriber_gender": "gender or null",
      "subscriber_relationship": "relationship or null",
      "insurance_address": "address or null",
      "adjustor_fax": "fax or null",
      "adjustor_phone": "phone or null",
      "adjustor_name": "name or null",
      "prior_auth_number": "auth number or null",
      "card_insurance_group": "group from card or null",
      "card_insurance_code": "code from card or null",
      "card_id_insurance_name": "ID name from card or null",
      "card_insured_member_id": "member ID from card or null",
      "card_insurance_address": "address from card or null",
      "card_insured_name": "insured name from card or null"
    },
    "secondary": {
      "present": "true or false",
      "insurance_coverage": "coverage type or null",
      "insurance_type": "type or null",
      "insurance_name": "payer name or null",
      "insurance_contract_number": "contract number or null",
      "insurance_group_number": "group number or null",
      "subscriber_name": "subscriber name or null",
      "subscriber_dob": "MM/DD/YYYY or null",
      "subscriber_gender": "gender or null",
      "subscriber_relationship": "relationship or null",
      "insurance_address": "address or null",
      "adjustor_fax": "fax or null",
      "adjustor_phone": "phone or null",
      "adjustor_name": "name or null",
      "prior_auth_number": "auth number or null",
      "card_insurance_group": "group from card or null",
      "card_insurance_code": "code from card or null",
      "card_id_insurance_name": "ID name from card or null",
      "card_insured_member_id": "member ID from card or null",
      "card_insurance_address": "address from card or null",
      "card_insured_name": "insured name from card or null"
    },
    "tertiary": {
      "present": "true or false",
      "insurance_coverage": "coverage type or null",
      "insurance_type": "type or null",
      "insurance_name": "payer name or null",
      "insurance_contract_number": "contract number or null",
      "insurance_group_number": "group number or null",
      "subscriber_name": "subscriber name or null",
      "subscriber_dob": "MM/DD/YYYY or null",
      "subscriber_gender": "gender or null",
      "subscriber_relationship": "relationship or null",
      "insurance_address": "address or null",
      "adjustor_fax": "fax or null",
      "adjustor_phone": "phone or null",
      "adjustor_name": "name or null",
      "prior_auth_number": "auth number or null",
      "card_insurance_group": "group from card or null",
      "card_insurance_code": "code from card or null",
      "card_id_insurance_name": "ID name from card or null",
      "card_insured_member_id": "member ID from card or null",
      "card_insurance_address": "address from card or null",
      "card_insured_name": "insured name from card or null"
    }
  },

  "section5_employer": {
    "present": "true or false",
    "employer_name": "employer name or null",
    "employer_status": "employment status or null"
  }
}`,

  unknown: `You are a healthcare document specialist. This document could not be auto-classified.
Extract whatever structured information you can find. Respond ONLY with a JSON object — no markdown.

{
  "document_description": "describe what this document appears to be",
  "patient_name": "name if found or null",
  "date": "any date found or null",
  "provider": "any provider name found or null",
  "facility": "any facility name found or null",
  "insurance": "any insurance info found or null",
  "codes": ["any medical codes found"],
  "amounts": ["any dollar amounts found"],
  "key_fields": {"field_name": "value for any other important fields found"}
}`,
};

// ─────────────────────────────────────────────────────────────
// BUILD MESSAGE CONTENT
// Handles both PDF and image inputs
// ─────────────────────────────────────────────────────────────

function buildContent(buffer: Buffer, mimeType: string, promptText: string): MessageContent[] {
  const base64 = buffer.toString('base64');

  if (mimeType === 'application/pdf') {
    return [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      },
      { type: 'text', text: promptText },
    ];
  }

  return [
    {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: base64 },
    },
    { type: 'text', text: promptText },
  ];
}

// ─────────────────────────────────────────────────────────────
// PARSE JSON SAFELY
// Claude should return clean JSON but we strip fences just in case
// ─────────────────────────────────────────────────────────────

function parseJson(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — DETECT DOCUMENT TYPE
// ─────────────────────────────────────────────────────────────

export async function detectDocumentType(
  buffer: Buffer,
  mimeType: string
): Promise<DetectionResult> {
  const content = buildContent(buffer, mimeType, DETECTION_PROMPT);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: content as Anthropic.MessageParam['content'] }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  const parsed = parseJson(text);

  const detectionTokens: TokenUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    estimated_cost_usd:
      (response.usage.input_tokens / 1_000_000) * 3.0 +
      (response.usage.output_tokens / 1_000_000) * 15.0,
  };

  return {
    doc_type: (parsed.doc_type as DocType) ?? 'unknown',
    confidence: (parsed.confidence as number) ?? 0.5,
    reason: (parsed.reason as string) ?? '',
    token_usage: detectionTokens,
  };
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — EXTRACT FIELDS USING SPECIALIST PROMPT
// ─────────────────────────────────────────────────────────────

export async function extractFields(
  buffer: Buffer,
  mimeType: string,
  docType: DocType
): Promise<{ fields: Record<string, string | string[] | number | null>; token_usage: TokenUsage }> {
  const prompt = EXTRACTION_PROMPTS[docType] ?? EXTRACTION_PROMPTS['unknown'];
  const content = buildContent(buffer, mimeType, prompt);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: content as Anthropic.MessageParam['content'] }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  const parsed = parseJson(text);
  const extractionTokens: TokenUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    estimated_cost_usd:
      (response.usage.input_tokens / 1_000_000) * 3.0 +
      (response.usage.output_tokens / 1_000_000) * 15.0,
  };
  return { fields: parsed as Record<string, string | string[] | number | null>, token_usage: extractionTokens };
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT — runClaudePipeline
// Runs both steps and returns combined result
// ─────────────────────────────────────────────────────────────

export async function runClaudePipeline(
  buffer: Buffer,
  mimeType: string
): Promise<ExtractionResult> {
  // Step 1: Detect
  const detection = await detectDocumentType(buffer, mimeType);

  // Step 2: Extract
  // Step 2: Extract
  const { fields, token_usage: extractionTokens } = await extractFields(buffer, mimeType, detection.doc_type);

  // Combined token usage across both calls
  const token_usage: TokenUsage = {
    input_tokens:       detection.token_usage.input_tokens + extractionTokens.input_tokens,
    output_tokens:      detection.token_usage.output_tokens + extractionTokens.output_tokens,
    total_tokens:       detection.token_usage.total_tokens + extractionTokens.total_tokens,
    estimated_cost_usd: detection.token_usage.estimated_cost_usd + extractionTokens.estimated_cost_usd,
  };

  // Raw text reconstruction from fields for display
  const raw_text = Object.entries(fields)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');

  return {
    doc_type: detection.doc_type,
    detection_confidence: detection.confidence,
    fields,
    raw_text,
    token_usage,
  };
}