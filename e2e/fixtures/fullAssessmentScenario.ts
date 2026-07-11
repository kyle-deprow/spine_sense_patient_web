// SYNTHETIC DATA ONLY.
//
// Browser E2E fixture for the server-owned v2 questionnaire. Screening IDs
// follow the reachable low-back path; adaptive IDs are bank-backed candidates
// because the server selects the final subset at runtime.

type AssessmentAnswer = {
  readonly id: string
  readonly value: string | number | readonly (string | number)[]
}

type TextAnswer = {
  readonly id: string
  readonly text: string
}

export const fullAssessmentScenario = {
  registration: {
    firstName: 'Casey',
    lastName: 'Assessment',
    dateOfBirth: '1988-04-22',
    password: 'E2eTest123!!',
    verificationCode: '000000',
  },
  onboarding: {
    dateOfBirthDisplay: '04/22/1988',
    sexAtBirth: 'female',
    heightFeet: '5',
    heightInches: '6',
    weightPounds: '145',
    occupation: 'Synthetic desk worker',
    activityLevel: 'lightly-active',
    chiefComplaint: 'Lower back pain that started gradually and gets worse with prolonged sitting and bending',
    intakeStepData: {
      'treatment-history': {
        conditions: { items: [], none: true },
      },
    },
  },
  assessmentStory:
    'My low-back pain has been present for more than a year. It built gradually, and sitting, bending forward, and lifting make it worse.',
  uiContracts: {
    a02OptionIds: [
      'pain',
      'tingling_pins',
      'numbness_deficit',
      'weakness',
      'balance_walking',
      'hand_clumsiness',
      'stiffness_heaviness',
    ],
  },
  stress: {
    reloadAfterScreeningQuestionId: 'A03_Q2',
    backtrackAfterScreeningQuestionId: 'R03',
  },
  finalScreeningQuestionId: 'G04',
  screening: [
    { id: 'A00', value: ['low_back'] },
    { id: 'A02', value: ['pain', 'tingling_pins', 'numbness_deficit'] },
    { id: 'A03_Q2', value: 'gradually' },
    { id: 'A03_Q1', value: 'gt_1_year' },
    { id: 'A03_Q3', value: 'getting_worse' },
    { id: 'A03_Q4', value: 'one_ongoing_problem' },
    { id: 'R01', value: 'no' },
    { id: 'R02', value: 'no' },
    { id: 'R03', value: 'no' },
    { id: 'R_SYS', value: ['none'] },
    { id: 'R06', value: 'no' },
    { id: 'R_NEURO', value: ['none'] },
    { id: 'L00', value: 'mostly_back_pain' },
    { id: 'L02', value: ['sitting', 'bending_forward', 'lifting'] },
    { id: 'L03', value: ['heat_ice', 'stretching'] },
    { id: 'L04', value: ['pressure'] },
    { id: 'L05_Q1', value: 7 },
    { id: 'L05_Q2', value: 7 },
    { id: 'L06_Q1', value: 'constant' },
    { id: 'L06_Q2', value: 'same' },
    { id: 'INF_MORNING', value: 'no' },
    { id: 'INF_ACTIVITY', value: 'no' },
    { id: 'INF_NIGHT', value: 'no' },
    { id: 'L_EXT_YOUTH', value: 'no' },
    { id: 'F01', value: ['sitting'] },
    { id: 'F02_Q1', value: 'lt_10_min' },
    { id: 'F02_Q2', value: '10_30_min' },
    { id: 'F02_Q3', value: 'not_limited' },
    { id: 'T00', value: ['no_imaging'] },
    { id: 'T01', value: ['none'] },
    { id: 'T06_Q1', value: 'no' },
    { id: 'T06_Q2', value: 'yes' },
  ] satisfies readonly AssessmentAnswer[],
  screeningText: [
    {
      id: 'G04',
      text: 'I want to understand why sitting and bending keep flaring the low-back pain.',
    },
  ] satisfies readonly TextAnswer[],
  adaptive: [
    { id: 'ONSET_SL_LUMBAR', value: 'gt_1_year' },
    { id: 'SL01', value: 'no' },
    { id: 'SL02', value: 'no' },
    { id: 'SL10', value: 'left' },
    { id: 'SL11', value: 'buttock_only' },
    { id: 'SL12_a', value: 'no' },
    { id: 'SL12_b', value: 'no' },
    { id: 'SL_LEG_PAIN_NOW', value: 0 },
    { id: 'SL_LEG_PAIN_WORST', value: 0 },
    { id: 'SL_LEG_BACK_DOMINANCE', value: 'back_worse' },
    { id: 'SL_L5_MOTOR', value: 'no' },
    { id: 'SL_PAIN_QUALITY', value: ['aching'] },
    { id: 'SL_CLAUD_1', value: 'no' },
    { id: 'SL_CLAUD_3', value: 'no' },
    { id: 'SL_L5_MOTOR_PROG', value: 'stable' },
    { id: 'SL13', value: ['buttock_psis'] },
    { id: 'SC01', value: 'no' },
    { id: 'SC02', value: 'no' },
    { id: 'SC03', value: 'no' },
    { id: 'SC_NECK_SEV_NOW', value: 0 },
    { id: 'SC_NECK_SEV_WORST', value: 0 },
    { id: 'SC_NECK_LOC', value: 'center' },
    { id: 'SC_WIDESPREAD_GATE', value: 'separate_specific' },
    { id: 'SC10', value: 'left' },
    { id: 'SC11', value: 'shoulder_only' },
    { id: 'SC12_a', value: 'no' },
    { id: 'SC12_a_DIST', value: ['hard_to_say'] },
    { id: 'SC12_b', value: 'no' },
    { id: 'SC_ARM_PAIN_NOW', value: 0 },
    { id: 'SC_DISCRIMINATOR', value: 'no' },
    { id: 'SC16', value: 'neck_more' },
    { id: 'TH06_Q2', value: 0 },
    { id: 'TH07_Q2', value: 'same_all_day' },
    { id: 'ST01', value: 'no' },
    { id: 'ST02', value: 'no' },
    { id: 'ST_BAND', value: 'no' },
    { id: 'ST_SENSORY', value: 'no' },
    { id: 'ST_SEV', value: 0 },
    { id: 'F03_Q1', value: 'occasionally' },
    { id: 'F03_Q2', value: 'moderate' },
    { id: 'F03_Q3', value: 'no' },
    { id: 'F04', value: ['sitting', 'driving', 'exercise_recreation'] },
    { id: 'INF_STIFF_SPINE', value: 'no' },
    {
      id: 'G01',
      value: ['relieve_pain', 'return_to_work', 'understand_diagnosis'],
    },
    { id: 'G03', value: 'want_a_plan' },
  ] satisfies readonly AssessmentAnswer[],
} as const

export type FullAssessmentScenario = typeof fullAssessmentScenario
